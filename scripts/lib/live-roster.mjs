const REQUIRED_COLUMNS = ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'TEAM_ID',
  'TEAM_ABBREVIATION', 'POSITION', 'HEIGHT', 'WEIGHT', 'COUNTRY', 'DRAFT_YEAR',
  'DRAFT_ROUND', 'DRAFT_NUMBER', 'ROSTER_STATUS', 'FROM_YEAR', 'TO_YEAR'];
const NBA_TEAMS = new Set('ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split(' '));
const canonicalInteger = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value))) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export function parseLiveRoster(payload, { season, fetchedAt, minRows = 400, requiredSeason = '2026-27' } = {}) {
  if (season !== requiredSeason) throw new Error(`Roster season must be ${requiredSeason}.`);
  if (!Number.isSafeInteger(minRows) || minRows < 1) throw new Error('Roster minimum row count must be a positive integer.');
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Roster fetch time is invalid.');
  const table = payload?.resultSets?.[0] || payload?.resultSet;
  const sourceHeaders = table?.headers;
  if (!Array.isArray(sourceHeaders) || !Array.isArray(table?.rowSet)) throw new Error('Roster response has no player index table.');
  if (sourceHeaders.some(h=>typeof h!=='string'||!h) || new Set(sourceHeaders).size!==sourceHeaders.length) throw new Error('Roster response has invalid or duplicate columns.');
  const positions = REQUIRED_COLUMNS.map((column) => sourceHeaders.indexOf(column));
  if (positions.some((position) => position < 0)) throw new Error('Roster response is missing required columns.');
  const rows = [];
  const seen = new Set();
  const idPos = sourceHeaders.indexOf('PERSON_ID');
  const teamPos = sourceHeaders.indexOf('TEAM_ABBREVIATION');
  const statusPos = sourceHeaders.indexOf('ROSTER_STATUS');
  for (const source of table.rowSet) {
    if (!Array.isArray(source) || source.length !== sourceHeaders.length) throw new Error('Roster row has invalid width.');
    const status=canonicalInteger(source[statusPos]);
    if (status !== 0 && status !== 1) throw new Error('Roster row has invalid roster status.');
    if (status === 0) continue;
    const id = canonicalInteger(source[idPos]);
    const team = source[teamPos];
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Roster row has invalid player ID.');
    if (!NBA_TEAMS.has(team)) throw new Error(`Roster row has invalid team ${team}.`);
    if (seen.has(id)) throw new Error(`Roster has duplicate active player ID ${id}.`);
    seen.add(id);
    const normalized=positions.map((position)=>source[position]);
    normalized[REQUIRED_COLUMNS.indexOf('PERSON_ID')]=id;
    normalized[REQUIRED_COLUMNS.indexOf('ROSTER_STATUS')]=1;
    rows.push(normalized);
  }
  if (rows.length < minRows) throw new Error(`Roster has too few active players (${rows.length}; minimum ${minRows}).`);
  return { season, fetchedAt, source: 'stats.nba.com/stats/playerindex', headers: REQUIRED_COLUMNS, rows };
}

export function verifyLiveRosterSnapshot(snapshot, { minRows = 400, requiredSeason = '2026-27' } = {}) {
  if (snapshot?.source !== 'stats.nba.com/stats/playerindex') throw new Error('Roster source is not the official player index.');
  const verified = parseLiveRoster({ resultSets: [{ headers: snapshot.headers, rowSet: snapshot.rows }] },
    { season: snapshot.season, fetchedAt: snapshot.fetchedAt, minRows, requiredSeason });
  if (verified.rows.length !== snapshot.rows.length) throw new Error('Roster snapshot contains non-active rows.');
  return verified;
}

export async function refreshLiveRoster({ file, season = '2026-27', minRows = 400,
  now = () => new Date().toISOString(), fetchJson = fetchOfficialRoster } = {}) {
  if (!file) throw new Error('Live roster destination is required.');
  const params = new URLSearchParams({ College: '', Country: '', DraftPick: '', DraftRound: '',
    DraftYear: '', Height: '', Historical: '0', LeagueID: '00', Season: season,
    SeasonType: 'Regular Season', TeamID: '0', Weight: '' });
  const payload = await fetchJson(`https://stats.nba.com/stats/playerindex?${params}`);
  const roster = parseLiveRoster(payload, { season, fetchedAt: now(), minRows });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(roster) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return roster;
}

async function fetchOfficialRoster(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
      Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com', Accept: 'application/json',
      'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
    },
  });
  if (!response.ok) throw new Error(`Official roster request failed: HTTP ${response.status}`);
  return response.json();
}
import fs from 'node:fs';
import path from 'node:path';

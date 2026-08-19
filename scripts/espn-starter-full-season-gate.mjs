// Exhaustive cross-source acceptance gate for historical NBA starter identities.
//
// Why this exists: NBA Stats' boxscore START_POSITION field is structurally corrupt in
// 2015-16 and 2016-17, so those seasons can never legitimately pass the native NBA gate.
// This gate uses ESPN's published per-player box scores (starter=true), then maps ESPN game
// and player ids back to NBA Stats ids through SportsDataverse's season-specific schedule and
// player crosswalk releases. It fails closed on every missing/ambiguous mapping and validates
// the mapped identities against the local NBA player-game roster wherever that cache exists.
// Regular-season starter counts must reconcile EXACTLY per player to NBA's independently fetched
// StarterBench=Starters split; matching only the league-wide total is not sufficient.
//
// No starter is ever inferred from minutes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const CURRENT_SPLIT = path.join(ROOT, 'scripts/data/splits_nba/starter.json');
const SOURCE_REPO = 'sportsdataverse/sportsdataverse-data';
const SOURCE_TAG = 'espn_nba_player_boxscores';
const XWALK_TAG = 'nba_crosswalk';
const GATE_SCHEMA_VERSION = 1;
const ASSIGNMENT_SCHEMA_VERSION = 2;
const MIN_CROSSWALK_CONFIDENCE = 0.92;
const CURRENT_SEASON = '2025-26';

function sha256Buffer(buf) {
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)); }
function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} missing: ${path.relative(ROOT, file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function bool(v) { return /^(true|t|1)$/i.test(String(v ?? '').trim()); }
function clean(v) {
  const s = String(v ?? '').trim();
  return /^(na|nan|null)$/i.test(s) ? '' : s;
}
function int(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${label}: expected integer, got ${JSON.stringify(v)}`);
  return n;
}
function seasonEndYear(season) {
  const m = /^(\d{4})-(\d{2})$/.exec(season);
  if (!m) throw new Error(`invalid NBA season ${season}; expected YYYY-YY`);
  const start = Number(m[1]);
  const end = start + 1;
  if (String(end).slice(-2) !== m[2]) throw new Error(`invalid season rollover ${season}`);
  return end;
}
function releaseUrl(tag, asset) {
  return `https://github.com/${SOURCE_REPO}/releases/download/${tag}/${asset}`;
}
async function download(url, label) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'TulipBasketball-starter-acceptance-gate/1.0' },
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      if (!buf.length) throw new Error('empty response');
      return { label, url, buffer: buf, ...sha256Buffer(buf) };
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`${label} download failed: ${last?.message || last}`);
}

// RFC-4180-enough parser for the release CSVs: quoted fields, escaped quotes, CRLF/LF.
function parseCsvBuffer(buf, label) {
  const text = buf.toString('utf8');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error(`${label}: unterminated quoted CSV field`);
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows.length < 2) throw new Error(`${label}: CSV has no data rows`);
  const headers = rows.shift().map((x) => x.replace(/^\uFEFF/, ''));
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));
  return { headers, index, rows };
}
function requireColumns(csv, label, cols) {
  const missing = cols.filter((c) => !(c in csv.index));
  if (missing.length) throw new Error(`${label}: missing columns ${missing.join(', ')}`);
}
function value(csv, row, col) { return row[csv.index[col]]; }
function sameSet(a, b) { return a.size === b.size && [...a].every((x) => b.has(x)); }
function addFailure(failures, kind, detail = {}) {
  failures.push({ kind, ...detail });
}

function readHistoricalPhase(season, seasonType) {
  const file = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
  const rows = readJson(file, `${season} ${seasonType} game log`);
  const games = new Map();
  for (const row of rows) {
    if (!row.gameId || !row.teamId || !row.playerId) {
      throw new Error(`${season} ${seasonType}: local row missing gameId/teamId/playerId`);
    }
    const gameId = String(row.gameId), teamId = String(row.teamId), playerId = String(row.playerId);
    if (!games.has(gameId)) games.set(gameId, { teams: new Set(), rosters: new Map(), date: row.gameDate || null });
    const game = games.get(gameId);
    game.teams.add(teamId);
    if (!game.rosters.has(teamId)) game.rosters.set(teamId, new Set());
    game.rosters.get(teamId).add(playerId);
  }
  return { file, rows, games, fingerprint: sha256File(file) };
}

function historicalStarterExpectation(season) {
  const file = path.join(HIST, season, 'starter_splits.json');
  const json = readJson(file, `${season} starter splits`);
  if (!Array.isArray(json.starters)) throw new Error(`${season}: starter_splits.json lacks starters[]`);
  const starts = new Map();
  for (const row of json.starters) {
    const id = clean(row.playerId);
    if (!id) throw new Error(`${season}: starter split row missing playerId`);
    if (starts.has(id)) throw new Error(`${season}: duplicate player ${id} in starter split`);
    starts.set(id, int(row.gp, `${season} starter split GP ${id}`));
  }
  return { file, starts, fingerprint: sha256File(file), source: 'historical StarterBench=Starters cache' };
}

function currentStarterExpectation(season) {
  if (season !== CURRENT_SEASON) throw new Error(`${season}: no hydrated historical cache and no current-season adapter`);
  const json = readJson(CURRENT_SPLIT, `${season} current starter split`);
  const rs = Array.isArray(json.resultSets) ? json.resultSets[0] : json.resultSets;
  if (!rs?.headers || !rs?.rowSet) throw new Error(`${season}: malformed scripts/data/splits_nba/starter.json`);
  const idx = Object.fromEntries(rs.headers.map((h, i) => [h, i]));
  for (const col of ['PLAYER_ID', 'GP']) if (!(col in idx)) throw new Error(`${season}: current starter split missing ${col}`);
  const starts = new Map();
  for (const row of rs.rowSet) {
    const id = String(row[idx.PLAYER_ID]);
    if (starts.has(id)) throw new Error(`${season}: duplicate current starter split player ${id}`);
    starts.set(id, int(row[idx.GP], `${season} current starter GP ${id}`));
  }
  return { file: CURRENT_SPLIT, starts, fingerprint: sha256File(CURRENT_SPLIT), source: 'tracked 2025-26 NBA StarterBench=Starters split' };
}

function verifyHistoryProvenance(season, phaseInputs, splitInput) {
  const provenanceFile = path.join(HIST, 'provenance.json');
  const provenance = readJson(provenanceFile, 'history provenance');
  const required = [
    [`${season}/Regular Season/gamelog`, phaseInputs['Regular Season']],
    [`${season}/Playoffs/gamelog`, phaseInputs.Playoffs],
    [`${season}/starter_splits`, splitInput],
  ];
  const checks = [];
  for (const [dataset, input] of required) {
    const rec = provenance.datasets?.find((x) => x.dataset === dataset);
    if (!rec) throw new Error(`${season}: provenance lacks ${dataset}`);
    const actual = sha256File(input.file);
    const pass = Number(rec.bytes) === actual.bytes && actual.sha256.startsWith(String(rec.sha256));
    checks.push({ dataset, expectedBytes: rec.bytes, observedBytes: actual.bytes, expectedSha256Prefix: rec.sha256, observedSha256: actual.sha256, pass });
  }
  return { file: { path: path.relative(ROOT, provenanceFile), ...sha256File(provenanceFile) }, checks, pass: checks.every((x) => x.pass) };
}

function indexSchedule(csv) {
  requireColumns(csv, 'schedule crosswalk', [
    'espn_game_id', 'nba_game_id', 'home_espn_team_id', 'away_espn_team_id',
    'nba_home_team_id', 'nba_away_team_id', 'match_method', 'match_confidence',
  ]);
  const byNba = new Map(), byEspn = new Map();
  for (const row of csv.rows) {
    const nba = clean(value(csv, row, 'nba_game_id'));
    const espn = clean(value(csv, row, 'espn_game_id'));
    if (nba) {
      if (!byNba.has(nba)) byNba.set(nba, []);
      byNba.get(nba).push(row);
    }
    if (espn) {
      if (!byEspn.has(espn)) byEspn.set(espn, []);
      byEspn.get(espn).push(row);
    }
  }
  return { byNba, byEspn };
}

function indexPlayers(csv) {
  requireColumns(csv, 'player crosswalk', [
    'espn_team_id', 'espn_athlete_id', 'nba_player_id', 'match_method', 'match_confidence',
  ]);
  const byKey = new Map();
  for (const row of csv.rows) {
    const team = clean(value(csv, row, 'espn_team_id'));
    const athlete = clean(value(csv, row, 'espn_athlete_id'));
    if (!team || !athlete) continue;
    const key = `${team}|${athlete}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return byKey;
}

function indexPlayerBox(csv) {
  requireColumns(csv, 'ESPN player box', ['game_id', 'season_type', 'athlete_id', 'team_id', 'starter']);
  const byGame = new Map();
  for (const row of csv.rows) {
    const game = clean(value(csv, row, 'game_id'));
    if (!game) continue;
    if (!byGame.has(game)) byGame.set(game, []);
    byGame.get(game).push(row);
  }
  return byGame;
}

function resolveScheduleRow(rows, nbaGameId, failures) {
  if (!rows?.length) { addFailure(failures, 'NBA_GAME_MISSING_FROM_SCHEDULE_CROSSWALK', { gameId: nbaGameId }); return null; }
  const usable = rows.filter((row) => clean(row.__espnGameId));
  if (rows.length !== 1 || usable.length !== 1) {
    addFailure(failures, 'AMBIGUOUS_SCHEDULE_CROSSWALK', { gameId: nbaGameId, rows: rows.length, withEspnId: usable.length });
    return null;
  }
  return rows[0];
}

function scheduleRecord(csv, row) {
  const conf = Number(value(csv, row, 'match_confidence'));
  return {
    espnGameId: clean(value(csv, row, 'espn_game_id')),
    nbaGameId: clean(value(csv, row, 'nba_game_id')),
    homeEspnTeamId: clean(value(csv, row, 'home_espn_team_id')),
    awayEspnTeamId: clean(value(csv, row, 'away_espn_team_id')),
    nbaHomeTeamId: clean(value(csv, row, 'nba_home_team_id')),
    nbaAwayTeamId: clean(value(csv, row, 'nba_away_team_id')),
    matchMethod: clean(value(csv, row, 'match_method')),
    matchConfidence: Number.isFinite(conf) ? conf : null,
    seasonType: 'season_type' in csv.index ? clean(value(csv, row, 'season_type')) : null,
  };
}

function resolvePlayer(playerCsv, rows, espnTeamId, espnAthleteId, failures, context) {
  if (!rows?.length) {
    addFailure(failures, 'PLAYER_MISSING_FROM_CROSSWALK', { ...context, espnTeamId, espnAthleteId });
    return null;
  }
  const candidates = rows.map((row) => ({
    nbaPlayerId: clean(value(playerCsv, row, 'nba_player_id')),
    method: clean(value(playerCsv, row, 'match_method')),
    confidence: Number(value(playerCsv, row, 'match_confidence')),
    nbaPlayerName: 'nba_player_name' in playerCsv.index ? clean(value(playerCsv, row, 'nba_player_name')) : '',
    espnFullName: 'espn_full_name' in playerCsv.index ? clean(value(playerCsv, row, 'espn_full_name')) : '',
  })).filter((x) => x.nbaPlayerId && x.method && x.method !== 'unmatched' && Number.isFinite(x.confidence) && x.confidence >= MIN_CROSSWALK_CONFIDENCE);
  const ids = new Set(candidates.map((x) => x.nbaPlayerId));
  if (ids.size !== 1) {
    addFailure(failures, 'PLAYER_CROSSWALK_NOT_UNIQUE_OR_CONFIDENT', {
      ...context, espnTeamId, espnAthleteId, rows: rows.length,
      acceptableCandidates: candidates.map((x) => ({ nbaPlayerId: x.nbaPlayerId, method: x.method, confidence: x.confidence })),
    });
    return null;
  }
  const chosen = candidates.find((x) => x.nbaPlayerId === [...ids][0]);
  return chosen;
}

function validateScheduleRecord(rec, failures, context) {
  if (!rec.espnGameId || !rec.nbaGameId || !rec.homeEspnTeamId || !rec.awayEspnTeamId || !rec.nbaHomeTeamId || !rec.nbaAwayTeamId) {
    addFailure(failures, 'INCOMPLETE_SCHEDULE_CROSSWALK_ROW', { ...context, rec });
    return false;
  }
  if (rec.matchMethod !== 'both' || rec.matchConfidence !== 1) {
    addFailure(failures, 'SCHEDULE_CROSSWALK_NOT_EXACT', { ...context, method: rec.matchMethod, confidence: rec.matchConfidence });
    return false;
  }
  if (rec.homeEspnTeamId === rec.awayEspnTeamId || rec.nbaHomeTeamId === rec.nbaAwayTeamId) {
    addFailure(failures, 'SCHEDULE_CROSSWALK_DUPLICATE_TEAM', { ...context, rec });
    return false;
  }
  return true;
}

function evaluateMappedGame({
  seasonType, rec, localGame, playerBoxCsv, playerBoxByGame, playerCsv, playerByKey, failures,
}) {
  const sourceRows = playerBoxByGame.get(rec.espnGameId) || [];
  if (!sourceRows.length) {
    addFailure(failures, 'ESPN_GAME_MISSING_PLAYER_BOX', { seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId });
    return null;
  }
  const expectedEspnSeasonType = seasonType === 'Regular Season' ? '2' : '3';
  const observedSeasonTypes = new Set(sourceRows.map((row) => clean(value(playerBoxCsv, row, 'season_type'))).filter(Boolean));
  if (!sameSet(new Set([expectedEspnSeasonType]), observedSeasonTypes)) {
    addFailure(failures, 'ESPN_SEASON_TYPE_MISMATCH', {
      seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId,
      expectedEspnSeasonType, observedEspnSeasonTypes: [...observedSeasonTypes].sort(),
    });
  }
  const expectedTeams = new Map([
    [rec.homeEspnTeamId, rec.nbaHomeTeamId],
    [rec.awayEspnTeamId, rec.nbaAwayTeamId],
  ]);
  const observedTeams = new Set(sourceRows.map((row) => clean(value(playerBoxCsv, row, 'team_id'))).filter(Boolean));
  if (!sameSet(new Set(expectedTeams.keys()), observedTeams)) {
    addFailure(failures, 'ESPN_PLAYER_BOX_TEAM_MISMATCH', {
      seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId,
      expectedEspnTeamIds: [...expectedTeams.keys()].sort(), observedEspnTeamIds: [...observedTeams].sort(),
    });
  }
  const assignments = [];
  for (const [espnTeamId, nbaTeamId] of expectedTeams) {
    const teamRows = sourceRows.filter((row) => clean(value(playerBoxCsv, row, 'team_id')) === espnTeamId);
    const starters = teamRows.filter((row) => bool(value(playerBoxCsv, row, 'starter')));
    const espnStarterIds = starters.map((row) => clean(value(playerBoxCsv, row, 'athlete_id'))).filter(Boolean);
    if (starters.length !== 5 || new Set(espnStarterIds).size !== 5) {
      addFailure(failures, 'ESPN_INVALID_STARTER_COUNT_OR_IDENTITY', {
        seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId, espnTeamId, nbaTeamId,
        starterRows: starters.length, distinctStarterIds: new Set(espnStarterIds).size,
      });
      continue;
    }
    const mapped = [];
    const crosswalkEvidence = [];
    for (const espnAthleteId of espnStarterIds) {
      const resolved = resolvePlayer(playerCsv, playerByKey.get(`${espnTeamId}|${espnAthleteId}`), espnTeamId, espnAthleteId, failures, {
        seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId, nbaTeamId,
      });
      if (!resolved) continue;
      mapped.push(resolved.nbaPlayerId);
      crosswalkEvidence.push({ espnAthleteId, nbaPlayerId: resolved.nbaPlayerId, method: resolved.method, confidence: resolved.confidence });
    }
    if (mapped.length !== 5 || new Set(mapped).size !== 5) {
      addFailure(failures, 'MAPPED_STARTER_IDENTITY_NOT_FIVE_DISTINCT', {
        seasonType, gameId: rec.nbaGameId, espnGameId: rec.espnGameId, espnTeamId, nbaTeamId,
        mapped: mapped.length, distinct: new Set(mapped).size,
      });
      continue;
    }
    if (localGame) {
      if (!localGame.teams.has(nbaTeamId)) {
        addFailure(failures, 'MAPPED_NBA_TEAM_NOT_IN_LOCAL_GAME', { seasonType, gameId: rec.nbaGameId, nbaTeamId });
      }
      const roster = localGame.rosters.get(nbaTeamId) || new Set();
      const missing = mapped.filter((id) => !roster.has(id));
      if (missing.length) {
        addFailure(failures, 'MAPPED_STARTER_NOT_IN_LOCAL_NBA_ROSTER', {
          seasonType, gameId: rec.nbaGameId, nbaTeamId, playerIds: missing,
        });
      }
    }
    assignments.push({
      seasonType, gameId: rec.nbaGameId, teamId: nbaTeamId,
      starterPlayerIds: [...mapped].sort(),
      source: { espnGameId: rec.espnGameId, espnTeamId, playerCrosswalk: crosswalkEvidence },
    });
  }
  return assignments;
}

function reconcilePerPlayerStarts(expected, assignments) {
  const observed = new Map();
  for (const row of assignments) for (const id of row.starterPlayerIds) observed.set(id, (observed.get(id) || 0) + 1);
  const mismatches = [];
  const ids = new Set([...expected.keys(), ...observed.keys()]);
  for (const id of [...ids].sort()) {
    const e = expected.get(id) || 0, o = observed.get(id) || 0;
    if (e !== o) mismatches.push({ playerId: id, expected: e, observed: o, delta: o - e });
  }
  const expectedEdges = [...expected.values()].reduce((a, b) => a + b, 0);
  const observedEdges = [...observed.values()].reduce((a, b) => a + b, 0);
  return { pass: mismatches.length === 0, expectedPlayers: expected.size, observedPlayers: observed.size, expectedStarterEdges: expectedEdges, observedStarterEdges: observedEdges, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 100) };
}

function historicalExpectedGames(phaseInputs) {
  return Object.fromEntries(Object.entries(phaseInputs).map(([phase, input]) => [phase, [...input.games.keys()].sort()]));
}

function currentExpectedGames(scheduleCsv, splitExpectation) {
  // NBA game-id families: 002 = regular season, 004 = playoffs. We intentionally exclude
  // preseason/all-star/play-in here to preserve the same Regular Season + Playoffs contract as
  // scripts/fetch-history.mjs.
  const regular = [], playoffs = [];
  for (const row of scheduleCsv.rows) {
    const nba = clean(value(scheduleCsv, row, 'nba_game_id'));
    if (nba.startsWith('002')) regular.push(nba);
    else if (nba.startsWith('004')) playoffs.push(nba);
  }
  const expectedRegularFromSplit = [...splitExpectation.starts.values()].reduce((a, b) => a + b, 0) / 10;
  if (!Number.isInteger(expectedRegularFromSplit)) throw new Error(`current starter split edge total does not imply an integer game count: ${expectedRegularFromSplit}`);
  return {
    games: { 'Regular Season': [...new Set(regular)].sort(), Playoffs: [...new Set(playoffs)].sort() },
    expectedRegularFromSplit,
  };
}

const season = process.argv[2];
if (!season) {
  console.error('usage: node scripts/espn-starter-full-season-gate.mjs <season>');
  process.exit(2);
}
const endYear = seasonEndYear(season);
const historyDir = path.join(HIST, season);
const hasHistoricalCache = fs.existsSync(path.join(historyDir, 'gamelog.json')) && fs.existsSync(path.join(historyDir, 'gamelog_playoffs.json'));

console.log(`Exhaustive ESPN -> NBA starter acceptance gate: ${season}`);
console.log(`mode: ${hasHistoricalCache ? 'hydrated historical cache' : 'current-season schedule crosswalk'}`);

const assets = {
  playerBox: await download(releaseUrl(SOURCE_TAG, `player_box_${endYear}.csv`), 'ESPN player box'),
  scheduleCrosswalk: await download(releaseUrl(XWALK_TAG, `nba_schedule_crosswalk_${endYear}.csv`), 'NBA schedule crosswalk'),
  playerCrosswalk: await download(releaseUrl(XWALK_TAG, `nba_player_crosswalk_${endYear}.csv`), 'NBA player crosswalk'),
};
console.log(`downloaded source assets: player box ${assets.playerBox.bytes} B, schedule xwalk ${assets.scheduleCrosswalk.bytes} B, player xwalk ${assets.playerCrosswalk.bytes} B`);

const playerBoxCsv = parseCsvBuffer(assets.playerBox.buffer, 'ESPN player box');
const scheduleCsv = parseCsvBuffer(assets.scheduleCrosswalk.buffer, 'NBA schedule crosswalk');
const playerCsv = parseCsvBuffer(assets.playerCrosswalk.buffer, 'NBA player crosswalk');
const scheduleIndex = indexSchedule(scheduleCsv);
const playerByKey = indexPlayers(playerCsv);
const playerBoxByGame = indexPlayerBox(playerBoxCsv);

// Attach parsed records once so resolution does not repeatedly parse the same row.
for (const rows of scheduleIndex.byNba.values()) for (const row of rows) {
  const rec = scheduleRecord(scheduleCsv, row);
  Object.defineProperty(row, '__record', { value: rec });
  Object.defineProperty(row, '__espnGameId', { value: rec.espnGameId });
}

let splitExpectation;
let phaseInputs = null;
let historyProvenance = null;
let expectedGames;
let currentCountExpectation = null;
if (hasHistoricalCache) {
  phaseInputs = {
    'Regular Season': readHistoricalPhase(season, 'Regular Season'),
    Playoffs: readHistoricalPhase(season, 'Playoffs'),
  };
  splitExpectation = historicalStarterExpectation(season);
  historyProvenance = verifyHistoryProvenance(season, phaseInputs, splitExpectation);
  if (!historyProvenance.pass) throw new Error(`${season}: restored historical cache does not match tracked provenance`);
  expectedGames = historicalExpectedGames(phaseInputs);
} else {
  splitExpectation = currentStarterExpectation(season);
  const current = currentExpectedGames(scheduleCsv, splitExpectation);
  expectedGames = current.games;
  currentCountExpectation = current.expectedRegularFromSplit;
}

const failures = [];
const phaseResults = [];
const allAssignments = [];
for (const seasonType of ['Regular Season', 'Playoffs']) {
  const ids = expectedGames[seasonType];
  const assignments = [];
  const phaseFailureStart = failures.length;
  let mappedGames = 0;
  let exactScheduleRows = 0;
  for (const nbaGameId of ids) {
    const rows = scheduleIndex.byNba.get(nbaGameId);
    const row = resolveScheduleRow(rows, nbaGameId, failures);
    if (!row) continue;
    const rec = row.__record || scheduleRecord(scheduleCsv, row);
    if (!validateScheduleRecord(rec, failures, { seasonType, gameId: nbaGameId })) continue;
    exactScheduleRows++;
    const localGame = phaseInputs?.[seasonType]?.games.get(nbaGameId) || null;
    if (localGame) {
      const localTeams = localGame.teams;
      const xwalkTeams = new Set([rec.nbaHomeTeamId, rec.nbaAwayTeamId]);
      if (!sameSet(localTeams, xwalkTeams)) {
        addFailure(failures, 'SCHEDULE_NBA_TEAM_IDS_DO_NOT_MATCH_LOCAL_GAME', {
          seasonType, gameId: nbaGameId, localTeamIds: [...localTeams].sort(), crosswalkTeamIds: [...xwalkTeams].sort(),
        });
      }
    }
    const gameAssignments = evaluateMappedGame({
      seasonType, rec, localGame, playerBoxCsv, playerBoxByGame, playerCsv, playerByKey, failures,
    });
    if (gameAssignments) {
      mappedGames++;
      assignments.push(...gameAssignments);
    }
  }
  const expectedTeamGames = ids.length * 2;
  const assignmentEdges = assignments.reduce((n, row) => n + row.starterPlayerIds.length, 0);
  const phaseFailureCount = failures.length - phaseFailureStart;
  const reconciliations = {
    gameUniverse: { expectedGames: ids.length, mappedGames, pass: mappedGames === ids.length },
    exactScheduleCrosswalk: { expectedGames: ids.length, exactRows: exactScheduleRows, pass: exactScheduleRows === ids.length },
    assignmentCapture: {
      expectedTeamGames, observedTeamGames: assignments.length,
      expectedStarterEdges: expectedTeamGames * 5, observedStarterEdges: assignmentEdges,
      pass: assignments.length === expectedTeamGames && assignmentEdges === expectedTeamGames * 5,
    },
    phaseFailures: { count: phaseFailureCount, pass: phaseFailureCount === 0 },
  };
  if (!hasHistoricalCache && seasonType === 'Regular Season') {
    reconciliations.currentRegularGameCount = {
      expectedFromOfficialStarterEdges: currentCountExpectation,
      observedScheduleGames: ids.length,
      pass: currentCountExpectation === ids.length,
    };
  }
  const accepted = Object.values(reconciliations).every((x) => x.pass === true);
  phaseResults.push({ seasonType, accepted, counts: { games: ids.length, teamGames: assignments.length, starterEdges: assignmentEdges }, reconciliations });
  allAssignments.push(...assignments);
  console.log(`  ${seasonType}: ${accepted ? 'PASS' : 'FAIL'} · ${ids.length} games · ${assignments.length}/${expectedTeamGames} team-games`);
}

const regularAssignments = allAssignments.filter((x) => x.seasonType === 'Regular Season');
const perPlayerStarts = reconcilePerPlayerStarts(splitExpectation.starts, regularAssignments);
if (!perPlayerStarts.pass) addFailure(failures, 'REGULAR_SEASON_PER_PLAYER_START_RECONCILIATION', { mismatchCount: perPlayerStarts.mismatchCount, examples: perPlayerStarts.mismatches.slice(0, 25) });

const expectedAssignmentRows = phaseResults.reduce((n, x) => n + x.counts.games * 2, 0);
const expectedAssignmentEdges = expectedAssignmentRows * 5;
const observedAssignmentEdges = allAssignments.reduce((n, x) => n + x.starterPlayerIds.length, 0);
const accepted = phaseResults.every((x) => x.accepted) && perPlayerStarts.pass && failures.length === 0 &&
  allAssignments.length === expectedAssignmentRows && observedAssignmentEdges === expectedAssignmentEdges;

const implementation = { gate: { path: path.relative(ROOT, fileURLToPath(import.meta.url)), ...sha256File(fileURLToPath(import.meta.url)) } };
const sourceAssets = Object.fromEntries(Object.entries(assets).map(([key, a]) => [key, { url: a.url, bytes: a.bytes, sha256: a.sha256 }]));
const sourceContract = {
  provider: 'ESPN data processed and published by SportsDataverse/hoopR',
  playerBox: 'starter=true only; never inferred from minutes',
  scheduleIdentity: 'nba_schedule_crosswalk: exact match_method=both and match_confidence=1',
  playerIdentity: `nba_player_crosswalk: unique NBA player id at confidence >= ${MIN_CROSSWALK_CONFIDENCE}, then local NBA roster membership when historical cache exists`,
  regularSeasonAcceptance: 'mapped per-player start counts must exactly equal NBA StarterBench=Starters GP for every player',
};

const assignmentFile = path.join(HIST, `starter_assignments_${season}.json`);
const acceptanceFile = path.join(HIST, `starter_espn_acceptance_${season}.json`);
let assignmentArtifact = null;
if (accepted) {
  const output = {
    schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    season,
    sourceVersion: 'ESPN player box starter flag + SportsDataverse NBA schedule/player crosswalks',
    rule: 'Only source-declared starters are captured. No starter is inferred from minutes. Consumer must verify this file fingerprint against starter_espn_acceptance_<season>.json.',
    implementation,
    sourceAssets,
    officialStarterSplit: { path: path.relative(ROOT, splitExpectation.file), ...splitExpectation.fingerprint, source: splitExpectation.source },
    counts: { teamGames: allAssignments.length, starterEdges: observedAssignmentEdges },
    assignments: allAssignments,
  };
  fs.writeFileSync(assignmentFile, JSON.stringify(output, null, 2));
  assignmentArtifact = { path: path.relative(ROOT, assignmentFile), ...sha256File(assignmentFile), teamGames: allAssignments.length, starterEdges: observedAssignmentEdges };
} else if (fs.existsSync(assignmentFile)) fs.unlinkSync(assignmentFile);

const acceptance = {
  schemaVersion: GATE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  season,
  accepted,
  mode: hasHistoricalCache ? 'historical-local-roster-validated' : 'current-season-crosswalk-validated',
  acceptanceRule: 'Fail closed unless every expected regular-season/playoff NBA game maps exactly to one ESPN game, every ESPN team-game has exactly five distinct declared starters, every starter maps uniquely and confidently to an NBA player, all historical starters belong to the exact local NBA team-game roster, assignment counts reconcile exactly, and regular-season per-player start totals exactly equal NBA StarterBench=Starters.',
  implementation,
  sourceContract,
  sourceAssets,
  historyProvenance,
  officialStarterSplit: { path: path.relative(ROOT, splitExpectation.file), ...splitExpectation.fingerprint, source: splitExpectation.source },
  perPlayerStarts,
  expected: { teamGames: expectedAssignmentRows, starterEdges: expectedAssignmentEdges },
  observed: { teamGames: allAssignments.length, starterEdges: observedAssignmentEdges },
  phases: phaseResults,
  failures: failures.slice(0, 200),
  failureCount: failures.length,
  starterAssignments: assignmentArtifact,
};
fs.writeFileSync(acceptanceFile, JSON.stringify(acceptance, null, 2));
console.log(`per-player regular starts: ${perPlayerStarts.pass ? 'PASS' : 'FAIL'} · ${perPlayerStarts.mismatchCount} mismatches`);
console.log(`${accepted ? 'ACCEPTED' : 'REJECTED'} -> ${path.relative(ROOT, acceptanceFile)}`);
if (assignmentArtifact) console.log(`validated assignments -> ${assignmentArtifact.path}`);
if (!accepted) process.exitCode = 1;

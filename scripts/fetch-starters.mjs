// Resumable per-game starter crawl. Usage: node scripts/fetch-starters.mjs <season> [seasonType]
//
// Validity is decided per TEAM-GAME, never per season: exactly five non-empty START_POSITION
// entries = VALID, anything else = INVALID, no response = MISSING. Invalid team-games are never
// repaired and starters are never inferred from minutes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const season = process.argv[2];
const seasonType = process.argv[3] || 'Regular Season';
if (!season) { console.error('usage: fetch-starters.mjs <season> [seasonType]'); process.exit(1); }

const slug = seasonType === 'Playoffs' ? 'playoffs' : 'regular';
const CACHE = path.join(HIST, season, `starters_${slug}`);
const OUTFILE = path.join(HIST, season, `starters_${slug}.json`);
const STATE = path.join(HIST, season, `starters_${slug}_state.json`);
fs.mkdirSync(CACHE, { recursive: true });

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const ENDPOINT = 'https://stats.nba.com/stats/boxscoretraditionalv2';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const boxUrl = (g) => ENDPOINT + '?' + new URLSearchParams({
  GameID: g, StartPeriod: '0', EndPeriod: '10', StartRange: '0', EndRange: '28800', RangeType: '0' });

async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(url, { headers: H, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === 4) return { __err: e.message };
      await wait(2000 * (i + 1));   // exponential backoff
    }
  }
}

const logFile = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
if (!fs.existsSync(logFile)) { console.error('no game log for ' + season + ' ' + seasonType); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(logFile, 'utf8'));
const gameIds = [...new Set(rows.map((r) => r.gameId))].sort();

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
  : { done: [], failed: [], startedAt: new Date().toISOString() };
const doneSet = new Set(state.done);
const todo = gameIds.filter((g) => !doneSet.has(g));
console.log(`${season} ${seasonType}: ${gameIds.length} games, ${doneSet.size} cached, ${todo.length} to fetch`);

let n = 0;
for (const g of todo) {
  n++;
  const cached = path.join(CACHE, `${g}.json`);
  if (!fs.existsSync(cached)) {
    const j = await get(boxUrl(g));
    if (j.__err) {
      if (!state.failed.includes(g)) state.failed.push(g);
      if (n % 25 === 0) fs.writeFileSync(STATE, JSON.stringify(state));
      await wait(1200);
      continue;
    }
    fs.writeFileSync(cached, JSON.stringify(j));
    await wait(1150);
  }
  state.done.push(g);
  state.failed = state.failed.filter((x) => x !== g);
  if (n % 25 === 0) {
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`  ${n}/${todo.length} fetched (${state.failed.length} failed so far)`);
  }
}
fs.writeFileSync(STATE, JSON.stringify(state));

/* --------------------------------------------- normalise from the cache */
const out = [];
const teamGames = [];
for (const g of gameIds) {
  const f = path.join(CACHE, `${g}.json`);
  if (!fs.existsSync(f)) { teamGames.push({ gameId: g, team: null, status: 'MISSING', starterCount: null }); continue; }
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ps = j.resultSets?.find((x) => x.name === 'PlayerStats');
  if (!ps || !ps.rowSet.length) { teamGames.push({ gameId: g, team: null, status: 'MISSING', starterCount: null }); continue; }
  const i = Object.fromEntries(ps.headers.map((h, k) => [h, k]));
  const byTeam = new Map();
  for (const row of ps.rowSet) {
    const team = row[i.TEAM_ABBREVIATION];
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(row);
  }
  for (const [team, list] of byTeam) {
    const flagged = list.filter((r) => String(r[i.START_POSITION] ?? '').trim() !== '');
    const status = flagged.length === 5 ? 'VALID' : 'INVALID';
    teamGames.push({ gameId: g, team, teamId: list[0][i.TEAM_ID], status, starterCount: flagged.length });
    for (const r of list) {
      const pos = String(r[i.START_POSITION] ?? '').trim();
      out.push({
        season, seasonType, gameId: g,
        playerId: r[i.PLAYER_ID], teamId: r[i.TEAM_ID], team,
        // started is only true/false when the TEAM-GAME itself is valid.
        started: status === 'VALID' ? pos !== '' : null,
        startPosition: status === 'VALID' && pos !== '' ? pos : null,
        candidateFlagged: pos !== '',          // raw field, retained for the constraint work
        minutes: r[i.MIN] ?? null,
        comment: String(r[i.COMMENT] ?? '').trim() || null,
        starterSource: 'boxscoretraditionalv2/START_POSITION',
        starterSourceStatus: status,
        starterKnown: status === 'VALID',
      });
    }
  }
}
fs.writeFileSync(OUTFILE, JSON.stringify(out));

const valid = teamGames.filter((t) => t.status === 'VALID').length;
const invalid = teamGames.filter((t) => t.status === 'INVALID').length;
const missing = teamGames.filter((t) => t.status === 'MISSING').length;

// The fat normalized file is a build cache (regenerable from the raw responses, ~6.5 MB/season).
// What gets committed is this compact form: for each VALID team-game the five starter ids, and
// for each INVALID one its candidate set, which is all the reconstruction needs. ~50x smaller.
const COMPACT_DIR = path.join(HIST, 'starters');
fs.mkdirSync(COMPACT_DIR, { recursive: true });
const compact = { season, seasonType, source: 'boxscoretraditionalv2/START_POSITION', valid: {}, invalid: {} };
for (const r of out) {
  const k = `${r.gameId}|${r.teamId}`;
  if (r.starterSourceStatus === 'VALID') {
    if (r.started) (compact.valid[k] = compact.valid[k] || []).push(r.playerId);
  } else if (r.candidateFlagged) {
    (compact.invalid[k] = compact.invalid[k] || []).push(r.playerId);
  }
}
fs.writeFileSync(path.join(COMPACT_DIR, `${season}_${slug}.json`), JSON.stringify(compact));

const provPath = path.join(HIST, season, `starters_${slug}_provenance.json`);
const provenance = JSON.stringify({
  season, seasonType, endpoint: ENDPOINT, source: 'boxscoretraditionalv2/START_POSITION',
  fetchedAt: new Date().toISOString(),
  gamesRequested: gameIds.length, gamesCached: gameIds.filter((g) => fs.existsSync(path.join(CACHE, `${g}.json`))).length,
  failedGameIds: state.failed,
  teamGames: { valid, invalid, missing, total: teamGames.length },
  playerGameRows: out.length,
  sha256: crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16),
  invalidExamples: teamGames.filter((t) => t.status === 'INVALID').slice(0, 10),
}, null, 1);
fs.writeFileSync(provPath, provenance);
fs.writeFileSync(path.join(COMPACT_DIR, `${season}_${slug}_provenance.json`), provenance);

console.log(`\nteam-games: ${valid} VALID · ${invalid} INVALID · ${missing} MISSING (of ${teamGames.length})`);
console.log(`player-game rows: ${out.length}`);
console.log(`failed games: ${state.failed.length}`);
console.log(`-> ${path.relative(ROOT, OUTFILE)}`);

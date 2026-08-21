// Per-game starters for a recent season via boxscoretraditionalV3.
//
// WHY V3. boxscoretraditionalv2 returns HTTP 200 with ZERO PlayerStats rows for ~97% of 2025-26
// games — verified as non-transient (four consecutive attempts on one game, five of six on a spread
// sample). v3 returns a complete box for the same games. This is the same deprecation pattern that
// playbyplayv3 solved earlier in this project, and it is why "not in the repo" must never be treated
// as "unavailable" without testing the source.
//
// STARTER SEMANTICS. v3 marks starters with a non-empty `position` ("F"/"C"/"G"); bench players have
// an empty string. That is a DECLARED starter field, not an inference from minutes. Any team-game
// that does not yield exactly five declared starters is recorded as INVALID and excluded rather than
// being patched up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const season = process.argv[2];
const seasonType = process.argv[3] || 'Regular Season';
if (!season) { console.error('usage: fetch-starters-v3.mjs <season> [seasonType]'); process.exit(1); }
const slug = seasonType === 'Playoffs' ? 'playoffs' : 'regular';
const CACHE = path.join(HIST, season, `starters_${slug}_v3cache`);
const OUT = path.join(HIST, season, `starters_${slug}.json`);
fs.mkdirSync(CACHE, { recursive: true });

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (g) => `https://stats.nba.com/stats/boxscoretraditionalv3?GameID=${g}&StartPeriod=0&EndPeriod=10&StartRange=0&EndRange=0&RangeType=0`;

// Game universe from the season's own gamelog, so no game can be silently skipped.
const logFile = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
const games = [...new Set(log.map((r) => r.gameId))].sort();
console.log(`${season} ${seasonType}: ${games.length} games`);

async function fetchGame(g) {
  const cf = path.join(CACHE, `${g}.json`);
  if (fs.existsSync(cf)) { try { return JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { /* refetch */ } }
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(url(g), { headers: H, signal: c.signal });
      clearTimeout(t);
      if (!r.ok) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await r.json();
      if (!j.boxScoreTraditional) { await sleep(1500 * (attempt + 1)); continue; }
      fs.writeFileSync(cf, JSON.stringify(j.boxScoreTraditional));
      return j.boxScoreTraditional;
    } catch { clearTimeout(t); await sleep(1500 * (attempt + 1)); }
  }
  return null;
}

const rows = [];
let valid = 0, invalid = 0, failed = 0;
for (let i = 0; i < games.length; i++) {
  const g = games[i];
  const box = await fetchGame(g);
  if (!box) { failed++; continue; }
  for (const side of ['homeTeam', 'awayTeam']) {
    const tm = box[side];
    if (!tm) continue;
    const players = tm.players || [];
    const declared = players.filter((p) => p.position && String(p.position).trim());
    // Exactly five declared starters or the team-game does not count.
    if (declared.length !== 5) { invalid++; continue; }
    valid++;
    for (const p of players) {
      const isStarter = !!(p.position && String(p.position).trim());
      rows.push({
        season, seasonType, gameId: g,
        playerId: Number(p.personId), teamId: Number(tm.teamId), team: tm.teamTricode,
        started: isStarter, startPosition: isStarter ? String(p.position) : '',
        minutes: p.statistics?.minutes ?? null, comment: p.comment || null,
        starterSource: 'boxscoretraditionalv3/position', starterSourceStatus: 'VALID', starterKnown: true,
      });
    }
  }
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${games.length} · team-games valid ${valid} invalid ${invalid} · failed games ${failed}`);
  await sleep(250);
}
fs.writeFileSync(OUT, JSON.stringify(rows));
console.log(`\nteam-games: ${valid} VALID · ${invalid} INVALID · failed games ${failed}`);
console.log(`player-game rows: ${rows.length} · starters: ${rows.filter((r) => r.started).length}`);
console.log(`-> ${OUT}`);

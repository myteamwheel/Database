// CROSS-ENDPOINT RECONCILIATION of per-game starter flags against season starter/bench splits.
//
// This is NOT independent external validation. Both sides originate from stats.nba.com:
//   left  = boxscoretraditionalv2 / START_POSITION   (per game)
//   right = leaguedashplayerstats StarterBench=Starters / GP  (season total)
// A shared upstream error would agree with itself. What this test CAN establish is whether the
// per-game field, aggregated, is internally consistent with the season aggregate the same
// provider publishes — a strong falsifier, not a proof of truth.
//
// Nothing is normalized away. Exceptions are reported and counted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const season = process.argv[2] || '2023-24';
const seasonType = process.argv[3] || 'Regular Season';
const slug = seasonType === 'Playoffs' ? 'playoffs' : 'regular';

const startersFile = path.join(HIST, season, `starters_${slug}.json`);
const logFile = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
if (!fs.existsSync(startersFile)) { console.error('no starter crawl for ' + season + ' ' + seasonType); process.exit(1); }

const starters = JSON.parse(fs.readFileSync(startersFile, 'utf8'));
const gamelog = JSON.parse(fs.readFileSync(logFile, 'utf8'));
const prov = JSON.parse(fs.readFileSync(path.join(HIST, season, `starters_${slug}_provenance.json`), 'utf8'));

const bar = '='.repeat(78);
console.log(bar);
console.log(`CROSS-ENDPOINT RECONCILIATION — ${season} ${seasonType}`);
console.log(bar);

/* ---------------------------------------------------------- 1. crawl yield */
console.log('\n--- 1. crawl yield ---');
const tg = prov.teamGames;
console.log(`  games requested            ${prov.gamesRequested}`);
console.log(`  successful responses       ${prov.gamesCached}  (${prov.failedGameIds.length} failed after retries)`);
console.log(`  team-games VALID           ${tg.valid}  (${(100 * tg.valid / tg.total).toFixed(2)}%)`);
console.log(`  team-games INVALID         ${tg.invalid}  (${(100 * tg.invalid / tg.total).toFixed(2)}%)`);
console.log(`  team-games MISSING         ${tg.missing}`);
if (tg.invalid) {
  const byCount = {};
  for (const e of prov.invalidExamples) byCount[e.starterCount] = (byCount[e.starterCount] || 0) + 1;
  console.log(`  invalid examples (first 10 by flagged-starter count): ${JSON.stringify(byCount)}`);
}

/* --------------------------------------------------- 2. join onto game log */
console.log('\n--- 2. join onto historical player-game rows (by IDs) ---');
const key = (r) => `${r.gameId}|${r.playerId}|${r.teamId}`;
const startIdx = new Map();
const dupeStart = [];
for (const r of starters) {
  const k = key(r);
  if (startIdx.has(k)) dupeStart.push(k); else startIdx.set(k, r);
}
const logIdx = new Map();
const dupeLog = [];
for (const r of gamelog) {
  const k = key(r);
  if (logIdx.has(k)) dupeLog.push(k); else logIdx.set(k, r);
}
let matched = 0, logOnly = 0, startOnly = 0;
for (const k of logIdx.keys()) (startIdx.has(k) ? matched++ : logOnly++);
for (const k of startIdx.keys()) if (!logIdx.has(k)) startOnly++;
console.log(`  game-log rows              ${gamelog.length}  (${dupeLog.length} duplicate keys)`);
console.log(`  boxscore rows              ${starters.length}  (${dupeStart.length} duplicate keys)`);
console.log(`  matched on gameId|playerId|teamId   ${matched}  (${(100 * matched / logIdx.size).toFixed(2)}% of game log)`);
console.log(`  in game log, not in boxscore        ${logOnly}`);
console.log(`  in boxscore, not in game log        ${startOnly}   <- DNP rows; leaguegamelog omits non-players`);

// Conflict test: a matched pair must agree on the minutes both endpoints report.
let minConflict = 0;
const conflictEx = [];
for (const [k, s] of startIdx) {
  const g = logIdx.get(k);
  if (!g || s.minutes === null || g.min === null) continue;
  const sMin = typeof s.minutes === 'string' ? Number(s.minutes.split(':')[0]) + Number(s.minutes.split(':')[1] || 0) / 60 : s.minutes;
  if (Math.abs(sMin - g.min) > 1.0) { minConflict++; if (conflictEx.length < 3) conflictEx.push({ k, box: s.minutes, log: g.min }); }
}
console.log(`  matched pairs disagreeing on minutes by >1.0  ${minConflict}`);
if (conflictEx.length) console.log('    e.g. ' + JSON.stringify(conflictEx));

/* ------------------------------------------------------- 3. hard invariants */
console.log('\n--- 3. structural invariants (never silently corrected) ---');
const perTeamGame = new Map();
for (const r of starters) {
  if (r.starterSourceStatus !== 'VALID') continue;
  const k = `${r.gameId}|${r.teamId}`;
  perTeamGame.set(k, (perTeamGame.get(k) || 0) + (r.started ? 1 : 0));
}
const notFive = [...perTeamGame.entries()].filter(([, n]) => n !== 5);
console.log(`  VALID team-games where starters != 5   ${notFive.length}  (of ${perTeamGame.size})`);
if (notFive.length) console.log('    ' + JSON.stringify(notFive.slice(0, 5)));

/* --------------------------------------- 4. aggregate and reconcile vs splits */
console.log('\n--- 4. computed starts vs official season splits ---');
const splitsPath = path.join(HIST, season, 'starter_splits.json');
if (seasonType === 'Playoffs') {
  console.log('  SKIPPED. starter_splits.json was fetched with SeasonType="Regular Season",');
  console.log('  so it does not cover playoffs. Playoff starters are not reconciled against it.');
} else if (!fs.existsSync(splitsPath)) {
  console.log('  no starter_splits.json');
} else {
  const splits = JSON.parse(fs.readFileSync(splitsPath, 'utf8'));
  // TeamID=0 in the split fetch means these are PLAYER-SEASON totals across every team a
  // traded player suited up for — so computed starts must be summed across teams to match.
  const official = new Map(splits.starters.map((s) => [s.playerId, s.gp]));
  const benchGp = new Map(splits.bench.map((s) => [s.playerId, s.gp]));

  const computed = new Map();     // playerId -> {starts, appearances, unknownGames}
  for (const r of starters) {
    const c = computed.get(r.playerId) || { starts: 0, appearances: 0, unknown: 0 };
    // "Appearance" = played, not merely rostered. DNP rows carry null minutes / a comment.
    const played = r.minutes !== null && r.minutes !== '' && r.minutes !== undefined;
    if (played) c.appearances++;
    if (r.starterSourceStatus !== 'VALID') { if (played) c.unknown++; }
    else if (r.started) c.starts++;
    computed.set(r.playerId, c);
  }

  let exact = 0, mismatch = 0, missingOfficial = 0, maxDiff = 0;
  const diffs = [];
  for (const [pid, c] of computed) {
    if (!official.has(pid) && !benchGp.has(pid)) { missingOfficial++; continue; }
    const off = official.get(pid) || 0;   // absent from the Starters split = zero starts
    const d = c.starts - off;
    if (d === 0) exact++;
    else { mismatch++; diffs.push({ pid, computed: c.starts, official: off, d, unknown: c.unknown }); }
    if (Math.abs(d) > Math.abs(maxDiff)) maxDiff = d;
  }
  const n = exact + mismatch;
  console.log(`  players compared           ${n}`);
  console.log(`  exact matches              ${exact}  (${(100 * exact / n).toFixed(2)}%)`);
  console.log(`  mismatches                 ${mismatch}  (${(100 * mismatch / n).toFixed(2)}%)`);
  console.log(`  max signed discrepancy     ${maxDiff}`);
  console.log(`  in boxscores, absent from both splits   ${missingOfficial}`);

  if (diffs.length) {
    diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const explained = diffs.filter((x) => x.unknown > 0 && Math.abs(x.d) <= x.unknown).length;
    console.log(`  mismatches fully explainable by INVALID team-games      ${explained}`);
    console.log(`  mismatches NOT explainable by INVALID team-games        ${diffs.length - explained}`);
    console.log('  largest 8 mismatches (d = computed - official):');
    for (const x of diffs.slice(0, 8)) {
      console.log(`    player ${x.pid}  computed ${String(x.computed).padStart(3)}  official ${String(x.official).padStart(3)}  d=${String(x.d).padStart(4)}  unknownGames=${x.unknown}`);
    }
  }

  // startShareOfAppearances is the honest denominator: starts/appearances, NOT starts/teamGames.
  const shares = [...computed.values()].filter((c) => c.appearances >= 20)
    .map((c) => c.starts / c.appearances);
  shares.sort((a, b) => a - b);
  console.log(`  startShareOfAppearances (>=20 apps, n=${shares.length}): ` +
    `median ${shares[Math.floor(shares.length / 2)]?.toFixed(3)}, ` +
    `p10 ${shares[Math.floor(shares.length * 0.1)]?.toFixed(3)}, p90 ${shares[Math.floor(shares.length * 0.9)]?.toFixed(3)}`);

  const violates = [...computed.entries()].filter(([, c]) => c.starts > c.appearances);
  console.log(`  players with starts > appearances (must be 0)   ${violates.length}`);
}
console.log('\nTerminology: cross-endpoint reconciliation. Both sides are NBA-sourced.');

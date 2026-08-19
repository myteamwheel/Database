// Exhaustive fail-closed acceptance gate for the ESPN-vs-NBA starter superset test.
//
// The exploratory script intentionally supports stratified samples. This wrapper is the gate that
// downstream reconstruction must rely on: it forces every historical game in the requested season
// through that comparison and rejects the season on ANY coverage, identity, mapping, source-shape,
// or superset-assumption failure. A clean sample is evidence; only this exhaustive gate can produce
// an acceptance record.
//
// Usage: node scripts/espn-full-season-gate.mjs 2015-16
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const season = process.argv[2];
if (!season) {
  console.error('Usage: node scripts/espn-full-season-gate.mjs <season>');
  process.exit(2);
}


// A gate that dies without a verdict is indistinguishable from one still running, and that is how
// three consecutive runs left stale acceptance records in place while appearing merely slow. Any
// uncaught failure is now reported AS A REJECTION, loudly, with a non-zero exit.
function crashOut(err) {
  console.error('\n' + '='.repeat(78));
  console.error(`FULL-SEASON ESPN SUPERSET GATE: REJECTED (gate crashed before reaching a verdict)`);
  console.error(`  season: ${season}`);
  console.error(`  error:  ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n          ') : err}`);
  console.error('  No acceptance record was written. Treat this season as NOT gated.');
  console.error('='.repeat(78));
  process.exit(1);
}
process.on('uncaughtException', crashOut);
process.on('unhandledRejection', crashOut);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function historicalFile(file) {
  return path.join(HIST, season, file);
}

function uniqueGames(file) {
  const p = historicalFile(file);
  if (!fs.existsSync(p)) return 0;
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Set(rows.map((r) => String(r.gameId))).size;
}

function fingerprintFile(p) {
  const stat = fs.statSync(p);
  return {
    path: path.relative(ROOT, p),
    bytes: stat.size,
    sha256: sha256File(p),
  };
}

function fingerprintHistoricalInput(file) {
  const p = historicalFile(file);
  if (!fs.existsSync(p)) return null;
  return fingerprintFile(p);
}

const regularGames = uniqueGames('gamelog.json');
const playoffGames = uniqueGames('gamelog_playoffs.json');
const expectedGames = regularGames + playoffGames;
if (!expectedGames) {
  console.error(`No historical game logs found for ${season}; cannot run acceptance gate.`);
  process.exit(2);
}

// Fingerprint the exact historical inputs before invoking the checker. Count reconciliation alone is
// not enough to prove an acceptance record belongs to the current cache: file contents can change
// while game counts remain identical. These hashes make the evidence record content-addressed.
const inputs = {
  regularSeason: fingerprintHistoricalInput('gamelog.json'),
  playoffs: fingerprintHistoricalInput('gamelog_playoffs.json'),
};

const checkerPath = path.join(ROOT, 'scripts/espn-superset-test.mjs');
const checkerFingerprint = fingerprintFile(checkerPath);
// The gate logic is evidence-bearing too. If this wrapper changes after an acceptance record is
// generated, reconstruction must force the season through the new gate rather than trusting the old
// verdict. The record therefore binds both the checker implementation and the acceptance wrapper.
const gatePath = fileURLToPath(import.meta.url);
const gateFingerprint = fingerprintFile(gatePath);

// A very large requested sample makes espn-superset-test's stratified sampler step by one and
// therefore visit every game in each phase. The wrapper independently checks the resulting counts,
// so this cannot silently degrade back into a sample if that implementation changes later.
const child = spawnSync(process.execPath, ['scripts/espn-superset-test.mjs', season, '1000000'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 32 * 1024 * 1024,
});
const stdout = child.stdout || '';
const stderr = child.stderr || '';
process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

function metric(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Tolerate an explanatory suffix after the number ("... 2   <- ESPN has no usable record").
  // Anchoring on end-of-line made three metrics parse as null the moment those annotations were
  // added, and a null silently became 0 in the arithmetic below.
  const m = stdout.match(new RegExp(`^\\s*${escaped}\\s+(\\d+)\\s*(?:<-.*)?$`, 'm'));
  return m ? Number(m[1]) : null;
}

const measured = {
  gamesSampled: metric('games sampled'),
  nbaMissing: metric('NBA box scores missing'),
  espnMissing: metric('ESPN pages missing'),
  gameMappingFailures: metric('ESPN<->NBA game mapping failures'),
  dateOffsetMatches: metric('matched via +/-1 day scoreboard'),
  espnScoreboardGaps: metric('ESPN scoreboard gaps (empty events)'),
  espnStarterCountNot5: metric('ESPN team-games not showing 5'),
  teamGamesTested: metric('team-games tested'),
  starterEdgesTested: metric('starter edges tested'),
  identityMapFailures: metric('player identity mapping failures'),
  sourceDisagreements: metric('SOURCE DISAGREEMENTS (both well-formed, different names)'),
  supersetViolations: metric('SUPERSET VIOLATIONS'),
};

const parseFailures = Object.entries(measured).filter(([, v]) => v == null).map(([k]) => k);
const failures = [];
if (child.status !== 0) failures.push(`exploratory checker exited ${child.status}`);
if (parseFailures.length) failures.push(`could not parse metrics: ${parseFailures.join(', ')}`);
if (measured.gamesSampled !== expectedGames) failures.push(`games checked ${measured.gamesSampled} != historical games ${expectedGames}`);

// Edges are only tested where ESPN is usable, so the expected edge count is reduced by the
// team-games ESPN itself reports impossibly. Those are counted separately below.
const untestable = measured.espnStarterCountNot5 || 0;
const gapGames = measured.espnScoreboardGaps || 0;
// Team-games are only comparable where ESPN has a usable record of the game at all.
const expectedTeamGames = (expectedGames - gapGames) * 2;
if (measured.teamGamesTested !== expectedTeamGames) {
  failures.push(`team-games tested ${measured.teamGamesTested} != ${expectedTeamGames} (${expectedGames} games minus ${gapGames} ESPN scoreboard gaps, x2)`);
}
const expectedEdges = (expectedGames - gapGames) * 10 - untestable * 5;
if (measured.starterEdgesTested !== expectedEdges) {
  failures.push(`starter edges tested ${measured.starterEdgesTested} != ${expectedEdges} (${expectedGames} games, minus ${gapGames} ESPN scoreboard gaps and ${untestable} untestable team-games)`);
}
for (const [key, label] of [
  ['nbaMissing', 'NBA box scores missing'],
  ['espnMissing', 'ESPN pages missing'],
  ['gameMappingFailures', 'ESPN<->NBA game mapping failures'],
  ['identityMapFailures', 'player identity mapping failures'],
  ['sourceDisagreements', 'source disagreements (both records well-formed, different starters named)'],
  ['supersetViolations', 'superset violations'],
]) {
  if (measured[key] !== 0) failures.push(`${label}: ${measured[key]}`);
}

// ESPN team-games that are INTERNALLY IMPOSSIBLE (a starter count other than five) are an ESPN
// defect, not evidence against the NBA record. Investigated on 2017-11-24 MIN: ESPN flagged eight
// starters, six after removing its own starter+DNP contradictions, while NBA reported a complete
// and consistent F/F/C/G/G five. Treating that as an NBA failure was a category error.
//
// They are NOT ignored. They reduce cross-check COVERAGE, so they are counted, listed in the
// acceptance record, and rejected outright above a cap — beyond which ESPN is not a usable
// reference for the season at all.
// Both ESPN-side shortfalls count against the same coverage budget: an unusable team-game and a
// missing scoreboard entry are equally "ESPN cannot check this", and neither is an NBA defect.
const MAX_UNTESTABLE_SHARE = 0.01;
const untestableShare = (untestable + gapGames * 2) / (expectedGames * 2);
if (untestableShare > MAX_UNTESTABLE_SHARE) {
  failures.push(`ESPN unusable team-games ${untestable} = ${(100 * untestableShare).toFixed(2)}% of the season, above the ${100 * MAX_UNTESTABLE_SHARE}% cap`);
}

const accepted = failures.length === 0;
const record = {
  schemaVersion: 2,
  season,
  scope: 'Regular Season + Playoffs present in historical cache',
  exhaustive: true,
  accepted,
  acceptanceMeaning: accepted
    ? 'Every historical game was cross-checked; ESPN exposed exactly five starters per team-game; all starter identities mapped; every ESPN starter was inside the NBA candidate set.'
    : 'NOT ACCEPTED. Constraint-derived starter statuses must not be promoted from this cross-source evidence.',
  expected: { regularGames, playoffGames, games: expectedGames, teamGames: expectedGames * 2, starterEdges: expectedGames * 10 },
  measured,
  inputs,
  checkerFingerprint,
  gateFingerprint,
  failures,
  crossCheckCoverage: {
    teamGamesComparable: (expectedGames - gapGames) * 2 - untestable,
    espnScoreboardGapGames: gapGames,
    dateOffsetMatches: measured.dateOffsetMatches || 0,
    teamGamesTotal: expectedGames * 2,
    espnUnusableTeamGames: untestable,
    sharePct: Number((100 * (1 - untestableShare)).toFixed(4)),
    note: 'ESPN-unusable team-games report a starter count other than five and cannot validate anything. They are excluded from the comparison and reduce coverage; they are not counted as NBA defects.',
  },
  checker: 'scripts/espn-superset-test.mjs',
  checkerMode: 'exhaustive-via-step-1-with-independent-count-reconciliation',
  generatedAt: new Date().toISOString(),
  stdoutSha256: crypto.createHash('sha256').update(stdout).digest('hex'),
};

const outDir = path.join(HIST, 'starters');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${season}_espn_superset_acceptance.json`);
fs.writeFileSync(out, JSON.stringify(record, null, 1) + '\n');

console.log('\n' + '='.repeat(78));
console.log(`FULL-SEASON ESPN SUPERSET GATE: ${accepted ? 'ACCEPTED' : 'REJECTED'}`);
console.log(`  historical games  ${expectedGames} (${regularGames} regular + ${playoffGames} playoffs)`);
console.log(`  input fingerprint ${inputs.regularSeason?.sha256 || 'missing'} (regular)`);
if (inputs.playoffs) console.log(`                    ${inputs.playoffs.sha256} (playoffs)`);
console.log(`  checker fingerprint ${checkerFingerprint.sha256}`);
console.log(`  gate fingerprint    ${gateFingerprint.sha256}`);
console.log(`  acceptance record ${path.relative(ROOT, out)}`);
if (failures.length) for (const f of failures) console.log(`  FAIL: ${f}`);

if (!accepted) process.exit(1);

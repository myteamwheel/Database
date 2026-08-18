// Constrained reconstruction of per-game starters for seasons whose START_POSITION field is
// corrupted (2015-16, 2016-17 flag more than five players per team-game).
//
// Three modes:
//   node scripts/reconstruct-starters.mjs hypothesis <season>   testable necessary conditions
//   node scripts/reconstruct-starters.mjs validate <season> [k] degrade a CLEAN season, measure recovery
//   node scripts/reconstruct-starters.mjs solve <season>        classify and write reconstruction
//
// The validate mode tests solver soundness on known truth. The solve mode has an additional,
// non-negotiable gate: the ESPN superset assumption must have passed the exhaustive full-season
// acceptance gate for the exact historical cache currently on disk. A feasible max-flow solution
// alone is not evidence that the true starters were inside the corrupted NBA candidate sets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { solve } from './lib/bmatch.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const mode = process.argv[2] || 'hypothesis';
const season = process.argv[3] || '2015-16';

function load(season) {
  const f = path.join(HIST, season, 'starters_regular.json');
  if (!fs.existsSync(f)) { console.error(`no starter crawl for ${season}; run fetch-starters.mjs first`); process.exit(1); }
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  const splits = JSON.parse(fs.readFileSync(path.join(HIST, season, 'starter_splits.json'), 'utf8'));
  // TeamID=0 => player-season totals summed across every team a traded player played for.
  const officialStarts = new Map(splits.starters.map((s) => [s.playerId, s.gp]));
  return { rows, officialStarts, splits };
}

function uniqueHistoricalGames(season, file) {
  const f = path.join(HIST, season, file);
  if (!fs.existsSync(f)) return 0;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  return new Set(rows.map((r) => String(r.gameId))).size;
}

function fingerprintFile(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    path: path.relative(ROOT, file),
    bytes: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function sameFingerprint(recorded, current) {
  if (recorded === null || current === null) return recorded === current;
  return recorded && current && recorded.path === current.path && recorded.bytes === current.bytes && recorded.sha256 === current.sha256;
}

/**
 * Fail closed before any reconstruction is persisted.
 *
 * The acceptance record is deliberately checked again here instead of assuming callers ran the
 * gate. This closes the direct `node reconstruct-starters.mjs solve ...` bypass and rejects stale
 * evidence by both reconciled game counts and cryptographic fingerprints of the historical inputs,
 * cross-source checker, and exhaustive gate implementation.
 */
function requireAcceptedSupersetGate(season) {
  const f = path.join(HIST, 'starters', `${season}_espn_superset_acceptance.json`);
  const fail = (why) => {
    console.error(`\nREFUSING TO RECONSTRUCT ${season}: ${why}`);
    console.error(`Run: npm run gate:espn-starters -- ${season}`);
    console.error('Only an exhaustive, accepted cross-source record for the current historical cache may unlock solve mode.');
    process.exit(1);
  };
  if (!fs.existsSync(f)) fail('no exhaustive ESPN superset acceptance record exists');

  let a;
  try { a = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { fail('acceptance record is unreadable or invalid JSON'); }

  if (a.schemaVersion !== 2) fail(`unsupported acceptance schemaVersion ${String(a.schemaVersion)}; rerun the exhaustive gate`);
  if (a.season !== season) fail(`acceptance record season ${String(a.season)} does not match ${season}`);
  if (a.exhaustive !== true) fail('acceptance record is not exhaustive');
  if (a.accepted !== true) fail('exhaustive ESPN superset gate did not accept this season');
  if (!a.expected || !a.measured) fail('acceptance record is missing expected/measured reconciliation fields');
  if (!a.inputs || !a.checkerFingerprint || !a.gateFingerprint) fail('acceptance record is missing content fingerprints; rerun the exhaustive gate');

  const regularGames = uniqueHistoricalGames(season, 'gamelog.json');
  const playoffGames = uniqueHistoricalGames(season, 'gamelog_playoffs.json');
  const games = regularGames + playoffGames;
  const currentExpected = { regularGames, playoffGames, games, teamGames: games * 2, starterEdges: games * 10 };
  for (const [k, v] of Object.entries(currentExpected)) {
    if (a.expected[k] !== v) fail(`stale acceptance record: expected.${k}=${String(a.expected[k])}, current cache=${v}`);
  }

  const currentInputs = {
    regularSeason: fingerprintFile(path.join(HIST, season, 'gamelog.json')),
    playoffs: fingerprintFile(path.join(HIST, season, 'gamelog_playoffs.json')),
  };
  for (const key of ['regularSeason', 'playoffs']) {
    if (!sameFingerprint(a.inputs[key], currentInputs[key])) {
      fail(`stale acceptance record: ${key} historical-input fingerprint no longer matches current cache`);
    }
  }
  const currentChecker = fingerprintFile(path.join(ROOT, 'scripts/espn-superset-test.mjs'));
  if (!sameFingerprint(a.checkerFingerprint, currentChecker)) {
    fail('stale acceptance record: ESPN checker implementation has changed');
  }
  const currentGate = fingerprintFile(path.join(ROOT, 'scripts/espn-full-season-gate.mjs'));
  if (!sameFingerprint(a.gateFingerprint, currentGate)) {
    fail('stale acceptance record: exhaustive gate implementation has changed');
  }

  if (a.measured.gamesSampled !== games) fail(`acceptance measured ${String(a.measured.gamesSampled)} games, current cache has ${games}`);
  if (a.measured.teamGamesTested !== games * 2) fail(`acceptance measured ${String(a.measured.teamGamesTested)} team-games, expected ${games * 2}`);
  if (a.measured.starterEdgesTested !== games * 10) fail(`acceptance measured ${String(a.measured.starterEdgesTested)} starter edges, expected ${games * 10}`);
  for (const k of ['nbaMissing', 'espnMissing', 'gameMappingFailures', 'espnStarterCountNot5', 'identityMapFailures', 'supersetViolations']) {
    if (a.measured[k] !== 0) fail(`acceptance record contains nonzero ${k}: ${String(a.measured[k])}`);
  }
  if (Array.isArray(a.failures) && a.failures.length) fail(`acceptance record contains failures: ${a.failures.join('; ')}`);

  return a;
}

/** Group rows into team-games with their candidate sets (players carrying a START_POSITION). */
function candidateSets(rows, useCandidates = true) {
  const byTG = new Map();
  for (const r of rows) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!byTG.has(k)) byTG.set(k, { game: k, players: [], all: [] });
    const t = byTG.get(k);
    t.all.push(r);
    const flag = useCandidates ? r.candidateFlagged : r.started;
    if (flag) t.players.push(r.playerId);
  }
  return [...byTG.values()];
}

const pct = (a, b) => b ? (100 * a / b).toFixed(2) + '%' : 'n/a';

/**
 * Reconstruction metrics with explicit denominators. "Recovery" is ambiguous on its own — a system
 * that pins many bench statuses but few starters is not the same as one that pins 14% of everything.
 * `truth` maps game -> Set of true starter ids; omit it when there is no ground truth.
 */
function metrics(edges, truth = null) {
  const m = {
    candidateEdges: edges.length,
    forcedTrue: 0, forcedFalse: 0, ambiguous: 0,
    trueStarterEdges: 0, trueBenchEdges: 0,
    trueStarterForcedTrue: 0, trueBenchForcedFalse: 0,
    falseForcedTrue: 0, falseForcedFalse: 0,
    teamGamesFullyIdentified: 0, teamGamesPartial: 0, teamGamesFullyAmbiguous: 0,
  };
  const byGame = new Map();
  for (const e of edges) {
    if (e.status === 'FORCED_TRUE') m.forcedTrue++;
    else if (e.status === 'FORCED_FALSE') m.forcedFalse++;
    else m.ambiguous++;
    const g = byGame.get(e.game) || { n: 0, amb: 0, ft: 0 };
    g.n++;
    if (e.status === 'AMBIGUOUS') g.amb++;
    if (e.status === 'FORCED_TRUE') g.ft++;
    byGame.set(e.game, g);
    if (truth) {
      const isTrue = truth.get(e.game).has(e.playerId);
      if (isTrue) {
        m.trueStarterEdges++;
        if (e.status === 'FORCED_TRUE') m.trueStarterForcedTrue++;
        if (e.status === 'FORCED_FALSE') m.falseForcedFalse++;
      } else {
        m.trueBenchEdges++;
        if (e.status === 'FORCED_FALSE') m.trueBenchForcedFalse++;
        if (e.status === 'FORCED_TRUE') m.falseForcedTrue++;
      }
    }
  }
  for (const g of byGame.values()) {
    // "Fully identified" means every candidate in the team-game has a determined status, which is
    // exactly when all five starters are known AND every other candidate is excluded.
    if (g.amb === 0) m.teamGamesFullyIdentified++;
    else if (g.amb === g.n) m.teamGamesFullyAmbiguous++;
    else m.teamGamesPartial++;
  }
  m.teamGames = byGame.size;
  return m;
}

function printMetrics(m, indent = '  ') {
  const i = indent;
  console.log(`${i}candidate edges                                   ${m.candidateEdges}`);
  console.log(`${i}  FORCED_TRUE                                     ${m.forcedTrue}  ${pct(m.forcedTrue, m.candidateEdges)}`);
  console.log(`${i}  FORCED_FALSE                                    ${m.forcedFalse}  ${pct(m.forcedFalse, m.candidateEdges)}`);
  console.log(`${i}  AMBIGUOUS                                       ${m.ambiguous}  ${pct(m.ambiguous, m.candidateEdges)}`);
  console.log(`${i}identifiable share of all candidate edges         ${pct(m.forcedTrue + m.forcedFalse, m.candidateEdges)}`);
  if (m.trueStarterEdges) {
    console.log(`${i}true STARTER edges pinned FORCED_TRUE             ${m.trueStarterForcedTrue}/${m.trueStarterEdges}  ${pct(m.trueStarterForcedTrue, m.trueStarterEdges)}`);
    console.log(`${i}true BENCH edges pinned FORCED_FALSE              ${m.trueBenchForcedFalse}/${m.trueBenchEdges}  ${pct(m.trueBenchForcedFalse, m.trueBenchEdges)}`);
    console.log(`${i}false FORCED_TRUE  (asserted start, was bench)    ${m.falseForcedTrue}`);
    console.log(`${i}false FORCED_FALSE (asserted bench, was start)    ${m.falseForcedFalse}`);
  }
  console.log(`${i}team-games fully identified                       ${m.teamGamesFullyIdentified}/${m.teamGames}  ${pct(m.teamGamesFullyIdentified, m.teamGames)}`);
  console.log(`${i}team-games partially identified                   ${m.teamGamesPartial}  ${pct(m.teamGamesPartial, m.teamGames)}`);
  console.log(`${i}team-games completely ambiguous                   ${m.teamGamesFullyAmbiguous}  ${pct(m.teamGamesFullyAmbiguous, m.teamGames)}`);
}

/* ==================================================================== HYPOTHESIS */
if (mode === 'hypothesis') {
  const { rows, officialStarts } = load(season);
  const tgs = candidateSets(rows);
  console.log('='.repeat(78));
  console.log(`SUPERSET HYPOTHESIS — ${season}`);
  console.log('='.repeat(78));
  console.log('\nH: every true starter is among the flagged candidates in that team-game.');
  console.log('H cannot be proved directly without ground truth, but it makes falsifiable predictions.\n');

  const sizes = {};
  for (const t of tgs) sizes[t.players.length] = (sizes[t.players.length] || 0) + 1;
  console.log('--- candidate-set size distribution ---');
  for (const k of Object.keys(sizes).map(Number).sort((a, b) => a - b)) {
    console.log(`  ${String(k).padStart(3)} candidates  ${String(sizes[k]).padStart(5)} team-games  ${pct(sizes[k], tgs.length)}`);
  }
  const ns = tgs.map((t) => t.players.length).sort((a, b) => a - b);
  const q = (p) => ns[Math.min(ns.length - 1, Math.floor(p * ns.length))];
  console.log(`  min ${ns[0]} · p5 ${q(0.05)} · median ${q(0.5)} · mean ${(ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(2)}` +
    ` · p95 ${q(0.95)} · max ${ns[ns.length - 1]}`);
  console.log(`  => mean spurious candidates per team-game: +${(ns.reduce((a, b) => a + b, 0) / ns.length - 5).toFixed(2)}`);

  // Does the corruption vary by team? A uniform defect points at a league-wide feed problem;
  // a team-dependent one would mean the degradation experiment must be stratified by team.
  const byTeam = new Map();
  for (const t of tgs) {
    const tid = t.game.split('|')[1];
    if (!byTeam.has(tid)) byTeam.set(tid, []);
    byTeam.get(tid).push(t.players.length);
  }
  const teamMeans = [...byTeam.entries()].map(([tid, l]) => ({ tid, mean: l.reduce((a, b) => a + b, 0) / l.length }))
    .sort((a, b) => a.mean - b.mean);
  if (teamMeans.length) {
    console.log(`  by team: lowest mean ${teamMeans[0].mean.toFixed(2)} (team ${teamMeans[0].tid}), ` +
      `highest ${teamMeans[teamMeans.length - 1].mean.toFixed(2)} (team ${teamMeans[teamMeans.length - 1].tid}), ` +
      `spread ${(teamMeans[teamMeans.length - 1].mean - teamMeans[0].mean).toFixed(2)}`);
  }

  console.log('\n--- prediction 1: no team-game may have fewer than 5 candidates ---');
  const thin = tgs.filter((t) => t.players.length < 5);
  console.log(`  team-games with <5 candidates   ${thin.length}  ${pct(thin.length, tgs.length)}`);
  console.log(`  => H is ${thin.length ? 'FALSIFIED for those team-games' : 'not falsified by this test'}`);
  if (thin.length) console.log('     ' + JSON.stringify(thin.slice(0, 5).map((t) => ({ g: t.game, n: t.players.length }))));

  console.log('\n--- prediction 2: official season starts <= games flagged as a candidate ---');
  const appear = new Map();
  for (const t of tgs) for (const p of t.players) appear.set(p, (appear.get(p) || 0) + 1);
  const over = [];
  for (const [p, gp] of officialStarts) {
    const a = appear.get(p) || 0;
    if (gp > a) over.push({ p, officialStarts: gp, candidateGames: a, deficit: gp - a });
  }
  over.sort((a, b) => b.deficit - a.deficit);
  console.log(`  players whose official starts exceed their candidate games   ${over.length}`);
  console.log(`  => H is ${over.length ? 'FALSIFIED — those starts cannot be placed' : 'not falsified by this test'}`);
  if (over.length) for (const x of over.slice(0, 8)) console.log(`     player ${x.p}: ${x.officialStarts} starts but candidate in only ${x.candidateGames} games (deficit ${x.deficit})`);

  console.log('\n--- prediction 3: total starts must equal 5 x team-games ---');
  let supply = 0;
  for (const t of tgs) for (const p of new Set(t.players)) { /* count once */ }
  for (const [, gp] of officialStarts) supply += gp;
  const demand = 5 * tgs.length;
  console.log(`  sum(official starts)  ${supply}`);
  console.log(`  5 x team-games        ${demand}   (${tgs.length} team-games)`);
  console.log(`  difference            ${supply - demand}`);
  console.log(`  => ${supply === demand
    ? 'the Starters split is exactly aggregate-consistent with five starters per team-game'
    : 'MISMATCH — splits are incomplete or GP is not starts'}`);
  // What this does and does not establish. It strongly supports reading Starters GP as games
  // started and shows the split is complete in aggregate. It does NOT prove any individual
  // player total is correct — offsetting per-player errors would still sum correctly — and it
  // says nothing about whether the true starters lie inside the corrupted candidate sets.
  console.log('     (aggregate consistency; offsetting per-player errors would still sum correctly)');

  console.log('\n--- prediction 4: the constraint system admits a solution ---');
  const r = solve(tgs, officialStarts);
  console.log(`  max flow ${r.flow} of required ${r.demand}`);
  console.log(`  => system is ${r.feasible ? 'FEASIBLE; H survives every test available without ground truth' : 'INFEASIBLE; H is FALSIFIED'}`);
  if (!r.feasible) console.log(`     ${r.demand - r.flow} starts cannot be placed inside the candidate sets`);
}

/* ==================================================================== VALIDATE */
if (mode === 'validate') {
  const { rows, officialStarts } = load(season);
  const clean = candidateSets(rows, false).filter((t) => t.players.length === 5);
  console.log('='.repeat(78));
  console.log(`METHOD VALIDATION — degrade ${season} (known-clean), attempt recovery`);
  console.log('='.repeat(78));
  console.log(`\n${clean.length} team-games with exactly five known starters.`);
  console.log('Spurious candidates are drawn from players who actually appeared in that same');
  console.log('team-game, matching what the corruption looks like: bench players wrongly flagged.\n');

  // Deterministic PRNG so the reported numbers are reproducible.
  let seed = 20232024;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const byTG = new Map();
  for (const r of rows) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!byTG.has(k)) byTG.set(k, []);
    byTG.get(k).push(r);
  }

  // Official starts recomputed from the clean subset so the constraint is exactly consistent.
  const starts = new Map();
  for (const t of clean) for (const p of t.players) starts.set(p, (starts.get(p) || 0) + 1);

  /** Degrade every clean team-game by adding `pickExtra()` spurious candidates, then classify. */
  function trial(label, pickExtra) {
    const degraded = [], truth = new Map();
    for (const t of clean) {
      const truthSet = new Set(t.players);
      // Spurious candidates come only from players who genuinely appeared in that team-game.
      // Selection is uniform among them: minutes and performance are never consulted.
      const bench = (byTG.get(t.game) || [])
        .filter((r) => !truthSet.has(r.playerId) && r.minutes !== null && r.minutes !== '')
        .map((r) => r.playerId);
      const pool = bench.slice(), picked = [];
      const want = pickExtra();
      for (let i = 0; i < want && pool.length; i++) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      degraded.push({ game: t.game, players: [...t.players, ...picked] });
      truth.set(t.game, truthSet);
    }
    const r = solve(degraded, starts);
    console.log(`\n--- ${label} ---`);
    if (!r.feasible) { console.log(`  INFEASIBLE (flow ${r.flow}/${r.demand}) — degradation broke the constraints`); return; }
    const m = metrics(r.edges, truth);
    printMetrics(m);
    if (m.falseForcedTrue || m.falseForcedFalse) {
      console.log(`  !! UNSOUND: ${m.falseForcedTrue} false FORCED_TRUE, ${m.falseForcedFalse} false FORCED_FALSE`);
    }
  }

  // Controlled stress tests: a fixed number of spurious candidates per team-game.
  for (const extra of [1, 2, 3, 4]) trial(`controlled stress test: +${extra} spurious candidates per team-game`, () => extra);

  // Empirically matched: sample the extra-candidate count from a real corrupted season, so the
  // experiment resembles the data we actually have to reconstruct.
  const distArg = process.argv[4];
  if (distArg && fs.existsSync(path.join(HIST, 'starters', `${distArg}_regular.json`))) {
    const old = JSON.parse(fs.readFileSync(path.join(HIST, 'starters', `${distArg}_regular.json`), 'utf8'));
    const counts = Object.values(old.invalid).map((a) => a.length).filter((n) => n >= 5).map((n) => n - 5);
    if (counts.length) {
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      console.log(`\nEmpirical extra-candidate distribution from ${distArg}: n=${counts.length}, mean +${mean.toFixed(2)}`);
      trial(`EMPIRICALLY MATCHED to ${distArg} corruption`, () => counts[Math.floor(rnd() * counts.length)]);
    }
  } else {
    console.log('\n(Pass a corrupted season as the 4th argument once crawled, e.g. `validate 2023-24 2015-16`,');
    console.log(' to repeat the experiment with that season\'s real extra-candidate distribution.)');
  }
  console.log('\n  FORCED_* must NEVER contradict ground truth. Any nonzero WRONG column invalidates');
  console.log('  the method. A high AMBIGUOUS count is not an error — it is the honest answer.');
  console.log('\n  CAVEAT. Spurious candidates are drawn uniformly from players who appeared. If the real');
  console.log('  corruption is systematic instead (say, always the next men in the rotation), recovery');
  console.log('  on real data will differ from these numbers. Compare the real candidate-set size');
  console.log('  distribution from `hypothesis` mode against the row of this table with the same mean.');
}

/* ==================================================================== SOLVE */
if (mode === 'solve') {
  const acceptance = requireAcceptedSupersetGate(season);
  const { rows, officialStarts } = load(season);
  // Every team-game enters the system, VALID and INVALID alike. This handles partially corrupted
  // seasons without special-casing: a VALID team-game's candidate set is already exactly its five
  // starters, so those edges saturate and come back FORCED_TRUE, and they correctly consume the
  // season-start budget that the INVALID team-games must then fit around.
  const tgs = candidateSets(rows);
  console.log('='.repeat(78));
  console.log(`CONSTRAINED RECONSTRUCTION — ${season}`);
  console.log('='.repeat(78));
  console.log(`\n  exhaustive ESPN superset gate ACCEPTED (${acceptance.measured.gamesSampled} games / ${acceptance.measured.starterEdgesTested} starter edges)`);
  const r = solve(tgs, officialStarts);
  console.log(`\n  team-games        ${r.teamGames}`);
  console.log(`  players           ${r.players}`);
  console.log(`  candidate edges   ${r.candidateEdges}`);
  console.log(`  feasible          ${r.feasible}  (flow ${r.flow} / ${r.demand}, supply ${r.supply})`);
  if (!r.feasible) {
    console.log('\n  INFEASIBLE. No assignment satisfies both constraints, so the candidate sets or');
    console.log('  season splits disagree. Nothing is written even though the superset gate passed.');
    process.exit(1);
  }
  console.log('');
  printMetrics(metrics(r.edges));

  const out = r.edges.map((e) => ({
    season, seasonType: 'Regular Season',
    gameId: e.game.split('|')[0], teamId: Number(e.game.split('|')[1]), playerId: e.playerId,
    started: e.started,
    starterSourceStatus: e.status === 'AMBIGUOUS' ? 'AMBIGUOUS_OFFICIAL_CONSTRAINTS'
      : 'RECONSTRUCTED_EXACT_OFFICIAL_CONSTRAINTS',
  }));
  const f = path.join(HIST, season, 'starters_reconstructed.json');
  fs.writeFileSync(f, JSON.stringify(out));
  console.log(`\n  -> ${path.relative(ROOT, f)}`);
  console.log('  AMBIGUOUS rows carry started = null. They are not guessed.');
  console.log('  Rows for players who appeared but were NOT flagged as candidates are absent from');
  console.log('  this file entirely. Because solve mode is now reachable only after the exhaustive');
  console.log('  superset gate passes, downstream code may derive those non-candidates as bench only');
  console.log('  when it explicitly carries that accepted-gate provenance; this file does not do so.');
}

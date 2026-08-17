// Constrained reconstruction of per-game starters for seasons whose START_POSITION field is
// corrupted (2015-16, 2016-17 flag more than five players per team-game).
//
// Three modes:
//   node scripts/reconstruct-starters.mjs hypothesis <season>   testable necessary conditions
//   node scripts/reconstruct-starters.mjs validate <season> [k] degrade a CLEAN season, measure recovery
//   node scripts/reconstruct-starters.mjs solve <season>        classify and write reconstruction
//
// The validate mode is the gate. If reconstruction cannot recover a season we already know the
// answer for, its output on a season we do not know is worthless.
import fs from 'node:fs';
import path from 'node:path';
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
  console.log(`  => ${supply === demand ? 'identity holds; splits are complete and start-counting' : 'MISMATCH — splits are incomplete or GP is not starts'}`);

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

  console.log('  extra   candidate   FORCED_TRUE   of which   FORCED_FALSE   AMBIGUOUS   true starters');
  console.log('  /game   edges       correct       WRONG      correct        edges       recovered');
  for (const extra of [1, 2, 3, 4, 5]) {
    const degraded = [];
    const truth = new Map();
    for (const t of clean) {
      const all = byTG.get(t.game) || [];
      const truthSet = new Set(t.players);
      const bench = all.filter((r) => !truthSet.has(r.playerId) && r.minutes !== null && r.minutes !== '')
        .map((r) => r.playerId);
      // sample `extra` distinct bench players without replacement
      const picked = [];
      const pool = bench.slice();
      for (let i = 0; i < extra && pool.length; i++) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      degraded.push({ game: t.game, players: [...t.players, ...picked] });
      truth.set(t.game, truthSet);
    }
    // Official starts recomputed from the clean subset so the constraint is exactly consistent.
    const starts = new Map();
    for (const t of clean) for (const p of t.players) starts.set(p, (starts.get(p) || 0) + 1);

    const r = solve(degraded, starts);
    let ft = 0, ftWrong = 0, ff = 0, ffWrong = 0, amb = 0, recovered = 0;
    for (const e of r.edges) {
      const isTrue = truth.get(e.game).has(e.playerId);
      if (e.status === 'FORCED_TRUE') { ft++; if (!isTrue) ftWrong++; if (isTrue) recovered++; }
      else if (e.status === 'FORCED_FALSE') { ff++; if (isTrue) ffWrong++; }
      else amb++;
    }
    const totalTrue = clean.length * 5;
    console.log(`  ${String(extra).padStart(5)}   ${String(r.candidateEdges).padStart(9)}   ${String(ft).padStart(11)}   ${String(ftWrong).padStart(8)}   ${String(ff).padStart(12)}   ${String(amb).padStart(9)}   ${pct(recovered, totalTrue).padStart(7)}`);
    if (ftWrong || ffWrong) console.log(`        !! ${ftWrong} FORCED_TRUE and ${ffWrong} FORCED_FALSE contradict ground truth — the classifier is unsound`);
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
  const { rows, officialStarts } = load(season);
  // Every team-game enters the system, VALID and INVALID alike. This handles partially corrupted
  // seasons without special-casing: a VALID team-game's candidate set is already exactly its five
  // starters, so those edges saturate and come back FORCED_TRUE, and they correctly consume the
  // season-start budget that the INVALID team-games must then fit around.
  const tgs = candidateSets(rows);
  console.log('='.repeat(78));
  console.log(`CONSTRAINED RECONSTRUCTION — ${season}`);
  console.log('='.repeat(78));
  const r = solve(tgs, officialStarts);
  console.log(`\n  team-games        ${r.teamGames}`);
  console.log(`  players           ${r.players}`);
  console.log(`  candidate edges   ${r.candidateEdges}`);
  console.log(`  feasible          ${r.feasible}  (flow ${r.flow} / ${r.demand}, supply ${r.supply})`);
  if (!r.feasible) {
    console.log('\n  INFEASIBLE. No assignment satisfies both constraints, so the superset hypothesis');
    console.log('  is false or the season splits disagree with the box scores. Nothing is written.');
    process.exit(1);
  }
  const counts = { FORCED_TRUE: 0, FORCED_FALSE: 0, AMBIGUOUS: 0 };
  const byGame = new Map();
  for (const e of r.edges) {
    counts[e.status]++;
    const g = byGame.get(e.game) || { forcedTrue: 0, amb: 0 };
    if (e.status === 'FORCED_TRUE') g.forcedTrue++;
    if (e.status === 'AMBIGUOUS') g.amb++;
    byGame.set(e.game, g);
  }
  const fully = [...byGame.values()].filter((g) => g.amb === 0).length;
  console.log(`\n  FORCED_TRUE       ${counts.FORCED_TRUE}   ${pct(counts.FORCED_TRUE, r.candidateEdges)}`);
  console.log(`  FORCED_FALSE      ${counts.FORCED_FALSE}   ${pct(counts.FORCED_FALSE, r.candidateEdges)}`);
  console.log(`  AMBIGUOUS         ${counts.AMBIGUOUS}   ${pct(counts.AMBIGUOUS, r.candidateEdges)}`);
  console.log(`  uniquely identifiable edges   ${pct(counts.FORCED_TRUE + counts.FORCED_FALSE, r.candidateEdges)}`);
  console.log(`  fully identified team-games   ${fully} of ${byGame.size}  ${pct(fully, byGame.size)}`);

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
}

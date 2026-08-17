// Brute-force oracle test for the starter reconstruction classifier.
// Run: node tests/bmatch.oracle.test.mjs [instances]
//
// The classifier claims an EXACT identifiability answer via max-flow + one SCC pass. Hand-built
// examples test the intuition; this tests the implementation. Every instance here is small enough
// to enumerate the COMPLETE set of feasible assignments by brute force, which gives ground truth:
//
//   edge is 1 in every feasible solution   -> FORCED_TRUE
//   edge is 0 in every feasible solution   -> FORCED_FALSE
//   edge takes both values                 -> AMBIGUOUS
//
// Any disagreement between that and the SCC classifier is a bug that would fabricate history.
import { solve } from '../scripts/lib/bmatch.mjs';

// Deterministic by default so a future regression reproduces the exact failing instance.
// CI runs the default 3,000; the large stress audit is `node tests/bmatch.oracle.test.mjs 25000`.
// A different seed can be swept explicitly: `... 3000 <seed>`.
const N = Number(process.argv[2] || 3000);
const SEED = Number(process.argv[3] || 12345);
let seed = SEED;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** All k-subsets of arr. */
function subsets(arr, k) {
  const out = [];
  const rec = (i, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    if (i >= arr.length || arr.length - i < k - cur.length) return;
    cur.push(arr[i]); rec(i + 1, cur); cur.pop();
    rec(i + 1, cur);
  };
  rec(0, []);
  return out;
}

/** Exhaustively enumerate feasible assignments; returns per-edge {canBe0, canBe1} and a count. */
function oracle(teamGames, starts, perGame) {
  const choices = teamGames.map((t) => subsets(t.players, perGame));
  if (choices.some((c) => c.length === 0)) return { count: 0, edge: new Map() };
  const edge = new Map();
  for (const t of teamGames) for (const p of t.players) edge.set(`${p}@${t.game}`, { can0: false, can1: false });
  let count = 0;
  const totals = new Map();
  const rec = (g) => {
    if (g === teamGames.length) {
      for (const [p, need] of starts) if ((totals.get(p) || 0) !== need) return;
      for (const [p, got] of totals) if (!starts.has(p) && got > 0) return;
      count++;
      for (let i = 0; i < teamGames.length; i++) {
        const sel = new Set(cur[i]);
        for (const p of teamGames[i].players) {
          edge.get(`${p}@${teamGames[i].game}`)[sel.has(p) ? 'can1' : 'can0'] = true;
        }
      }
      return;
    }
    for (const pick of choices[g]) {
      // Prune: never exceed a player's required total. A candidate absent from `starts` is
      // capped at 0, matching how solve() treats a player with no official starts.
      let applied = 0, ok = true;
      for (const p of pick) {
        const v = (totals.get(p) || 0) + 1;
        if (v > (starts.get(p) || 0)) { ok = false; break; }
        totals.set(p, v); applied++;
      }
      if (ok) { cur[g] = pick; rec(g + 1); }
      for (let i = 0; i < applied; i++) totals.set(pick[i], totals.get(pick[i]) - 1);
    }
  };
  const cur = new Array(teamGames.length);
  rec(0);
  return { count, edge };
}

let checked = 0, disagreements = 0, feasibleN = 0, infeasibleN = 0;
const seen = { FORCED_TRUE: 0, FORCED_FALSE: 0, AMBIGUOUS: 0 };
const shapes = { unique: 0, ambiguous: 0, disconnected: 0, zeroStart: 0, allStart: 0 };

for (let iter = 0; iter < N; iter++) {
  const P = ri(3, 7), G = ri(2, 4), perGame = ri(1, Math.min(3, P - 1));
  const players = Array.from({ length: P }, (_, i) => i + 1);

  // Candidate sets: size between perGame and P, sometimes sparse (disconnected components),
  // sometimes dense (highly ambiguous).
  const dense = rnd() < 0.5;
  const teamGames = [];
  for (let g = 0; g < G; g++) {
    const size = dense ? ri(Math.min(P, perGame + 2), P) : ri(perGame, Math.min(P, perGame + 2));
    const pool = players.slice();
    const pick = [];
    for (let i = 0; i < size; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    teamGames.push({ game: `g${g}`, players: pick.sort((a, b) => a - b) });
  }

  // Build starts from a genuine random assignment so the instance is feasible by construction...
  const starts = new Map();
  for (const t of teamGames) {
    const pool = t.players.slice();
    for (let i = 0; i < perGame; i++) {
      const p = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      starts.set(p, (starts.get(p) || 0) + 1);
    }
  }
  // ...then sometimes deliberately break it, to confirm infeasibility is detected, not classified.
  let intendedInfeasible = false;
  if (rnd() < 0.2) {
    intendedInfeasible = true;
    const keys = [...starts.keys()];
    const victim = keys[Math.floor(rnd() * keys.length)];
    if (rnd() < 0.5) starts.set(victim, starts.get(victim) + 1);           // supply != demand
    else {
      // move a start to a player who is a candidate nowhere: supply == demand but unsatisfiable
      starts.set(victim, starts.get(victim) - 1);
      starts.set(999, (starts.get(999) || 0) + 1);
    }
  }

  const truth = oracle(teamGames, starts, perGame);
  const got = solve(teamGames, starts, perGame);

  if (truth.count === 0) {
    infeasibleN++;
    // The solver must refuse. It may only disagree by claiming feasibility.
    if (got.feasible) {
      disagreements++;
      console.log(`FAIL instance ${iter}: solver says feasible, brute force found no assignment`);
      console.log('  ' + JSON.stringify({ teamGames, starts: [...starts], perGame }));
    } else if (got.edges.some((e) => e.status !== 'INFEASIBLE')) {
      disagreements++;
      console.log(`FAIL instance ${iter}: infeasible instance produced classifications`);
    }
    continue;
  }

  feasibleN++;
  if (!got.feasible) {
    disagreements++;
    console.log(`FAIL instance ${iter}: solver says infeasible, brute force found ${truth.count} assignments`);
    console.log('  ' + JSON.stringify({ teamGames, starts: [...starts], perGame }));
    continue;
  }
  if (truth.count === 1) shapes.unique++; else shapes.ambiguous++;
  if (!dense) shapes.disconnected++;
  // A zero-start player is a CANDIDATE with no official starts — they are absent from `starts`
  // rather than present with value 0, which is what the earlier version of this counter looked for.
  if (teamGames.some((t) => t.players.some((p) => !starts.get(p)))) shapes.zeroStart++;
  for (const [p, n] of starts) if (n === teamGames.filter((t) => t.players.includes(p)).length && n > 0) { shapes.allStart++; break; }

  for (const e of got.edges) {
    const k = `${e.playerId}@${e.game}`;
    const o = truth.edge.get(k);
    const expected = o.can1 && o.can0 ? 'AMBIGUOUS' : o.can1 ? 'FORCED_TRUE' : 'FORCED_FALSE';
    checked++;
    seen[e.status] = (seen[e.status] || 0) + 1;
    if (e.status !== expected) {
      disagreements++;
      if (disagreements <= 5) {
        console.log(`FAIL instance ${iter} edge ${k}: classifier ${e.status}, oracle ${expected}`);
        console.log('  ' + JSON.stringify({ teamGames, starts: [...starts], perGame, solutions: truth.count }));
      }
    }
  }
}

console.log(`\nseed                 ${SEED}   (reproduce with: node tests/bmatch.oracle.test.mjs ${N} ${SEED})`);
console.log(`instances            ${N}  (${feasibleN} feasible, ${infeasibleN} infeasible)`);
console.log(`edges compared       ${checked}`);
console.log(`  FORCED_TRUE        ${seen.FORCED_TRUE}`);
console.log(`  FORCED_FALSE       ${seen.FORCED_FALSE}`);
console.log(`  AMBIGUOUS          ${seen.AMBIGUOUS}`);
console.log(`shape coverage       uniquely-solvable ${shapes.unique}, multi-solution ${shapes.ambiguous},`);
console.log(`                     sparse ${shapes.disconnected}, zero-start player ${shapes.zeroStart}, must-start-all ${shapes.allStart}`);
console.log(`\ndisagreements with brute force: ${disagreements}`);
process.exit(disagreements ? 1 : 0);

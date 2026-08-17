// Unit tests for the starter reconstruction classifier. Run: node tests/bmatch.test.mjs
//
// These cases are small enough to verify by hand, which matters: the classifier decides which
// historical starter values get written down as fact, so a silent bug here would fabricate data.
import { solve } from '../scripts/lib/bmatch.mjs';

let failures = 0;
function check(label, teamGames, startsObj, expect) {
  const r = solve(teamGames, new Map(Object.entries(startsObj).map(([k, v]) => [Number(k), v])));
  const got = {};
  for (const e of r.edges) got[`${e.playerId}@${e.game}`] = e.status;
  const problems = [];
  if (expect.feasible !== undefined && r.feasible !== expect.feasible) {
    problems.push(`feasible ${r.feasible}, expected ${expect.feasible}`);
  }
  for (const [k, v] of Object.entries(expect.edges || {})) {
    if (got[k] !== v) problems.push(`${k}: ${got[k]}, expected ${v}`);
  }
  if (problems.length) { failures++; console.log(`FAIL ${label}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok   ${label}`);
}

const two = (a, b) => [{ game: 'g1', players: a }, { game: 'g2', players: b }];
const F = 'FORCED_TRUE', N = 'FORCED_FALSE', A = 'AMBIGUOUS';

// Exactly five candidates per team-game: every assignment is forced.
check('exact candidate sets are fully determined',
  two([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 },
  { feasible: true, edges: { '1@g1': F, '5@g2': F } });

// A spurious candidate with zero official starts is excluded everywhere.
check('zero-start candidate is forced false',
  two([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 0 },
  { feasible: true, edges: { '6@g1': N, '6@g2': N, '1@g1': F } });

// Two players each starting once across two identical candidate sets: genuinely undecidable.
check('symmetric single starts are ambiguous, not guessed',
  two([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1 },
  { feasible: true, edges: { '5@g1': A, '6@g1': A, '5@g2': A, '6@g2': A, '1@g1': F } });

// Supply exceeding demand means the constraints contradict each other.
check('over-supplied system is infeasible',
  [{ game: 'g1', players: [1, 2, 3, 4, 5, 6] }], { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
  { feasible: false });

// Transitive inference: player 6 is a candidate only in g2, which pins their start there and
// forces player 5 out of g2. This is the chain that makes reconstruction worth doing.
check('a pinned start transitively forces another player out',
  two([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6]), { 1: 2, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1 },
  { feasible: true, edges: { '6@g2': F, '5@g2': N, '5@g1': F } });

console.log(failures ? `\n${failures} test(s) failed` : '\nall passed');
process.exit(failures ? 1 : 0);

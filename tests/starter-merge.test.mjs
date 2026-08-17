// Invariant tests for starter source precedence. Run: node tests/starter-merge.test.mjs
//
// The rule under test: the solver may fill only UNKNOWN rows and may NEVER overwrite a direct
// source. A regression here would silently replace observed data with derived data.
import { mergeStarter } from '../scripts/lib/starter-merge.mjs';

let fails = 0;
const row = (source, starter) => ({ starter, starterSource: source });
function check(label, base, incoming, expectAction, expectSource, expectStarter) {
  const r = mergeStarter(base, incoming);
  const bad = [];
  if (r.action !== expectAction) bad.push(`action ${r.action} != ${expectAction}`);
  if (r.row.starterSource !== expectSource) bad.push(`source ${r.row.starterSource} != ${expectSource}`);
  if (expectStarter !== undefined && r.row.starter !== expectStarter) bad.push(`starter ${r.row.starter} != ${expectStarter}`);
  if (bad.length) { fails++; console.log(`FAIL ${label}\n  ${bad.join('\n  ')}`); }
  else console.log(`ok   ${label}`);
}

const UNK = row('UNKNOWN', null);

check('solver fills an UNKNOWN row',
  UNK, row('RECONSTRUCTED_V1', true), 'filled', 'RECONSTRUCTED_V1', true);
check('solver fills a row with no base at all',
  null, row('RECONSTRUCTED_V1', false), 'filled', 'RECONSTRUCTED_V1', false);

// The critical invariant.
check('solver may NOT overwrite DIRECT_NBA (same value)',
  row('DIRECT_NBA', true), row('RECONSTRUCTED_V1', true), 'rejected', 'DIRECT_NBA', true);
check('solver may NOT overwrite DIRECT_NBA (contradicting value)',
  row('DIRECT_NBA', true), row('RECONSTRUCTED_V1', false), 'rejected', 'DIRECT_NBA', true);
check('solver may NOT overwrite DIRECT_ESPN',
  row('DIRECT_ESPN', false), row('RECONSTRUCTED_V1', true), 'rejected', 'DIRECT_ESPN', false);

check('UNKNOWN incoming never clears an established row',
  row('DIRECT_NBA', true), UNK, 'kept', 'DIRECT_NBA', true);
check('UNKNOWN incoming never clears a reconstructed row',
  row('RECONSTRUCTED_V1', true), UNK, 'kept', 'RECONSTRUCTED_V1', true);

check('a direct source DOES upgrade a reconstructed row',
  row('RECONSTRUCTED_V1', false), row('DIRECT_NBA', true), 'filled', 'DIRECT_NBA', true);

// Two direct sources that disagree must surface, not be resolved by precedence order.
check('DIRECT sources disagreeing raises a conflict rather than silently preferring NBA',
  row('DIRECT_NBA', true), row('DIRECT_ESPN', false), 'conflict', 'DIRECT_NBA', true);
check('DIRECT sources agreeing is a plain keep',
  row('DIRECT_NBA', true), row('DIRECT_ESPN', true), 'kept', 'DIRECT_NBA', true);

// Exhaustive sweep: no combination may ever let RECONSTRUCTED win over a direct source.
for (const direct of ['DIRECT_NBA', 'DIRECT_ESPN']) {
  for (const bv of [true, false]) {
    for (const iv of [true, false]) {
      const r = mergeStarter(row(direct, bv), row('RECONSTRUCTED_V1', iv));
      if (r.row.starterSource === 'RECONSTRUCTED_V1' || r.row.starter !== bv) {
        fails++;
        console.log(`FAIL sweep: ${direct}(${bv}) + RECONSTRUCTED(${iv}) -> ${r.row.starterSource}(${r.row.starter})`);
      }
    }
  }
}
console.log(fails ? '' : 'ok   exhaustive sweep: reconstruction never displaces a direct source');

console.log(fails ? `\n${fails} test(s) failed` : '\nall passed');
process.exit(fails ? 1 : 0);

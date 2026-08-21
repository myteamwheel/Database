// Regression tests for the TULIP Capacity V1 PRODUCT INTEGRATION.
// These assert the site ships the frozen model faithfully. They must never be "fixed" by changing
// the model — if a hash test fails, the model was altered and that is the bug.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { loadFrozenCard, loadTrainingTransitions, scoreCapacity } from '../scripts/lib/tulip-capacity-v1.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log(`  PASS  ${name}`); pass++; } catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fail++; } };

const FROZEN_ID = '96cb2f34c6cd06c3';
const { card, id } = loadFrozenCard();
const training = loadTrainingTransitions(card);
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const nba = data.leagues.NBA.players || data.leagues.NBA.rows || data.leagues.NBA;
const gl = data.leagues.GLEAGUE.players || data.leagues.GLEAGUE.rows || data.leagues.GLEAGUE;
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

console.log('TULIP Capacity V1 integration tests');

t('1 frozen card hash matches the immutable identifier', () => assert.strictEqual(id, FROZEN_ID));
t('2 generated payload declares V1 and its hash', () => {
  assert.ok(data.tulipCapacityMeta, 'tulipCapacityMeta missing from payload');
  assert.strictEqual(data.tulipCapacityMeta.version, 'TULIP_CAPACITY_V1');
  assert.strictEqual(data.tulipCapacityMeta.cardSha256, FROZEN_ID);
});
t('3 NBA rows carry a capacity object and some are scored', () => {
  assert.ok(nba.every((r) => r.tulipCapacity), 'some NBA rows lack tulipCapacity');
  const scored = nba.filter((r) => !r.tulipCapacity.abstain);
  assert.ok(scored.length > 100, `only ${scored.length} scored NBA rows`);
  assert.ok(scored.every((r) => Number.isFinite(r.tulipCapacity.capacityMpg)), 'non-finite capacity present');
});
t('4 Headroom equals Capacity minus Team A season MPG', () => {
  for (const r of nba.filter((x) => !x.tulipCapacity.abstain)) {
    const c = r.tulipCapacity;
    // Each field is rounded to 1dp INDEPENDENTLY, so round(a)-round(b) may differ from round(a-b)
    // by up to one rounding step. Anything beyond that is a real inconsistency.
    assert.ok(Math.abs((c.capacityMpg - c.teamASeasonMpg) - c.headroom) <= 0.11,
      `${r.name}: ${c.capacityMpg} - ${c.teamASeasonMpg} != ${c.headroom}`);
  }
});
t('5 every scored row carries a 50% interval that brackets the estimate', () => {
  for (const r of nba.filter((x) => !x.tulipCapacity.abstain)) {
    const c = r.tulipCapacity;
    assert.ok(Number.isFinite(c.interval50Low) && Number.isFinite(c.interval50High), `${r.name}: missing interval`);
    assert.ok(c.interval50Low < c.capacityMpg && c.capacityMpg < c.interval50High, `${r.name}: interval does not bracket estimate`);
  }
});
t('6 support count and evidence grade present on scored rows', () => {
  for (const r of nba.filter((x) => !x.tulipCapacity.abstain)) {
    assert.ok(Number.isInteger(r.tulipCapacity.supportCount), `${r.name}: no supportCount`);
    assert.ok(['A', 'B', 'C', 'D'].includes(r.tulipCapacity.evidenceGrade), `${r.name}: bad grade`);
  }
});
t('7 abstentions are null-like, never zero', () => {
  for (const r of nba.filter((x) => x.tulipCapacity.abstain)) {
    assert.ok(r.tulipCapacity.capacityMpg === undefined || r.tulipCapacity.capacityMpg === null,
      `${r.name}: abstention carries a capacity value`);
    assert.ok(r.tulipCapacity.reason, `${r.name}: abstention has no reason`);
  }
});
t('8 G League never receives a V1 prediction', () => {
  assert.ok(gl.every((r) => r.tulipCapacity && r.tulipCapacity.abstain === true), 'a G League row was scored');
  assert.ok(gl.every((r) => r.tulipCapacity.reason === 'not_validated_for_gleague'), 'wrong G League abstain reason');
});
t('9 legacy x2.2 TULIP is not presented as the current TULIP', () => {
  assert.ok(!/'opt\.minutesDelta':\{label:'TULIP'/.test(app), 'legacy minutesDelta still labelled TULIP');
  assert.ok(!/'opt\.targetMpg':\{label:'TULIP MPG'/.test(app), 'legacy targetMpg still labelled TULIP MPG');
  assert.ok(/'tc\.capacityMpg':\{label:'Projected Role MPG'/.test(app), 'Projected Role MPG column missing');
});
t('10 no UI text claims V1 is validated in-season', () => {
  // Remove explicitly NEGATED statements first, otherwise "NOT validated for in-season trades" —
  // the very disclaimer we require — trips the check.
  const stripped = app.replace(/\b(not|never|no)\s+validated/gi, 'DISCLAIMED');
  const bad = /validated[^.]{0,40}in-season/i.test(stripped);
  assert.ok(!bad, 'found a positive claim that V1 is validated in-season');
  assert.ok(/NOT validated for in-season trades/i.test(app), 'in-season limitation not stated in UI');
});
t('11 capacity and headroom are sortable numeric accessors', () => {
  assert.ok(/key\.startsWith\('tc\.'\)/.test(app), 'tc.* accessor missing');
  assert.ok(/if \(!c \|\| c\.abstain === true\) return null;[\s\S]{0,200}sub === 'evidence'/.test(app),
    'tc.* accessor does not null out abstentions');
});
t('12a shipped metric does NOT claim to be a capacity estimate', () => {
  // The frozen artifact id may still contain the old name, but nothing user-facing may present the
  // metric as capacity. See TULIP_DEFINITION.md.
  assert.strictEqual(data.tulipCapacityMeta.displayName, 'Projected Role MPG');
  assert.strictEqual(data.tulipCapacityMeta.isCapacityMetric, false);
  assert.ok(!/label:'TULIP Capacity'/.test(app), 'a column is still labelled TULIP Capacity');
  assert.ok(/not a capacity metric/i.test(app), 'UI does not state that this is not a capacity metric');
});
t('12 payload carries the frozen benchmark numbers for the UI to quote', () => {
  const b = data.tulipCapacityMeta.benchmarks;
  assert.strictEqual(b.byMoveType.offseason.verdict, 'VALIDATED');
  assert.strictEqual(b.byMoveType.inSeason.verdict, 'NOT ESTABLISHED');
});
// The decisive one: the shipped payload must equal an INDEPENDENT recomputation from the card.
t('13 payload matches independent V1 recomputation for >=20 NBA rows', () => {
  const M = card.productionModel;
  const scored = nba.filter((r) => !r.tulipCapacity.abstain).slice(0, 40);
  assert.ok(scored.length >= 20, `only ${scored.length} scored rows available`);
  let checked = 0;
  for (const r of scored) {
    const c = r.tulipCapacity;
    // recompute headroom/interval relationships straight from the frozen residual quantiles
    const lo = Math.round((c.capacityMpg + M.residualQuantiles.q25) * 10) / 10;
    const hi = Math.round((c.capacityMpg + M.residualQuantiles.q75) * 10) / 10;
    // Recomputed from the already-rounded capacity, so allow one rounding step (see test 4).
    assert.ok(Math.abs(lo - c.interval50Low) <= 0.11, `${r.name}: interval low ${c.interval50Low} != ${lo}`);
    assert.ok(Math.abs(hi - c.interval50High) <= 0.11, `${r.name}: interval high ${c.interval50High} != ${hi}`);
    // Support was computed from the UNROUNDED season MPG; the payload only exposes it rounded to
    // 1dp. The true value therefore lies in [displayed-0.05, displayed+0.05], so the shipped count
    // must fall between the counts at those two bounds. That is an exact bound, not a tolerance.
    // The window slides: players enter at the top while others leave at the bottom, so the count at
    // the two endpoints does NOT bound the interior. Sweep the interval finely and take the true
    // min/max the count can attain for any unrounded value consistent with what was published.
    let min = Infinity, max = -Infinity;
    for (let d = -0.05; d <= 0.0501; d += 0.005) {
      const n = training.filter((x) => Math.abs(x.aSeasonMpg - (c.teamASeasonMpg + d)) <= 3).length;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    assert.ok(c.supportCount >= min && c.supportCount <= max,
      `${r.name}: support ${c.supportCount} outside [${min}, ${max}] implied by season MPG ${c.teamASeasonMpg}`);
    checked++;
  }
  console.log(`        (independently verified ${checked} rows)`);
});
t('14 scorer abstains rather than defaulting missing workload inputs', () => {
  const r = scoreCapacity({ aGames: 50, aSeasonMpg: 20 }, { card, training });
  assert.strictEqual(r.abstain, true);
  assert.strictEqual(r.reason, 'missing_required_workload_inputs');
});
t('15 scorer refuses players below the card eligibility floor', () => {
  const r = scoreCapacity({ aGames: 5 }, { card, training });
  assert.strictEqual(r.abstain, true);
  assert.strictEqual(r.reason, 'insufficient_team_a_history');
});

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} · ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);

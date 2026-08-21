// Engineering validation for TULIP Beta. Correctness of the shipped artifact, not model validity.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const nba = D.leagues.NBA, gl = D.leagues.GLEAGUE;
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n} — ${e.message}`); fail++; } };
console.log('TULIP Beta engineering validation');

t('1 every eligible team ledger conserves (sum of deltas ~ 0)', () => {
  const byTeam = {};
  for (const p of nba) if (p.tulipBeta && !p.tulipBeta.abstain) (byTeam[p.team] = byTeam[p.team] || []).push(p);
  let worst = 0, worstT = null;
  for (const [team, arr] of Object.entries(byTeam)) {
    const s = arr.reduce((a, p) => a + p.tulipBeta.tulip, 0);
    if (Math.abs(s) > worst) { worst = Math.abs(s); worstT = team; }
  }
  // each delta is rounded to 0.1 independently, so a roster of ~16 can drift up to ~0.8
  assert.ok(worst <= 0.8, `worst imbalance ${worst.toFixed(2)} MPG on ${worstT}`);
  console.log(`        (worst team imbalance ${worst.toFixed(2)} MPG across ${Object.keys(byTeam).length} teams — rounding only)`);
});
t('2 sign is consistent with the underlying value signal', () => {
  let bad = 0;
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain || c.tulip === 0) continue;
    if (Math.sign(c.tulip) !== Math.sign(c.valueGapSd)) bad++;
  }
  assert.strictEqual(bad, 0, `${bad} players whose TULIP sign contradicts their value gap`);
});
t('3 Recommended = Current + TULIP within rounding', () => {
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain) continue;
    assert.ok(Math.abs((c.currentMpg + c.tulip) - c.recommendedMpg) <= 0.11,
      `${p.name}: ${c.currentMpg} + ${c.tulip} != ${c.recommendedMpg}`);
  }
});
t('4 no NaN, and abstentions carry no numeric value', () => {
  for (const p of [...nba, ...gl]) {
    const c = p.tulipBeta; if (!c) continue;
    if (c.abstain) { assert.ok(c.tulip === undefined, `${p.name}: abstention carries a value`); assert.ok(c.reason, `${p.name}: no reason`); }
    else for (const k of ['tulip', 'currentMpg', 'recommendedMpg', 'valueGapSd', 'supportedCeiling'])
      assert.ok(Number.isFinite(c[k]), `${p.name}: ${k} not finite`);
  }
});
t('5 confidence populated on every scored row', () => {
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain) continue;
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(c.confidence), `${p.name}: bad confidence ${c.confidence}`);
  }
});
t('6 role evidence actually constrains expansion', () => {
  const pos = nba.filter((p) => p.tulipBeta && !p.tulipBeta.abstain && p.tulipBeta.tulip > 0);
  const factors = [...new Set(pos.map((p) => p.tulipBeta.evidenceFactor))];
  assert.ok(factors.length > 1, 'evidence factor never varies — it is not constraining anything');
  assert.ok(factors.some((f) => f < 1), 'no positive recommendation was ever attenuated');
  const attenuated = pos.filter((p) => p.tulipBeta.evidenceFactor < 1).length;
  console.log(`        (${attenuated}/${pos.length} positive recommendations attenuated by role evidence)`);
});
t('7 recommendation never exceeds the supported ceiling', () => {
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain) continue;
    assert.ok(c.recommendedMpg <= c.supportedCeiling + 0.11, `${p.name}: ${c.recommendedMpg} > ceiling ${c.supportedCeiling}`);
  }
});
t('8 NBA coverage is substantial', () => {
  const sc = nba.filter((p) => p.tulipBeta && !p.tulipBeta.abstain).length;
  assert.ok(sc > 400, `only ${sc} scored`);
  console.log(`        (${sc} of ${nba.length} NBA rows scored)`);
});
t('9 G League abstains — never improvised', () => {
  assert.ok(gl.every((p) => p.tulipBeta && p.tulipBeta.abstain === true), 'a G League row was scored');
  assert.ok(gl.every((p) => p.tulipBeta.reason === 'not_supported_for_gleague'), 'wrong G League reason');
});
t('10 payload declares experimental status and the non-validation', () => {
  const m = D.tulipBetaMeta;
  assert.strictEqual(m.status, 'EXPERIMENTAL BETA');
  assert.ok(/did NOT establish/i.test(m.notValidated), 'non-validation not stated');
  assert.ok(/zero-sum|conserve/i.test(m.zeroSum), 'zero-sum not stated');
});
t('11 UI exposes TULIP columns and states beta status', () => {
  assert.ok(/'tb\.tulip':\{label:'TULIP'/.test(app), 'TULIP column missing');
  assert.ok(/'tb\.recommendedMpg':\{label:'Recommended MPG'/.test(app), 'Recommended MPG missing');
  assert.ok(/'tb\.confidence':\{label:'Confidence'/.test(app), 'Confidence missing');
  assert.ok(/EXPERIMENTAL BETA|experimental beta/i.test(app), 'beta status absent from UI');
  assert.ok(/did not establish that the exact MPG deltas maximize wins/i.test(app), 'non-validation absent from UI');
});
t('12 TULIP Beta is not called Capacity, and Projected Role MPG survives separately', () => {
  assert.ok(!/label:'TULIP Capacity'/.test(app), 'TULIP Capacity label present');
  assert.ok(/label:'Projected Role MPG'/.test(app), 'Projected Role MPG was removed');
});
t('13 abstentions null out in the accessor so they sort last', () => {
  assert.ok(/key\.startsWith\('tb\.'\)/.test(app), 'tb.* accessor missing');
  assert.ok(/const c = p\.tulipBeta;[\s\S]{0,160}return null;/.test(app), 'accessor does not null abstentions');
});
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} · ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);

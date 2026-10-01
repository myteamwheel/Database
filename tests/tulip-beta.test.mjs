// Engineering validation for TULIP Beta. Correctness of the shipped artifact, not model validity.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { tulipBetaForTeam, BETA_CONFIG } from '../scripts/lib/tulip-beta.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const nba = D.leagues.NBA, gl = D.leagues.GLEAGUE;
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n} — ${e.message}`); fail++; } };
console.log('TULIP Beta engineering validation');

t('1 every eligible team ledger conserves (sum of deltas ~ 0)', () => {
  const byTeam = {};
  for (const p of nba) if (p.tulipBeta && !p.tulipBeta.abstain) (byTeam[p.currentTeam] = byTeam[p.currentTeam] || []).push(p);
  let worst = 0, worstT = null;
  for (const [team, arr] of Object.entries(byTeam)) {
    const s = arr.reduce((a, p) => a + p.tulipBeta.tulip, 0);
    if (Math.abs(s) > worst) { worst = Math.abs(s); worstT = team; }
  }
  assert.ok(worst <= 0.01, `worst imbalance ${worst.toFixed(2)} MPG on ${worstT}`);
  console.log(`        (worst team imbalance ${worst.toFixed(2)} MPG across ${Object.keys(byTeam).length} teams)`);
});
t('2 sign is consistent with the underlying value signal', () => {
  let bad = 0;
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain || c.tulip === 0) continue;
    if (Math.sign(c.tulip) !== Math.sign(c.valueGapSd)) bad++;
  }
  assert.strictEqual(bad, 0, `${bad} players whose TULIP sign contradicts their value gap`);
});
t('3 Recommended = Baseline + TULIP within rounding', () => {
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
t('7 recommendations stay feasible; extrapolation beyond direct workload evidence is disclosed', () => {
  let extrapolated = 0;
  for (const p of nba) {
    const c = p.tulipBeta; if (!c || c.abstain) continue;
    assert.ok(c.recommendedMpg >= -0.11 && c.recommendedMpg <= 40.11,
      `${p.name}: infeasible recommendation ${c.recommendedMpg} MPG`);
    if (c.recommendedMpg > c.supportedCeiling + 0.11) {
      extrapolated++;
      assert.notStrictEqual(c.confidence, 'HIGH',
        `${p.name}: extrapolated above evidence-supported workload but still marked HIGH support`);
    }
  }
  console.log(`        (${extrapolated} recommendations extrapolate beyond directly supported workload)`);
});
t('8 NBA coverage is substantial', () => {
  const sc = nba.filter((p) => p.tulipBeta && !p.tulipBeta.abstain).length;
  assert.ok(sc > 250, `only ${sc} current-roster players scored`);
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
  assert.ok(/'tb\.confidence':\{label:'Support'/.test(app), 'Support column missing');
  assert.ok(/NOT PROBABILITY OF CORRECTNESS/.test(app), 'support-vs-probability distinction absent');
  assert.ok(/TULIP Beta recommends/.test(app), 'detail does not frame the number as a recommendation');
  assert.ok(/EXPERIMENTAL BETA|experimental beta/i.test(app), 'beta status absent from UI');
  assert.ok(/did not establish that either the play-more\/play-less direction or the exact MPG deltas improve winning/i.test(app)
    || /neither the play-more\/play-less direction nor the exact magnitude has been validated/i.test(app),
    'direction-and-magnitude non-validation absent from UI');
});
t('12 TULIP Beta is not called Capacity, and Projected Role MPG survives separately', () => {
  assert.ok(!/label:'TULIP Capacity'/.test(app), 'TULIP Capacity label present');
  assert.ok(/label:'Projected Role MPG'/.test(app), 'Projected Role MPG was removed');
});
t('13 abstentions null out in the accessor so they sort last', () => {
  assert.ok(/key\.startsWith\('tb\.'\)/.test(app), 'tb.* accessor missing');
  assert.ok(/const c = p\.tulipBeta;[\s\S]{0,160}return null;/.test(app), 'accessor does not null abstentions');
});
t('14 current TULIP has no arbitrary +/-8 MPG delta cap', () => {
  assert.strictEqual(BETA_CONFIG.floorMpg, 0);
  assert.ok(BETA_CONFIG.ceilingHardCap >= 40);
  assert.ok(BETA_CONFIG.minutesPerSd >= 9);

  // Synthetic current roster: one elite low-minute player has both workload support and enough
  // minutes available from teammates. This must be able to move by >8 MPG.
  const mk = (id, bpm, mpg) => ({
    playerId: String(id), appeared: true, bpm, mpg, minutes: 1000,
    history: [['2025-26', 'Regular Season', [], 60, Math.max(mpg, id === 1 ? 35 : mpg)]],
    tulip: {
      frontier: [{ mpg: 40, abstain: false }],
      card: { evidenceTier: { tier: 'A' }, projection: { counterfactualSupport: { status: 'OK' } } },
      roleScaleResponse: { response: 'SUPPORTED' },
    },
  });
  const roster = [mk(1, 10, 5), mk(2, -2, 20), mk(3, -2, 20), mk(4, -2, 20), mk(5, -2, 20)];
  const out = tulipBetaForTeam(roster, { leagueBpm: 0, leagueGapSd: 1 });
  const delta = out.get('1')?.tulip;
  assert.ok(Number.isFinite(delta) && delta > 8, `synthetic supported expansion only moved ${delta} MPG`);
});
t('15 scored NBA rows belong to the current roster/team scope', () => {
  for (const p of nba) {
    if (!p.tulipBeta || p.tulipBeta.abstain) continue;
    assert.ok(p.currentRoster && p.currentTeam, `${p.name}: scored without current roster team`);
  }
});

t('16 real current-roster recommendations are not trapped inside +/-8 MPG', () => {
  const deltas = nba.filter((p) => p.tulipBeta && !p.tulipBeta.abstain && Number.isFinite(p.tulipBeta.tulip))
    .map((p) => Number(p.tulipBeta.tulip));
  assert.ok(deltas.length > 200, `only ${deltas.length} scored current-roster deltas`);
  const min = Math.min(...deltas), max = Math.max(...deltas);
  console.log(`        real current-roster TULIP range: ${min.toFixed(1)} to +${max.toFixed(1)} MPG`);
  assert.ok(Math.max(Math.abs(min), Math.abs(max)) > 8,
    `generated recommendations are still effectively trapped inside +/-8 MPG: ${min} to ${max}`);
});

t('17 expansion beyond observed workload is marked LOW support, not hidden as confidence', () => {
  const mk = (id, bpm, mpg, tier = 'A') => ({
    playerId: String(id), appeared: true, bpm, mpg, minutes: 1000,
    history: [['2025-26', 'Regular Season', [], 60, mpg]],
    tulip: { frontier: [], card: { evidenceTier: { tier }, projection: { counterfactualSupport: { status: 'OK' } } },
      roleScaleResponse: { response: 'SUPPORTED' } },
  });
  const rows = [mk(11, 12, 10), mk(12, -2, 18), mk(13, -2, 18), mk(14, -2, 18), mk(15, -2, 18)];
  const out = tulipBetaForTeam(rows, { leagueBpm: 0, leagueGapSd: 1 });
  const star = out.get('11');
  assert.ok(star.recommendedMpg > star.supportedCeiling, 'scenario did not exercise extrapolation');
  assert.strictEqual(star.confidence, 'LOW', 'unsupported expansion should be disclosed as low support');
});

t('18 overlapping evidence weaknesses are not multiplied into duplicate penalties', () => {
  const mk = (id, bpm, mpg, weakest = false) => ({
    playerId: String(id), appeared: true, bpm, mpg, minutes: 1000,
    history: [['2025-26', 'Regular Season', [], 60, Math.max(mpg, id === 21 ? 35 : mpg)]],
    tulip: { frontier: [{ mpg: 40, abstain: false }], card: { evidenceTier: { tier: 'A' },
      projection: { counterfactualSupport: { status: weakest ? 'INSUFFICIENT' : 'OK' } } },
      roleScaleResponse: { response: weakest ? 'INSUFFICIENT_HISTORY' : 'SUPPORTED' } },
  });
  const rows = [mk(21, 10, 5, true), mk(22, -2, 20), mk(23, -2, 20), mk(24, -2, 20), mk(25, -2, 20)];
  const out = tulipBetaForTeam(rows, { leagueBpm: 0, leagueGapSd: 1 });
  assert.ok(Math.abs(out.get('21').extrapolationFactor - 0.7) < 0.001,
    'the unsupported portion should receive one attenuation');
  assert.ok(out.get('21').evidenceFactor > 0.7 && out.get('21').evidenceFactor < 1,
    'the already-supported portion should remain unattenuated');
});

// ---- team-ledger regression: a future UI change must not silently break zero-sum conservation ----
console.log('\nTULIP Beta team-ledger regression');
const t2 = (n, fn) => { try { fn(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n} — ${e.message}`); fail++; } };
const byTeam = {};
for (const p of nba) if (p.tulipBeta && !p.tulipBeta.abstain) (byTeam[p.currentTeam] = byTeam[p.currentTeam] || []).push(p);

t2('T1 every team ledger sums to zero within rounding', () => {
  for (const [team, arr] of Object.entries(byTeam)) {
    const s = arr.reduce((a, p) => a + p.tulipBeta.tulip, 0);
    // each delta rounds to 0.1 independently; a roster of n can drift at most n*0.05
    const tol = Math.max(0.11, arr.length * 0.05);
    assert.ok(Math.abs(s) <= tol, `${team}: net ${s.toFixed(2)} exceeds rounding tolerance ${tol.toFixed(2)}`);
  }
});
t2('T2 minutes gained equals minutes surrendered per team', () => {
  for (const [team, arr] of Object.entries(byTeam)) {
    const g = arr.filter((p) => p.tulipBeta.tulip > 0).reduce((a, p) => a + p.tulipBeta.tulip, 0);
    const s = arr.filter((p) => p.tulipBeta.tulip < 0).reduce((a, p) => a - p.tulipBeta.tulip, 0);
    const tol = Math.max(0.11, arr.length * 0.05);
    assert.ok(Math.abs(g - s) <= tol, `${team}: gained ${g.toFixed(2)} vs surrendered ${s.toFixed(2)}`);
  }
});
t2('T3 team recommended total equals team baseline total', () => {
  for (const [team, arr] of Object.entries(byTeam)) {
    const cur = arr.reduce((a, p) => a + p.tulipBeta.currentMpg, 0);
    const rec = arr.reduce((a, p) => a + p.tulipBeta.recommendedMpg, 0);
    const tol = Math.max(0.11, arr.length * 0.05);
    assert.ok(Math.abs(rec - cur) <= tol, `${team}: current ${cur.toFixed(1)} vs recommended ${rec.toFixed(1)}`);
  }
});
t2('T4 every team has both sides of the ledger or neither', () => {
  for (const [team, arr] of Object.entries(byTeam)) {
    const g = arr.filter((p) => p.tulipBeta.tulip > 0).length;
    const s = arr.filter((p) => p.tulipBeta.tulip < 0).length;
    assert.ok((g > 0 && s > 0) || (g === 0 && s === 0), `${team}: ${g} gaining, ${s} surrendering — one-sided ledger`);
  }
});
t2('T5 team allocation view exists and states the non-validation', () => {
  assert.ok(/function openTeamAllocation/.test(app), 'openTeamAllocation missing');
  assert.ok(/MINUTES GAINED/.test(app) && /MINUTES SURRENDERED/.test(app), 'gained/surrendered ledger missing');
  assert.ok(/neither its play-more\/play-less direction nor its exact MPG magnitude has been validated as win-maximizing/i.test(app),
    'team-level direction-and-magnitude non-validation wording missing');
  assert.ok(!/optimal rotation|proven best allocation|expected wins added/i.test(app), 'forbidden overclaiming language present');
  assert.ok(/View \$\{esc\(p\.currentTeam/.test(app), 'per-player current-team allocation link missing');
});
t2('T6 no G League team appears in the allocation view data', () => {
  const glTeams = new Set(gl.filter((p) => p.tulipBeta && !p.tulipBeta.abstain).map((p) => p.team));
  assert.strictEqual(glTeams.size, 0, `G League teams with TULIP: ${[...glTeams].join(', ')}`);
});
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} · ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);

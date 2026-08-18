// TULIP verification. Every number here comes from ONE build of public/data.json, because the
// last report mixed a reason breakdown from a pre-fix run with a total from a post-fix run and
// produced 121 reasons for 163 abstentions. Assertions fail the script rather than printing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TULIP_CONFIG } from './lib/tulip.mjs';
import { tulipDiagnostics } from './lib/tulip-diagnostics.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const WEIGHTS = d.analysis.similarityWeights;
const fails = [];

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

console.log('='.repeat(78));
console.log('TULIP VERIFICATION  ·  build ' + (d.provenance?.buildCommit || '?') + '  ·  ' + d.generatedAt);
console.log('='.repeat(78));

// The same diagnostics are persisted into tulipMeta at build time. Recompute them here and fail if
// the published metadata/UI ever drifts from the executable model.
const liveDiagnostics = tulipDiagnostics(d.leagues.NBA, TULIP_CONFIG);
const metaDiagnostics = d.tulipMeta?.validationSnapshot;
const near = (a, b, eps = 1e-12) => (a === null && b === null) || (fin(a) && fin(b) && Math.abs(Number(a) - Number(b)) <= eps);
if (!metaDiagnostics) fails.push('tulipMeta.validationSnapshot is missing');
else {
  const liveB = liveDiagnostics.balance.starterContext, metaB = metaDiagnostics.balance?.starterContext || {};
  if (!near(liveB.pooledSmd, metaB.pooledSmd) || !near(liveB.worstBandSmd, metaB.worstBandSmd) || liveB.worstBand !== metaB.worstBand) {
    fails.push('persisted starter-context diagnostics do not match recomputation');
  }
  for (const [k, v] of Object.entries(liveDiagnostics.outcomeSensitivity.vsNetRtg)) {
    if (!near(v, metaDiagnostics.outcomeSensitivity?.vsNetRtg?.[k])) fails.push(`persisted outcome sensitivity mismatch for ${k}`);
  }
  for (const [k, v] of Object.entries(liveDiagnostics.outcomeSensitivity.top20Overlap)) {
    if (v !== metaDiagnostics.outcomeSensitivity?.top20Overlap?.[k]) fails.push(`persisted top-20 overlap mismatch for ${k}`);
  }
}
console.log('\n--- 0. build-metadata reconciliation ---');
console.log(metaDiagnostics ? '  validationSnapshot present; recomputed values checked against artifact' : '  MISSING validationSnapshot');

/* ------------------------------------------- 1. abstention reconciliation */
console.log('\n--- 1. abstention reconciliation (must sum exactly) ---');
const REASON_RULES = [
  ['already in a large role', /Already plays/],
  ['target too close to current role', /only .* minutes above/],
  ['too few comparables', /comparable players have played/],
  ['support below threshold', /Support .* below/],
  ['insufficient counterfactual support', /do not cover this candidate/],
];
for (const lg of ['NBA', 'GLEAGUE']) {
  const cards = d.leagues[lg].filter((p) => p.appeared && p.tulip);
  const abst = cards.filter((p) => p.tulip.card.abstain);
  const buckets = {}; let unclassified = 0;
  for (const p of abst) {
    const r = p.tulip.card.reason || '';
    const hit = REASON_RULES.find(([, re]) => re.test(r));
    if (hit) buckets[hit[0]] = (buckets[hit[0]] || 0) + 1; else unclassified++;
  }
  const sum = Object.values(buckets).reduce((a, v) => a + v, 0) + unclassified;
  console.log(`  ${lg}: ${cards.length} cards · ${abst.length} abstained (${(100 * abst.length / cards.length).toFixed(1)}%) · ${cards.length - abst.length} estimated`);
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(34)}${v}`);
  if (unclassified) console.log(`     ${'UNCLASSIFIED'.padEnd(34)}${unclassified}`);
  console.log(`     ${'sum'.padEnd(34)}${sum}  ${sum === abst.length ? 'reconciles' : 'MISMATCH'}`);
  if (sum !== abst.length) fails.push(`${lg}: abstention reasons sum to ${sum}, abstentions are ${abst.length}`);
  if (unclassified) fails.push(`${lg}: ${unclassified} abstentions have an unclassified reason`);
}

/* ------------------------------------- 2/5. covariate balance, per band */
console.log('\n--- 2/5. covariate balance, overall and per target band ---');
const bal = liveDiagnostics.balance;
console.log(`  overall — candidates matched: before ${bal.candidatesMatched.before}, after ${bal.candidatesMatched.after}`);
console.log('  covariate         before    after   change');
for (const k of Object.keys(bal.overallSmd)) {
  const b = bal.beforeSmd[k], a = bal.overallSmd[k];
  if (!fin(b) || !fin(a)) continue;
  const flag = Math.abs(a) < 0.1 ? '' : Math.abs(a) < 0.25 ? '  (residual)' : '  IMBALANCED';
  console.log(`  ${k.padEnd(16)}${Number(b).toFixed(3).padStart(7)}${Number(a).toFixed(3).padStart(9)}` +
    `${(Math.abs(a) - Math.abs(b) <= 0 ? '  better' : '  worse').padStart(9)}${flag}`);
}
console.log('\n  per target band (after fix) — pooled balance can hide target-band imbalance');
console.log('  band        n   rateGrade  starterShare   usage    age  teamQuality');
for (const r of bal.bands) {
  const g = (k) => (!fin(r.smds[k]) ? '   n/a' : Number(r.smds[k]).toFixed(3).padStart(6));
  console.log(`  ${String(r.band).padEnd(7)} ${String(r.n).padStart(4)}` +
    `   ${g('rateGrade')}      ${g('starterShare')}  ${g('usage')} ${g('age')}   ${g('teamQuality')}`);
}
console.log(`  worst starter-context band: ${bal.starterContext.worstBand || 'n/a'} · ` +
  `${fin(bal.starterContext.worstBandSmd) ? Number(bal.starterContext.worstBandSmd).toFixed(3) : 'n/a'}`);

/* ------------------------------- 4. target-variable sensitivity */
console.log('\n--- 4. does the expansion ranking survive changing the outcome target? ---');
const sens = liveDiagnostics.outcomeSensitivity;
for (const [k, rho] of Object.entries(sens.vsNetRtg)) {
  console.log(`  ${k.padEnd(16)} vs netRtg  rho=${fin(rho) ? Number(rho).toFixed(3) : 'n/a'}  top-20 overlap ${sens.top20Overlap[k] ?? 'n/a'}/20`);
}
if (sens.spearmanRange.every(fin)) {
  console.log(`  Spearman range vs netRtg: ${Number(sens.spearmanRange[0]).toFixed(3)}–${Number(sens.spearmanRange[1]).toFixed(3)}`);
}
console.log('  Interpretation: robustness to alternative correlated outcome definitions; not predictive validation and not causal identification.');

/* --------------------------------------- 7. 3dp precision audit */
console.log('\n--- 7. 3-decimal payload audit ---');
const prev = process.argv[2];
if (prev && fs.existsSync(prev)) {
  const o = JSON.parse(fs.readFileSync(prev, 'utf8'));
  let maxDelta = 0, changedFields = 0, compared = 0, maxField = '';
  for (const lg of ['NBA', 'GLEAGUE']) {
    const om = new Map(o.leagues[lg].map((p) => [p.playerId, p]));
    for (const p of d.leagues[lg]) {
      const q = om.get(p.playerId); if (!q) continue;
      for (const [k, v] of Object.entries(p.stats || {})) {
        const w = q.stats?.[k];
        if (typeof v !== 'number' || typeof w !== 'number') continue;
        compared++;
        const dd = Math.abs(v - w);
        if (dd > 0) { changedFields++; if (dd > maxDelta) { maxDelta = dd; maxField = `${lg}/${p.name}/${k}`; } }
      }
    }
  }
  console.log(`  numeric stat fields compared: ${compared.toLocaleString()} · changed: ${changedFields.toLocaleString()}`);
  console.log(`  maximum absolute change: ${maxDelta} (${maxField})`);
  for (const lg of ['NBA', 'GLEAGUE']) {
    const om = new Map(o.leagues[lg].map((p) => [p.playerId, p]));
    const gradeMoves = d.leagues[lg].filter((p) => om.has(p.playerId)
      && fin(p.grade) && fin(om.get(p.playerId).grade) && Math.abs(p.grade - om.get(p.playerId).grade) > 1e-9).length;
    const rankMoves = d.leagues[lg].filter((p) => om.has(p.playerId) && p.rank !== om.get(p.playerId).rank).length;
    const verdictMoves = d.leagues[lg].filter((p) => {
      const q = om.get(p.playerId); if (!q) return false;
      return (p.tulip?.card?.rotation?.verdict || null) !== (q.tulip?.card?.rotation?.verdict || null);
    }).length;
    console.log(`  ${lg}: grades changed ${gradeMoves} · ranks changed ${rankMoves} · TULIP verdicts changed ${verdictMoves}`);
  }
} else {
  console.log('  (pass a previous data.json as argv[2] to run the before/after comparison)');
}

console.log('\n--- failures ---');
fails.length ? fails.forEach((f) => console.log('  X ' + f)) : console.log('  none');
process.exit(fails.length ? 1 : 0);

// TULIP verification. Every number here comes from ONE build of public/data.json, because the
// last report mixed a reason breakdown from a pre-fix run with a total from a post-fix run and
// produced 121 reasons for 163 abstentions. Assertions fail the script rather than printing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRole, rotationDelta, TULIP_CONFIG, starterShare } from './lib/tulip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const WEIGHTS = d.analysis.similarityWeights;
const fails = [];

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : 0; };
const smd = (a, b) => {
  const A = a.filter(fin), B = b.filter(fin);
  if (A.length < 3 || B.length < 3) return null;
  const p = Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2);
  return p ? (mean(A) - mean(B)) / p : 0;
};
const spearman = (a, b) => {
  const ids = [...a.keys()].filter((k) => b.has(k));
  if (ids.length < 5) return { rho: null, n: ids.length };
  const rk = (m) => { const s = ids.slice().sort((x, y) => m.get(y) - m.get(x)); const r = new Map();
    s.forEach((id, i) => r.set(id, i + 1)); return r; };
  const ra = rk(a), rb = rk(b), n = ids.length;
  return { rho: 1 - (6 * ids.reduce((s, id) => s + (ra.get(id) - rb.get(id)) ** 2, 0)) / (n * (n * n - 1)), n };
};

console.log('='.repeat(78));
console.log('TULIP VERIFICATION  ·  build ' + (d.provenance?.buildCommit || '?') + '  ·  ' + d.generatedAt);
console.log('='.repeat(78));

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
const pool = d.leagues.NBA.filter((p) => p.appeared && p.skillProfile);
const rosters = {};
for (const p of pool) (rosters[p.team] = rosters[p.team] || []).push(p);
const teamNet = {};
for (const [t, r] of Object.entries(rosters)) {
  const w = r.filter((x) => fin(x.netRtg) && fin(x.minutes));
  const tot = w.reduce((a, x) => a + x.minutes, 0);
  teamNet[t] = tot ? w.reduce((a, x) => a + x.netRtg * x.minutes, 0) / tot : 0;
}
const COV = {
  rateGrade: (p) => p.rateGrade, mpg: (p) => p.mpg, gp: (p) => p.gp, minutes: (p) => p.minutes,
  usage: (p) => p.usg, age: (p) => p.ageOpeningNight ?? p.age, heightIn: (p) => p.heightInches,
  starterShare: (p) => starterShare(p), teamQuality: (p) => teamNet[p.team],
  selfCreation: (p) => p.skillProfile?.selfCreation, rimProtection: (p) => p.skillProfile?.rimProtection,
};
/** Rebuild the comparable set exactly as projectRole does, for a given config. */
function comparablesFor(c, target, cfg) {
  return pool.filter((q) => q.playerId !== c.playerId
    && Math.abs(q.mpg - target) <= cfg.bandHalfWidth
    && (q.minutes || 0) >= cfg.minMinutes
    && (!fin(c.rateGrade) || !fin(q.rateGrade) || Math.abs(q.rateGrade - c.rateGrade) <= cfg.qualityBand)
    && (() => { const a = starterShare(c), b = starterShare(q);
        return !fin(a) || !fin(b) || Math.abs(a - b) <= (cfg.starterShareBand ?? 1e9); })());
}
function balance(cfg, bandFilter) {
  const acc = Object.fromEntries(Object.keys(COV).map((k) => [k, { c: [], m: [] }]));
  let n = 0;
  for (const c of pool) {
    if (!fin(c.mpg) || c.mpg > cfg.maxCurrentMpgForExpansion || (c.minutes || 0) < 200) continue;
    const target = Math.min(34, Math.round(c.mpg) + 8);
    if (bandFilter && !bandFilter(target)) continue;
    const comps = comparablesFor(c, target, cfg);
    if (comps.length < cfg.minComparables) continue;
    n++;
    for (const [k, f] of Object.entries(COV)) {
      const cv = f(c); if (fin(cv)) acc[k].c.push(Number(cv));
      for (const q of comps) { const qv = f(q); if (fin(qv)) acc[k].m.push(Number(qv)); }
    }
  }
  return { n, smds: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, smd(v.c, v.m)])) };
}
const NO_STARTER = { ...TULIP_CONFIG, starterShareBand: 1e9 };
const before = balance(NO_STARTER), after = balance(TULIP_CONFIG);
console.log(`  overall — candidates matched: before ${before.n}, after ${after.n}`);
console.log('  covariate         before    after   change');
for (const k of Object.keys(COV)) {
  const b = before.smds[k], a = after.smds[k];
  if (b === null || a === null) continue;
  const flag = Math.abs(a) < 0.1 ? '' : Math.abs(a) < 0.25 ? '  (residual)' : '  IMBALANCED';
  console.log(`  ${k.padEnd(16)}${b.toFixed(3).padStart(7)}${a.toFixed(3).padStart(9)}` +
    `${(Math.abs(a) - Math.abs(b) <= 0 ? '  better' : '  worse').padStart(9)}${flag}`);
}
console.log('\n  per target band (after fix) — a model can balance overall and fail at 28-32 mpg');
console.log('  band        n   rateGrade  starterShare   usage    age  teamQuality');
for (const [lo, hi] of [[14, 20], [20, 24], [24, 28], [28, 32], [32, 40]]) {
  const r = balance(TULIP_CONFIG, (t) => t >= lo && t < hi);
  if (!r.n) continue;
  const g = (k) => (r.smds[k] === null ? '   n/a' : r.smds[k].toFixed(3).padStart(6));
  console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(3)} ${String(r.n).padStart(4)}` +
    `   ${g('rateGrade')}      ${g('starterShare')}  ${g('usage')} ${g('age')}   ${g('teamQuality')}`);
}

/* ------------------------------- 4. target-variable sensitivity */
console.log('\n--- 4. does the expansion ranking survive changing the outcome target? ---');
/**
 * The default target is on-court NetRtg, which is noisy and lineup-dependent. These alternatives
 * are built from more individual inputs. If the same players are candidates under all of them,
 * the ranking is not an artefact of NetRtg; if not, that is a limitation worth stating.
 */
const TARGETS = {
  netRtg: (p) => p.netRtg,
  pie: (p) => (fin(p.pie) ? p.pie * 100 : null),
  // Rate-production composite from independent grade components, deliberately excluding the
  // impact component because that CONTAINS netRtg and would make the comparison circular.
  rateComposite: (p) => {
    const c = p.components || {};
    const parts = ['scoring', 'playmaking', 'rebounding', 'defense', 'efficiency']
      .map((k) => c[k]).filter(fin);
    return parts.length >= 4 ? mean(parts) : null;
  },
  rateGrade: (p) => p.rateGrade,
};
function rankUnder(targetFn) {
  const out = new Map();
  for (const c of pool) {
    if (!fin(c.mpg) || c.mpg > TULIP_CONFIG.maxCurrentMpgForExpansion || (c.minutes || 0) < 200) continue;
    const target = Math.min(34, Math.round(c.mpg) + 8);
    const comps = comparablesFor(c, target, TULIP_CONFIG);
    if (comps.length < TULIP_CONFIG.minComparables) continue;
    const vals = comps.map(targetFn).filter(fin);
    if (vals.length < TULIP_CONFIG.minComparables) continue;
    // Same league-referenced idea: projection minus a median rotation reference on this target.
    const ref = pool.filter((q) => (q.mpg || 0) >= 10 && (q.minutes || 0) >= TULIP_CONFIG.displacedMinMinutes)
      .map(targetFn).filter(fin).sort((a, b) => a - b);
    const med = ref.length ? ref[Math.floor(ref.length / 2)] : 0;
    out.set(c.playerId, mean(vals) - med);
  }
  return out;
}
const ranks = Object.fromEntries(Object.entries(TARGETS).map(([k, f]) => [k, rankUnder(f)]));
const keys = Object.keys(TARGETS);
console.log('  Spearman between expansion rankings under different targets:');
console.log('               ' + keys.map((k) => k.slice(0, 8).padStart(10)).join(''));
for (const a of keys) {
  console.log('  ' + a.padEnd(13) + keys.map((b) => {
    const s = spearman(ranks[a], ranks[b]);
    return (s.rho === null ? '   n/a' : s.rho.toFixed(3)).padStart(10);
  }).join(''));
}
const topK = (m, k = 20) => new Set([...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([id]) => id));
const base = topK(ranks.netRtg);
console.log('\n  top-20 overlap with the NetRtg-based ranking:');
for (const k of keys.filter((x) => x !== 'netRtg')) {
  const o = [...topK(ranks[k])].filter((id) => base.has(id)).length;
  console.log(`    ${k.padEnd(16)} ${o}/20`);
}

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

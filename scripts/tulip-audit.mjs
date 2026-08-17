// TULIP model audit: covariate balance, sensitivity, support/abstention statistics.
//
// The claim under test is NOT "does TULIP produce numbers" but "is the comparable engine
// accidentally learning that better players play more minutes?" Matching on rateGrade is an
// intention, not evidence. This measures it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRole, rotationDelta, TULIP_CONFIG, ROLE_BANDS } from './lib/tulip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const WEIGHTS = d.analysis.similarityWeights;

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : 0; };
/** Standardized mean difference — the standard covariate-balance diagnostic. |SMD|<0.10 is good. */
const smd = (a, b) => {
  const A = a.filter(fin), B = b.filter(fin);
  if (A.length < 3 || B.length < 3) return null;
  const pooled = Math.sqrt((sd(A) ** 2 + sd(B) ** 2) / 2);
  return pooled ? (mean(A) - mean(B)) / pooled : 0;
};

const pool = d.leagues.NBA.filter((p) => p.appeared && p.skillProfile);
const rosters = {};
for (const p of pool) (rosters[p.team] = rosters[p.team] || []).push(p);

console.log('='.repeat(78));
console.log('TULIP AUDIT — covariate balance, sensitivity, support');
console.log('='.repeat(78));

/* ------------------------------------------------ 0. the confound, measured */
console.log('\n--- 0. does minutes track quality in this league at all? ---');
for (const b of ROLE_BANDS) {
  const band = pool.filter((p) => Math.abs(p.mpg - b.mpg) <= TULIP_CONFIG.bandHalfWidth);
  if (band.length < 5) continue;
  console.log(`  ${String(b.mpg).padStart(2)} mpg  n=${String(band.length).padStart(3)}` +
    `  rateGrade ${mean(band.map((p) => p.rateGrade)).toFixed(2)}` +
    `  netRtg ${mean(band.map((p) => p.netRtg).filter(fin)).toFixed(2)}` +
    `  usg ${mean(band.map((p) => p.usg).filter(fin)).toFixed(1)}` +
    `  age ${mean(band.map((p) => p.ageOpeningNight ?? p.age).filter(fin)).toFixed(1)}`);
}
console.log('  If TULIP did not match on ability, an upward frontier would mostly recover this row.');

/* ------------------------------------- 1. covariate balance candidate vs comparables */
console.log('\n--- 1. covariate balance: candidates vs their selected comparables ---');
const COVARIATES = {
  rateGrade: (p) => p.rateGrade, usage: (p) => p.usg, age: (p) => p.ageOpeningNight ?? p.age,
  heightIn: (p) => p.heightInches, ts: (p) => p.ts, astPct: (p) => p.astPct,
  drebPct: (p) => p.drebPct, teamNetRtg: (p) => mean((rosters[p.team] || []).map((x) => x.netRtg).filter(fin)),
  starterShare: (p) => { const s = p.stats?.sit_starter_gp || 0; return p.gp ? (100 * s) / p.gp : 0; },
  gamesPlayed: (p) => p.gp,
};
const collected = Object.fromEntries(Object.keys(COVARIATES).map((k) => [k, { c: [], m: [] }]));
let projected = 0, abstained = 0;
const candidates = pool.filter((p) => fin(p.mpg) && p.mpg <= TULIP_CONFIG.maxCurrentMpgForExpansion
  && (p.minutes || 0) >= 200);
for (const c of candidates) {
  const target = Math.min(34, Math.round(c.mpg) + 8);
  const r = projectRole(c, pool, target, { weights: WEIGHTS });
  if (r.abstain) { abstained++; continue; }
  projected++;
  // Re-derive the same comparable set for balance measurement.
  const comps = pool.filter((q) => q.playerId !== c.playerId
    && Math.abs(q.mpg - target) <= TULIP_CONFIG.bandHalfWidth
    && (q.minutes || 0) >= TULIP_CONFIG.minMinutes
    && (!fin(c.rateGrade) || !fin(q.rateGrade) || Math.abs(q.rateGrade - c.rateGrade) <= TULIP_CONFIG.qualityBand)
    && (() => { const a = COVARIATES.starterShare(c), b = COVARIATES.starterShare(q);
        return !fin(a) || !fin(b) || Math.abs(a - b) <= TULIP_CONFIG.starterShareBand; })());
  for (const [k, f] of Object.entries(COVARIATES)) {
    const cv = f(c); if (fin(cv)) collected[k].c.push(Number(cv));
    for (const q of comps) { const qv = f(q); if (fin(qv)) collected[k].m.push(Number(qv)); }
  }
}
console.log(`  candidates evaluated ${candidates.length} · projected ${projected} · abstained ${abstained}`);
console.log('  covariate        candidate  comparable      SMD   balance');
for (const [k, v] of Object.entries(collected)) {
  const s = smd(v.c, v.m);
  if (s === null) continue;
  const flag = Math.abs(s) < 0.1 ? 'good' : Math.abs(s) < 0.25 ? 'acceptable' : 'IMBALANCED';
  console.log(`  ${k.padEnd(15)} ${mean(v.c).toFixed(2).padStart(8)} ${mean(v.m).toFixed(2).padStart(11)}` +
    `  ${s.toFixed(3).padStart(7)}   ${flag}`);
}
console.log('  SMD = standardized mean difference. |SMD| < 0.10 is conventionally good balance.');

/* --------------------------------------------------------- 2. sensitivity */
console.log('\n--- 2. sensitivity: do TULIP rankings survive parameter changes? ---');
const baseline = new Map();
for (const c of candidates) {
  const target = Math.min(34, Math.round(c.mpg) + 8);
  const r = projectRole(c, pool, target, { weights: WEIGHTS });
  const rot = r.abstain ? null : rotationDelta(c, rosters[c.team] || pool, target, r);
  if (rot && !rot.abstain) baseline.set(c.playerId, rot.neutralRotationDelta);
}
const spearman = (a, b) => {
  const ids = [...a.keys()].filter((k) => b.has(k));
  if (ids.length < 5) return { rho: null, n: ids.length };
  const rk = (m) => { const s = ids.slice().sort((x, y) => m.get(y) - m.get(x)); const r = new Map();
    s.forEach((id, i) => r.set(id, i + 1)); return r; };
  const ra = rk(a), rb = rk(b);
  const n = ids.length;
  const d2 = ids.reduce((s, id) => s + (ra.get(id) - rb.get(id)) ** 2, 0);
  return { rho: 1 - (6 * d2) / (n * (n * n - 1)), n };
};
const VARIANTS = [
  ['minComparables 8->5', { minComparables: 5 }], ['minComparables 8->14', { minComparables: 14 }],
  ['minSimilarity 62->56', { minSimilarity: 56 }], ['minSimilarity 62->70', { minSimilarity: 70 }],
  ['minSupport 40->30', { minSupport: 30 }], ['minSupport 40->55', { minSupport: 55 }],
  ['qualityBand 1.2->0.8', { qualityBand: 0.8 }], ['qualityBand 1.2->2.0', { qualityBand: 2.0 }],
  ['netRtgClamp 25->15', { netRtgClamp: 15 }],
  ['netRtgShrink 900->400', { netRtgShrinkMinutes: 400 }],
  ['netRtgShrink 900->1800', { netRtgShrinkMinutes: 1800 }],
  ['bandHalfWidth 3->2', { bandHalfWidth: 2 }], ['bandHalfWidth 3->4.5', { bandHalfWidth: 4.5 }],
];
console.log('    variant                    n   rho vs baseline   projected  abstained');
for (const [label, override] of VARIANTS) {
  const cfg = { ...TULIP_CONFIG, ...override };
  const alt = new Map();
  let proj = 0, abst = 0;
  for (const c of candidates) {
    const target = Math.min(34, Math.round(c.mpg) + 8);
    const r = projectRole(c, pool, target, { weights: WEIGHTS, config: cfg });
    if (r.abstain || r.support < cfg.minSupport) { abst++; continue; }
    proj++;
    const savedClamp = TULIP_CONFIG.netRtgClamp, savedShrink = TULIP_CONFIG.netRtgShrinkMinutes;
    TULIP_CONFIG.netRtgClamp = cfg.netRtgClamp; TULIP_CONFIG.netRtgShrinkMinutes = cfg.netRtgShrinkMinutes;
    const rot = rotationDelta(c, rosters[c.team] || pool, target, r);
    TULIP_CONFIG.netRtgClamp = savedClamp; TULIP_CONFIG.netRtgShrinkMinutes = savedShrink;
    if (rot && !rot.abstain) alt.set(c.playerId, rot.neutralRotationDelta);
  }
  const s = spearman(baseline, alt);
  console.log(`    ${label.padEnd(24)} ${String(s.n).padStart(4)}   ${s.rho === null ? '   n/a' : s.rho.toFixed(4).padStart(6)}` +
    `          ${String(proj).padStart(4)}       ${String(abst).padStart(4)}`);
}

/* ------------------------------------------------- 3. support / abstention */
console.log('\n--- 3. support and abstention across the league ---');
let cards = 0, abst = 0; const reasons = {}; const supports = []; const tiers = {};
for (const p of d.leagues.NBA.filter((x) => x.appeared && x.tulip)) {
  const c = p.tulip.card; cards++;
  tiers[c.evidenceTier?.tier || '?'] = (tiers[c.evidenceTier?.tier || '?'] || 0) + 1;
  if (c.abstain) {
    abst++;
    const key = /Already plays/.test(c.reason) ? 'already in a large role'
      : /only .* minutes above/.test(c.reason) ? 'target too close to current role'
      : /comparable players have played/.test(c.reason) ? 'too few comparables'
      : /Support .* below/.test(c.reason) ? 'support below threshold' : 'other';
    reasons[key] = (reasons[key] || 0) + 1;
  } else supports.push(c.projection.support);
}
console.log(`  cards ${cards} · abstained ${abst} (${(100 * abst / cards).toFixed(1)}%) · estimated ${cards - abst}`);
Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k.padEnd(34)} ${v}`));
console.log(`  evidence tiers: ${Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(' ')}` +
  '   (A and C are unreachable without game logs)');
if (supports.length) {
  const s = supports.slice().sort((a, b) => a - b);
  console.log(`  support where estimated: min ${s[0]} median ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]}`);
}

/* ---------------------------------------- 4. does TULIP say anything new? */
console.log('\n--- 4. does the neutral rotation delta add information beyond simpler metrics? ---');
const rows = [...baseline.entries()].map(([id, delta]) => {
  const p = pool.find((x) => x.playerId === id);
  return { p, delta };
}).filter((x) => x.p);
const pearson = (xs, ys) => {
  const q = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => fin(a) && fin(b));
  if (q.length < 5) return null;
  const A = q.map((z) => z[0]), B = q.map((z) => z[1]);
  const ma = mean(A), mb = mean(B), s = sd(A) * sd(B);
  return s ? q.reduce((acc, [a, b]) => acc + (a - ma) * (b - mb), 0) / ((q.length - 1) * s) : null;
};
for (const [label, f] of [['rateGrade', (p) => p.rateGrade], ['grade', (p) => p.grade],
  ['magnitudeGrade', (p) => p.magnitudeGrade], ['PIE', (p) => p.pie], ['netRtg', (p) => p.netRtg],
  ['pts/36', (p) => (p.mpg ? (p.pts * 36) / p.mpg : null)], ['mpg', (p) => p.mpg]]) {
  const r = pearson(rows.map((x) => f(x.p)), rows.map((x) => x.delta));
  console.log(`  neutral delta ~ ${label.padEnd(16)} r = ${r === null ? 'n/a' : r.toFixed(3)}`);
}
console.log(`  n = ${rows.length} players with a neutral rotation delta`);
console.log('  A near-1 correlation with rateGrade would mean TULIP is an expensive re-ranking of it.');
console.log('');

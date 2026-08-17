// Old-vs-new grade diagnostics. Run against a previous data.json to see exactly what a model
// change did, rather than eyeballing a leaderboard.
//   node scripts/diagnostics.mjs [pathToPreviousBuild]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INGREDIENTS, COMPONENT_WEIGHTS, effectiveConceptWeights } from './lib/grades.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const prevPath = process.argv[2];
const prev = prevPath && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : null;

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) : 0; };

function spearman(aMap, bMap) {
  const ids = [...aMap.keys()].filter((k) => bMap.has(k));
  const rank = (m) => { const s = ids.map((id) => ({ id, v: m.get(id) })).sort((x, y) => y.v - x.v);
    const r = new Map(); s.forEach((x, i) => r.set(x.id, i + 1)); return r; };
  const ra = rank(aMap), rb = rank(bMap);
  const n = ids.length;
  let d2 = 0;
  for (const id of ids) { const d = ra.get(id) - rb.get(id); d2 += d * d; }
  return { n, rho: 1 - (6 * d2) / (n * (n * n - 1)) };
}

function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => fin(a) && fin(b));
  if (pairs.length < 3) return null;
  const xa = pairs.map((p) => p[0]), ya = pairs.map((p) => p[1]);
  const mx = mean(xa), my = mean(ya);
  const cov = mean(pairs.map(([a, b]) => (a - mx) * (b - my)));
  const s = sd(xa) * sd(ya);
  return s ? cov / s : null;
}

console.log('='.repeat(78));
console.log('GRADE MODEL DIAGNOSTICS  ·  ' + (prev ? `vs ${path.basename(prevPath)}` : 'current build only'));
console.log('='.repeat(78));

console.log('\n--- effective concept weights (dependency tree resolved) ---');
for (const [c, v] of Object.entries(effectiveConceptWeights()))
  console.log(`  ${c.padEnd(24)} ${String(v.pctOfGrade).padStart(6)}% of the grade`);

console.log('\n--- declared component weights ---');
console.log('  ' + Object.entries(COMPONENT_WEIGHTS).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' · '));
console.log('  ingredients per component: ' +
  Object.entries(INGREDIENTS).map(([k, v]) => `${k} ${v.length}`).join(' · '));

// Every statistic must appear exactly once across the whole model.
const seen = new Map();
for (const [comp, list] of Object.entries(INGREDIENTS))
  for (const ing of list) {
    const k = ing.key || ing.pg;
    if (seen.has(k)) console.log(`  X REUSE: ${k} appears in ${seen.get(k)} and ${comp}`);
    seen.set(k, comp);
  }
console.log(`  ${seen.size} distinct statistics, no reuse across components`);

for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = now.leagues[lg].filter((p) => p.appeared);
  console.log(`\n${'='.repeat(78)}\n${lg}  (${arr.length} graded players)\n${'='.repeat(78)}`);

  // ---- coverage
  const cov = arr.map((p) => p.gradeCoverage).filter(fin);
  const below = arr.filter((p) => (p.componentsBelowMinimum || []).length);
  console.log(`\n--- ingredient coverage ---`);
  console.log(`  median ${mean(cov).toFixed(1)}% · full coverage ${arr.filter((p) => p.gradeCoverage === 100).length}/${arr.length}`);
  console.log(`  players with a component below its minimum: ${below.length}`);
  if (below.length) {
    const tally = {};
    below.forEach((p) => p.componentsBelowMinimum.forEach((c) => { tally[c] = (tally[c] || 0) + 1; }));
    console.log('    ' + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · '));
  }

  // ---- three grades against each other
  const gm = new Map(arr.map((p) => [p.playerId, p.grade]));
  const rm = new Map(arr.filter((p) => fin(p.rateGrade)).map((p) => [p.playerId, p.rateGrade]));
  const mm = new Map(arr.filter((p) => fin(p.magnitudeGrade)).map((p) => [p.playerId, p.magnitudeGrade]));
  console.log(`\n--- the three grades ---`);
  console.log(`  grade      range ${Math.min(...gm.values()).toFixed(3)}..${Math.max(...gm.values()).toFixed(3)}`);
  console.log(`  rateGrade  range ${Math.min(...rm.values()).toFixed(3)}..${Math.max(...rm.values()).toFixed(3)}  spearman vs grade ${spearman(gm, rm).rho.toFixed(4)}`);
  console.log(`  magnitude  range ${Math.min(...mm.values()).toFixed(3)}..${Math.max(...mm.values()).toFixed(3)}  spearman vs grade ${spearman(gm, mm).rho.toFixed(4)}`);
  const gaps = [...gm.values()].sort((a, b) => b - a);
  const adj = gaps.slice(1).map((v, i) => +(gaps[i] - v).toFixed(4));
  console.log(`  grade distinct adjacent gaps: ${new Set(adj).size}/${adj.length}`);
  const mgaps = [...mm.values()].sort((a, b) => b - a);
  const madj = mgaps.slice(1).map((v, i) => +(mgaps[i] - v).toFixed(4));
  console.log(`  magnitude distinct adjacent gaps: ${new Set(madj).size}/${madj.length}`);

  // ---- bias checks
  console.log(`\n--- bias checks ---`);
  for (const [label, keyFn] of [
    ['position', (p) => p.positionFamily],
    ['age band', (p) => { const a = p.ageOpeningNight ?? p.age; return a == null ? null : a <= 22 ? '<=22' : a <= 26 ? '23-26' : a <= 30 ? '27-30' : '31+'; }],
  ]) {
    const by = {};
    arr.forEach((p) => { const k = keyFn(p); if (k) (by[k] = by[k] || []).push(p.grade); });
    const entries = Object.entries(by).filter(([, v]) => v.length >= 10)
      .map(([k, v]) => [k, mean(v)]).sort((a, b) => b[1] - a[1]);
    const spread = entries.length ? entries[0][1] - entries[entries.length - 1][1] : 0;
    console.log(`  ${label.padEnd(9)} spread ${spread.toFixed(2)}  ` +
      entries.map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '));
  }
  console.log(`  grade vs minutes  r=${(pearson(arr.map((p) => p.minutes), arr.map((p) => p.grade)) ?? 0).toFixed(3)}`);
  console.log(`  grade vs games    r=${(pearson(arr.map((p) => p.gp), arr.map((p) => p.grade)) ?? 0).toFixed(3)}`);
  console.log(`  magnitude vs min  r=${(pearson(arr.map((p) => p.minutes), arr.map((p) => p.magnitudeGrade)) ?? 0).toFixed(3)}`);

  // ---- component correlation / redundancy
  console.log(`\n--- component correlation matrix (redundancy check) ---`);
  const comps = Object.keys(COMPONENT_WEIGHTS);
  const series = Object.fromEntries(comps.map((c) => [c, arr.map((p) => p.components?.[c])]));
  console.log('             ' + comps.map((c) => c.slice(0, 6).padStart(7)).join(''));
  for (const a of comps) {
    const row = comps.map((b) => {
      const r = pearson(series[a], series[b]);
      return (r === null ? '  --  ' : r.toFixed(2).padStart(6)) + ' ';
    }).join('');
    console.log('  ' + a.padEnd(11) + row);
  }
  const high = [];
  for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
    const r = pearson(series[comps[i]], series[comps[j]]);
    if (r !== null && Math.abs(r) > 0.7) high.push(`${comps[i]}~${comps[j]} r=${r.toFixed(2)}`);
  }
  console.log(`  pairs above |r|=0.70: ${high.length ? high.join(', ') : 'none'}`);

  // ---- vs previous build
  if (prev && prev.leagues?.[lg]) {
    const old = new Map(prev.leagues[lg].filter((p) => fin(p.grade)).map((p) => [p.playerId, p.grade]));
    const both = arr.filter((p) => old.has(p.playerId));
    const s = spearman(new Map(both.map((p) => [p.playerId, p.grade])),
                       new Map(both.map((p) => [p.playerId, old.get(p.playerId)])));
    console.log(`\n--- vs previous build ---`);
    console.log(`  spearman rank correlation: ${s.rho.toFixed(4)} over ${s.n} players`);

    const oldRank = new Map([...old.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]));
    const newRank = new Map(both.slice().sort((a, b) => b.grade - a.grade).map((p, i) => [p.playerId, i + 1]));
    const moves = both.map((p) => ({ p, delta: oldRank.get(p.playerId) - newRank.get(p.playerId) }));

    const oldTop = new Set([...oldRank.entries()].filter(([, r]) => r <= 25).map(([id]) => id));
    const newTop = new Set([...newRank.entries()].filter(([, r]) => r <= 25).map(([id]) => id));
    const inNow = [...newTop].filter((id) => !oldTop.has(id));
    const outNow = [...oldTop].filter((id) => !newTop.has(id));
    const nm = new Map(both.map((p) => [p.playerId, p.name]));
    console.log(`  top-25 churn: ${inNow.length} in, ${outNow.length} out`);
    if (inNow.length) console.log(`    in : ${inNow.map((id) => nm.get(id)).join(', ')}`);
    if (outNow.length) console.log(`    out: ${outNow.map((id) => nm.get(id)).join(', ')}`);

    const why = (p) => {
      const c = p.components || {};
      const top = Object.entries(c).filter(([, v]) => fin(v)).sort((a, b) => b[1] - a[1]);
      return top.length ? `${top[0][0]} ${top[0][1]}` : '—';
    };
    console.log('  largest risers:');
    moves.sort((a, b) => b.delta - a.delta).slice(0, 5)
      .forEach((m) => console.log(`    +${String(m.delta).padStart(4)}  ${m.p.name.padEnd(24)} ${m.p.gp}gp  strongest: ${why(m.p)}`));
    console.log('  largest fallers:');
    moves.sort((a, b) => a.delta - b.delta).slice(0, 5)
      .forEach((m) => console.log(`    ${String(m.delta).padStart(5)}  ${m.p.name.padEnd(24)} ${m.p.gp}gp  strongest: ${why(m.p)}`));
  }
}
console.log('');

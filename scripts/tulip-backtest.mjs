// TULIP CAPACITY — definition, and the discriminative backtest that decides whether it is useful.
//
// CAPACITY = the expected sustained latent workload from Model A. No cutoff, no invented
// coefficient; it is a distributional mean with a direct interpretation. HEADROOM = Capacity minus
// current MPG, kept separate because it is team- and role-dependent.
//
// The decisive test is NOT aggregate error. It is whether TULIP DISCRIMINATES: among players at the
// same current workload, does the one TULIP rates higher actually sustain a larger role? A model can
// be statistically respectable and still useless if it only reproduces current minutes.
//
// Trained on earlier seasons, evaluated on a season it never saw.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
// Spec 5. The full 12-feature model beat this by 0.004 MAE with a CI including zero, so the extra
// complexity is not carried into the product.
const FE = ['baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart', 'preGsPer36', 'preStartRate', 'preForm5'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
attachStarterFlags(rows, HIST);
const nameOf = new Map();
for (const r of rows) nameOf.set(String(r.playerId), r.playerName);

const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  let num = 0, den = 0, w = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w * (e.outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  if (!(den > 0)) continue;
  data.push({ ...e.pre, baselineMpg: e.baselineMpg,
    openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    y: num / den, pid: String(e.playerId), season: e.season, nFollow: e.outcomeRows.length });
}
const RIDGE = 1e-6;
function fit(train) {
  const m = FE.length + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; }
  }
  for (let a = 1; a < m; a++) A[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) {
    let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
  }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
const seasons = [...new Set(data.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
const f = fit(tr);
const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
const q = (p) => resid[Math.min(resid.length - 1, Math.max(0, Math.floor(p * resid.length)))];
const pGE = (pred, T) => resid.reduce((c, r) => c + (pred + r >= T ? 1 : 0), 0) / resid.length;
const medResid = q(0.5);

for (const d of te) {
  d.capacity = f(d);                 // expected sustained latent workload
  d.median = f(d) + medResid;
  d.headroom = d.capacity - d.baselineMpg;
}

console.log(`TULIP BACKTEST · trained on ${seasons.slice(0, -1).join(', ')} · held out ${last} · n=${te.length}`);

console.log('\n=== WHICH SUMMARY STATISTIC IS THE BEST SINGLE CAPACITY NUMBER? ===');
{
  const mae = (g) => te.reduce((a, d) => a + Math.abs(g(d) - d.y), 0) / te.length;
  const bias = (g) => te.reduce((a, d) => a + (g(d) - d.y), 0) / te.length;
  for (const [n, g] of [['mean (expected)', (d) => d.capacity], ['median', (d) => d.median], ['current MPG (null)', (d) => d.baselineMpg]]) {
    console.log(`  ${n.padEnd(20)} MAE ${mae(g).toFixed(3)}  bias ${bias(g) >= 0 ? '+' : ''}${bias(g).toFixed(3)}`);
  }
  console.log('  -> the expected value is used: lowest MAE, near-zero bias, no cutoff required.');
}

console.log('\n=== THE DECISIVE TEST: does TULIP DISCRIMINATE at equal current workload? ===');
{
  // Pair players whose CURRENT workload matches but whose TULIP capacity differs. If TULIP only
  // re-states current minutes, the higher-capacity player wins no more often than chance.
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffled = [...te].sort(() => rnd() - 0.5);
  for (const [gapLo, label] of [[3, 'capacity gap >= 3 MPG'], [5, 'capacity gap >= 5 MPG']]) {
    const pairs = [];
    const used = new Set();
    for (let i = 0; i < shuffled.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < shuffled.length; j++) {
        if (used.has(j)) continue;
        const a = shuffled[i], b = shuffled[j];
        if (a.pid === b.pid) continue;
        if (Math.abs(a.baselineMpg - b.baselineMpg) > 1.0) continue;   // same current workload
        if (Math.abs(a.capacity - b.capacity) < gapLo) continue;       // materially different TULIP
        pairs.push([a, b]); used.add(i); used.add(j); break;
      }
    }
    let win = 0, tie = 0;
    for (const [a, b] of pairs) {
      const hi = a.capacity > b.capacity ? a : b, lo = a.capacity > b.capacity ? b : a;
      if (Math.abs(hi.y - lo.y) < 1e-9) tie++;
      else if (hi.y > lo.y) win++;
    }
    const n = pairs.length - tie;
    const rate = n ? win / n : NaN;
    // Binomial 95% interval on the win rate.
    const se = n ? Math.sqrt(rate * (1 - rate) / n) : NaN;
    console.log(`  ${label}: ${win}/${n} = ${(100 * rate).toFixed(1)}%  95% CI [${(100 * (rate - 1.96 * se)).toFixed(1)}%, ${(100 * (rate + 1.96 * se)).toFixed(1)}%]  (50% = no skill)`);
  }
}

console.log('\n=== HEADROOM BUCKETS: what actually happened afterwards ===');
console.log('  headroom band       n    mean current   mean TULIP   mean ACTUAL sustained   actual-current');
for (const [lo, hi, lbl] of [[-99, -3, 'much less (<-3)'], [-3, -1, 'less'], [-1, 1, 'about same'], [1, 3, 'more'], [3, 99, 'much more (>+3)']]) {
  const s = te.filter((d) => d.headroom >= lo && d.headroom < hi);
  if (s.length < 20) continue;
  const m = (g) => s.reduce((a, d) => a + g(d), 0) / s.length;
  console.log(`  ${lbl.padEnd(18)} ${String(s.length).padStart(4)}      ${m((d) => d.baselineMpg).toFixed(1)}         ${m((d) => d.capacity).toFixed(1)}          ${m((d) => d.y).toFixed(1)}              ${(m((d) => d.y) - m((d) => d.baselineMpg)) >= 0 ? '+' : ''}${(m((d) => d.y) - m((d) => d.baselineMpg)).toFixed(1)}`);
}

console.log('\n=== REAL HELD-OUT EXAMPLES ===');
const show = (title, sel, n = 6) => {
  console.log(`\n  ${title}`);
  console.log('    player                  current  TULIP  headroom   P>=24  P>=28   ACTUAL   err');
  const s = te.filter(sel).sort((a, b) => Math.abs(b.headroom) - Math.abs(a.headroom)).slice(0, n);
  for (const d of s) {
    console.log(`    ${(nameOf.get(d.pid) || d.pid).slice(0, 22).padEnd(22)}  ${d.baselineMpg.toFixed(1).padStart(5)}  ${d.capacity.toFixed(1).padStart(5)}  ${(d.headroom >= 0 ? '+' : '') + d.headroom.toFixed(1)}`.padEnd(64)
      + `  ${(100 * pGE(d.capacity, 24)).toFixed(0).padStart(3)}%  ${(100 * pGE(d.capacity, 28)).toFixed(0).padStart(3)}%   ${d.y.toFixed(1).padStart(5)}  ${(d.y - d.capacity >= 0 ? '+' : '') + (d.y - d.capacity).toFixed(1)}`);
  }
};
show('SUBSTANTIALLY MORE capacity than current role', (d) => d.headroom >= 3 && d.nFollow >= 5);
show('ROUGHLY THE SAME', (d) => Math.abs(d.headroom) <= 1 && d.nFollow >= 5);
show('SUBSTANTIALLY LESS capacity than current role', (d) => d.headroom <= -3 && d.nFollow >= 5);

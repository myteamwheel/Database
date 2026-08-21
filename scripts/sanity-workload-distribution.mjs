// FACE VALIDITY AND CALIBRATION of the Model A workload distribution.
//
// Triggered by a suspicious figure: an "established 26 MPG starter" was shown at P(sustain>=22)=57%.
// If real 26-MPG players only hold 22 minutes 57% of the time, the probability construction is
// broken. Checks here: monotonicity in T, face validity against ACTUAL sustained workload, the
// direction of the baseline-MPG effect, and calibration by predicted band on the chronological
// holdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
const FE = ['baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart', 'preGsPer36', 'preStartRate', 'preForm5'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
attachStarterFlags(rows, HIST);
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
    y: num / den, pid: String(e.playerId), season: e.season });
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
const pGE = (pred, T) => resid.reduce((c, r) => c + (pred + r >= T ? 1 : 0), 0) / resid.length;
const TS = [22, 24, 26, 28, 30, 32];

console.log('=== 1. MONOTONICITY: P(>=22) >= P(>=24) >= ... for every held-out prediction ===');
{
  let viol = 0;
  for (const d of te) {
    const p = TS.map((T) => pGE(f(d), T));
    for (let i = 1; i < p.length; i++) if (p[i] > p[i - 1] + 1e-12) viol++;
  }
  console.log(`  violations: ${viol} of ${te.length * (TS.length - 1)} comparisons  ${viol === 0 ? 'PASS' : 'FAIL'}`);
}

console.log('\n=== 2. FACE VALIDITY: by ACTUAL sustained workload, mean P(>=T) on holdout ===');
console.log('  actual sustained    n     P>=22  P>=24  P>=26  P>=28  P>=30');
for (const [lo, hi] of [[0, 14], [14, 18], [18, 22], [22, 26], [26, 30], [30, 99]]) {
  const s = te.filter((d) => d.y >= lo && d.y < hi);
  if (s.length < 25) continue;
  const ps = TS.slice(0, 5).map((T) => 100 * s.reduce((a, d) => a + pGE(f(d), T), 0) / s.length);
  console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(3)} MPG      ${String(s.length).padStart(5)}   ${ps.map((x) => x.toFixed(0).padStart(4) + '%').join(' ')}`);
}

console.log('\n=== 3. DIRECTION: does higher pre-event workload shift the distribution up? ===');
console.log('  baselineMpg band   n     mean predicted sustained   mean actual');
for (const [lo, hi] of [[0, 14], [14, 18], [18, 22], [22, 26], [26, 30], [30, 99]]) {
  const s = te.filter((d) => d.baselineMpg >= lo && d.baselineMpg < hi);
  if (s.length < 25) continue;
  const mp = s.reduce((a, d) => a + f(d), 0) / s.length, ma = s.reduce((a, d) => a + d.y, 0) / s.length;
  console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(3)}          ${String(s.length).padStart(5)}        ${mp.toFixed(1)}                ${ma.toFixed(1)}`);
}

console.log('\n=== 4. CALIBRATION by predicted band, chronological holdout ===');
{
  const b = new Map();
  for (const d of te) for (const T of TS) {
    const p = pGE(f(d), T), k = Math.min(9, Math.floor(p * 10));
    const g = b.get(k) || { n: 0, p: 0, y: 0 };
    g.n++; g.p += p; g.y += d.y >= T ? 1 : 0; b.set(k, g);
  }
  let e = 0, tot = 0;
  for (const [k, g] of [...b.entries()].sort((x, y) => x[0] - y[0])) {
    if (g.n < 50) continue;
    const pm = 100 * g.p / g.n, am = 100 * g.y / g.n;
    e += g.n * Math.abs(pm - am); tot += g.n;
    console.log(`  ${String(k * 10).padStart(3)}-${k * 10 + 10}%  predicted ${pm.toFixed(1)}%  actual ${am.toFixed(1)}%  n=${g.n}`);
  }
  console.log(`  ECE ${(e / tot).toFixed(2)}%`);
}

console.log('\n=== 5. THE 57% FIGURE: what query produced it? ===');
{
  // Real 26-MPG-baseline players in the holdout, using their OWN opener minutes.
  const real = te.filter((d) => d.baselineMpg >= 24 && d.baselineMpg < 28);
  const m = (g) => g.reduce((a, x) => a + x, 0) / g.length;
  console.log(`  real holdout players with baseline 24-28 MPG: n=${real.length}`);
  console.log(`    mean own openerMin ${m(real.map((d) => d.openerMin)).toFixed(1)} · mean actual sustained ${m(real.map((d) => d.y)).toFixed(1)}`);
  console.log(`    mean P(>=22) using their OWN opener: ${(100 * m(real.map((d) => pGE(f(d), 22)))).toFixed(0)}%`);
  console.log(`    observed frequency of actually sustaining >=22: ${(100 * real.filter((d) => d.y >= 22).length / real.length).toFixed(0)}%`);
  // The curve script forced openerMin = T at every row of the table.
  const q = { ...real[0], baselineMpg: 26, preGsPer36: 13, preStartRate: 0.8, preForm5: 13, startedOpener: 1, promotedToStart: 0 };
  console.log(`  hypothetical used by the curve (openerMin forced to equal the threshold):`);
  for (const T of [22, 26, 30]) console.log(`    opener=${T} -> P(>=${T}) = ${(100 * pGE(f({ ...q, openerMin: T }), T)).toFixed(0)}%`);
  console.log(`  with opener held at a realistic 30 for a 26-MPG starter:`);
  for (const T of [22, 26, 30]) console.log(`    opener=30 -> P(>=${T}) = ${(100 * pGE(f({ ...q, openerMin: 30 }), T)).toFixed(0)}%`);
}

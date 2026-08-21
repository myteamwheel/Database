// RECALIBRATION, learned WITHOUT touching the evaluation season.
//
// The chronological holdout showed systematic under-confidence (ECE 3.67%, actual above predicted in
// all ten bands). Fitting a correction on 2024-25 and then reporting success on 2024-25 would be
// circular. So the correction is learned from NESTED out-of-fold predictions inside the TRAINING
// seasons only, frozen, and then applied once to 2024-25.
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
for (const s of SEASONS) { const f = path.join(HIST, s, 'gamelog.json'); if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8'))); }
attachStarterFlags(rows, HIST);
const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  let num = 0, den = 0, w = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w * (e.outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  if (!(den > 0)) continue;
  data.push({ ...e.pre, baselineMpg: e.baselineMpg, openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    y: num / den, pid: String(e.playerId), season: e.season });
}
const RIDGE = 1e-6;
function fit(train) {
  const m = FE.length + 1; const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) { const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; } }
  for (let a = 1; a < m; a++) A[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) { let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
const seasons = [...new Set(data.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);

// Nested OOF inside TRAINING only, grouped by player, to get honest residuals for calibration.
const players = [...new Set(tr.map((d) => d.pid))];
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const folds = Array.from({ length: 5 }, () => new Set());
[...players].sort(() => rnd() - 0.5).forEach((p, i) => folds[i % 5].add(p));
const nested = [];
for (const t of folds) {
  const a = tr.filter((d) => !t.has(d.pid)), b = tr.filter((d) => t.has(d.pid));
  if (a.length < 200 || !b.length) continue;
  const f = fit(a);
  for (const d of b) nested.push(d.y - f(d));
}
nested.sort((x, y) => x - y);
const inSample = tr.map((d) => d.y - fit(tr)(d)).sort((x, y) => x - y);

// The correction is a single frozen SCALE on the residual spread, chosen on training-nested data.
const spread = (r) => { const q = (p) => r[Math.floor(p * r.length)]; return q(0.84) - q(0.16); };
const SCALE = spread(nested) / spread(inSample);
console.log(`residual spread — in-sample ${spread(inSample).toFixed(3)} · nested OOF ${spread(nested).toFixed(3)}`);
console.log(`FROZEN calibration scale (learned on training seasons only): ${SCALE.toFixed(4)}`);

const f = fit(tr);
const evalCal = (resid, label) => {
  const pGE = (pred, T) => resid.reduce((c, r) => c + (pred + r >= T ? 1 : 0), 0) / resid.length;
  const b = new Map();
  for (const d of te) for (const T of [22, 24, 26, 28, 30, 32]) {
    const p = pGE(f(d), T), k = Math.min(9, Math.floor(p * 10));
    const g = b.get(k) || { n: 0, p: 0, y: 0 }; g.n++; g.p += p; g.y += d.y >= T ? 1 : 0; b.set(k, g);
  }
  let e = 0, tot = 0;
  for (const [, g] of b) { if (g.n < 50) continue; e += g.n * Math.abs(100 * g.p / g.n - 100 * g.y / g.n); tot += g.n; }
  const cov = (lvl) => { let hit = 0;
    for (const d of te) { const lo = resid[Math.floor((0.5 - lvl / 2) * resid.length)], hi = resid[Math.min(resid.length - 1, Math.floor((0.5 + lvl / 2) * resid.length))];
      if (d.y >= f(d) + lo && d.y <= f(d) + hi) hit++; } return 100 * hit / te.length; };
  console.log(`  ${label.padEnd(28)} ECE ${(e / tot).toFixed(2)}%   coverage ${cov(0.5).toFixed(1)}/${cov(0.8).toFixed(1)}/${cov(0.9).toFixed(1)}`);
};
console.log('\nAPPLIED ONCE to the untouched 2024-25 holdout:');
evalCal(inSample, 'before (in-sample resid)');
evalCal(nested, 'nested-OOF residuals');
evalCal(nested.map((r) => r * SCALE), `frozen scale x${SCALE.toFixed(3)}`);

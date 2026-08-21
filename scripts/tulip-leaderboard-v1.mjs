// TULIP_CAPACITY_V1 historical backtest. Predictions are genuinely out-of-sample: the model is
// fitted on 2015-16..2023-24 and applied to 2024-25 transitions it never saw.
//
// Selection logic is prespecified: rank by predicted Headroom, take the top/bottom 25 of the
// OFFSEASON population (the validated scope). Names appear only if they qualify under that rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const T = JSON.parse(fs.readFileSync(path.join(HIST, 'transitions.json'), 'utf8'));
const nameOf = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) nameOf.set(String(r.playerId), r.playerName);
}
const FE = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aTrend', 'aStartRate', 'aGames', 'aSeasons', 'aCareerHighMpg',
  'age', 'heightIn', 'weight', 'draftPick', 'undrafted', 'aGsPer36', 'aTs', 'aFgaPer36', 'aAstPer36', 'aRebPer36', 'aPfPer36'];
const RIDGE = 1e-5;
function fit(train, F, yk) {
  const m = F.length + 1;
  const mu = F.map((k) => train.reduce((a, d) => a + (d[k] ?? 0), 0) / train.length);
  const sd = F.map((k, i) => Math.sqrt(train.reduce((a, d) => a + ((d[k] ?? 0) - mu[i]) ** 2, 0) / train.length) || 1);
  const z = (d) => F.map((k, i) => ((d[k] ?? 0) - mu[i]) / sd[i]);
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) { const v = [1, ...z(d)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d[yk]; } }
  for (let a = 1; a < m; a++) A[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) { let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
  const w = A.map((r, i) => r[m] / A[i][i]);
  return (d) => w[0] + z(d).reduce((s, v, i) => s + w[i + 1] * v, 0);
}
const pool = T.filter((d) => Number.isFinite(d.tFirst10));
const seasons = [...new Set(pool.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = pool.filter((d) => d.season !== last), te = pool.filter((d) => d.season === last);
const f = fit(tr, FE, 'tFirst10'), fb = fit(tr, ['aSeasonMpg'], 'tFirst10');
const resid = tr.map((d) => d.tFirst10 - f(d)).sort((a, b) => a - b);
const q = (p) => resid[Math.min(resid.length - 1, Math.max(0, Math.floor(p * resid.length)))];
const support = (d) => tr.filter((x) => Math.abs(x.aSeasonMpg - d.aSeasonMpg) <= 3).length;
const gradeOf = (n) => (n >= 300 ? 'A' : n >= 150 ? 'B' : n >= 60 ? 'C' : 'D');
for (const d of te) {
  d.cap = f(d); d.base = fb(d); d.hr = d.cap - d.aSeasonMpg;
  d.err = d.tFirst10 - d.cap; d.baseErr = d.tFirst10 - d.base;
  d.beatBase = Math.abs(d.err) < Math.abs(d.baseErr);
  d.sup = support(d); d.grade = gradeOf(d.sup);
}
const off = te.filter((d) => !d.inSeason);
const H = '  #  player                A-szn  TULIP   HEAD  50% range   ACTUAL   err  baseErr  beat  ev  n';
const L = (d, i) => `  ${String(i + 1).padStart(2)} ${(nameOf.get(d.pid) || d.pid).slice(0, 20).padEnd(20)} ${d.aSeasonMpg.toFixed(1).padStart(5)} ${d.cap.toFixed(1).padStart(6)} ${((d.hr >= 0 ? '+' : '') + d.hr.toFixed(1)).padStart(6)}  ${(d.cap + q(0.25)).toFixed(0)}-${(d.cap + q(0.75)).toFixed(0)}`.padEnd(62)
  + `${d.tFirst10.toFixed(1).padStart(6)} ${((d.err >= 0 ? '+' : '') + d.err.toFixed(1)).padStart(6)} ${((d.baseErr >= 0 ? '+' : '') + d.baseErr.toFixed(1)).padStart(7)}   ${d.beatBase ? 'YES' : ' no'}   ${d.grade} ${String(d.sup).padStart(4)}`;

console.log(`TULIP_CAPACITY_V1 · HISTORICAL BACKTEST · out-of-sample ${last} offseason transitions (n=${off.length})`);
console.log(`trained on ${seasons.slice(0, -1).join(', ')}\n`);
console.log('=== TOP 25 HIDDEN-CAPACITY CALLS (highest predicted headroom) ===');
console.log(H);
[...off].sort((a, b) => b.hr - a.hr).slice(0, 25).forEach((d, i) => console.log(L(d, i)));
console.log('\n=== TOP 25 NEGATIVE-HEADROOM CALLS (predicted to lose role) ===');
console.log(H);
[...off].sort((a, b) => a.hr - b.hr).slice(0, 25).forEach((d, i) => console.log(L(d, i)));
console.log('\n=== STRONGEST HITS (smallest |err| among |headroom| >= 3) ===');
console.log(H);
off.filter((d) => Math.abs(d.hr) >= 3).sort((a, b) => Math.abs(a.err) - Math.abs(b.err)).slice(0, 8).forEach((d, i) => console.log(L(d, i)));
console.log('\n=== STRONGEST MISSES (largest |err|) ===');
console.log(H);
[...off].sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 8).forEach((d, i) => console.log(L(d, i)));
const beat = off.filter((d) => d.beatBase).length;
console.log(`\n=== SUMMARY (offseason holdout, n=${off.length}) ===`);
console.log(`  TULIP beat the Team A season-MPG baseline on ${beat}/${off.length} players (${(100 * beat / off.length).toFixed(1)}%)`);
console.log(`  mean |err|  TULIP ${(off.reduce((a, d) => a + Math.abs(d.err), 0) / off.length).toFixed(3)}  ·  baseline ${(off.reduce((a, d) => a + Math.abs(d.baseErr), 0) / off.length).toFixed(3)}`);
console.log(`  50% interval width ${(q(0.75) - q(0.25)).toFixed(1)} MPG — individual predictions are NOT precise`);

// TULIP CAPACITY — the finished product.
//
// SCOPE, set by the final gate and not by preference:
//   OFFSEASON moves  the portable model beats Team A season MPG, MAE gain +0.122 [0.035, 0.221].
//   IN-SEASON trades the gain is +0.040 [-0.075, 0.188] — NOT distinguishable from season MPG.
// So Capacity is issued with full confidence for offseason acquisitions and flagged as
// "season-MPG equivalent" for in-season trades. That distinction is part of the output, not a
// footnote.
//
// Model: Team A workload history + age/physicals/draft/production. Destination-context variables
// tested here added no incremental value beyond it and are excluded; that is a statement about THESE
// features, not about whether destination fit matters.
//
// Predicts SUSTAINABLE TEAM B WORKLOAD. It is not a validated latent physical/skill construct.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
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

/** Support grade: how many historical transitions resemble this one in established workload. */
const support = (d) => tr.filter((x) => Math.abs(x.aSeasonMpg - d.aSeasonMpg) <= 3).length;
const grade = (d) => {
  const n = support(d);
  const base = n >= 300 ? 'A' : n >= 150 ? 'B' : n >= 60 ? 'C' : 'D';
  // In-season trades did not beat season MPG, so they are capped: the model is not adding
  // demonstrated value there.
  return d.inSeason ? `${base}- (in-season: season-MPG equivalent)` : base;
};
for (const d of te) { d.cap = f(d); d.base = fb(d); d.hr = d.cap - d.aSeasonMpg; }

console.log('================ TULIP CAPACITY ================');
console.log(`trained ${seasons.slice(0, -1).join(', ')} · UNTOUCHED holdout ${last} · n=${te.length} transitions`);
console.log(`target: sustained MPG over first 10 games with the new team\n`);
{
  const mae = (g) => te.reduce((a, d) => a + Math.abs(g(d) - d.tFirst10), 0) / te.length;
  console.log(`  TULIP Capacity   MAE ${mae((d) => d.cap).toFixed(3)}`);
  console.log(`  Team A season MPG MAE ${mae((d) => d.base).toFixed(3)}   (the baseline it must beat)`);
  console.log(`  naive: Team A recent-10 MAE ${mae((d) => d.aRecent10).toFixed(3)}`);
}
const line = (d) => `  ${(nameOf.get(d.pid) || d.pid).slice(0, 20).padEnd(20)} ${d.inSeason ? 'trade' : 'offsn'} ${d.aSeasonMpg.toFixed(1).padStart(5)} ${d.cap.toFixed(1).padStart(6)} ${((d.hr >= 0 ? '+' : '') + d.hr.toFixed(1)).padStart(6)}  ${(d.cap + q(0.25)).toFixed(0)}-${(d.cap + q(0.75)).toFixed(0)}`.padEnd(66)
  + ` ${String(grade(d)).padEnd(32)} ${d.tFirst10.toFixed(1).padStart(5)} ${((d.tFirst10 - d.cap >= 0 ? '+' : '') + (d.tFirst10 - d.cap).toFixed(1)).padStart(6)}`;
const head = '  player               move  A-szn  TULIP   HEAD   50% int  evidence                         ACTUAL    err';

const off = te.filter((d) => !d.inSeason);
console.log(`\n=== LEADERBOARD · HIGHEST HEADROOM (offseason, where the model is validated) ===`);
console.log(head);
for (const d of [...off].sort((a, b) => b.hr - a.hr).slice(0, 10)) console.log(line(d));
console.log(`\n=== LOWEST HEADROOM (offseason) ===`);
console.log(head);
for (const d of [...off].sort((a, b) => a.hr - b.hr).slice(0, 8)) console.log(line(d));
console.log(`\n=== STRONGEST HITS (|err| smallest among |headroom| >= 4) ===`);
console.log(head);
for (const d of te.filter((x) => Math.abs(x.hr) >= 4).sort((a, b) => Math.abs(a.tFirst10 - a.cap) - Math.abs(b.tFirst10 - b.cap)).slice(0, 8)) console.log(line(d));
console.log(`\n=== STRONGEST MISSES ===`);
console.log(head);
for (const d of [...te].sort((a, b) => Math.abs(b.tFirst10 - b.cap) - Math.abs(a.tFirst10 - a.cap)).slice(0, 8)) console.log(line(d));

console.log(`\n=== HEADROOM CALIBRATION vs TEAM A SEASON MPG BASELINE (offseason, quintiles) ===`);
{
  const s = [...off].sort((a, b) => b.hr - a.hr), k = Math.floor(s.length / 5);
  const m = (g, fn) => g.reduce((a, x) => a + fn(x), 0) / g.length;
  console.log('  quintile  n    A-season   TULIP   baseline   ACTUAL   TULIP err   baseline err');
  for (let i = 0; i < 5; i++) {
    const g = s.slice(i * k, (i + 1) * k);
    if (g.length < 4) continue;
    console.log(`  ${String(i + 1).padStart(6)}  ${String(g.length).padStart(4)}    ${m(g, (x) => x.aSeasonMpg).toFixed(1).padStart(5)}   ${m(g, (x) => x.cap).toFixed(1).padStart(5)}    ${m(g, (x) => x.base).toFixed(1).padStart(5)}    ${m(g, (x) => x.tFirst10).toFixed(1).padStart(5)}      ${m(g, (x) => Math.abs(x.tFirst10 - x.cap)).toFixed(2)}          ${m(g, (x) => Math.abs(x.tFirst10 - x.base)).toFixed(2)}`);
  }
}

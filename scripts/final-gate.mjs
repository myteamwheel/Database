// FINAL GATE: does the portable model add signal beyond Team A SEASON MPG?
//
// recent-10 is no longer the bar — it does not travel. Season MPG does, and it is already strong, so
// the honest question is whether age/physicals/draft/production distinguish two players with the SAME
// established Team A workload. The matched-pair test therefore matches on season MPG.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const T = JSON.parse(fs.readFileSync(path.join(HIST, 'transitions.json'), 'utf8'));
const A_WORK = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aTrend', 'aStartRate', 'aGames', 'aSeasons', 'aCareerHighMpg'];
const A_ATTR = ['age', 'heightIn', 'weight', 'draftPick', 'undrafted', 'aGsPer36', 'aTs', 'aFgaPer36', 'aAstPer36', 'aRebPer36', 'aPfPer36'];
const B_CTX = ['bAhead', 'bMinsAhead', 'bBestAhead', 'bDepth'];
const BASE = ['aSeasonMpg'];
const PORT = [...A_WORK, ...A_ATTR];
const DEST = [...PORT, ...B_CTX];
const RIDGE = 1e-5;
function fit(train, FE, yk) {
  const m = FE.length + 1;
  const mu = FE.map((k) => train.reduce((a, d) => a + (d[k] ?? 0), 0) / train.length);
  const sd = FE.map((k, i) => Math.sqrt(train.reduce((a, d) => a + ((d[k] ?? 0) - mu[i]) ** 2, 0) / train.length) || 1);
  const z = (d) => FE.map((k, i) => ((d[k] ?? 0) - mu[i]) / sd[i]);
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
function folds5(pool, seed0 = 11) {
  const P = [...new Set(pool.map((d) => d.pid))];
  let seed = seed0; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const F = Array.from({ length: 5 }, () => new Set());
  [...P].sort(() => rnd() - 0.5).forEach((p, i) => F[i % 5].add(p));
  return F;
}
const spearman = (a, b) => {
  const rank = (v) => { const q = v.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]); const r = new Array(v.length); q.forEach(([, i], k) => { r[i] = k; }); return r; };
  const x = rank(a), y = rank(b), n = a.length, m = (n - 1) / 2;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { nu += (x[i] - m) * (y[i] - m); dx += (x[i] - m) ** 2; dy += (y[i] - m) ** 2; }
  return nu / Math.sqrt(dx * dy);
};
/** OOF predictions for several specs on IDENTICAL folds. */
function oofAll(pool, yk, specs) {
  const out = pool.map((d) => ({ d, actual: d[yk], pred: {} }));
  const idx = new Map(pool.map((d, i) => [d, i]));
  for (const t of folds5(pool)) {
    const tr = pool.filter((d) => !t.has(d.pid)), te = pool.filter((d) => t.has(d.pid));
    if (tr.length < 80 || !te.length) continue;
    for (const [n, FE] of Object.entries(specs)) {
      const f = fit(tr, FE, yk);
      for (const d of te) out[idx.get(d)].pred[n] = f(d);
    }
  }
  return out.filter((x) => Object.keys(x.pred).length === Object.keys(specs).length);
}
const metrics = (o, n) => {
  const mae = o.reduce((a, x) => a + Math.abs(x.pred[n] - x.actual), 0) / o.length;
  const my = o.reduce((a, x) => a + x.actual, 0) / o.length;
  let ssr = 0, sst = 0;
  for (const x of o) { ssr += (x.actual - x.pred[n]) ** 2; sst += (x.actual - my) ** 2; }
  return { mae, r2: 1 - ssr / sst, sp: spearman(o.map((x) => x.pred[n] - x.d.aSeasonMpg), o.map((x) => x.actual - x.d.aSeasonMpg)) };
};
/** Player-clustered bootstrap of the paired MAE difference (base - challenger). */
function pairedCI(o, base, chal, B = 2000) {
  const byP = new Map();
  for (const x of o) { const k = x.d.pid; if (!byP.has(k)) byP.set(k, []); byP.get(k).push(Math.abs(x.pred[base] - x.actual) - Math.abs(x.pred[chal] - x.actual)); }
  const g = [...byP.values()];
  const pt = o.reduce((a, x) => a + (Math.abs(x.pred[base] - x.actual) - Math.abs(x.pred[chal] - x.actual)), 0) / o.length;
  let seed = 41; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0;
    for (let i = 0; i < g.length; i++) { const gg = g[Math.floor(rnd() * g.length)]; for (const v of gg) { s += v; n++; } }
    boot.push(s / n); }
  boot.sort((a, b) => a - b);
  return { pt, lo: boot[Math.floor(0.025 * B)], hi: boot[Math.floor(0.975 * B)] };
}
const SPECS = { base: BASE, portable: PORT, dest: DEST };

console.log('===== 1. PORTABLE+ATTRS vs TEAM A SEASON MPG · all three windows =====');
for (const yk of ['tFirst10', 't6to15', 'tRest']) {
  const pool = T.filter((d) => Number.isFinite(d[yk]));
  const o = oofAll(pool, yk, SPECS);
  const b = metrics(o, 'base'), p = metrics(o, 'portable'), dd = metrics(o, 'dest');
  const ci = pairedCI(o, 'base', 'portable'), ciD = pairedCI(o, 'base', 'dest');
  console.log(`\n  ${yk} · n=${o.length}`);
  console.log(`    season MPG    MAE ${b.mae.toFixed(3)}  R2 ${b.r2.toFixed(4)}  Spearman ${b.sp.toFixed(3)}`);
  console.log(`    portable      MAE ${p.mae.toFixed(3)}  R2 ${p.r2.toFixed(4)}  Spearman ${p.sp.toFixed(3)}`);
  console.log(`    destination   MAE ${dd.mae.toFixed(3)}  R2 ${dd.r2.toFixed(4)}  Spearman ${dd.sp.toFixed(3)}`);
  console.log(`    portable - base: MAE gain ${ci.pt >= 0 ? '+' : ''}${ci.pt.toFixed(3)} 95% CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] ${(ci.lo > 0 || ci.hi < 0) ? 'EXCLUDES 0' : 'includes 0'}`
    + ` · dR2 ${(p.r2 - b.r2 >= 0 ? '+' : '')}${(p.r2 - b.r2).toFixed(4)} · dSpearman ${(p.sp - b.sp >= 0 ? '+' : '')}${(p.sp - b.sp).toFixed(3)}`);
  console.log(`    dest - base:     MAE gain ${ciD.pt >= 0 ? '+' : ''}${ciD.pt.toFixed(3)} 95% CI [${ciD.lo.toFixed(3)}, ${ciD.hi.toFixed(3)}] ${(ciD.lo > 0 || ciD.hi < 0) ? 'EXCLUDES 0' : 'includes 0'}`);
}

console.log('\n===== 2. MATCHED PAIRS ON TEAM A SEASON MPG (within 1.0) =====');
{
  const yk = 'tFirst10';
  const pool = T.filter((d) => Number.isFinite(d[yk]));
  const o = oofAll(pool, yk, SPECS);
  const PAIRS = [];
  for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) {
    if (o[i].d.pid === o[j].d.pid) continue;
    if (Math.abs(o[i].d.aSeasonMpg - o[j].d.aSeasonMpg) > 1.0) continue;
    if (Math.abs(o[i].actual - o[j].actual) < 1e-9) continue;
    PAIRS.push([i, j]);
  }
  const conc = (n, sub) => { let w = 0; for (const [i, j] of sub) { const h = o[i].pred[n] > o[j].pred[n] ? i : j, l = o[i].pred[n] > o[j].pred[n] ? j : i; if (o[h].actual > o[l].actual) w++; } return w / sub.length; };
  const players = [...new Set(o.map((x) => x.d.pid))];
  function ci(n, sub, B = 400) {
    let seed = 71; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const out = [];
    for (let b = 0; b < B; b++) {
      const keep = new Set();
      for (let i = 0; i < players.length; i++) keep.add(players[Math.floor(rnd() * players.length)]);
      const s = sub.filter(([i, j]) => keep.has(o[i].d.pid) && keep.has(o[j].d.pid));
      if (s.length < 30) continue;
      out.push(conc(n, s));
    }
    out.sort((a, b) => a - b);
    return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : [NaN, NaN];
  }
  console.log(`  pair universe: ${PAIRS.length} pairs`);
  console.log('  spec           all pairs             gap>=3 (n)          gap>=5 (n)');
  for (const n of ['base', 'portable', 'dest']) {
    const g3 = PAIRS.filter(([i, j]) => Math.abs(o[i].pred[n] - o[j].pred[n]) >= 3);
    const g5 = PAIRS.filter(([i, j]) => Math.abs(o[i].pred[n] - o[j].pred[n]) >= 5);
    const b = ci(n, PAIRS);
    console.log(`  ${n.padEnd(12)} ${(100 * conc(n, PAIRS)).toFixed(1)}% [${(100 * b[0]).toFixed(1)},${(100 * b[1]).toFixed(1)}]   `
      + `${g3.length > 30 ? (100 * conc(n, g3)).toFixed(1) + '% (' + g3.length + ')' : 'n=' + g3.length}`.padEnd(20)
      + `${g5.length > 30 ? (100 * conc(n, g5)).toFixed(1) + '% (' + g5.length + ')' : 'n=' + g5.length}`);
  }
}

console.log('\n===== 3. IN-SEASON vs OFFSEASON: does the advantage survive in both? =====');
for (const [lbl, sel] of [['offseason', (d) => !d.inSeason], ['in-season', (d) => d.inSeason]]) {
  const pool = T.filter((d) => Number.isFinite(d.tFirst10) && sel(d));
  const o = oofAll(pool, 'tFirst10', SPECS);
  const b = metrics(o, 'base'), p = metrics(o, 'portable');
  const ci = pairedCI(o, 'base', 'portable');
  console.log(`  ${lbl} n=${o.length}: season MPG MAE ${b.mae.toFixed(3)} (R2 ${b.r2.toFixed(4)}) · portable ${p.mae.toFixed(3)} (R2 ${p.r2.toFixed(4)})`);
  console.log(`    gain ${ci.pt >= 0 ? '+' : ''}${ci.pt.toFixed(3)} 95% CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] ${(ci.lo > 0 || ci.hi < 0) ? 'EXCLUDES 0' : 'includes 0'}`);
}

console.log('\n===== CHRONOLOGICAL HOLDOUT 2024-25 =====');
{
  const pool = T.filter((d) => Number.isFinite(d.tFirst10));
  const seasons = [...new Set(pool.map((d) => d.season))].sort();
  const last = seasons[seasons.length - 1];
  const tr = pool.filter((d) => d.season !== last), te = pool.filter((d) => d.season === last);
  for (const [n, FE] of Object.entries(SPECS)) {
    const f = fit(tr, FE, 'tFirst10');
    const mae = te.reduce((a, d) => a + Math.abs(f(d) - d.tFirst10), 0) / te.length;
    const my = te.reduce((a, d) => a + d.tFirst10, 0) / te.length;
    let ssr = 0, sst = 0;
    for (const d of te) { ssr += (d.tFirst10 - f(d)) ** 2; sst += (d.tFirst10 - my) ** 2; }
    console.log(`  ${n.padEnd(12)} MAE ${mae.toFixed(3)}  R2 ${(1 - ssr / sst).toFixed(4)}  Spearman ${spearman(te.map((d) => f(d) - d.aSeasonMpg), te.map((d) => d.tFirst10 - d.aSeasonMpg)).toFixed(3)}  n=${te.length}`);
  }
}

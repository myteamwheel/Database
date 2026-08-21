// Evaluation of the cross-team portability study.
//
// THE BAR IS recent-10 MPG ON TEAM A. Everything is reported as improvement over that, because that
// rule already reproduces the within-team ranking. The pair test therefore MATCHES on Team A
// recent-10 MPG: among two players who looked identical by recent minutes on their old team, can
// anything else tell us who sustains more on the new one?
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
const A_WORK = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aTrend', 'aStartRate', 'aGames', 'aSeasons', 'aCareerHighMpg'];
const A_ATTR = ['age', 'heightIn', 'weight', 'draftPick', 'undrafted', 'aGsPer36', 'aTs', 'aFgaPer36', 'aAstPer36', 'aRebPer36', 'aPfPer36'];
const B_CTX = ['bAhead', 'bMinsAhead', 'bBestAhead', 'bDepth'];
const SPECS = {
  '1 TeamA season MPG': ['aSeasonMpg'],
  '2 TeamA recent-10': ['aRecent10'],
  '3 recent-10 + trend': ['aRecent10', 'aTrend'],
  '4 PORTABLE player': A_WORK,
  '5 PORTABLE + attrs': [...A_WORK, ...A_ATTR],
  '6 DESTINATION-aware': [...A_WORK, ...A_ATTR, ...B_CTX],
};
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
function folds5(pool) {
  const P = [...new Set(pool.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
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
function evalSpec(pool, FE, yk) {
  const oof = [];
  for (const t of folds5(pool)) {
    const tr = pool.filter((d) => !t.has(d.pid)), te = pool.filter((d) => t.has(d.pid));
    if (tr.length < 80 || !te.length) continue;
    const f = fit(tr, FE, yk);
    for (const d of te) oof.push({ d, pred: f(d), actual: d[yk] });
  }
  const mae = oof.reduce((a, x) => a + Math.abs(x.pred - x.actual), 0) / oof.length;
  const my = oof.reduce((a, x) => a + x.actual, 0) / oof.length;
  let ssr = 0, sst = 0;
  for (const x of oof) { ssr += (x.actual - x.pred) ** 2; sst += (x.actual - my) ** 2; }
  const sp = spearman(oof.map((x) => x.pred - x.d.aRecent10), oof.map((x) => x.actual - x.d.aRecent10));
  return { mae, r2: 1 - ssr / sst, sp, n: oof.length, oof };
}

for (const yk of ['tFirst10', 't6to15', 'tRest']) {
  const pool = T.filter((d) => Number.isFinite(d[yk]));
  console.log(`\n===== TARGET: ${yk} · n=${pool.length} transitions · ${new Set(pool.map((d) => d.pid)).size} players =====`);
  console.log('  spec                     MAE      R2     Spearman(headroom,change)   vs recent-10');
  let base = null;
  for (const [n, FE] of Object.entries(SPECS)) {
    const s = evalSpec(pool, FE, yk);
    if (n.startsWith('2')) base = s.mae;
    const imp = base === null ? '' : `${(base - s.mae) >= 0 ? '+' : ''}${(base - s.mae).toFixed(3)} (${(100 * (base - s.mae) / base).toFixed(1)}%)`;
    console.log(`  ${n.padEnd(22)} ${s.mae.toFixed(3)}   ${s.r2.toFixed(4)}   ${s.sp.toFixed(3)}                      ${imp}`);
  }
}

// ---- pair test on the PRIMARY target, matched on Team A recent-10 ----
const yk = 'tFirst10';
const pool = T.filter((d) => Number.isFinite(d[yk]));
const seasons = [...new Set(pool.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = pool.filter((d) => d.season !== last), te = pool.filter((d) => d.season === last);
console.log(`\n===== CHRONOLOGICAL HOLDOUT: ${last} · train ${tr.length} · test ${te.length} =====`);
console.log('  spec                     MAE      R2     Spearman   vs recent-10');
const P = {}; let cbase = null;
for (const [n, FE] of Object.entries(SPECS)) {
  const f = fit(tr, FE, yk); P[n] = te.map((d) => f(d));
  const mae = te.reduce((a, d, i) => a + Math.abs(P[n][i] - d[yk]), 0) / te.length;
  const my = te.reduce((a, d) => a + d[yk], 0) / te.length;
  let ssr = 0, sst = 0;
  for (let i = 0; i < te.length; i++) { ssr += (te[i][yk] - P[n][i]) ** 2; sst += (te[i][yk] - my) ** 2; }
  if (n.startsWith('2')) cbase = mae;
  const sp = spearman(te.map((d, i) => P[n][i] - d.aRecent10), te.map((d) => d[yk] - d.aRecent10));
  console.log(`  ${n.padEnd(22)} ${mae.toFixed(3)}   ${(1 - ssr / sst).toFixed(4)}   ${sp.toFixed(3)}      ${cbase === null ? '' : `${(cbase - mae) >= 0 ? '+' : ''}${(cbase - mae).toFixed(3)}`}`);
}

// Pairs matched on Team A recent-10 within 1 MPG, pooled OOF across all seasons for power.
console.log('\n===== PAIRWISE: same Team A recent-10 MPG, who sustains more on Team B? =====');
{
  const oofBy = {};
  for (const [n, FE] of Object.entries(SPECS)) oofBy[n] = evalSpec(pool, FE, yk).oof;
  const ref = oofBy['2 TeamA recent-10'];
  const PAIRS = [];
  for (let i = 0; i < ref.length; i++) for (let j = i + 1; j < ref.length; j++) {
    if (ref[i].d.pid === ref[j].d.pid) continue;
    if (Math.abs(ref[i].d.aRecent10 - ref[j].d.aRecent10) > 1.0) continue;
    if (Math.abs(ref[i].actual - ref[j].actual) < 1e-9) continue;
    PAIRS.push([i, j]);
  }
  console.log(`  pair universe: ${PAIRS.length} pairs (matched on Team A recent-10 within 1.0)`);
  const conc = (o, sub) => { let w = 0; for (const [i, j] of sub) { const h = o[i].pred > o[j].pred ? i : j, l = o[i].pred > o[j].pred ? j : i; if (o[h].actual > o[l].actual) w++; } return w / sub.length; };
  const players = [...new Set(ref.map((x) => x.d.pid))];
  function ci(o, sub, B = 400) {
    let seed = 71; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const out = [];
    for (let b = 0; b < B; b++) {
      const keep = new Set();
      for (let i = 0; i < players.length; i++) keep.add(players[Math.floor(rnd() * players.length)]);
      const s = sub.filter(([i, j]) => keep.has(o[i].d.pid) && keep.has(o[j].d.pid));
      if (s.length < 30) continue;
      out.push(conc(o, s));
    }
    out.sort((a, b) => a - b);
    return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : [NaN, NaN];
  }
  console.log('  spec                     all pairs            gap>=3 (n)         gap>=5 (n)');
  for (const n of Object.keys(SPECS)) {
    const o = oofBy[n];
    const c = conc(o, PAIRS), b = ci(o, PAIRS);
    const g3 = PAIRS.filter(([i, j]) => Math.abs(o[i].pred - o[j].pred) >= 3);
    const g5 = PAIRS.filter(([i, j]) => Math.abs(o[i].pred - o[j].pred) >= 5);
    console.log(`  ${n.padEnd(22)} ${(100 * c).toFixed(1)}% [${(100 * b[0]).toFixed(1)},${(100 * b[1]).toFixed(1)}]   `
      + `${g3.length > 30 ? (100 * conc(o, g3)).toFixed(1) + '% (' + g3.length + ')' : 'n=' + g3.length}`.padEnd(20)
      + `${g5.length > 30 ? (100 * conc(o, g5)).toFixed(1) + '% (' + g5.length + ')' : 'n=' + g5.length}`);
  }
  console.log('\n  COVERAGE vs ACCURACY (most confident pairs first)');
  console.log('  spec                     5%      10%     20%     40%    100%');
  for (const n of Object.keys(SPECS)) {
    const o = oofBy[n];
    const srt = [...PAIRS].sort((a, b) => Math.abs(o[b[0]].pred - o[b[1]].pred) - Math.abs(o[a[0]].pred - o[a[1]].pred));
    console.log(`  ${n.padEnd(22)} ` + [0.05, 0.1, 0.2, 0.4, 1.0].map((c) => `${(100 * conc(o, srt.slice(0, Math.max(30, Math.floor(srt.length * c))))).toFixed(1)}%`.padStart(6)).join('  '));
  }
}

console.log('\n===== STRATIFIED: offseason vs in-season =====');
for (const [lbl, sel] of [['offseason', (d) => !d.inSeason], ['in-season', (d) => d.inSeason]]) {
  const p = pool.filter(sel);
  console.log(`  ${lbl} n=${p.length}`);
  for (const n of ['2 TeamA recent-10', '4 PORTABLE player', '6 DESTINATION-aware']) {
    const s = evalSpec(p, SPECS[n], yk);
    console.log(`    ${n.padEnd(22)} MAE ${s.mae.toFixed(3)}  R2 ${s.r2.toFixed(4)}  Spearman ${s.sp.toFixed(3)}`);
  }
}

// ===================================================================================
// HISTORICAL EXAMPLES — model frozen (spec 5, PORTABLE + attrs), trained on pre-2024-25 only.
// Selection rule fixed before names or outcomes were inspected:
//   top 6 / bottom 6 by predicted portable Headroom, then 4 largest misses in each direction.
// ===================================================================================
{
  const f = fit(tr, SPECS['5 PORTABLE + attrs'], 'tFirst10');
  const U = te.map((d) => ({ d, pred: f(d), hr: f(d) - d.aRecent10 }));
  const line = (x) => `  ${(nameOf.get(x.d.pid) || x.d.pid).slice(0, 21).padEnd(21)} ${x.d.inSeason ? 'trade ' : 'offsn '} A-recent ${x.d.aRecent10.toFixed(1).padStart(5)}  A-season ${x.d.aSeasonMpg.toFixed(1).padStart(5)}  pred ${x.pred.toFixed(1).padStart(5)}  hr ${((x.hr >= 0 ? '+' : '') + x.hr.toFixed(1)).padStart(6)}  TeamB ACTUAL ${x.d.tFirst10.toFixed(1).padStart(5)}  err ${((x.d.tFirst10 - x.pred >= 0 ? '+' : '') + (x.d.tFirst10 - x.pred).toFixed(1)).padStart(6)}`;
  const byHr = [...U].sort((a, b) => b.hr - a.hr);
  console.log(`\n===== CROSS-TEAM EXAMPLES · untouched ${last} · n=${te.length} =====`);
  console.log('\n  HIGH PORTABLE HEADROOM (predicted to gain on the new team):');
  for (const x of byHr.slice(0, 6)) console.log(line(x));
  console.log('\n  LOW PORTABLE HEADROOM (predicted to lose role on the new team):');
  for (const x of byHr.slice(-6)) console.log(line(x));
  const byErr = [...U].sort((a, b) => (b.d.tFirst10 - b.pred) - (a.d.tFirst10 - a.pred));
  console.log('\n  MISSES — predicted too LOW:');
  for (const x of byErr.slice(0, 4)) console.log(line(x));
  console.log('\n  MISSES — predicted too HIGH:');
  for (const x of byErr.slice(-4)) console.log(line(x));
  const m = (g, fn) => g.reduce((a, x) => a + fn(x), 0) / g.length;
  const k = Math.max(15, Math.floor(U.length / 5));
  console.log(`\n  GROUP CHECK (top vs bottom quintile of predicted portable headroom):`);
  for (const [lbl, g] of [['top   ', byHr.slice(0, k)], ['bottom', byHr.slice(-k)]]) {
    console.log(`    ${lbl} n=${g.length}  A-recent ${m(g, (x) => x.d.aRecent10).toFixed(1)}  predicted ${m(g, (x) => x.pred).toFixed(1)}  TeamB ACTUAL ${m(g, (x) => x.d.tFirst10).toFixed(1)}  (${(m(g, (x) => x.d.tFirst10) - m(g, (x) => x.d.aRecent10) >= 0 ? '+' : '') + (m(g, (x) => x.d.tFirst10) - m(g, (x) => x.d.aRecent10)).toFixed(1)} vs Team A recent)`);
  }
}

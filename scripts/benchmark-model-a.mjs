// IS MODEL A ACTUALLY EARNING ITS COMPLEXITY?
//
// R2 .553 means nothing in isolation. The question is whether the full model beats the obvious
// simple alternatives on the SAME grouped-player and chronological splits — above all
// "current MPG + opener minutes + starter status", which needs no model at all to justify.
//
// Six prespecified specifications, identical rows, identical folds, identical estimator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
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
  data.push({
    ...e.pre, baselineMpg: e.baselineMpg,
    openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    y: num / den, pid: String(e.playerId), season: e.season,
  });
}
console.log(`episodes ${data.length} · players ${new Set(data.map((d) => d.pid)).size}`);

const SPECS = {
  '1 mpg only': ['baselineMpg'],
  '2 opener only': ['openerMin'],
  '3 mpg+opener': ['baselineMpg', 'openerMin'],
  '4 mpg+opener+starter': ['baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart'],
  '5 simple quality': ['baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart', 'preGsPer36', 'preStartRate', 'preForm5'],
  '6 FULL Model A': ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
    'preRebPer36', 'preStartRate', 'baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart'],
};
const RIDGE = Number(process.env.RIDGE || 1e-6);
function fit(train, FE) {
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
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
function folds5() {
  const players = [...new Set(data.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const F = Array.from({ length: 5 }, () => new Set());
  [...players].sort(() => rnd() - 0.5).forEach((p, i) => F[i % 5].add(p));
  return F;
}
function oofFor(FE) {
  const out = [];
  for (const test of folds5()) {
    const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
    if (tr.length < 200 || !te.length) continue;
    const f = fit(tr, FE);
    const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
    for (const d of te) out.push({ d, pred: f(d), actual: d.y, resid });
  }
  return out;
}
function score(o) {
  const mae = o.reduce((a, x) => a + Math.abs(x.pred - x.actual), 0) / o.length;
  const my = o.reduce((a, x) => a + x.actual, 0) / o.length;
  let ssr = 0, sst = 0;
  for (const x of o) { ssr += (x.actual - x.pred) ** 2; sst += (x.actual - my) ** 2; }
  let crps = 0;
  for (const x of o) {
    let s2 = 0;
    for (const r of x.resid) s2 += Math.abs(x.pred + r - x.actual);
    let s3 = 0;
    for (let i = 0; i < x.resid.length; i += 7) for (let j = 0; j < x.resid.length; j += 7) s3 += Math.abs(x.resid[i] - x.resid[j]);
    const k = Math.ceil(x.resid.length / 7);
    crps += s2 / x.resid.length - 0.5 * s3 / (k * k);
  }
  return { mae, r2: 1 - ssr / sst, crps: crps / o.length, n: o.length };
}
function chrono(FE) {
  const seasons = [...new Set(data.map((d) => d.season))].sort();
  const last = seasons[seasons.length - 1];
  const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
  const f = fit(tr, FE);
  const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
  return score(te.map((d) => ({ d, pred: f(d), actual: d.y, resid })));
}

console.log('\n===== GROUPED 5-FOLD BY PLAYER =====');
console.log('  spec                     MAE      R2       CRPS');
const G = {}, C = {};
for (const [n, FE] of Object.entries(SPECS)) {
  G[n] = score(oofFor(FE)); C[n] = chrono(FE);
  console.log(`  ${n.padEnd(22)} ${G[n].mae.toFixed(3)}   ${G[n].r2.toFixed(4)}   ${G[n].crps.toFixed(3)}`);
}
console.log('\n===== CHRONOLOGICAL HOLDOUT (2024-25) =====');
console.log('  spec                     MAE      R2       CRPS     n');
for (const n of Object.keys(SPECS)) console.log(`  ${n.padEnd(22)} ${C[n].mae.toFixed(3)}   ${C[n].r2.toFixed(4)}   ${C[n].crps.toFixed(3)}   ${C[n].n}`);

// The comparison that matters: full model vs the BEST simple alternative, not vs always-mean.
const simple = Object.keys(SPECS).filter((k) => !k.startsWith('6'));
const bestG = simple.reduce((a, b) => (G[b].mae < G[a].mae ? b : a));
const bestC = simple.reduce((a, b) => (C[b].mae < C[a].mae ? b : a));
console.log('\n===== FULL MODEL vs BEST SIMPLE BASELINE =====');
console.log(`  grouped: best simple = "${bestG}" MAE ${G[bestG].mae.toFixed(3)} · full ${G['6 FULL Model A'].mae.toFixed(3)}`);
console.log(`           gain ${(G[bestG].mae - G['6 FULL Model A'].mae).toFixed(3)} MAE (${(100 * (G[bestG].mae - G['6 FULL Model A'].mae) / G[bestG].mae).toFixed(2)}%) · R2 ${(G['6 FULL Model A'].r2 - G[bestG].r2 >= 0 ? '+' : '')}${(G['6 FULL Model A'].r2 - G[bestG].r2).toFixed(4)} · CRPS ${(G['6 FULL Model A'].crps - G[bestG].crps).toFixed(3)}`);
console.log(`  chrono:  best simple = "${bestC}" MAE ${C[bestC].mae.toFixed(3)} · full ${C['6 FULL Model A'].mae.toFixed(3)}`);
console.log(`           gain ${(C[bestC].mae - C['6 FULL Model A'].mae).toFixed(3)} MAE (${(100 * (C[bestC].mae - C['6 FULL Model A'].mae) / C[bestC].mae).toFixed(2)}%) · R2 ${(C['6 FULL Model A'].r2 - C[bestC].r2 >= 0 ? '+' : '')}${(C['6 FULL Model A'].r2 - C[bestC].r2).toFixed(4)}`);

// Player-clustered bootstrap on the full-vs-best-simple MAE difference.
{
  const oA = oofFor(SPECS[bestG]), oF = oofFor(SPECS['6 FULL Model A']);
  const byP = new Map();
  for (let i = 0; i < oA.length; i++) {
    const p = oA[i].d.pid, diff = Math.abs(oA[i].pred - oA[i].actual) - Math.abs(oF[i].pred - oF[i].actual);
    if (!byP.has(p)) byP.set(p, []);
    byP.get(p).push(diff);
  }
  const groups = [...byP.values()];
  let seed = 31; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(rnd() * groups.length)]; for (const v of g) { s += v; n++; } }
    boot.push(s / n);
  }
  boot.sort((a, b) => a - b);
  const pt = [...byP.values()].flat().reduce((a, b) => a + b, 0) / oA.length;
  console.log(`  bootstrap: ${pt >= 0 ? '+' : ''}${pt.toFixed(3)} MAE  95% CI [${boot[50].toFixed(3)}, ${boot[1950].toFixed(3)}]  ${(boot[50] > 0 || boot[1950] < 0) ? 'excludes 0' : 'INCLUDES 0'}`);
}

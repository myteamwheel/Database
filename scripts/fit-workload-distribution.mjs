// MODEL A (production) — sustained latent workload after an expanded-role opportunity.
//
// WHY NOT SURVIVAL AGAINST A THRESHOLD. Treating one game below "target - 2" as role loss measured
// nightly MINUTES VARIANCE, not role: per-game hazard came out at 54%, a coin flip, because NBA
// minutes swing far more than 2 minutes for blowouts, foul trouble, back-to-backs and matchups. The
// construct was wrong, so its AUC and calibration were beside the point.
//
// WHAT THIS MODELS INSTEAD. A player's rotation role is LATENT; each game's minutes are a noisy
// observation of it:
//     observed minutes = latent role + game noise
// The latent sustained role is estimated with an exponentially weighted average over the follow-up
// games, which lets one quiet night be absorbed as noise rather than end a spell, and needs no
// arbitrary choice of "exactly three games".
//
// The model then predicts the DISTRIBUTION of that sustained workload, so survival-style answers
// become derived queries rather than the thing being fitted:
//     P(sustain >= 24) , P(sustain >= 26) , expected sustained MPG, interval
//
// This also captures partial retention, which a binary target throws away. A 19-MPG player pushed
// toward 27 who settles at 25.5 is not a failure — that IS his capacity, and the distribution says so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;      // EWMA weight on the most recent game
// ASSIGNED vs REALIZED workload. Early-rotation "assigned workload" was built and TESTED against
// this model (fit-assigned-workload.mjs) on 4,849 episodes: alone it is significantly WORSE than
// openerMin, and added on top it buys 0.32% MAE with every prespecified subgroup non-significant,
// including the large-expansion and promoted-to-starter cases TULIP targets. It is not carried here.
//
// The one genuine assignment signal is whether he was moved into the STARTING LINEUP, which is fixed
// before tip-off and cannot be contaminated by foul trouble, blowouts or overtime the way final
// minutes are. NOTE: gamelog.json ships `started: null` on every row, so this feature was silently a
// CONSTANT ZERO until the flags were attached from starters_*.json below.
//
// So the model carries both, and they mean different things:
//   openerMin       what he actually logged (realized, partly an outcome)
//   startedOpener   whether the team promoted him to the starting five (assigned, pre-game)
// The prediction must therefore be named precisely: it is the sustained workload after a player
// ACTUALLY REACHES a given opening workload, not merely because a team intends to offer it.
const FEATS = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
{
  const cov = attachStarterFlags(rows, HIST);
  console.log(`starter flags attached: ${cov.set} rows covered (${(100 * cov.coverage).toFixed(1)}%)`);
}

/** Latent sustained role: exponentially weighted mean of the follow-up games, recent weighted more. */
function latentWorkload(outcomeRows) {
  if (!outcomeRows.length) return null;
  let num = 0, den = 0, w = 1;
  for (let i = outcomeRows.length - 1; i >= 0; i--) {
    num += w * (outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA;
  }
  return den > 0 ? num / den : null;
}
const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  const sustained = latentWorkload(e.outcomeRows);
  if (!Number.isFinite(sustained)) continue;
  data.push({
    ...e.pre, baselineMpg: e.baselineMpg,
    openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    // Promotion is the cleanest assignment signal available: he started this game while normally
    // coming off the bench.
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    y: sustained, followGames: e.outcomeRows.length,
    pid: String(e.playerId), season: e.season,
  });
}
console.log(`episodes ${data.length} · players ${new Set(data.map((d) => d.pid)).size}`);
console.log(`sustained workload: mean ${(data.reduce((a, d) => a + d.y, 0) / data.length).toFixed(1)} MPG`);

function ols(train) {
  const m = FEATS.length + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FEATS.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; }
  }
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
  const w = A.map((r, i) => r[m] / A[i][i]);
  return (d) => w[0] + FEATS.reduce((s, k, i) => s + w[i + 1] * (d[k] ?? 0), 0);
}

// Grouped 5-fold by player: predictions, and the residual distribution used to answer P(sustain>=T).
const players = [...new Set(data.map((d) => d.pid))];
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const shuf = [...players].sort(() => rnd() - 0.5);
const folds = Array.from({ length: 5 }, () => new Set());
shuf.forEach((p, i) => folds[i % 5].add(p));
const oof = [];
for (const test of folds) {
  const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
  if (tr.length < 200 || te.length < 50) continue;
  const f = ols(tr);
  const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
  for (const d of te) oof.push({ pred: f(d), actual: d.y, resid });
}
const mae = oof.reduce((a, o) => a + Math.abs(o.pred - o.actual), 0) / oof.length;
const my = oof.reduce((a, o) => a + o.actual, 0) / oof.length;
const baseMae = oof.reduce((a, o) => a + Math.abs(my - o.actual), 0) / oof.length;
let ssr = 0, sst = 0;
for (const o of oof) { ssr += (o.actual - o.pred) ** 2; sst += (o.actual - my) ** 2; }
console.log(`\nOUT-OF-SAMPLE (grouped by player, n=${oof.length})`);
console.log(`  MAE ${mae.toFixed(2)} MPG   vs ${baseMae.toFixed(2)} for always-predict-mean`);
console.log(`  R2  ${(1 - ssr / sst).toFixed(4)}`);

// Calibration of the derived probabilities: P(sustain >= T) from the residual distribution.
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
const pAtLeast = (o, T) => {
  // share of residuals that would put the outcome at or above T
  let c = 0;
  for (const r of o.resid) if (o.pred + r >= T) c++;
  return c / o.resid.length;
};
console.log(`\nCALIBRATION of P(sustain >= T), pooled over targets 20/24/28 MPG`);
const bucket = new Map();
for (const o of oof) for (const T of [20, 24, 28]) {
  const p = pAtLeast(o, T), b = Math.min(9, Math.floor(p * 10));
  const g = bucket.get(b) || { n: 0, p: 0, y: 0 };
  g.n++; g.p += p; g.y += o.actual >= T ? 1 : 0; bucket.set(b, g);
}
let e = 0, tot = 0;
for (const [b, g] of [...bucket.entries()].sort((a, c) => a[0] - c[0])) {
  if (g.n < 50) continue;
  const pm = 100 * g.p / g.n, am = 100 * g.y / g.n;
  e += g.n * Math.abs(pm - am); tot += g.n;
  console.log(`  ${String(b * 10).padStart(2)}-${(b + 1) * 10}%  predicted ${pm.toFixed(1)}%   actual ${am.toFixed(1)}%   n=${g.n}`);
}
console.log(`  ECE ${(e / tot).toFixed(2)}%`);

// Worked example, replacing the brittle survival curve.
const f = ols(data);
const resid = data.map((d) => d.y - f(d)).sort((a, b) => a - b);
const ex = { preGsPer36: 14, preForm5: 14, preTs: 0.56, preFgaPer36: 13, preAstPer36: 4,
  preTovPer36: 2, preRebPer36: 6, preStartRate: 0.2, baselineMpg: 19, openerMin: 27,
  startedOpener: 1, promotedToStart: 1 };
const pt = f(ex);
// Does the predicted 50% interval actually contain 50% of outcomes? A distribution can produce
// well-calibrated P(>=T) at a few thresholds while being systematically too wide or too narrow.
console.log(`\nDISTRIBUTION VALIDATION — interval coverage`);
for (const lvl of [0.5, 0.8, 0.9]) {
  const lo = (1 - lvl) / 2, hi = 1 - lo;
  let hit = 0;
  for (const o of oof) {
    const a = o.pred + q(o.resid, lo), b = o.pred + q(o.resid, hi);
    if (o.actual >= a && o.actual <= b) hit++;
  }
  const cov = 100 * hit / oof.length;
  console.log(`  nominal ${(100 * lvl).toFixed(0)}%  actual coverage ${cov.toFixed(1)}%  ${Math.abs(cov - 100 * lvl) < 3 ? 'OK' : cov > 100 * lvl ? 'TOO WIDE' : 'TOO NARROW'}`);
}
// CRPS: a proper scoring rule for the whole distribution, not just its mean or a threshold.
let crps = 0;
for (const o of oof) {
  let s2 = 0;
  for (const r of o.resid) s2 += Math.abs(o.pred + r - o.actual);
  let s3 = 0;
  for (let i = 0; i < o.resid.length; i += 7) for (let j = 0; j < o.resid.length; j += 7) s3 += Math.abs(o.resid[i] - o.resid[j]);
  const k = Math.ceil(o.resid.length / 7);
  crps += s2 / o.resid.length - 0.5 * s3 / (k * k);
}
console.log(`  CRPS ${(crps / oof.length).toFixed(3)} MPG  (lower better; proper scoring rule)`);

// Historical support: TULIP must not extrapolate confidently past where comparable jumps exist.
console.log(`\nHISTORICAL SUPPORT by attempted increase over baseline`);
for (const [lo, hi] of [[0, 4], [4, 8], [8, 12], [12, 16], [16, 99]]) {
  const n = data.filter((d) => d.openerMin - d.baselineMpg >= lo && d.openerMin - d.baselineMpg < hi).length;
  const label = n >= 800 ? 'High' : n >= 250 ? 'Moderate' : n >= 80 ? 'Low' : 'INSUFFICIENT — abstain';
  console.log(`  +${lo}-${hi} MPG   n=${String(n).padStart(5)}   ${label}`);
}

console.log(`\nWORKED EXAMPLE — 19.0 MPG baseline, opener 27 MPG`);
console.log(`  expected sustained workload  ${pt.toFixed(1)} MPG`);
console.log(`  50% interval                 ${(pt + q(resid, 0.25)).toFixed(1)} to ${(pt + q(resid, 0.75)).toFixed(1)} MPG`);
for (const T of [22, 24, 26, 28]) {
  let c = 0; for (const r of resid) if (pt + r >= T) c++;
  console.log(`  P(sustain >= ${T} MPG)          ${(100 * c / resid.length).toFixed(0)}%`);
}

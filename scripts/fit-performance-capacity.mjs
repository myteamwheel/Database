// MODEL B — PERFORMANCE CAPACITY.
//
// Model A asks whether a workload PERSISTS. That is only half of capacity: a player who holds 32 MPG
// while producing at a replacement rate has demonstrated availability, not capacity. Model B asks the
// other half — conditional on actually receiving workload w, how well does effectiveness hold up?
//
// NOT REDUCED TO ONE NUMBER. Effectiveness is predicted as separate components, because they fail
// differently: a player can hold his efficiency while his creation collapses, and a single summary
// metric hides that. The summary is reported alongside the components, never instead of them.
//
// WHAT THIS IS AND IS NOT. w is the workload being EVALUATED and the components are measured over
// the same follow-up window, so the w coefficient is NOT a causal effect of minutes — that would be
// the same-game simultaneity that killed TULIP v1. This is a conditional predictive object:
// "given he ends up playing w, what does his production look like", which is exactly the query TULIP
// needs for a candidate workload. Every predictor is pre-event; nothing from the outcome window
// enters the right-hand side except w itself.
//
// THRESHOLDS. "Remains effective" is reported at explicit, non-tuned levels. The primary one is
// delta = 0 against the player's OWN pre-event rate — he holds what he was already doing — which is
// principled rather than fitted. Others are shown for transparency, not selected on calibration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';
import { gameScore } from './lib/minutes-response.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const MIN_FOLLOW = Number(process.env.MIN_FOLLOW || 3);
const MIN_FOLLOW_MIN = 8;

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
attachStarterFlags(rows, HIST);

const per36 = (v, m) => (m > 0 ? 36 * v / m : null);
const tsOf = (pts, fga, fta) => (fga + 0.44 * fta > 0 ? pts / (2 * (fga + 0.44 * fta)) : null);

// COMPONENTS. Defence is the weak one: the box score sees steals, blocks and defensive rebounds and
// nothing else, so this is an acknowledged proxy, not a defensive rating.
const COMPONENTS = [
  ['ts', 'scoring efficiency (TS%)'],
  ['fgaPer36', 'scoring volume (FGA/36)'],
  ['astPer36', 'creation (AST/36)'],
  ['tovPer36', 'turnovers (TOV/36)'],
  ['rebPer36', 'rebounding (REB/36)'],
  ['stlBlkPer36', 'defensive box proxy (STL+BLK/36)'],
  ['gsPer36', 'summary (GameScore/36)'],
];

const data = [];
let censored = 0;
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  const fr = e.outcomeRows.filter((r) => (r.min ?? 0) >= MIN_FOLLOW_MIN);
  if (fr.length < MIN_FOLLOW) { censored++; continue; }
  const m = fr.reduce((a, r) => a + r.min, 0);
  if (m <= 0) { censored++; continue; }
  const sum = (k) => fr.reduce((a, r) => a + (r[k] ?? 0), 0);
  const d = {
    ...e.pre, baselineMpg: e.baselineMpg,
    w: m / fr.length,                                    // the workload being evaluated
    ts: tsOf(sum('pts'), sum('fga'), sum('fta')),
    fgaPer36: per36(sum('fga'), m), astPer36: per36(sum('ast'), m),
    tovPer36: per36(sum('tov'), m), rebPer36: per36(sum('reb'), m),
    stlBlkPer36: per36(sum('stl') + sum('blk'), m),
    gsPer36: per36(fr.reduce((a, r) => a + (gameScore(r) ?? 0), 0), m),
    pid: String(e.playerId), season: e.season, nFollow: fr.length,
  };
  d.wGain = d.w - e.baselineMpg;
  data.push(d);
}
console.log('MODEL B — PERFORMANCE CAPACITY');
console.log(`episodes ${data.length} · players ${new Set(data.map((x) => x.pid)).size} · censored (<${MIN_FOLLOW} usable follow-ups) ${censored}`);
console.log('NOTE: conditioning on >=3 usable follow-up games is conditioning on PERSISTENCE, which is');
console.log('      the definition of "given the role is received" — but it is a post-treatment');
console.log('      selection, so Model B is conditional and cannot be read marginally.');

const PRE = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg'];
// Baselines first, then the workload terms, so any gain is attributable.
const SETS = {
  'pre-only': PRE,
  'pre+w': [...PRE, 'w'],
  'pre+w+gain': [...PRE, 'w', 'wGain'],
};
const RIDGE = 1e-6;
function fit(train, FE, yk) {
  const m = FE.length + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d[yk]; }
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
function groupedOOF(FE, yk) {
  const out = [];
  for (const test of folds5()) {
    const tr = data.filter((d) => !test.has(d.pid) && Number.isFinite(d[yk]));
    const te = data.filter((d) => test.has(d.pid) && Number.isFinite(d[yk]));
    if (tr.length < 100 || !te.length) continue;
    const f = fit(tr, FE, yk);
    const resid = tr.map((d) => d[yk] - f(d)).sort((a, b) => a - b);
    for (const d of te) out.push({ d, pred: f(d), actual: d[yk], resid });
  }
  return out;
}
const metrics = (o) => {
  const mae = o.reduce((a, x) => a + Math.abs(x.pred - x.actual), 0) / o.length;
  const my = o.reduce((a, x) => a + x.actual, 0) / o.length;
  let ssr = 0, sst = 0;
  for (const x of o) { ssr += (x.actual - x.pred) ** 2; sst += (x.actual - my) ** 2; }
  const base = o.reduce((a, x) => a + Math.abs(my - x.actual), 0) / o.length;
  return { mae, r2: 1 - ssr / sst, base, n: o.length };
};

console.log('\n===== COMPONENT PREDICTION (grouped 5-fold by player) =====');
console.log('  component                          set          MAE    vs mean     R2');
for (const [k, label] of COMPONENTS) {
  for (const sn of Object.keys(SETS)) {
    const o = groupedOOF(SETS[sn], k);
    if (!o.length) continue;
    const m = metrics(o);
    console.log(`  ${(sn === 'pre-only' ? label : '').padEnd(34)} ${sn.padEnd(11)} ${m.mae.toFixed(4)}   ${m.base.toFixed(4)}   ${m.r2.toFixed(4)}`);
  }
}

// Does knowing w actually help predict effectiveness? If not, effectiveness is workload-invariant in
// this range, which is itself the answer TULIP needs.
console.log('\n===== DOES WORKLOAD IMPROVE EFFECTIVENESS PREDICTION? (pre+w vs pre-only) =====');
for (const [k, label] of COMPONENTS) {
  const a = metrics(groupedOOF(SETS['pre-only'], k)), b = metrics(groupedOOF(SETS['pre+w'], k));
  const rel = 100 * (a.mae - b.mae) / a.mae;
  console.log(`  ${label.padEnd(34)} ${(a.mae - b.mae >= 0 ? '+' : '')}${(a.mae - b.mae).toFixed(4)}  (${rel >= 0 ? '+' : ''}${rel.toFixed(2)}%)`);
}

// P(remains effective | w): derived from the residual distribution, at explicit untuned thresholds.
console.log('\n===== P(REMAINS EFFECTIVE | w) — calibration, threshold = holds own pre-event GS/36 =====');
{
  const oof = groupedOOF(SETS['pre+w'], 'gsPer36');
  const pGE = (o, T) => o.resid.reduce((c, r) => c + (o.pred + r >= T ? 1 : 0), 0) / o.resid.length;
  const buckets = new Map();
  for (const o of oof) {
    const T = o.d.preGsPer36;                 // delta = 0: holds his own prior rate
    const p = pGE(o, T), b = Math.min(9, Math.floor(p * 10));
    const g = buckets.get(b) || { n: 0, p: 0, y: 0 };
    g.n++; g.p += p; g.y += o.actual >= T ? 1 : 0; buckets.set(b, g);
  }
  let ece = 0, tot = 0;
  for (const [b, g] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    if (g.n < 50) continue;
    const pm = 100 * g.p / g.n, am = 100 * g.y / g.n;
    ece += g.n * Math.abs(pm - am); tot += g.n;
    console.log(`  ${String(b * 10).padStart(3)}-${b * 10 + 10}%  predicted ${pm.toFixed(1)}%  actual ${am.toFixed(1)}%  n=${g.n}`);
  }
  console.log(`  ECE ${(ece / tot).toFixed(2)}%`);
  const cov = (lvl) => {
    let hit = 0;
    for (const o of oof) {
      const lo = o.resid[Math.floor((0.5 - lvl / 2) * o.resid.length)];
      const hi = o.resid[Math.min(o.resid.length - 1, Math.floor((0.5 + lvl / 2) * o.resid.length))];
      if (o.actual >= o.pred + lo && o.actual <= o.pred + hi) hit++;
    }
    return 100 * hit / oof.length;
  };
  console.log(`  interval coverage  50% -> ${cov(0.5).toFixed(1)}%   80% -> ${cov(0.8).toFixed(1)}%   90% -> ${cov(0.9).toFixed(1)}%`);
}

console.log('\n===== ACCURACY BY WORKLOAD RANGE, WITH LOCAL SUPPORT =====');
{
  const oof = groupedOOF(SETS['pre+w'], 'gsPer36');
  console.log('  w band      n      MAE    support');
  for (const [lo, hi] of [[0, 18], [18, 22], [22, 26], [26, 30], [30, 34], [34, 99]]) {
    const s = oof.filter((o) => o.d.w >= lo && o.d.w < hi);
    if (!s.length) continue;
    const m = metrics(s);
    const sup = s.length >= 500 ? 'High' : s.length >= 200 ? 'Moderate' : s.length >= 60 ? 'Low' : 'INSUFFICIENT — abstain';
    console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(3)}  ${String(m.n).padStart(5)}   ${m.mae.toFixed(3)}   ${sup}`);
  }
}

console.log('\n===== CHRONOLOGICAL HOLDOUT (latest season) =====');
{
  const seasons = [...new Set(data.map((d) => d.season))].sort();
  const last = seasons[seasons.length - 1];
  const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
  console.log(`  held out ${last} · train ${tr.length} · test ${te.length}`);
  for (const [k, label] of COMPONENTS) {
    const t2 = tr.filter((d) => Number.isFinite(d[k])), e2 = te.filter((d) => Number.isFinite(d[k]));
    if (t2.length < 100 || e2.length < 30) continue;
    const f = fit(t2, SETS['pre+w'], k);
    const mae = e2.reduce((a, d) => a + Math.abs(f(d) - d[k]), 0) / e2.length;
    const my = e2.reduce((a, d) => a + d[k], 0) / e2.length;
    let ssr = 0, sst = 0;
    for (const d of e2) { ssr += (d[k] - f(d)) ** 2; sst += (d[k] - my) ** 2; }
    console.log(`  ${label.padEnd(34)} MAE ${mae.toFixed(4)}  R2 ${(1 - ssr / sst).toFixed(4)}  n=${e2.length}`);
  }
}

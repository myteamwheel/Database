// DEPLOYMENT-MODE BENCHMARK — the gate that decides what TULIP actually is.
//
// The 73.2%/79.8% discrimination result was produced by a model whose strongest inputs are OPENER
// MINUTES and OPENER STARTER STATUS. Those are observed only AFTER the opportunity has been given.
// So that result can only support:
//     "once a player has received an expanded role, we can predict whether it sticks"
// It cannot support the front-office question:
//     "before we acquire this 19-MPG player, does he plausibly have 26-MPG capacity?"
//
// This benchmark separates the two and tests them on ONE fixed pair universe:
//   PRE-OPPORTUNITY   nothing from the opener game or later; deployable before acquisition
//   POST-OPPORTUNITY  the current spec 5; role-persistence / opportunity confirmation
// plus the trivial baselines, because if `openerMin + starter` already reaches 73-80% then TULIP has
// not earned the headline — the observed opportunity has.
//
// LIMITATION: no birthdate is available anywhere in this dataset, so age cannot be used. A seasons-
// observed experience proxy is included in its place and is a poor substitute; a real pre-opportunity
// product would want true age.
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
const nameOf = new Map();
// Experience proxy: how many distinct seasons this player has appeared in up to and including this
// one. Not age, and it does not distinguish a 30-year-old journeyman from a 24-year-old.
const seasonsSeen = new Map();
for (const r of rows) {
  nameOf.set(String(r.playerId), r.playerName);
  const k = String(r.playerId);
  if (!seasonsSeen.has(k)) seasonsSeen.set(k, new Set());
  seasonsSeen.get(k).add(r.season);
}

const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  let num = 0, den = 0, w = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w * (e.outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  if (!(den > 0)) continue;
  const pid = String(e.playerId);
  data.push({ ...e.pre, baselineMpg: e.baselineMpg,
    openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    experience: [...(seasonsSeen.get(pid) || [])].filter((s) => s <= e.season).length,
    y: num / den, pid, season: e.season, nFollow: e.outcomeRows.length });
}

// PRE-OPPORTUNITY: nothing observed at or after the opener.
const PRE_ONLY = ['baselineMpg', 'preStartRate', 'preGsPer36', 'preForm5', 'preTs', 'preFgaPer36',
  'preAstPer36', 'preTovPer36', 'preRebPer36', 'experience'];
const METHODS = {
  'current MPG only': ['baselineMpg'],
  'openerMin only': ['openerMin'],
  'openerMin + starter': ['openerMin', 'startedOpener', 'promotedToStart'],
  'PRE-OPPORTUNITY TULIP': PRE_ONLY,
  'POST-OPP (spec 5)': ['baselineMpg', 'openerMin', 'startedOpener', 'promotedToStart', 'preGsPer36', 'preStartRate', 'preForm5'],
};
const RIDGE = 1e-6;
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
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
  }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
const seasons = [...new Set(data.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
console.log(`train ${tr.length} (${seasons.slice(0, -1).join(', ')}) · held out ${last} n=${te.length}`);

const preds = {};
for (const [n, FE] of Object.entries(METHODS)) { const f = fit(tr, FE); preds[n] = te.map((d) => f(d)); }

// ONE fixed pair universe, identical for every method: different players, current workload within
// 1 MPG, and an actual difference in outcome to resolve.
const PAIRS = [];
{
  let seed = 17; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const idx = te.map((_, i) => i).sort(() => rnd() - 0.5);
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a], j = idx[b];
      if (te[i].pid === te[j].pid) continue;
      if (Math.abs(te[i].baselineMpg - te[j].baselineMpg) > 1.0) continue;
      if (Math.abs(te[i].y - te[j].y) < 1e-9) continue;
      PAIRS.push([i, j]);
    }
  }
}
console.log(`fixed pair universe: ${PAIRS.length} pairs (same current MPG within 1.0, different outcomes)\n`);

/** Player-clustered bootstrap: resample PLAYERS, keep pairs whose BOTH members survive. */
function clusteredCI(pairSel, scoreFn, B = 800) {
  const players = [...new Set(te.map((d) => d.pid))];
  let seed = 71; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let b = 0; b < B; b++) {
    const keep = new Set();
    for (let i = 0; i < players.length; i++) keep.add(players[Math.floor(rnd() * players.length)]);
    const sub = pairSel.filter(([i, j]) => keep.has(te[i].pid) && keep.has(te[j].pid));
    if (sub.length < 30) continue;
    out.push(scoreFn(sub));
  }
  out.sort((a, b) => a - b);
  return out.length ? { lo: out[Math.floor(0.025 * out.length)], hi: out[Math.floor(0.975 * out.length)] } : { lo: NaN, hi: NaN };
}
const concord = (p, sub) => {
  let win = 0;
  for (const [i, j] of sub) {
    const hi = p[i] > p[j] ? i : j, lo = p[i] > p[j] ? j : i;
    if (te[hi].y > te[lo].y) win++;
  }
  return win / sub.length;
};
/** Spearman between predicted headroom and actual change in workload. */
function spearman(p) {
  const hr = te.map((d, i) => p[i] - d.baselineMpg), ac = te.map((d) => d.y - d.baselineMpg);
  const rank = (v) => { const s = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); s.forEach(([, i], k) => { r[i] = k; }); return r; };
  const a = rank(hr), b = rank(ac), n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - ma); da += (a[i] - ma) ** 2; db += (b[i] - ma) ** 2; }
  return num / Math.sqrt(da * db);
}

console.log('===== CONCORDANCE ON THE FIXED PAIR UNIVERSE (50% = no skill) =====');
console.log('  method                    all pairs           gap>=3              gap>=5           Spearman');
for (const n of Object.keys(METHODS)) {
  const p = preds[n];
  const all = concord(p, PAIRS);
  const ciA = clusteredCI(PAIRS, (s) => concord(p, s));
  const g3 = PAIRS.filter(([i, j]) => Math.abs(p[i] - p[j]) >= 3);
  const g5 = PAIRS.filter(([i, j]) => Math.abs(p[i] - p[j]) >= 5);
  const c3 = g3.length > 30 ? concord(p, g3) : NaN, c5 = g5.length > 30 ? concord(p, g5) : NaN;
  const ci3 = g3.length > 30 ? clusteredCI(g3, (s) => concord(p, s)) : { lo: NaN, hi: NaN };
  console.log(`  ${n.padEnd(23)} ${(100 * all).toFixed(1)}% [${(100 * ciA.lo).toFixed(1)},${(100 * ciA.hi).toFixed(1)}]  `
    + `${(100 * c3).toFixed(1)}% [${(100 * ci3.lo).toFixed(1)},${(100 * ci3.hi).toFixed(1)}] n=${String(g3.length).padStart(6)}  `
    + `${(100 * c5).toFixed(1)}% n=${String(g5.length).padStart(6)}   ${spearman(p).toFixed(3)}`);
}
console.log('\n  "all pairs" is the comparable column: same pairs, same outcomes, only the predictor changes.');
console.log('  gap>=3 / gap>=5 subsets are METHOD-SPECIFIC (each picks its own confident pairs), so n differs.');

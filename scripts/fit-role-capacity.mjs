// MODEL A — Role Capacity.
//
// Predicts P(a player sustains a PROPOSED workload | only pre-event information).
//
// Target definition, fixed deliberately: success at target T means the player averaged at least
// T - BAND minutes across the subsequent games of the episode, with at least MIN_FOLLOW games so
// "persistence" is not one follow-up appearance. Framed as "reached at least T" rather than "landed
// in a narrow band around T" because the former is monotone in T, which is what a capacity curve
// requires — a player who sustains 28 has necessarily sustained 24.
//
// The proposed workload is an explicit INPUT, so the same player yields different probabilities at
// 24, 27 and 30 MPG rather than one opaque number.
//
// Validation is by player group and by season, never by episode: 4,067 episodes come from only 700
// players, so an episode-level split would let the model see a player in training and be tested on
// him again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
// Persistence is judged over a FIXED number of available follow-up games. Episodes with fewer
// than that are CENSORED — recorded and excluded, never scored as failures. Simply raising the
// minimum instead would bias the sample: end-of-season, injured, traded and waived players
// disappear precisely because something happened to them.
export const CAPACITY_CONFIG = { band: 2, followGames: 2, gridLo: 14, gridHi: 34, gridStep: 0.5 };
const FEATS = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg', 'target', 'increase'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
const allEpisodes = buildEpisodes(detectAbsences(rows)).filter((e) =>
  Number.isFinite(e.pre?.preGsPer36) && Number.isFinite(e.pre?.preForm5));
const FOLLOW = Number(process.env.FOLLOW || CAPACITY_CONFIG.followGames);
const censored = allEpisodes.filter((e) => e.outcomeRows.length < FOLLOW).length;
const episodes = allEpisodes.filter((e) => e.outcomeRows.length >= FOLLOW).map((e) => {
  // Judge persistence on exactly FOLLOW games, so episodes of different lengths are comparable.
  const win = e.outcomeRows.slice(0, FOLLOW);
  const mins = win.reduce((a, r) => a + (r.min || 0), 0) / win.length;
  return { ...e, sustainedMpg: mins };
});
console.log(`follow-up window: ${FOLLOW} game(s) · censored (too few follow-ups): ${censored} of ${allEpisodes.length}`);

// One training row per (episode, proposed target).
const data = [];
for (const e of episodes) {
  for (let t = CAPACITY_CONFIG.gridLo; t <= CAPACITY_CONFIG.gridHi; t += CAPACITY_CONFIG.gridStep) {
    // Only ask about targets that represent an actual expansion for this player.
    if (t <= e.baselineMpg) continue;
    data.push({
      ...e.pre, baselineMpg: e.baselineMpg, target: t, increase: t - e.baselineMpg,
      y: e.sustainedMpg >= t - CAPACITY_CONFIG.band ? 1 : 0,
      pid: String(e.playerId), season: e.season,
    });
  }
}
console.log(`episodes ${episodes.length} · players ${new Set(episodes.map((e) => e.playerId)).size} · training rows ${data.length}`);
console.log(`base rate of success: ${(100 * data.reduce((a, d) => a + d.y, 0) / data.length).toFixed(1)}%`);

function fitLogistic(train, iters = 220, lr = 0.06) {
  const w = new Array(FEATS.length + 1).fill(0);
  const mu = {}, sd = {};
  for (const k of FEATS) {
    const v = train.map((d) => d[k] ?? 0);
    mu[k] = v.reduce((a, b) => a + b, 0) / v.length;
    sd[k] = Math.sqrt(v.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / v.length) || 1;
  }
  const vec = (d) => [1, ...FEATS.map((k) => ((d[k] ?? 0) - mu[k]) / sd[k])];
  for (let it = 0; it < iters; it++) {
    const g = new Array(w.length).fill(0);
    for (const d of train) {
      const x = vec(d);
      const p = 1 / (1 + Math.exp(-x.reduce((s, v, i) => s + v * w[i], 0)));
      const err = p - d.y;
      for (let i = 0; i < w.length; i++) g[i] += err * x[i];
    }
    for (let i = 0; i < w.length; i++) w[i] -= (lr / train.length) * g[i];
  }
  return { predict: (d) => 1 / (1 + Math.exp(-vec(d).reduce((s, v, i) => s + v * w[i], 0))) };
}

const auc = (pairs) => {
  const pos = pairs.filter((p) => p.y === 1).map((p) => p.p).sort((a, b) => a - b);
  const neg = pairs.filter((p) => p.y === 0).map((p) => p.p);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const n of neg) { let lo = 0, hi = pos.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[m] > n) hi = m; else lo = m + 1; } s += lo; }
  return 1 - s / (pos.length * neg.length);
};
const brier = (pairs) => pairs.reduce((a, p) => a + (p.p - p.y) ** 2, 0) / pairs.length;
/** Expected calibration error: mean |predicted - actual| weighted by bin size. AUC only tests
 *  ranking, and TULIP shows the probability itself, so probability accuracy matters equally. */
const ece = (pairs, bins = 10) => {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const g = pairs.filter((p) => p.p >= b / bins && p.p < (b + 1) / bins);
    if (!g.length) continue;
    const pm = g.reduce((a, x) => a + x.p, 0) / g.length, am = g.reduce((a, x) => a + x.y, 0) / g.length;
    e += (g.length / pairs.length) * Math.abs(pm - am);
  }
  return e;
};
const calibration = (pairs, bins = 5) => {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const g = pairs.filter((p) => p.p >= lo && p.p < hi);
    if (g.length >= 30) out.push({ band: `${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}%`, n: g.length,
      predicted: +(100 * g.reduce((a, x) => a + x.p, 0) / g.length).toFixed(1),
      actual: +(100 * g.reduce((a, x) => a + x.y, 0) / g.length).toFixed(1) });
  }
  return out;
};

// 1. Group CV by PLAYER.
const players = [...new Set(data.map((d) => d.pid))];
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const shuf = [...players].sort(() => rnd() - 0.5);
const K = 5, folds = Array.from({ length: K }, () => new Set());
shuf.forEach((p, i) => folds[i % K].add(p));
const oof = [];
for (const test of folds) {
  const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
  if (tr.length < 500 || te.length < 100) continue;
  const m = fitLogistic(tr);
  for (const d of te) oof.push({ p: m.predict(d), y: d.y });
}
console.log(`\n1. DISCRIMINATION — grouped 5-fold by player`);
console.log(`   AUC   ${auc(oof).toFixed(4)}   (0.5 = useless)   n=${oof.length}`);
console.log(`   Brier ${brier(oof).toFixed(4)}   (lower better; base rate ${(brier(oof.map((o) => ({ p: oof.reduce((a, x) => a + x.y, 0) / oof.length, y: o.y })))).toFixed(4)} for always-predict-base)`);
console.log(`   ECE   ${(100 * ece(oof)).toFixed(2)}%  mean gap between stated and actual probability`);
console.log(`\n2. CALIBRATION — does 70% mean 70%?`);
for (const c of calibration(oof)) console.log(`   ${c.band.padEnd(9)} predicted ${String(c.predicted).padStart(5)}%   actual ${String(c.actual).padStart(5)}%   n=${c.n}`);

// 3. Chronological: train on earlier seasons, predict a season never seen.
const tr2 = data.filter((d) => d.season !== '2024-25'), te2 = data.filter((d) => d.season === '2024-25');
if (tr2.length > 500 && te2.length > 100) {
  const m2 = fitLogistic(tr2);
  const pr = te2.map((d) => ({ p: m2.predict(d), y: d.y }));
  console.log(`\n3. CHRONOLOGICAL — train <=2023-24, predict 2024-25`);
  console.log(`   AUC ${auc(pr).toFixed(4)} · Brier ${brier(pr).toFixed(4)} · ECE ${(100 * ece(pr)).toFixed(2)}%   n=${pr.length}`);
  for (const c of calibration(pr)) console.log(`   ${c.band.padEnd(9)} predicted ${String(c.predicted).padStart(5)}%   actual ${String(c.actual).padStart(5)}%   n=${c.n}`);
}

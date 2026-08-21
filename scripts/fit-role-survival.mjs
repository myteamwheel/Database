// MODEL A (production) — Role Capacity as time-to-role-loss.
//
// WHY SURVIVAL RATHER THAN A BINARY CLASSIFIER. Requiring N follow-up games censored 58% of
// episodes at N=2 and 79% at N=3, and the excluded episodes are not random: players disappear
// because the season ended, they were hurt, traded or waived. Dropping them is cleaner than scoring
// them as failures, but it still selects on survival. A discrete-time hazard model uses every
// episode for exactly as long as it is observed, so a player whose season ends after two games
// contributes two games of evidence rather than being discarded or falsely marked a failure.
//
// OUTPUT is a curve, not a single probability: P(still holding the target workload after k games).
//
// Validation is grouped BY PLAYER and chronologically, never by episode — 700 players supply
// thousands of episodes, so an episode split would test the model on players it trained on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const CFG = { band: 2, gridLo: 16, gridHi: 32, gridStep: 2, horizon: 5 };
const FEATS = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg', 'target', 'increase', 'gameIndex'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
const episodes = buildEpisodes(detectAbsences(rows))
  .filter((e) => Number.isFinite(e.pre?.preGsPer36) && Number.isFinite(e.pre?.preForm5));

// Person-period rows: one per (episode, target, follow-up game) until role loss or censoring.
const data = [];
let events = 0, censoredEpisodes = 0;
for (const e of episodes) {
  for (let t = CFG.gridLo; t <= CFG.gridHi; t += CFG.gridStep) {
    if (t <= e.baselineMpg) continue;
    let lost = false;
    for (let k = 0; k < Math.min(e.outcomeRows.length, CFG.horizon); k++) {
      const m = e.outcomeRows[k].min ?? 0;
      const dropped = m < t - CFG.band ? 1 : 0;
      data.push({
        ...e.pre, baselineMpg: e.baselineMpg, target: t, increase: t - e.baselineMpg,
        gameIndex: k + 1, y: dropped, pid: String(e.playerId), season: e.season,
      });
      if (dropped) { lost = true; events++; break; }   // absorbing: role lost
    }
    if (!lost && e.outcomeRows.length < CFG.horizon) censoredEpisodes++;
  }
}
console.log(`episodes ${episodes.length} · players ${new Set(episodes.map((e) => e.playerId)).size}`);
console.log(`person-period rows ${data.length} · role-loss events ${events} · censored spells ${censoredEpisodes}`);
console.log(`per-game hazard of losing the role: ${(100 * data.reduce((a, d) => a + d.y, 0) / data.length).toFixed(1)}%`);

function fit(train, iters = 200, lr = 0.08) {
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
      for (let i = 0; i < w.length; i++) g[i] += (p - d.y) * x[i];
    }
    for (let i = 0; i < w.length; i++) w[i] -= (lr / train.length) * g[i];
  }
  return (d) => 1 / (1 + Math.exp(-vec(d).reduce((s, v, i) => s + v * w[i], 0)));
}
const auc = (pairs) => {
  const pos = pairs.filter((p) => p.y === 1).map((p) => p.p).sort((a, b) => a - b);
  const neg = pairs.filter((p) => p.y === 0).map((p) => p.p);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const n of neg) { let lo = 0, hi = pos.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[m] > n) hi = m; else lo = m + 1; } s += lo; }
  return 1 - s / (pos.length * neg.length);
};
const brier = (p) => p.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / p.length;
const ece = (p, bins = 10) => {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const g = p.filter((x) => x.p >= b / bins && x.p < (b + 1) / bins);
    if (!g.length) continue;
    e += (g.length / p.length) * Math.abs(g.reduce((a, x) => a + x.p, 0) / g.length - g.reduce((a, x) => a + x.y, 0) / g.length);
  }
  return e;
};

const players = [...new Set(data.map((d) => d.pid))];
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const shuf = [...players].sort(() => rnd() - 0.5);
const folds = Array.from({ length: 5 }, () => new Set());
shuf.forEach((p, i) => folds[i % 5].add(p));
const oof = [];
for (const test of folds) {
  const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
  if (tr.length < 500 || te.length < 100) continue;
  const m = fit(tr);
  for (const d of te) oof.push({ p: m(d), y: d.y });
}
console.log(`\nHAZARD MODEL — grouped 5-fold by player`);
console.log(`  AUC ${auc(oof).toFixed(4)} · Brier ${brier(oof).toFixed(4)} · ECE ${(100 * ece(oof)).toFixed(2)}%   n=${oof.length}`);

const tr2 = data.filter((d) => d.season !== '2024-25'), te2 = data.filter((d) => d.season === '2024-25');
if (tr2.length > 500 && te2.length > 100) {
  const m2 = fit(tr2);
  const pr = te2.map((d) => ({ p: m2(d), y: d.y }));
  console.log(`CHRONOLOGICAL — train <=2023-24, predict 2024-25`);
  console.log(`  AUC ${auc(pr).toFixed(4)} · Brier ${brier(pr).toFixed(4)} · ECE ${(100 * ece(pr)).toFixed(2)}%   n=${pr.length}`);

  // Survival curve for a worked example: chain (1 - hazard) across follow-up games.
  const m = fit(data);
  const ex = { preGsPer36: 14, preForm5: 14, preTs: 0.56, preFgaPer36: 13, preAstPer36: 4,
    preTovPer36: 2, preRebPer36: 6, preStartRate: 0.2, baselineMpg: 19 };
  console.log(`\nWORKED EXAMPLE — 19.0 MPG player, above-average production`);
  console.log(`  target   P(role survives 1)  (2)    (3)    (5 games)`);
  for (const t of [22, 24, 26, 28, 30]) {
    let s = 1; const out = [];
    for (let k = 1; k <= 5; k++) {
      s *= 1 - m({ ...ex, target: t, increase: t - ex.baselineMpg, gameIndex: k });
      if ([1, 2, 3, 5].includes(k)) out.push((100 * s).toFixed(0) + '%');
    }
    console.log(`  ${String(t).padStart(4)} MPG   ${out.map((x) => x.padStart(6)).join(' ')}`);
  }
}

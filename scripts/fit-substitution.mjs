// Directional minute-substitution model.
//
// Replaces the hand-built symmetric role-similarity score, which correlated r = 0.069 with actual
// minute redistribution across 4,585 absence events — too weak to weight anything by.
//
// Instead of asking "how similar are these two players", this asks the basketball question directly:
// when player A is absent, which team-mates actually absorb his minutes, and how many? Every
// remaining team-mate is a candidate row, so the relationship is DIRECTIONAL by construction — the
// model sees the whole situation rather than a symmetric distance, and "Turner absorbs Gobert" is a
// different prediction from "Gobert absorbs Turner".
//
// Every feature is frozen from games BEFORE the absence, so the expanded role being studied cannot
// contaminate the features used to identify it.
//
// Validation is deliberately NOT correlation alone. Minute substitution is lumpy and zero-heavy, so
// r understates a useful model. The tests that matter are within-event: did it find the main
// beneficiary, and what share of redistributed minutes went to its top picks?
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const fin = (v) => Number.isFinite(Number(v));

/** Build absence events with pre-event features for every candidate team-mate. */
function buildEvents(rows) {
  const byTG = new Map(), sched = new Map();
  for (const r of rows) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!byTG.has(k)) byTG.set(k, { players: [] });
    byTG.get(k).players.push(r);
    const sk = r.teamId;
    if (!sched.has(sk)) sched.set(sk, new Set());
    sched.get(sk).add(`${r.gameDate}|${r.gameId}`);
  }
  const events = [];
  for (const [teamId, set] of sched) {
    const ids = [...set].sort().map((x) => x.split('|')[1]);
    const cum = new Map(), lastIdx = new Map();
    for (let i = 0; i < ids.length; i++) {
      const tg = byTG.get(`${ids[i]}|${teamId}`); if (!tg) continue;
      const present = new Set(tg.players.filter((p) => p.min > 0).map((p) => String(p.playerId)));
      const rate = (c, k) => (c.min > 0 ? (c[k] / c.min) * 36 : 0);
      const prof = (c) => ({ mpg: c.min / c.g, reb: rate(c, 'reb'), ast: rate(c, 'ast'), blk: rate(c, 'blk'),
        fg3a: rate(c, 'fg3a'), fga: rate(c, 'fga'), stl: rate(c, 'stl'), tov: rate(c, 'tov'), pf: rate(c, 'pf') });

      const absentees = [...cum.entries()].filter(([k, c]) =>
        c.g >= 10 && c.min / c.g >= 18 && !present.has(k) && i - (lastIdx.get(k) ?? -99) <= 5);
      // Only single-absence events, so vacated minutes are attributable to one player.
      if (absentees.length === 1) {
        const [, ac] = absentees[0];
        const cands = [];
        for (const p of tg.players) {
          if (!(p.min > 0)) continue;
          const c = cum.get(String(p.playerId)); if (!c || c.g < 10) continue;
          cands.push({ pre: prof(c), gained: p.min - c.min / c.g });
        }
        if (cands.length >= 6) events.push({ absent: prof(ac), cands });
      }
      for (const p of tg.players) {
        if (!(p.min > 0)) continue;
        const k = String(p.playerId);
        const c = cum.get(k) || { g: 0, min: 0, reb: 0, ast: 0, blk: 0, fg3a: 0, fga: 0, stl: 0, tov: 0, pf: 0 };
        c.g++; c.min += p.min;
        for (const f of ['reb', 'ast', 'blk', 'fg3a', 'fga', 'stl', 'tov', 'pf']) c[f] += p[f] || 0;
        cum.set(k, c); lastIdx.set(k, i);
      }
    }
  }
  return events;
}

// Directional features: the candidate's own profile, the absent player's profile, and the SIGNED
// differences between them. Signed differences are what make it directional — a candidate who is
// bigger than the absent player is a different case from one who is smaller.
const AXES = ['mpg', 'reb', 'ast', 'blk', 'fg3a', 'fga', 'stl', 'tov', 'pf'];
const feat = (c, a) => [1, ...AXES.map((k) => c[k]), ...AXES.map((k) => a[k]), ...AXES.map((k) => c[k] - a[k])];

function ols(X, y) {
  const m = X[0].length;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < X.length; i++) for (let a = 0; a < m; a++) {
    for (let b = 0; b < m; b++) A[a][b] += X[i][a] * X[i][b];
    A[a][m] += X[i][a] * y[i];
  }
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) { A[c][c] = 1e-10; }
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[m] / A[i][i]);
}

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
const events = buildEvents(rows);
console.log(`single-absence events with 6+ candidates: ${events.length}`);

// Chronological-ish split by event index: train on the first 70%, test on the rest.
const cut = Math.floor(events.length * 0.7);
const train = events.slice(0, cut), test = events.slice(cut);
const X = [], y = [];
for (const ev of train) for (const c of ev.cands) { X.push(feat(c.pre, ev.absent)); y.push(c.gained); }
const coef = ols(X, y);
const pred = (c, a) => feat(c, a).reduce((s, v, i) => s + v * coef[i], 0);

// Within-event validation.
let top1 = 0, evalN = 0, capturedTop1 = 0, capturedTop3 = 0, totalPos = 0;
let chanceSum = 0, candSum = 0, randTop1 = 0, randCaptured = 0;
let rngState = 12345;
const rngNext = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const xs = [], ys = [];
for (const ev of test) {
  const scored = ev.cands.map((c) => ({ p: pred(c.pre, ev.absent), g: c.gained }));
  for (const s of scored) { xs.push(s.p); ys.push(s.g); }
  const pos = scored.filter((s) => s.g > 0);
  const tot = pos.reduce((a, s) => a + s.g, 0);
  if (tot <= 0 || scored.length < 6) continue;
  evalN++;
  const byPred = [...scored].sort((a, b) => b.p - a.p);
  const actualBest = scored.reduce((a, b) => (b.g > a.g ? b : a));
  if (byPred[0] === actualBest) top1++;
  capturedTop1 += Math.max(0, byPred[0].g) / tot;
  capturedTop3 += byPred.slice(0, 3).reduce((a, s) => a + Math.max(0, s.g), 0) / tot;
  totalPos += pos.length;
  // Chance of picking the top gainer at random, per event, over the SAME candidate set the model
  // chose from. The earlier version divided by the count of positive gainers while the model chose
  // from every candidate, which made the baseline look far higher than it was.
  chanceSum += 1 / scored.length;
  candSum += scored.length;
  // Random-pick control, drawn from the identical candidate set.
  const rnd = scored[Math.floor(rngNext() * scored.length)];
  if (rnd === actualBest) randTop1++;
  randCaptured += Math.max(0, rnd.g) / tot;
}
const n = xs.length;
const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }

console.log(`\nHELD-OUT VALIDATION (${test.length} events, ${evalN} scoreable)`);
console.log(`  correlation r                       ${(sxy / Math.sqrt(sxx * syy)).toFixed(4)}`);
console.log(`  candidates per event                 ${(candSum / evalN).toFixed(1)}`);
console.log(`  top-1 hit rate (found main gainer)  ${(100 * top1 / evalN).toFixed(1)}%`);
console.log(`  chance baseline (1/candidates)      ${(100 * chanceSum / evalN).toFixed(1)}%`);
console.log(`  random-pick control, same sets      ${(100 * randTop1 / evalN).toFixed(1)}%`);
console.log(`  random-pick captured minutes        ${(100 * randCaptured / evalN).toFixed(1)}%`);
console.log(`  share of gained minutes to top-1    ${(100 * capturedTop1 / evalN).toFixed(1)}%`);
console.log(`  share of gained minutes to top-3    ${(100 * capturedTop3 / evalN).toFixed(1)}%`);
console.log('\nIf top-1 barely beats chance, role-weighting should be ABANDONED rather than dressed up.');

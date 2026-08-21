// FINAL BOUNDED ATTEMPT AT PRE-OPPORTUNITY TULIP CAPACITY.
//
// Question: BEFORE a player receives an expanded role, can we distinguish a 19-MPG player who could
// sustain ~26 from one who could not? Everything used must be knowable before the opener tips off.
// No opener minutes, no opener starter status, nothing from the outcome window.
//
// Three specs on identical rows and splits:
//   P0  current/recent workload only            (trivial baseline)
//   P1  + age, physicals, draft, career history, foul rate, trajectory, pre-event production
//   P2  + current-team blockage/context
//
// WHY BLOCKAGE IS A SEPARATE FAMILY. A player can have portable 27-MPG capacity while playing 18
// because two better players occupy his role. Mixing roster congestion into "talent" would hide
// exactly the case TULIP exists to find, so it is tested as its own increment.
//
// All context is computed strictly from games BEFORE the episode date. No future depth chart, no
// future injuries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
const rows = [];
for (const s of SEASONS) { const f = path.join(HIST, s, 'gamelog.json'); if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8'))); }
attachStarterFlags(rows, HIST);
const nameOf = new Map();
for (const r of rows) nameOf.set(String(r.playerId), r.playerName);

// bio: age / height / weight / draft slot
const bio = new Map();
for (const s of SEASONS) {
  const f = path.join(HIST, 'bio', `${s}.json`);
  if (!fs.existsSync(f)) continue;
  for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const dn = Number(b.draftNumber);
    bio.set(`${s}|${b.playerId}`, {
      age: Number(b.age) || null, heightIn: Number(b.heightIn) || null, weight: Number(b.weight) || null,
      // Undrafted is a real category, not a missing value; code it as a slot beyond the draft.
      draftPick: Number.isFinite(dn) && dn > 0 ? dn : 61,
      undrafted: Number.isFinite(dn) && dn > 0 ? 0 : 1,
    });
  }
}

// Per-player chronological game index, and per-(season,team) roster, for pre-date lookups.
const byPlayer = new Map(), teamRoster = new Map();
for (const r of rows) {
  const pk = String(r.playerId);
  if (!byPlayer.has(pk)) byPlayer.set(pk, []);
  byPlayer.get(pk).push(r);
  const tk = `${r.season}|${r.teamId}`;
  if (!teamRoster.has(tk)) teamRoster.set(tk, new Set());
  teamRoster.get(tk).add(pk);
}
for (const v of byPlayer.values()) v.sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));

/** Mean MPG over the player's last N games strictly BEFORE date, within season if given. */
function priorMpg(pk, date, n = 10, season = null) {
  const g = byPlayer.get(pk); if (!g) return null;
  const prior = [];
  for (let i = g.length - 1; i >= 0; i--) {
    if (String(g[i].gameDate) >= String(date)) continue;
    if (season && g[i].season !== season) continue;
    prior.push(g[i]); if (prior.length >= n) break;
  }
  if (!prior.length) return null;
  return prior.reduce((a, x) => a + (x.min ?? 0), 0) / prior.length;
}

const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  let num = 0, den = 0, w = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w * (e.outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  if (!(den > 0)) continue;
  const pk = String(e.playerId), date = e.openerRow.gameDate, season = e.season;
  const b = bio.get(`${season}|${e.playerId}`) || {};
  const hist = (byPlayer.get(pk) || []).filter((g) => String(g.gameDate) < String(date));
  if (!hist.length) continue;
  // career history strictly before the episode
  const careerGames = hist.length;
  const careerSeasons = new Set(hist.map((g) => g.season)).size;
  const bySeasonMpg = new Map();
  for (const g of hist) {
    const k = g.season; const v = bySeasonMpg.get(k) || [0, 0];
    v[0] += g.min ?? 0; v[1]++; bySeasonMpg.set(k, v);
  }
  const careerHighMpg = Math.max(...[...bySeasonMpg.values()].map(([m, n]) => (n >= 10 ? m / n : 0)), 0);
  const recent = hist.slice(-20);
  const foulPer36 = (() => {
    const m = recent.reduce((a, g) => a + (g.min ?? 0), 0);
    return m > 0 ? 36 * recent.reduce((a, g) => a + (g.pf ?? 0), 0) / m : null;
  })();
  // trajectory: last-5 mean minus previous-10 mean, all pre-date
  const l5 = hist.slice(-5), p10 = hist.slice(-15, -5);
  const traj = (l5.length && p10.length)
    ? l5.reduce((a, g) => a + (g.min ?? 0), 0) / l5.length - p10.reduce((a, g) => a + (g.min ?? 0), 0) / p10.length : 0;
  // availability: share of the team's season games to date in which he appeared
  const teamGamesToDate = new Set(rows.filter((r) => r.teamId === e.openerRow.teamId && r.season === season && String(r.gameDate) < String(date)).map((r) => r.gameId)).size;
  const playedToDate = hist.filter((g) => g.season === season).length;
  const availability = teamGamesToDate > 0 ? playedToDate / teamGamesToDate : null;

  // --- BLOCKAGE / TEAM CONTEXT, all measured before the episode date ---
  const mates = [...(teamRoster.get(`${season}|${e.openerRow.teamId}`) || [])].filter((x) => x !== pk);
  const mateMpg = mates.map((m) => priorMpg(m, date, 10, season)).filter((x) => x !== null);
  const own = priorMpg(pk, date, 10, season) ?? e.baselineMpg;
  const ahead = mateMpg.filter((x) => x > own);
  const blockage = {
    nAhead: ahead.length,
    minsAhead: ahead.reduce((a, x) => a + x, 0),
    bestAheadMpg: ahead.length ? Math.max(...ahead) : 0,
    teamDepth: mateMpg.filter((x) => x >= 15).length,
  };
  // Portability: which team generated the PRE-event features vs which team the outcome happened on.
  // A mid-season trade makes these differ, which is the only clean within-dataset transfer test.
  const modal = (arr) => { const c = new Map(); for (const t of arr) c.set(t, (c.get(t) || 0) + 1);
    let best = null, n = -1; for (const [t, k] of c) if (k > n) { best = t; n = k; } return best; };
  const preTeam = modal(hist.filter((g) => g.season === season).slice(-15).map((g) => g.teamId));
  const outTeam = modal(e.outcomeRows.map((g) => g.teamId));
  data.push({
    preTeam, outTeam, crossTeam: (preTeam != null && outTeam != null && preTeam !== outTeam) ? 1 : 0,
    ...e.pre, baselineMpg: e.baselineMpg,
    recentMpg: own, trajectory: traj,
    age: b.age ?? 26, heightIn: b.heightIn ?? 78, weight: b.weight ?? 210,
    draftPick: b.draftPick ?? 61, undrafted: b.undrafted ?? 1,
    careerGames, careerSeasons, careerHighMpg, foulPer36: foulPer36 ?? 4,
    availability: availability ?? 0.8,
    ...blockage,
    y: num / den, pid: pk, season, nFollow: e.outcomeRows.length,
    openerMin: e.openerRow.min ?? e.baselineMpg,
  });
}
console.log(`episodes ${data.length} · players ${new Set(data.map((d) => d.pid)).size}`);
console.log(`bio coverage: age ${(100 * data.filter((d) => d.age !== 26).length / data.length).toFixed(0)}% · height ${(100 * data.filter((d) => d.heightIn !== 78).length / data.length).toFixed(0)}%`);

const P0 = ['baselineMpg', 'recentMpg'];
const P1 = [...P0, 'trajectory', 'careerHighMpg', 'careerGames', 'careerSeasons', 'availability',
  'age', 'heightIn', 'weight', 'draftPick', 'undrafted', 'foulPer36',
  'preStartRate', 'preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36', 'preRebPer36'];
const P2 = [...P1, 'nAhead', 'minsAhead', 'bestAheadMpg', 'teamDepth'];
// Diagnostic: the pair universe is MATCHED on baselineMpg, so a baselineMpg-only model must score
// near 50%. If it does, then P0's score is coming from recentMpg — genuinely pre-opportunity
// information that an earlier pre-opportunity spec of mine simply omitted.
const SPECS = { 'baselineMpg only': ['baselineMpg'], 'recentMpg only': ['recentMpg'],
  'recent + trend': ['recentMpg', 'trajectory'], 'P0 workload only': P0,
  'P1 player capacity': P1, 'P2 + team blockage': P2 };

const RIDGE = 1e-5;
function fit(train, FE) {
  const m = FE.length + 1; const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  const mu = FE.map((k) => train.reduce((a, d) => a + (d[k] ?? 0), 0) / train.length);
  const sd = FE.map((k, i) => Math.sqrt(train.reduce((a, d) => a + ((d[k] ?? 0) - mu[i]) ** 2, 0) / train.length) || 1);
  const z = (d) => FE.map((k, i) => ((d[k] ?? 0) - mu[i]) / sd[i]);
  for (const d of train) { const v = [1, ...z(d)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; } }
  for (let a = 1; a < m; a++) A[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) { let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + z(d).reduce((s, v, i) => s + wts[i + 1] * v, 0);
}
function folds5(pool) {
  const players = [...new Set(pool.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const F = Array.from({ length: 5 }, () => new Set());
  [...players].sort(() => rnd() - 0.5).forEach((p, i) => F[i % 5].add(p));
  return F;
}
function scoreOf(o) {
  const mae = o.reduce((a, x) => a + Math.abs(x.pred - x.actual), 0) / o.length;
  const my = o.reduce((a, x) => a + x.actual, 0) / o.length;
  let ssr = 0, sst = 0;
  for (const x of o) { ssr += (x.actual - x.pred) ** 2; sst += (x.actual - my) ** 2; }
  let crps = 0;
  for (const x of o) {
    let s2 = 0; for (const r of x.resid) s2 += Math.abs(x.pred + r - x.actual);
    let s3 = 0; for (let i = 0; i < x.resid.length; i += 7) for (let j = 0; j < x.resid.length; j += 7) s3 += Math.abs(x.resid[i] - x.resid[j]);
    const k = Math.ceil(x.resid.length / 7);
    crps += s2 / x.resid.length - 0.5 * s3 / (k * k);
  }
  return { mae, r2: 1 - ssr / sst, crps: crps / o.length, n: o.length };
}
console.log('\n===== GROUPED 5-FOLD BY PLAYER =====');
console.log('  spec                   MAE      R2       CRPS');
for (const [n, FE] of Object.entries(SPECS)) {
  const oof = [];
  for (const t of folds5(data)) {
    const tr = data.filter((d) => !t.has(d.pid)), te2 = data.filter((d) => t.has(d.pid));
    if (tr.length < 200 || !te2.length) continue;
    const f = fit(tr, FE); const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
    for (const d of te2) oof.push({ pred: f(d), actual: d.y, resid });
  }
  const s = scoreOf(oof);
  console.log(`  ${n.padEnd(20)} ${s.mae.toFixed(3)}   ${s.r2.toFixed(4)}   ${s.crps.toFixed(3)}`);
}

const seasons = [...new Set(data.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const trS = data.filter((d) => d.season !== last), teS = data.filter((d) => d.season === last);
console.log(`\n===== CHRONOLOGICAL HOLDOUT (${last}) · n=${teS.length} =====`);
console.log('  spec                   MAE      R2       CRPS   Spearman(headroom, actual change)');
const P = {};
for (const [n, FE] of Object.entries(SPECS)) {
  const f = fit(trS, FE); const resid = trS.map((d) => d.y - f(d)).sort((a, b) => a - b);
  P[n] = teS.map((d) => f(d));
  const s = scoreOf(teS.map((d, i) => ({ pred: P[n][i], actual: d.y, resid })));
  const hr = teS.map((d, i) => P[n][i] - d.baselineMpg), ac = teS.map((d) => d.y - d.baselineMpg);
  const rank = (v) => { const q = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); q.forEach(([, i], k) => { r[i] = k; }); return r; };
  const a = rank(hr), b = rank(ac), N = a.length, mm = (N - 1) / 2;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < N; i++) { nu += (a[i] - mm) * (b[i] - mm); da += (a[i] - mm) ** 2; db += (b[i] - mm) ** 2; }
  console.log(`  ${n.padEnd(20)} ${s.mae.toFixed(3)}   ${s.r2.toFixed(4)}   ${s.crps.toFixed(3)}   ${(nu / Math.sqrt(da * db)).toFixed(3)}`);
}

// Fixed pair universe: same current MPG within 1.0.
const PAIRS = [];
{
  let seed = 17; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const idx = teS.map((_, i) => i).sort(() => rnd() - 0.5);
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const i = idx[a], j = idx[b];
    if (teS[i].pid === teS[j].pid) continue;
    if (Math.abs(teS[i].baselineMpg - teS[j].baselineMpg) > 1.0) continue;
    if (Math.abs(teS[i].y - teS[j].y) < 1e-9) continue;
    PAIRS.push([i, j]);
  }
}
const conc = (p, sub) => { let w = 0; for (const [i, j] of sub) { const h = p[i] > p[j] ? i : j, l = p[i] > p[j] ? j : i; if (teS[h].y > teS[l].y) w++; } return w / sub.length; };
function clusteredCI(sub, p, B = 500) {
  const players = [...new Set(teS.map((d) => d.pid))];
  let seed = 71; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let b = 0; b < B; b++) {
    const keep = new Set();
    for (let i = 0; i < players.length; i++) keep.add(players[Math.floor(rnd() * players.length)]);
    const s2 = sub.filter(([i, j]) => keep.has(teS[i].pid) && keep.has(teS[j].pid));
    if (s2.length < 30) continue;
    out.push(conc(p, s2));
  }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : [NaN, NaN];
}
console.log(`\n===== SAME-CURRENT-MPG PAIRWISE CONCORDANCE · ${PAIRS.length} pairs (50% = no skill) =====`);
console.log('  spec                   all pairs            gap>=3 (n)             gap>=5 (n)');
for (const n of Object.keys(SPECS)) {
  const p = P[n], all = conc(p, PAIRS), ci = clusteredCI(PAIRS, p);
  const g3 = PAIRS.filter(([i, j]) => Math.abs(p[i] - p[j]) >= 3), g5 = PAIRS.filter(([i, j]) => Math.abs(p[i] - p[j]) >= 5);
  const s3 = g3.length > 30 ? `${(100 * conc(p, g3)).toFixed(1)}% (${g3.length})` : `n=${g3.length} too few`;
  const s5 = g5.length > 30 ? `${(100 * conc(p, g5)).toFixed(1)}% (${g5.length})` : `n=${g5.length} too few`;
  console.log(`  ${n.padEnd(20)} ${(100 * all).toFixed(1)}% [${(100 * ci[0]).toFixed(1)},${(100 * ci[1]).toFixed(1)}]   ${s3.padEnd(22)} ${s5}`);
}

// COVERAGE vs ACCURACY: confidence comes from the model's own predicted gap, and the WHOLE curve is
// shown, so no threshold can be picked after seeing outcomes.
console.log('\n===== COVERAGE vs ACCURACY (rank pairs by |predicted gap|, most confident first) =====');
console.log('  coverage:      5%     10%     20%     40%     60%     80%    100%');
for (const n of Object.keys(SPECS)) {
  const p = P[n];
  const sorted = [...PAIRS].sort((a, b) => Math.abs(p[b[0]] - p[b[1]]) - Math.abs(p[a[0]] - p[a[1]]));
  const cells = [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0].map((c) => {
    const k = Math.max(30, Math.floor(sorted.length * c));
    return `${(100 * conc(p, sorted.slice(0, k))).toFixed(1)}%`;
  });
  console.log(`  ${n.padEnd(20)} ${cells.map((x) => x.padStart(6)).join('  ')}`);
}

// ===================================================================================
// HISTORICAL CASES — selection rule fixed BEFORE looking at any outcome:
//   universe: held-out 2024-25 only, current workload 15-22 MPG (the underused band TULIP targets),
//             at least 5 follow-up games so the outcome is measurable.
//   "hidden capacity"  = the 6 largest predicted headrooms
//   "near capacity"    = the 6 smallest (most negative) predicted headrooms
//   "misses"           = the 4 largest absolute errors in each direction within the same universe
// No cherry-picking: these are whatever the rule returns.
// ===================================================================================
{
  const p = P['P2 + team blockage'];
  const U = teS.map((d, i) => ({ d, pred: p[i], hr: p[i] - d.baselineMpg }))
    .filter((x) => x.d.baselineMpg >= 15 && x.d.baselineMpg <= 22 && x.d.nFollow >= 5);
  console.log(`\n===== HISTORICAL CASES · universe n=${U.length} (2024-25, 15-22 MPG, >=5 follow-ups) =====`);
  const line = (x) => `    ${(nameOf.get(x.d.pid) || x.d.pid).slice(0, 22).padEnd(22)} current ${x.d.baselineMpg.toFixed(1).padStart(4)}  TULIP ${x.pred.toFixed(1).padStart(4)}  headroom ${(x.hr >= 0 ? '+' : '') + x.hr.toFixed(1)}`.padEnd(86)
    + `ACTUAL ${x.d.y.toFixed(1).padStart(4)}  err ${(x.d.y - x.pred >= 0 ? '+' : '') + (x.d.y - x.pred).toFixed(1)}`;
  const byHr = [...U].sort((a, b) => b.hr - a.hr);
  console.log('\n  TULIP SAYS HIDDEN CAPACITY (6 largest predicted headroom):');
  for (const x of byHr.slice(0, 6)) console.log(line(x));
  console.log('\n  TULIP SAYS NEAR CAPACITY (6 smallest predicted headroom):');
  for (const x of byHr.slice(-6)) console.log(line(x));
  const byErr = [...U].sort((a, b) => (b.d.y - b.pred) - (a.d.y - a.pred));
  console.log('\n  BIGGEST MISSES — TULIP too LOW (player far exceeded prediction):');
  for (const x of byErr.slice(0, 4)) console.log(line(x));
  console.log('\n  BIGGEST MISSES — TULIP too HIGH (player fell far short):');
  for (const x of byErr.slice(-4)) console.log(line(x));
  // Did the flagged group actually gain minutes, as a group?
  const hi = byHr.slice(0, Math.max(20, Math.floor(U.length * 0.1)));
  const lo = byHr.slice(-Math.max(20, Math.floor(U.length * 0.1)));
  const m = (g, f) => g.reduce((a, x) => a + f(x), 0) / g.length;
  console.log(`\n  GROUP CHECK (top vs bottom decile of predicted headroom, same 15-22 MPG band):`);
  console.log(`    top decile    n=${hi.length}  current ${m(hi, (x) => x.d.baselineMpg).toFixed(1)}  TULIP ${m(hi, (x) => x.pred).toFixed(1)}  ACTUAL ${m(hi, (x) => x.d.y).toFixed(1)}  (${(m(hi, (x) => x.d.y) - m(hi, (x) => x.d.baselineMpg) >= 0 ? '+' : '') + (m(hi, (x) => x.d.y) - m(hi, (x) => x.d.baselineMpg)).toFixed(1)} vs current)`);
  console.log(`    bottom decile n=${lo.length}  current ${m(lo, (x) => x.d.baselineMpg).toFixed(1)}  TULIP ${m(lo, (x) => x.pred).toFixed(1)}  ACTUAL ${m(lo, (x) => x.d.y).toFixed(1)}  (${(m(lo, (x) => x.d.y) - m(lo, (x) => x.d.baselineMpg) >= 0 ? '+' : '') + (m(lo, (x) => x.d.y) - m(lo, (x) => x.d.baselineMpg)).toFixed(1)} vs current)`);
}

// ===================================================================================
// TEST 1b — THE NAIVE RULE. Not a model at all: "pick whichever player has the higher recent-10
// MPG". If that alone reaches ~65%, TULIP's novelty is narrow and should be described as such.
// ===================================================================================
{
  const naive = teS.map((d) => d.recentMpg ?? d.baselineMpg);
  const ci = clusteredCI(PAIRS, naive);
  console.log(`\n===== NAIVE RULE: higher recent-10 MPG wins =====`);
  console.log(`  concordance ${(100 * conc(naive, PAIRS)).toFixed(1)}% [${(100 * ci[0]).toFixed(1)},${(100 * ci[1]).toFixed(1)}]  (vs P2 model ${(100 * conc(P['P2 + team blockage'], PAIRS)).toFixed(1)}%)`);
  const sorted = [...PAIRS].sort((a, b) => Math.abs(naive[b[0]] - naive[b[1]]) - Math.abs(naive[a[0]] - naive[a[1]]));
  console.log('  coverage curve: ' + [0.05, 0.1, 0.2, 0.4, 1.0].map((c) => {
    const k = Math.max(30, Math.floor(sorted.length * c));
    return `${(100 * c).toFixed(0)}%->${(100 * conc(naive, sorted.slice(0, k))).toFixed(1)}%`;
  }).join('  '));
}

// ===================================================================================
// TEST 3 — SELECTIVE USE ON THE UNTOUCHED CHRONOLOGICAL HOLDOUT, with clustered intervals.
// Every prediction here comes from a model fitted ONLY on earlier seasons (trS); the pair universe
// is 2024-25 only. Pairs share players, so intervals resample PLAYERS, not pairs.
// ===================================================================================
console.log('\n===== COVERAGE vs ACCURACY on 2024-25 ONLY, player-clustered 95% CI =====');
console.log('  spec                 coverage   accuracy [95% CI]            pairs');
for (const n of ['recentMpg only', 'P0 workload only', 'P2 + team blockage']) {
  const p = P[n];
  const sorted = [...PAIRS].sort((a, b) => Math.abs(p[b[0]] - p[b[1]]) - Math.abs(p[a[0]] - p[a[1]]));
  for (const c of [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const k = Math.max(30, Math.floor(sorted.length * c));
    const sub = sorted.slice(0, k);
    const ci = clusteredCI(sub, p, 300);
    console.log(`  ${(c === 0.05 ? n : '').padEnd(20)} ${String((100 * c).toFixed(0) + '%').padStart(6)}     ${(100 * conc(p, sub)).toFixed(1)}% [${(100 * ci[0]).toFixed(1)},${(100 * ci[1]).toFixed(1)}]   ${String(sub.length).padStart(7)}`);
  }
}

// ===================================================================================
// TEST 2 — PORTABILITY. Does a model built on Team A information rank who sustains on Team B?
// The model is the one already fitted on earlier seasons; nothing is retrained for this subset.
// ===================================================================================
{
  const cross = teS.map((d, i) => ({ d, i })).filter((x) => x.d.crossTeam === 1);
  const same = teS.map((d, i) => ({ d, i })).filter((x) => x.d.crossTeam === 0);
  console.log(`\n===== PORTABILITY: cross-team episodes in the untouched holdout =====`);
  console.log(`  cross-team n=${cross.length} · same-team n=${same.length} (of ${teS.length})`);
  const allData = data.filter((d) => d.crossTeam === 1);
  console.log(`  cross-team episodes across ALL seasons: ${allData.length} of ${data.length} (${(100 * allData.length / data.length).toFixed(1)}%)`);
  if (cross.length < 30) {
    console.log('  SAMPLE TOO SMALL in the holdout for a definitive cross-team estimate.');
  }
  const p = P['P2 + team blockage'];
  const rep = (grp, lbl) => {
    if (grp.length < 15) { console.log(`  ${lbl}: n=${grp.length} — too few to report`); return; }
    const mae = grp.reduce((a, x) => a + Math.abs(p[x.i] - x.d.y), 0) / grp.length;
    const my = grp.reduce((a, x) => a + x.d.y, 0) / grp.length;
    let ssr = 0, sst = 0;
    for (const x of grp) { ssr += (x.d.y - p[x.i]) ** 2; sst += (x.d.y - my) ** 2; }
    const hr = grp.map((x) => p[x.i] - x.d.baselineMpg), ac = grp.map((x) => x.d.y - x.d.baselineMpg);
    const rank = (v) => { const q = v.map((z, i) => [z, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); q.forEach(([, i], k) => { r[i] = k; }); return r; };
    const a1 = rank(hr), b1 = rank(ac), N = a1.length, mm = (N - 1) / 2;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < N; i++) { nu += (a1[i] - mm) * (b1[i] - mm); da += (a1[i] - mm) ** 2; db += (b1[i] - mm) ** 2; }
    console.log(`  ${lbl}: n=${grp.length}  MAE ${mae.toFixed(3)}  R2 ${(1 - ssr / sst).toFixed(4)}  Spearman(headroom,change) ${(nu / Math.sqrt(da * db)).toFixed(3)}`);
  };
  rep(same, 'same-team ');
  rep(cross, 'cross-team');
  // Pairwise concordance restricted to cross-team players, if the sample permits.
  const ci2 = new Set(cross.map((x) => x.i));
  const cp = PAIRS.filter(([i, j]) => ci2.has(i) && ci2.has(j));
  if (cp.length >= 100) {
    const ciX = clusteredCI(cp, p, 300);
    console.log(`  cross-team pair concordance: ${(100 * conc(p, cp)).toFixed(1)}% [${(100 * ciX[0]).toFixed(1)},${(100 * ciX[1]).toFixed(1)}]  pairs=${cp.length}`);
  } else console.log(`  cross-team pairs=${cp.length} — too few for a pairwise estimate`);
}

// Fit and backtest the 2026-27 stat projection.
//
//   1. Fit every parameter on target seasons up to 2024-25 (inputs never reach past the season
//      before each target).
//   2. Test ONCE on 2025-26 against two baselines anyone could compute:
//        repeat      last season's per-game line, unchanged
//        3-year avg  minutes-weighted average of the last three seasons (5/4/3), no adjustments
//   3. Refit the same structure through 2025-26 and write the frozen card used for 2026-27.
//
// Usage: node scripts/fit-projections.mjs            (writes PROJECTION_2026_27.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  prepare, historyBefore, projectionHistory, seasonPriors, teamPaces, leagueRates, projectRates, roleFeatures,
  perGameLine, actualLine, ridge, dot, prevSeason, seasonStart, seasonName, ageInSeason,
  RATE_STATS, PCT_STATS, USAGE_STATS, AGE_MIN, AGE_MAX, MIN_FEATURES, GP_FEATURES, playsPer100,
  applyTeamContext, projectedPace, leagueTrend, rosterDepth, expectedRookieMin,
} from './lib/projection.mjs';
import { evaluateMinuteReconciliation, historicalRoleProjection } from './lib/projection-context.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = path.join(ROOT, 'scripts/data/projection/inputs.json');
const raw = fs.readFileSync(INPUTS);
const D = prepare(JSON.parse(raw));
const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------------------- per-season context */
const trendFor = (league, T) => leagueTrend(league, T, D.bio);
const ctxCache = new Map();
function contextFor(league, T) {
  const key = league.key + T;
  if (!ctxCache.has(key)) {
    const s1 = league.seasons.get(prevSeason(T));
    ctxCache.set(key, { priors: seasonPriors(s1, D.bio), paces: teamPaces(s1), trend: trendFor(league, T) });
  }
  return ctxCache.get(key);
}

/* ------------------------------------------------------------------------------ backtest pairs */
/**
 * One row per player who played in season T and in at least one of the three seasons before it.
 * `team` is the team he opened T with (the roster a preseason projection knows), falling back to
 * his final team when he missed the opening fortnight.
 */
function pairsFor(league, T) {
  const cur = league.seasons.get(T);
  const open = league.opening.get(T) || new Map();
  const out = [];
  for (const r of cur.values()) {
    const hist = historyBefore(league, r.pid, T);
    if (!hist.some(Boolean)) continue;
    const last = hist.find(Boolean);
    const team = open.get(r.pid) || r.team;
    out.push({ T, pid: r.pid, hist, actual: r, team, moved: team !== last.team, bio: D.bio.get(r.pid) });
  }
  return out;
}

/** Everyone a team opened season T with, including rookies and returnees with no recent history. */
function rostersFor(league, T) {
  const cur = league.seasons.get(T);
  const open = league.opening.get(T) || new Map();
  const teams = new Map();
  for (const r of cur.values()) {
    const team = open.get(r.pid) || r.team;
    // A player who only turned up after opening night and has no NBA past is a mid-season call-up:
    // a preseason projection could not have known about him, so he does not count against depth.
    const hist = historyBefore(league, r.pid, T);
    if (!open.has(r.pid) && !hist.some(Boolean)) continue;
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(r.pid);
  }
  return teams;
}

// Model development used DEV mode only: fit through 2023-24, check on 2024-25. The 2025-26 season is
// the final exam, run by the default mode, and the card records its result as it came out.
const DEV = process.argv[2] === 'dev';
const LAST_TRAIN = DEV ? 2023 : 2024;
const NBA_TRAIN = [];
for (let y = 2012; y <= LAST_TRAIN; y++) NBA_TRAIN.push(seasonName(y));
const NBA_TEST = seasonName(LAST_TRAIN + 1);

/* --------------------------------------------------------------------------------- parameters */
function freshParams() {
  const zeros = () => new Array(AGE_MAX - AGE_MIN + 1).fill(0);
  return {
    w2: 0.6, w3: 0.3,
    R: Object.fromEntries(RATE_STATS.map((k) => [k, 1000])),
    m: Object.fromEntries(RATE_STATS.map((k) => [k, 1])),
    Rpct: { fg2: 300, fg3: 600, ft: 200 },
    mPct: { fg2: 1, ft: 1 },
    fg3Prior: [0.30, 0.02],
    age: Object.fromEntries([...RATE_STATS, ...Object.keys(PCT_STATS)].map((k) => [k, zeros()])),
    exp: {},
    trendShare: 0,
  };
}

/* ---------------------------------------------------------------------------- stage 1: rates */
function rateLoss(pairs, P, k) {
  let s = 0, w = 0;
  for (const q of pairs) {
    const c = contextFor(D[q.league], q.T);
    const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
    const a = q.actual;
    const actual = (a[k] / a.poss) * 100;
    s += a.poss * (actual - pr.rate[k]) ** 2;
    w += a.poss;
  }
  return s / w;
}
function pctLoss(pairs, P, k) {
  const [m, att] = PCT_STATS[k];
  let s = 0, w = 0;
  for (const q of pairs) {
    const a = q.actual;
    if (!(a[att] > 0)) continue;
    const c = contextFor(D[q.league], q.T);
    const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
    s += a[att] * (a[m] / a[att] - pr.pct[k]) ** 2;
    w += a[att];
  }
  return s / w;
}

function fitRegression(pairs, P) {
  const Rgrid = [1, 100, 250, 500, 1000, 2000, 4000, 8000];
  const mgrid = [0.7, 0.8, 0.9, 1, 1.1];
  for (const k of RATE_STATS) {
    let best = null;
    for (const R of Rgrid) for (const m of mgrid) {
      P.R[k] = R; P.m[k] = m;
      const l = rateLoss(pairs, P, k);
      if (!best || l < best.l) best = { l, R, m };
    }
    P.R[k] = best.R; P.m[k] = best.m;
  }
}

function fitWeights(pairs, P) {
  // Recency weights, shared by every stat: the season-before-last and the one before that.
  const sample = pairs.filter((_, i) => i % 3 === 0);
  const base = RATE_STATS.map((k) => rateLoss(sample, P, k));
  let best = null;
  for (const w2 of [0.3, 0.45, 0.6, 0.75, 0.9]) for (const w3 of [0, 0.15, 0.3, 0.45]) {
    if (w3 > w2) continue;
    P.w2 = w2; P.w3 = w3;
    const l = RATE_STATS.reduce((s, k, i) => s + rateLoss(sample, P, k) / base[i], 0);
    if (!best || l < best.l) best = { l, w2, w3 };
  }
  P.w2 = best.w2; P.w3 = best.w3;
}

/**
 * Age curves: after the regressed base, how far do actual rates sit above or below it at each
 * age? Kernel-smoothed ratio of sums, so a few extreme players cannot bend the curve.
 */
function fitAge(pairs, P, keys = RATE_STATS) {
  const sigma = 1.25;
  for (const k of keys) {
    const pts = [];
    for (const q of pairs) {
      const c = contextFor(D[q.league], q.T);
      const saved = P.age[k]; P.age[k] = null;
      const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
      P.age[k] = saved;
      const a = q.actual;
      if (PCT_STATS[k]) {
        const [m, att] = PCT_STATS[k];
        if (!(a[att] > 0)) continue;
        pts.push({ age: pr.age, w: a[att], resid: a[m] / a[att] - pr.pct[k], base: null });
      } else {
        pts.push({ age: pr.age, w: a.poss, act: (a[k] / a.poss) * 100, base: pr.rate[k] / (pr.pieces[k].ageF || 1) });
      }
    }
    const table = [];
    for (let age = AGE_MIN; age <= AGE_MAX; age++) {
      let num = 0, den = 0, wsum = 0;
      for (const p of pts) {
        if (!Number.isFinite(p.age)) continue;
        const kw = Math.exp(-0.5 * ((p.age - age) / sigma) ** 2) * p.w;
        if (PCT_STATS[k]) { num += kw * p.resid; den += kw; } else { num += kw * p.act; den += kw * p.base; }
        wsum += kw;
      }
      // Thin ages borrow from the neighbours: shrink toward zero when the kernel mass is small.
      const shrink = wsum / (wsum + (PCT_STATS[k] ? 2000 : 20000));
      table.push(den > 0 ? (PCT_STATS[k] ? num / den : num / den - 1) * shrink : 0);
    }
    P.age[k] = table.map((v) => Math.round(v * 10000) / 10000);
  }
}

/** Development for players in their first four seasons, beyond what age explains. */
function fitExperience(pairs, P) {
  for (const k of RATE_STATS) {
    const X = [], y = [], w = [];
    for (const q of pairs) {
      const c = contextFor(D[q.league], q.T);
      const saved = P.exp[k]; P.exp[k] = null;
      const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
      P.exp[k] = saved;
      if (!Number.isFinite(pr.yearsIn) || pr.yearsIn > 4 || pr.yearsIn < 2) continue;
      const a = q.actual;
      const ratio = ((a[k] / a.poss) * 100) / Math.max(1e-6, pr.rate[k]) - 1;
      const pick = (61 - Math.min(61, pr.draft)) / 60;
      X.push([pr.yearsIn === 2 ? 1 : 0, pr.yearsIn === 3 ? 1 : 0, pr.yearsIn === 4 ? 1 : 0, pick * (5 - pr.yearsIn) / 4]);
      y.push(Math.max(-1, Math.min(1.5, ratio)));
      w.push(a.poss);
    }
    const b = ridge(X, y, w, 2e5, []);
    P.exp[k] = { 0: 0, 1: b[0], 2: b[1], 3: b[2], pick: b[3] };
    for (const i of [1, 2, 3]) P.exp[k][i] = Math.round(P.exp[k][i] * 10000) / 10000;
    P.exp[k].pick = Math.round(b[3] * 10000) / 10000;
  }
}

function fitShooting(pairs, P) {
  // 3P% prior: volume shooters make more. Fitted on players with a real sample.
  {
    const X = [], y = [], w = [];
    for (const q of pairs) {
      const a = q.actual;
      if (a.fg3a < 50) continue;
      const c = contextFor(D[q.league], q.T);
      const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
      X.push([1, Math.log(Math.max(0.3, pr.rate.fg3a))]);
      y.push(a.fg3m / a.fg3a);
      w.push(a.fg3a);
    }
    P.fg3Prior = ridge(X, y, w, 1e-6, [0, 1]).map((v) => Math.round(v * 10000) / 10000);
  }
  // Recency weights for the percentages, chosen with each stat's best regression amount.
  let bestW = null;
  const sample = pairs.filter((_, i) => i % 2 === 0);
  for (const [pw2, pw3] of [[0.45, 0.3], [0.6, 0.45], [0.75, 0.6], [0.9, 0.8], [1, 1]]) {
    P.pw2 = pw2; P.pw3 = pw3;
    let tot = 0;
    for (const k of Object.keys(PCT_STATS)) {
      let bk = Infinity;
      for (const R of [50, 200, 700, 2000]) { P.Rpct[k] = R; bk = Math.min(bk, pctLoss(sample, P, k)); }
      tot += bk * 1000;
    }
    if (!bestW || tot < bestW.tot) bestW = { tot, pw2, pw3 };
  }
  P.pw2 = bestW.pw2; P.pw3 = bestW.pw3;
  for (const k of Object.keys(PCT_STATS)) {
    let best = null;
    for (const R of [25, 50, 100, 200, 400, 700, 1000, 1500, 2500]) {
      for (const m of k === 'fg3' ? [1] : [0.9, 0.95, 1, 1.03]) {
        P.Rpct[k] = R; if (k !== 'fg3') P.mPct[k] = m;
        const l = pctLoss(pairs, P, k);
        if (!best || l < best.l) best = { l, R, m };
      }
    }
    P.Rpct[k] = best.R; if (k !== 'fg3') P.mPct[k] = best.m;
  }
}

function fitTrend(pairs, P) {
  const sample = pairs.filter((_, i) => i % 2 === 0);
  let best = null;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    P.trendShare = t;
    const l = RATE_STATS.reduce((s, k) => s + rateLoss(sample, P, k) / (rateLoss(sample, { ...P, trendShare: 0 }, k) || 1), 0);
    if (!best || l < best.l) best = { l, t };
  }
  P.trendShare = best.t;
}

/* --------------------------------------------------------------------- stage 2: role and team */
function rookiePrior(league, seasons) {
  // Minutes a rookie plays, by draft slot, from every rookie season in the training window.
  const X = [], y = [], w = [];
  for (const T of seasons) {
    for (const r of league.seasons.get(T).values()) {
      const b = D.bio.get(r.pid);
      if (!b?.fromYear || b.fromYear !== seasonStart(T)) continue;
      const pick = (61 - Math.min(61, b.draftNumber ?? 61)) / 60;
      const share = Math.min(1, r.gp / league.teamGames(T, r.team));
      X.push([1, pick, pick * pick]); y.push((r.min / r.gp) * share); w.push(1);
    }
  }
  return ridge(X, y, w, 1e-6, [0, 1, 2]).map((v) => Math.round(v * 1000) / 1000);
}
const depthOf = (league, T, roster, pid, rookieCoef) => rosterDepth(league, T, roster, pid, rookieCoef, D.bio);

function buildRoleRows(league, pairs, P, rookieCoef) {
  const rosterCache = new Map();
  return pairs.map((q) => {
    if (!rosterCache.has(q.T)) rosterCache.set(q.T, rostersFor(league, q.T));
    const roster = rosterCache.get(q.T).get(q.team) || [];
    const c = contextFor(league, q.T);
    const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
    const f = roleFeatures(q.hist, q.T, q.bio, league.teamGames, pr, { moved: q.moved, depth: depthOf(league, q.T, roster, q.pid, rookieCoef) });
    return { q, pr, f };
  });
}

// How players are used drifts (load management has cut games played), so recent seasons count
// more when fitting minutes and games: each season back is worth ROLE_DECAY of the one after it.
const ROLE_DECAY = Number(process.env.ROLE_DECAY ?? 0.9);
function fitRole(rows) {
  const latest = Math.max(...rows.map((r) => seasonStart(r.q.T)));
  const rec = (r) => ROLE_DECAY ** (latest - seasonStart(r.q.T));
  const X = rows.map((r) => MIN_FEATURES.map((n) => r.f[n]));
  const y = rows.map((r) => r.q.actual.min / r.q.actual.gp);
  const w = rows.map((r) => Math.min(1, r.q.actual.gp / 20) * rec(r));
  const minutes = ridge(X, y, w, 1, [0]).map((v) => Math.round(v * 10000) / 10000);
  const Xg = rows.map((r) => GP_FEATURES.map((n) => r.f[n]));
  const yg = rows.map((r) => Math.min(1, r.q.actual.gp / D.nba.teamGames(r.q.T, r.q.actual.team)));
  const gp = ridge(Xg, yg, rows.map(rec), 1, [0]).map((v) => Math.round(v * 10000) / 10000);
  return { minutes, gp };
}

/**
 * Put rates, minutes and team context together for every player a team opened season T with.
 * This is the full projection; `opts` switches team factors off for the ablation table.
 */
function projectTeamSeason(league, T, pairs, P, role, opts = {}) {
  const c = contextFor(league, T);
  const rows = buildRoleRows(league, pairs, P, role.rookie);
  const byTeam = new Map();
  for (const r of rows) {
    r.mpg = Math.max(1, Math.min(40, dot(role.minutes, r.f, MIN_FEATURES)));
    r.share = Math.max(0.05, Math.min(1, dot(role.gp, r.f, GP_FEATURES)));
    r.games = r.share * 82;
    const last = r.q.hist[0];
    r.mpgLast = last ? last.min / last.gp : null;
    r.moved = r.q.moved;
    if (!byTeam.has(r.q.team)) byTeam.set(r.q.team, []);
    byTeam.get(r.q.team).push(r);
  }
  for (const [team, list] of byTeam) {
    const pace = opts.noPace ? projectedPace(c.priors, c.trend, NaN, P) : projectedPace(c.priors, c.trend, c.paces.get(team), P);
    applyTeamContext(list, c.priors, pace, P, opts);
  }
  return rows;
}

function fitTeam(league, trainPairs, P, role) {
  // Whole rosters, never a sample of players: the usage balance is a team-level quantity.
  const bySeason = groupBy(trainPairs, (q) => q.T);
  const loss = () => {
    const acc = Object.fromEntries(USAGE_STATS.map((k) => [k, [0, 0]]));
    for (const [T, ps] of bySeason) {
      for (const r of projectTeamSeason(league, T, ps, P, role, { noPace: true })) {
        const a = r.q.actual;
        for (const k of USAGE_STATS) {
          const e = r.rateFinal[k] - (a[k] / a.poss) * 100;
          acc[k][0] += a.poss * e * e; acc[k][1] += a.poss;
        }
      }
    }
    return USAGE_STATS.reduce((s, k) => s + acc[k][0] / acc[k][1] / ((baseLoss?.[k]) || 1), 0);
  };
  let baseLoss = null;
  {
    P.team.usageMu = 0; P.team.roleGamma = 0; P.team.movedUsage = 0;
    const acc = Object.fromEntries(USAGE_STATS.map((k) => [k, [0, 0]]));
    for (const [T, ps] of bySeason) for (const r of projectTeamSeason(league, T, ps, P, role, { noPace: true })) {
      const a = r.q.actual;
      for (const k of USAGE_STATS) { const e = r.rateFinal[k] - (a[k] / a.poss) * 100; acc[k][0] += a.poss * e * e; acc[k][1] += a.poss; }
    }
    baseLoss = Object.fromEntries(USAGE_STATS.map((k) => [k, acc[k][0] / acc[k][1]]));
  }
  // Coordinate search, each factor on its own grid, twice round.
  const grids = { usageMu: [0, 0.25, 0.5, 0.75, 1], roleGamma: [-0.15, -0.1, -0.05, 0, 0.05], movedUsage: [-0.06, -0.03, 0, 0.03] };
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, grid] of Object.entries(grids)) {
      let best = null;
      for (const v of grid) {
        P.team[name] = v;
        const l = loss();
        if (!best || l < best.l) best = { l, v };
      }
      P.team[name] = best.v;
    }
  }
}

function fitPace(league, seasons, P) {
  // Team-level persistence of pace relative to the league, season to season.
  const X = [], y = [];
  for (const T of seasons) {
    const cur = teamPaces(league.seasons.get(T)), prev = teamPaces(league.seasons.get(prevSeason(T)));
    const lgC = seasonPriors(league.seasons.get(T), D.bio).pace, lgP = seasonPriors(league.seasons.get(prevSeason(T)), D.bio).pace;
    for (const [team, p] of cur) {
      if (!prev.has(team)) continue;
      X.push([prev.get(team) / lgP - 1]); y.push(p / lgC - 1);
    }
  }
  P.team.paceRho = Math.round(ridge(X, y, null, 1e-6, [])[0] * 1000) / 1000;
  // Share of the recent league pace trend that carries into the next season.
  let best = null;
  for (const t of [0, 0.5, 1]) {
    let s = 0;
    for (const T of seasons) {
      const lgC = seasonPriors(league.seasons.get(T), D.bio).pace;
      const lgP = seasonPriors(league.seasons.get(prevSeason(T)), D.bio).pace;
      const tr = trendFor(league, T).pace || 0;
      s += (Math.log(lgC / lgP) - t * tr) ** 2;
    }
    if (!best || s < best.s) best = { s, t };
  }
  P.team.paceTrend = best.t;
}

const groupBy = (xs, f) => xs.reduce((m, x) => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); return m; }, new Map());

/* ------------------------------------------------------------------------------------- scoring */
const STAT_KEYS = ['mpg', 'gp', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m'];
const PCT_KEYS = [['fgPct', 'fga'], ['fg3Pct', 'fg3a'], ['ftPct', 'fta']];

function baselineLines(q) {
  const last = q.hist.find(Boolean);
  const idx = q.hist.indexOf(last);
  const rep = actualLine(last);
  rep.gp = Math.min(1, last.gp / D.nba.teamGames(prevSeason(q.T, idx + 1), last.team)) * 82;
  // 3-year average of per-game production, weighted 5/4/3 and by games.
  const w = [5, 4, 3];
  const avg = {};
  let den = 0;
  const lines = q.hist.map((r) => (r ? actualLine(r) : null));
  q.hist.forEach((r, i) => { if (r) den += w[i] * r.gp; });
  for (const k of [...STAT_KEYS, 'fga', 'fg3a', 'fta']) {
    let s = 0;
    q.hist.forEach((r, i) => { if (r) s += w[i] * r.gp * lines[i][k]; });
    avg[k] = s / den;
  }
  const tot = (key) => q.hist.reduce((s, r, i) => s + (r ? w[i] * r[key] : 0), 0);
  avg.fgPct = tot('fga') > 0 ? tot('fgm') / tot('fga') : null;
  avg.fg3Pct = tot('fg3a') > 0 ? tot('fg3m') / tot('fg3a') : null;
  avg.ftPct = tot('fta') > 0 ? tot('ftm') / tot('fta') : null;
  let gsh = 0, gw = 0;
  q.hist.forEach((r, i) => { if (r) { gsh += w[i] * Math.min(1, r.gp / D.nba.teamGames(prevSeason(q.T, i + 1), r.team)); gw += w[i]; } });
  avg.gp = (gsh / gw) * 82;
  return { repeat: rep, avg3: avg };
}

function score(rows, pick = () => true) {
  const out = {};
  const sets = { model: (r) => r.line, repeat: (r) => r.base.repeat, avg3: (r) => r.base.avg3 };
  const use = rows.filter(pick);
  for (const [name, get] of Object.entries(sets)) {
    out[name] = {};
    for (const k of STAT_KEYS) {
      let s = 0, s2 = 0;
      for (const r of use) {
        const a = actualLine(r.q.actual);
        const act = k === 'gp' ? Math.min(1, r.q.actual.gp / D.nba.teamGames(r.q.T, r.q.actual.team)) * 82 : a[k];
        const e = get(r)[k] - act;
        s += Math.abs(e); s2 += e * e;
      }
      out[name][k] = { mae: s / use.length, rmse: Math.sqrt(s2 / use.length) };
    }
    for (const [k, att] of PCT_KEYS) {
      let s = 0, w = 0;
      for (const r of use) {
        const a = actualLine(r.q.actual);
        const n = r.q.actual[att === 'fga' ? 'fga' : att];
        if (!(n >= (att === 'fga' ? 100 : 50)) || !Number.isFinite(get(r)[k])) continue;
        s += Math.abs(get(r)[k] - a[k]); w++;
      }
      out[name][k] = { mae: s / Math.max(1, w), n: w };
    }
  }
  out.n = use.length;
  return out;
}

/** Bootstrap the model-minus-baseline MAE difference over players (95% interval). */
function bootstrap(rows, k, baseline, reps = 1000) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const err = rows.map((r) => {
    const act = k === 'gp' ? Math.min(1, r.q.actual.gp / D.nba.teamGames(r.q.T, r.q.actual.team)) * 82 : actualLine(r.q.actual)[k];
    return Math.abs(r.base[baseline][k] - act) - Math.abs(r.line[k] - act);
  });
  const means = [];
  for (let b = 0; b < reps; b++) {
    let s = 0;
    for (let i = 0; i < err.length; i++) s += err[Math.floor(rnd() * err.length)];
    means.push(s / err.length);
  }
  means.sort((a, b) => a - b);
  return { gain: err.reduce((a, b) => a + b, 0) / err.length, lo: means[Math.floor(reps * 0.025)], hi: means[Math.floor(reps * 0.975)] };
}

/* --------------------------------------------------------------------------------- the pipeline */
function fitAll(league, trainSeasons) {
  const P = freshParams();
  const pairs = trainSeasons.flatMap((T) => pairsFor(league, T)).map((q) => ({ ...q, league: league.key }));
  log(`  ${pairs.length} player-season pairs from ${trainSeasons[0]} to ${trainSeasons.at(-1)}`);
  fitWeights(pairs, P); log(`  recency weights 1 / ${P.w2} / ${P.w3}`);
  fitRegression(pairs, P);
  fitAge(pairs, P);
  fitRegression(pairs, P);
  fitAge(pairs, P);
  fitExperience(pairs, P);
  fitTrend(pairs, P);
  fitShooting(pairs, P);
  fitAge(pairs, P, Object.keys(PCT_STATS));
  fitShooting(pairs, P);
  log(`  regression R ${JSON.stringify(P.R)}  m ${JSON.stringify(P.m)}`);
  log(`  shooting weights 1 / ${P.pw2} / ${P.pw3}  R ${JSON.stringify(P.Rpct)} mPct ${JSON.stringify(P.mPct)} 3P prior ${P.fg3Prior}  trend share ${P.trendShare}`);
  const role = { rookie: rookiePrior(league, trainSeasons) };
  const roleRows = buildRoleRows(league, pairs, P, role.rookie);
  Object.assign(role, fitRole(roleRows));
  P.team = { usageMu: 0, roleGamma: 0, movedUsage: 0, paceRho: 0.5, paceTrend: 0 };
  fitPace(league, trainSeasons, P);
  fitTeam(league, pairs, P, role);
  log(`  team: ${JSON.stringify(P.team)}`);
  log(`  minutes coef ${MIN_FEATURES.map((n, i) => n + '=' + role.minutes[i]).join(' ')}`);
  log(`  games coef ${GP_FEATURES.map((n, i) => n + '=' + role.gp[i]).join(' ')}`);
  return { P, role };
}

function evaluate(league, T, fit, opts) {
  const pairs = pairsFor(league, T).map((q) => ({ ...q, league: league.key }));
  const rows = projectTeamSeason(league, T, pairs, fit.P, fit.role, opts);
  for (const r of rows) r.base = baselineLines(r.q);
  return rows;
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
function report(label, sc) {
  log(`\n${label} (n=${sc.n})`);
  log('  stat     model   repeat   3yr-avg   (MAE, per game)');
  for (const k of [...STAT_KEYS, 'fgPct', 'fg3Pct', 'ftPct']) {
    const d = k.endsWith('Pct') ? 3 : 2;
    log(`  ${k.padEnd(7)} ${fmt(sc.model[k].mae, d).padStart(6)} ${fmt(sc.repeat[k].mae, d).padStart(8)} ${fmt(sc.avg3[k].mae, d).padStart(9)}`);
  }
}

log(`NBA: fitting on 2012-13 .. ${NBA_TRAIN.at(-1)} targets${DEV ? ' (DEV: checking on ' + NBA_TEST + ')' : ''}`);
const fitTrain = fitAll(D.nba, NBA_TRAIN);
const testRows = evaluate(D.nba, NBA_TEST, fitTrain);
const scAll = score(testRows);
const scRot = score(testRows, (r) => r.q.actual.min >= 1000);
const openingRoster = rostersFor(D.nba, NBA_TEST);
const scoredByPid = new Map(testRows.map((r) => [r.q.pid, r]));
const reconciliationRows = [];
let reconciliationExcludedTeams = 0;
const heldoutCtx = contextFor(D.nba, NBA_TEST);
for (const [team, roster] of openingRoster) {
  const teamRows = [];
  let supported = true;
  for (const pid of roster) {
    const scored = scoredByPid.get(pid);
    if (scored) {
      const a = actualLine(scored.q.actual);
      teamRows.push({
        team, rosterSize: roster.length, playerId: pid, score: true,
        mpg: scored.line.mpg, share: scored.share, pr: { baseMin: scored.pr.baseMin },
        line: { mpg: scored.line.mpg, pts: scored.line.pts, reb: scored.line.reb, ast: scored.line.ast },
        actual: { mpg: a.mpg, pts: a.pts, reb: a.reb, ast: a.ast },
      });
      continue;
    }

    // Reserve opportunity for opening-roster players who are not in the veteran scoring sample.
    // These proxies use only information available before the target season and are never scored.
    const bio = D.bio.get(pid);
    const history = projectionHistory(D.nba, pid, NBA_TEST);
    if (history.fallback) {
      const last = history.hist.find(Boolean);
      const moved = !!last && team !== last.team;
      const depth = depthOf(D.nba, NBA_TEST, roster, pid, fitTrain.role.rookie);
      const pr = projectRates(history.hist, NBA_TEST, bio, heldoutCtx.priors, fitTrain.P, heldoutCtx.trend);
      const hr = historicalRoleProjection(history.hist, NBA_TEST, bio, D.nba.teamGames, pr,
        { moved, depth }, fitTrain.role, fitTrain.P, 82);
      teamRows.push({
        team, rosterSize: roster.length, playerId: pid, score: false, proxyType: 'older-history-returner',
        mpg: hr.mpg, share: hr.share, pr: { baseMin: pr.baseMin },
      });
      continue;
    }

    const entryYear = bio?.fromYear || bio?.draftYear;
    if (entryYear === seasonStart(NBA_TEST)) {
      const effective = expectedRookieMin(fitTrain.role.rookie, bio);
      teamRows.push({
        team, rosterSize: roster.length, playerId: pid, score: false, proxyType: 'rookie',
        // expectedRookieMin is fitted as effective minutes per team game. Keep that exact base
        // demand here; the proxy exists only to reserve roster opportunity, not to predict MPG.
        mpg: Math.max(1, Math.min(36, effective)), share: 1, pr: { baseMin: 0 },
      });
      continue;
    }
    supported = false;
    break;
  }
  if (supported && teamRows.some((r) => r.score)) reconciliationRows.push(...teamRows);
  else reconciliationExcludedTeams++;
}
const contextReconciliation = evaluateMinuteReconciliation(reconciliationRows, {
  budget: 240,
  totalOpeningTeams: openingRoster.size,
  excludedTeams: reconciliationExcludedTeams,
});
report(`${DEV ? 'VALIDATION' : 'TEST'} ${NBA_TEST}, every player with NBA history`, scAll);
report(`${DEV ? 'VALIDATION' : 'TEST'} ${NBA_TEST}, 1,000+ minutes`, scRot);
log('  context reconciliation (minute layer only): ' + JSON.stringify(contextReconciliation));
if (process.argv.includes('context')) {
  log('\nCONTEXT_RECONCILIATION ' + JSON.stringify(contextReconciliation));
  process.exit(0);
}
const boots = {};
for (const k of STAT_KEYS) boots[k] = { vsRepeat: bootstrap(testRows, k, 'repeat'), vsAvg3: bootstrap(testRows, k, 'avg3') };
log('\n  model gain in MAE (positive = model better), 95% bootstrap interval');
for (const k of STAT_KEYS) log(`  ${k.padEnd(6)} vs repeat ${fmt(boots[k].vsRepeat.gain)} [${fmt(boots[k].vsRepeat.lo)}, ${fmt(boots[k].vsRepeat.hi)}]   vs 3yr ${fmt(boots[k].vsAvg3.gain)} [${fmt(boots[k].vsAvg3.lo)}, ${fmt(boots[k].vsAvg3.hi)}]`);
// What the team factors add, on the same held-out season.
const ablate = {};
for (const [name, opts] of Object.entries({ noUsage: { noUsage: true }, noRole: { noRole: true }, noMoved: { noMoved: true },
  noPace: { noPace: true }, noTeamContext: { noUsage: true, noRole: true, noMoved: true, noPace: true } })) {
  const rows = evaluate(D.nba, NBA_TEST, fitTrain, opts);
  const s = score(rows);
  ablate[name] = { pts: s.model.pts.mae, mpg: s.model.mpg.mae, reb: s.model.reb.mae, ast: s.model.ast.mae };
}
log(`\n  ablation on ${NBA_TEST} (MAE with that factor switched off): ` + JSON.stringify(ablate, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
log(`  full model: pts ${fmt(scAll.model.pts.mae, 3)} mpg ${fmt(scAll.model.mpg.mae, 3)} reb ${fmt(scAll.model.reb.mae, 3)} ast ${fmt(scAll.model.ast.mae, 3)}`);

// Ranges: how far actual results landed from the projection on the held-out season, for players
// with a similar projected value (bigger projections miss by more in absolute terms). Four bands per
// stat, split at the quartiles of the projected value; each stores the 10th and 90th percentile miss.
function intervals(rows) {
  const out = {};
  const actualOf = (r, k) => (k === 'gp' ? Math.min(1, r.q.actual.gp / D.nba.teamGames(r.q.T, r.q.actual.team)) * 82 : actualLine(r.q.actual)[k]);
  for (const k of ['gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']) {
    const sorted = rows.map((r) => ({ p: r.line[k], e: actualOf(r, k) - r.line[k] })).sort((a, b) => a.p - b.p);
    const n = sorted.length;
    out[k] = [0, 1, 2, 3].map((b) => {
      const part = sorted.slice(Math.floor((b * n) / 4), Math.floor(((b + 1) * n) / 4));
      const e = part.map((x) => x.e).sort((a, c) => a - c);
      const q = (pp) => e[Math.max(0, Math.min(e.length - 1, Math.round(pp * (e.length - 1))))];
      return { upTo: b === 3 ? null : Math.round(part.at(-1).p * 100) / 100, n: part.length,
        p10: Math.round(q(0.1) * 100) / 100, p90: Math.round(q(0.9) * 100) / 100 };
    });
  }
  return out;
}
const residualBands = intervals(testRows);
if (process.env.PROJ_DEBUG) {
  const bias = (k) => testRows.reduce((s, r) => s + r.line[k] - (k === 'gp' ? Math.min(1, r.q.actual.gp / D.nba.teamGames(r.q.T, r.q.actual.team)) * 82 : actualLine(r.q.actual)[k]), 0) / testRows.length;
  log('\n  mean bias (model - actual):', ['mpg', 'gp', 'pts', 'reb', 'ast', 'fg3m'].map((k) => k + ' ' + bias(k).toFixed(2)).join('  '));
  const P = fitTrain.P;
  log('  age effect (multiplier-1 for rates, +pct for shooting) at ages 20/23/26/29/32/35/38:');
  for (const k of ['fga', 'fg3a', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'fg2', 'fg3', 'ft']) {
    log('   ', k.padEnd(5), [20, 23, 26, 29, 32, 35, 38].map((a) => (P.age[k][a - AGE_MIN] * 100).toFixed(1).padStart(6)).join(''));
  }
  log('  experience effects', JSON.stringify(P.exp));
  const tier = (label, rows) => {
    if (!rows.length) return;
    const m = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    log(`  ${label.padEnd(22)} n=${String(rows.length).padStart(3)}  pts bias ${m((r) => r.line.pts - actualLine(r.q.actual).pts).toFixed(2).padStart(6)}  mpg bias ${m((r) => r.line.mpg - actualLine(r.q.actual).mpg).toFixed(2).padStart(6)}  pts MAE ${m((r) => Math.abs(r.line.pts - actualLine(r.q.actual).pts)).toFixed(2)} (repeat ${m((r) => Math.abs(r.base.repeat.pts - actualLine(r.q.actual).pts)).toFixed(2)})`);
  };
  const lastPts = (r) => (r.q.hist[0] ? r.q.hist[0].pts / r.q.hist[0].gp : 0);
  tier('last season 20+ ppg', testRows.filter((r) => lastPts(r) >= 20));
  tier('last season 12-20 ppg', testRows.filter((r) => lastPts(r) >= 12 && lastPts(r) < 20));
  tier('age 33+', testRows.filter((r) => r.pr.age >= 33));
  tier('age <= 23', testRows.filter((r) => r.pr.age <= 23));
  tier('missed last season', testRows.filter((r) => !r.q.hist[0]));
  tier('moved, 28+ mpg', testRows.filter((r) => r.q.moved && r.q.hist[0] && r.q.hist[0].min / r.q.hist[0].gp >= 28));
  tier('moved, <28 mpg', testRows.filter((r) => r.q.moved && r.q.hist[0] && r.q.hist[0].min / r.q.hist[0].gp < 28));
  const movers = testRows.filter((r) => r.q.moved);
  const mae = (rows, f) => rows.reduce((s, r) => s + Math.abs(f(r)), 0) / rows.length;
  log(`  movers n=${movers.length}: MPG MAE model ${mae(movers, (r) => r.line.mpg - actualLine(r.q.actual).mpg).toFixed(2)} vs repeat ${mae(movers, (r) => r.base.repeat.mpg - actualLine(r.q.actual).mpg).toFixed(2)}`);
}

const fitFinal = DEV ? null : (log('\nNBA: refitting through 2025-26 for the 2026-27 projection'), fitAll(D.nba, [...NBA_TRAIN, NBA_TEST]));

/* ------------------------------------------------------------------------------------ G League */
// The G League gets the same rate formula (its own weights, priors, regression and age curves)
// with a simpler role model: its rosters turn over too fast within a season for team budgets.
const GL_TRAIN = [];
for (let y = 2017; y <= LAST_TRAIN; y++) if (y !== 2020) GL_TRAIN.push(seasonName(y));
const GL_TEST = seasonName(LAST_TRAIN + 1);
const glGames = new Map();
for (const [s, m] of D.gleague.seasons) {
  const gps = [...m.values()].map((r) => r.gp).sort((a, b) => b - a);
  glGames.set(s, gps[Math.floor(gps.length * 0.02)] || 50);
}
D.gleague.teamGames = (s) => glGames.get(s) || 50;

function fitGLeague(trainSeasons) {
  const league = D.gleague;
  const P = freshParams();
  const pairs = trainSeasons.flatMap((T) => pairsFor(league, T)).map((q) => ({ ...q, league: 'gleague' }));
  log(`  ${pairs.length} G League pairs`);
  fitWeights(pairs, P); fitRegression(pairs, P); fitAge(pairs, P); fitRegression(pairs, P);
  fitShooting(pairs, P); fitAge(pairs, P, Object.keys(PCT_STATS)); fitShooting(pairs, P);
  P.trendShare = 0;
  const rows = pairs.map((q) => {
    const c = contextFor(league, q.T);
    const pr = projectRates(q.hist, q.T, q.bio, c.priors, P, c.trend);
    return { q, pr, f: roleFeatures(q.hist, q.T, q.bio, league.teamGames, pr, { moved: false, depth: 0 }) };
  });
  const X = rows.map((r) => MIN_FEATURES.map((n) => r.f[n]));
  const y = rows.map((r) => r.q.actual.min / r.q.actual.gp);
  const minutes = ridge(X, y, rows.map((r) => Math.min(1, r.q.actual.gp / 10)), 5, [0]).map((v) => Math.round(v * 10000) / 10000);
  const Xg = rows.map((r) => GP_FEATURES.map((n) => r.f[n]));
  const yg = rows.map((r) => Math.min(1, r.q.actual.gp / league.teamGames(r.q.T)));
  const gp = ridge(Xg, yg, null, 5, [0]).map((v) => Math.round(v * 10000) / 10000);
  P.team = { usageMu: 0, roleGamma: 0, movedUsage: 0, paceRho: 0, paceTrend: 0 };
  return { P, role: { minutes, gp, rookie: [0, 0, 0] } };
}
function evalGLeague(T, fit) {
  const league = D.gleague;
  const pairs = pairsFor(league, T);
  const c = contextFor(league, T);
  return pairs.map((q) => {
    const pr = projectRates(q.hist, T, q.bio, c.priors, fit.P, c.trend);
    const f = roleFeatures(q.hist, T, q.bio, league.teamGames, pr, { moved: false, depth: 0 });
    const mpg = Math.max(1, Math.min(42, dot(fit.role.minutes, f, MIN_FEATURES)));
    const share = Math.max(0.05, Math.min(1, dot(fit.role.gp, f, GP_FEATURES)));
    const games = league.teamGames(T);
    const line = perGameLine(pr.rate, pr.pct, mpg, share * games, c.priors.pace, c.priors.ftValue);
    const last = q.hist.find(Boolean);
    const rep = actualLine(last);
    const act = actualLine(q.actual);
    return { q, line, rep, act, games };
  });
}
log('\nG League: fitting');
const glFitTrain = fitGLeague(GL_TRAIN);
const glRows = evalGLeague(GL_TEST, glFitTrain);
const glScore = {};
for (const k of ['mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'fg3m']) {
  const m = glRows.reduce((s, r) => s + Math.abs(r.line[k] - r.act[k]), 0) / glRows.length;
  const b = glRows.reduce((s, r) => s + Math.abs(r.rep[k] - r.act[k]), 0) / glRows.length;
  glScore[k] = { model: Math.round(m * 1000) / 1000, repeat: Math.round(b * 1000) / 1000 };
}
log(`G League ${DEV ? 'VALIDATION' : 'TEST'} ${GL_TEST} (n=${glRows.length}) MAE model vs repeat: ${JSON.stringify(glScore)}`);
if (process.env.PROJ_DEBUG) {
  const bias = (f) => glRows.reduce((s, r) => s + f(r), 0) / glRows.length;
  log('  G League bias (model - actual): pts', bias((r) => r.line.pts - r.act.pts).toFixed(2), 'mpg', bias((r) => r.line.mpg - r.act.mpg).toFixed(2),
    'pts per36', bias((r) => r.line.pts / r.line.mpg * 36 - r.act.pts / r.act.mpg * 36).toFixed(2), 'repeat pts', bias((r) => r.rep.pts - r.act.pts).toFixed(2));
  for (const [lo, hi] of [[0, 8], [8, 14], [14, 20], [20, 99]]) {
    const g = glRows.filter((r) => r.rep.pts >= lo && r.rep.pts < hi);
    log(`   last-season ${lo}-${hi} ppg n=${g.length}: model bias ${(g.reduce((s, r) => s + r.line.pts - r.act.pts, 0) / g.length).toFixed(2)}, model MAE ${(g.reduce((s, r) => s + Math.abs(r.line.pts - r.act.pts), 0) / g.length).toFixed(2)}, repeat MAE ${(g.reduce((s, r) => s + Math.abs(r.rep.pts - r.act.pts), 0) / g.length).toFixed(2)}, mpg bias ${(g.reduce((s, r) => s + r.line.mpg - r.act.mpg, 0) / g.length).toFixed(2)}`);
  }
}
if (DEV) {
  log('\nDEV mode: stopping before the refit and the card.');
  process.exit(0);
}
const glFitFinal = fitGLeague([...GL_TRAIN, GL_TEST]);
const glBands = {};
for (const k of ['gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']) {
  const actualOf = (r) => (k === 'gp' ? Math.min(1, r.q.actual.gp / D.gleague.teamGames(GL_TEST)) * r.games : r.act[k]);
  const sorted = glRows.map((r) => ({ p: r.line[k], e: actualOf(r) - r.line[k] })).sort((a, b) => a.p - b.p);
  const n = sorted.length;
  glBands[k] = [0, 1, 2, 3].map((b) => {
    const part = sorted.slice(Math.floor((b * n) / 4), Math.floor(((b + 1) * n) / 4));
    const e = part.map((x) => x.e).sort((a, c) => a - c);
    const q = (pp) => e[Math.max(0, Math.min(e.length - 1, Math.round(pp * (e.length - 1))))];
    return { upTo: b === 3 ? null : Math.round(part.at(-1).p * 100) / 100, n: part.length,
      p10: Math.round(q(0.1) * 100) / 100, p90: Math.round(q(0.9) * 100) / 100 };
  });
}

/* ------------------------------------------------------------------------------------ the card */
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v)));
const summary = (sc) => Object.fromEntries([...STAT_KEYS, 'fgPct', 'fg3Pct', 'ftPct'].map((k) => [k, {
  model: sc.model[k].mae, repeat: sc.repeat[k].mae, avg3: sc.avg3[k].mae,
}]));
const card = round({
  id: 'PROJECTION_2026_27',
  target: '2026-27 regular season, per game',
  builtFrom: { inputs: 'scripts/data/projection/inputs.json', sha256: crypto.createHash('sha256').update(raw).digest('hex') },
  nba: { params: fitFinal.P, role: { ...fitFinal.role }, fittedOn: [NBA_TRAIN[0], NBA_TEST] },
  gleague: { params: glFitFinal.P, role: { ...glFitFinal.role }, fittedOn: [GL_TRAIN[0], GL_TEST],
    games: 50 },
  minFeatures: MIN_FEATURES, gpFeatures: GP_FEATURES,
  backtest: {
    protocol: 'Parameters fitted on 2012-13..2024-25 targets only; tested on 2025-26 using the rosters teams opened 2025-26 with.',
    development: 'Model choices (features, factors, weights) were made on a separate check season: fit through 2023-24, checked on 2024-25. One early 2025-26 run was seen before that; it exposed a bug (three-point and free-throw attempts counted twice), which was fixed. The 2025-26 figures here come from the final model.',
    nba: { season: NBA_TEST, all: { n: scAll.n, mae: summary(scAll) }, rotation1000: { n: scRot.n, mae: summary(scRot) },
      contextReconciliation, gainVsBaselines: boots, ablation: ablate, residualBands },
    gleague: { season: GL_TEST, n: glRows.length, mae: glScore, residualBands: glBands },
  },
});
const out = path.join(ROOT, 'PROJECTION_2026_27.json');
fs.writeFileSync(out, JSON.stringify(card, null, 1) + '\n');
log(`\nwrote ${out}`);

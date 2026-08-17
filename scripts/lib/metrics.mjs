// Project-defined composite metrics and the 0.0000-9.9999 performance grade.
//
// Every metric here is computed from official stats.nba.com fields that exist in BOTH the NBA
// and the G League, so the two panels are calculated the same way even though they are ranked
// as separate universes. Nothing is invented for a league that lacks it.
//
// v3.1 rebuild, after an audit found the model rewarded small samples and leaked concepts
// across components. See COMPONENT_INGREDIENTS and the notes on each fix below.
import { round } from './sources.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Percentile (0-100) within the supplied array, ties averaged. */
export function percentiles(values) {
  const idx = values.map((v, i) => ({ v, i })).filter((x) => fin(x.v));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array(values.length).fill(null);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const p = idx.length === 1 ? 50 : (100 * ((i + j) / 2)) / (idx.length - 1);
    for (let k = i; k <= j; k++) out[idx[k].i] = p;
    i = j + 1;
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Pull a rate metric toward its minutes-weighted league mean in proportion to minutes played,
 * after clipping the extreme tails that tiny samples produce.
 *
 * Without this, a one-game line wins every sort: the audit found Parker Van Dyke (1 game) at
 * +91.88 Efficiency Over Expected and 161.40 Role-Adjusted Impact, and a one-game Jae'Sean Tate
 * leading Chaos Points. Shrinking the metrics themselves — not just the headline grade — is what
 * stops that, and it is the same correction the grade already applies.
 */
export function stabilize(values, minutes, K) {
  const present = values.map((v, i) => ({ v, m: minutes[i] || 0, i })).filter((x) => fin(x.v));
  if (!present.length) return values.map(() => null);
  const sorted = present.map((x) => x.v).sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01), hi = quantile(sorted, 0.99);
  const wsum = present.reduce((a, x) => a + x.m, 0);
  const mean = wsum > 0
    ? present.reduce((a, x) => a + clamp(x.v, lo, hi) * x.m, 0) / wsum
    : present.reduce((a, x) => a + x.v, 0) / present.length;
  return values.map((v, i) => {
    if (!fin(v)) return null;
    const m = minutes[i] || 0;
    return (m * clamp(v, lo, hi) + K * mean) / (m + K);
  });
}

/** Least-squares fit of y on x. */
export function linfit(xs, ys, weights) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!fin(xs[i]) || !fin(ys[i])) continue;
    const w = weights ? (weights[i] || 0) : 1;
    if (w <= 0) continue;
    sw += w; sx += w * xs[i]; sy += w * ys[i];
    sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i];
  }
  if (sw === 0) return { m: 0, b: 0 };
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { m: 0, b: sy / sw };
  const m = (sw * sxy - sx * sy) / denom;
  return { m, b: (sy - m * sx) / sw };
}

/**
 * Piecewise reference curve of `y` against `x`, built from minutes-weighted bin means over
 * players who actually cleared a possession floor. A single straight line from 5% usage to 40%
 * usage is not what the usage-efficiency relationship looks like, so the expected value is
 * interpolated between bin centres instead of read off one global slope.
 */
export function referenceCurve(xs, ys, weights, { bins = 8, minWeight = 0 } = {}) {
  const pts = xs.map((x, i) => ({ x, y: ys[i], w: weights[i] || 0 }))
    .filter((p) => fin(p.x) && fin(p.y) && p.w > minWeight);
  if (pts.length < bins * 3) {
    const f = linfit(xs, ys, weights);
    return (x) => (fin(x) ? f.m * x + f.b : null);
  }
  pts.sort((a, b) => a.x - b.x);
  const per = Math.floor(pts.length / bins);
  const centres = [];
  for (let b = 0; b < bins; b++) {
    const slice = pts.slice(b * per, b === bins - 1 ? pts.length : (b + 1) * per);
    const w = slice.reduce((a, p) => a + p.w, 0) || slice.length;
    centres.push({
      x: slice.reduce((a, p) => a + p.x * p.w, 0) / w,
      y: slice.reduce((a, p) => a + p.y * p.w, 0) / w,
    });
  }
  return (x) => {
    if (!fin(x)) return null;
    if (x <= centres[0].x) return centres[0].y;
    if (x >= centres[centres.length - 1].x) return centres[centres.length - 1].y;
    for (let i = 1; i < centres.length; i++) {
      if (x <= centres[i].x) {
        const a = centres[i - 1], b = centres[i];
        const t = (x - a.x) / (b.x - a.x || 1);
        return a.y + t * (b.y - a.y);
      }
    }
    return centres[centres.length - 1].y;
  };
}

/** Normalized per-36 / rate view every downstream formula reads. */
export function normalize(o) {
  const t = o.totals, adv = o.advanced, ex = o.exact;
  const min = t.MIN || 0, gp = t.GP || 0;
  const p36 = (v) => (min > 0 && fin(v) ? (Number(v) * 36) / min : null);
  const fromPerGame36 = (v) => (min > 0 && gp > 0 && fin(v) ? (Number(v) * gp * 36) / min : null);

  // Per-GAME production. The original brief asked for a per-game performance grade; a per-36
  // rate grade answers a different question (12 pts in 16 min is 27/36 and outranks 19 pts in
  // 32 min). Both bases are computed, and the headline grade is the per-game one.
  const pgv = (v) => (gp > 0 && fin(v) ? Number(v) / gp : null);

  return {
    gp, min, mpg: gp > 0 ? min / gp : null,
    ptsPG: pgv(t.PTS), rebPG: pgv(t.REB), orebPG: pgv(t.OREB), drebPG: pgv(t.DREB),
    astPG: pgv(t.AST), stlPG: pgv(t.STL), blkPG: pgv(t.BLK), tovPG: pgv(t.TOV),
    ftaPG: pgv(t.FTA), fg3aPG: pgv(t.FG3A), pmPG: pgv(t.PLUS_MINUS),
    defWsPG: pgv(o.defense.DEF_WS),
    pts36: p36(t.PTS), reb36: p36(t.REB), oreb36: p36(t.OREB), dreb36: p36(t.DREB),
    ast36: p36(t.AST), stl36: p36(t.STL), blk36: p36(t.BLK), blka36: p36(t.BLKA),
    tov36: p36(t.TOV), pf36: p36(t.PF), pfd36: p36(t.PFD),
    fgm36: p36(t.FGM), fga36: p36(t.FGA), fg3m36: p36(t.FG3M), fg3a36: p36(t.FG3A),
    ftm36: p36(t.FTM), fta36: p36(t.FTA), fg2m36: p36(ex.FG2M), fg2a36: p36(ex.FG2A),
    pm36: p36(t.PLUS_MINUS),
    paintPts36: fromPerGame36(o.misc.PTS_PAINT), fbPts36: fromPerGame36(o.misc.PTS_FB),
    offTovPts36: fromPerGame36(o.misc.PTS_OFF_TOV), secondPts36: fromPerGame36(o.misc.PTS_2ND_CHANCE),
    ts: ex.TS_PCT, efg: ex.EFG_PCT, fgPct: ex.FG_PCT, fg3Pct: ex.FG3_PCT, ftPct: ex.FT_PCT,
    astTo: ex.AST_TO, usg: adv.USG_PCT, astPct: adv.AST_PCT, astRatio: adv.AST_RATIO,
    orebPct: adv.OREB_PCT, drebPct: adv.DREB_PCT, rebPct: adv.REB_PCT, tovPct: adv.TM_TOV_PCT,
    offRtg: adv.OFF_RATING, defRtg: adv.DEF_RATING, netRtg: adv.NET_RATING,
    pace: adv.PACE, pie: adv.PIE, poss: adv.POSS,
    pctUastFgm: o.scoring.PCT_UAST_FGM, pctUast2pm: o.scoring.PCT_UAST_2PM,
    pctUast3pm: o.scoring.PCT_UAST_3PM, pctPts3pt: o.scoring.PCT_PTS_3PT,
    pctPtsPaint: o.scoring.PCT_PTS_PAINT, pctPts2ptMr: o.scoring.PCT_PTS_2PT_MR,
    pctPtsFt: o.scoring.PCT_PTS_FT, pctPtsFb: o.scoring.PCT_PTS_FB,
    pctFga3pt: o.scoring.PCT_FGA_3PT,
    // Defensive win shares are cumulative, so a healthy player out-accumulates an equal
    // defender purely by playing. Converted to a per-36 rate before it reaches any component.
    defWs: o.defense.DEF_WS, defWs36: p36(o.defense.DEF_WS),
    pctPts: o.usage.PCT_PTS, pctAst: o.usage.PCT_AST, pctReb: o.usage.PCT_REB,
  };
}

/**
 * Fourteen project-defined metrics. Eight carry real basketball units; six are 0-100 indices.
 * These are NOT official NBA, G League or Basketball-Reference statistics.
 *
 * Every unit-carrying metric is reliability-adjusted by `stabilize` before it is exposed or
 * used, and the unadjusted figure is kept alongside it as `<name>Raw`.
 */
export function computeCustom(rows, opts = {}) {
  const n = rows.map(normalize);
  const mins = n.map((x) => x.min || 0);
  const sortedMin = [...mins].sort((a, b) => a - b);
  const K = opts.K ?? Math.round((sortedMin[Math.floor(sortedMin.length / 2)] || 1) * 0.6);
  const S = (vals) => stabilize(vals, mins, K);

  // --- unit-carrying, before stabilisation ---------------------------------
  const rawSelfCreated = n.map((x) => {
    if (!fin(x.fg2m36) || !fin(x.fg3m36)) return null;
    const u2 = fin(x.pctUast2pm) ? x.pctUast2pm : 0;
    const u3 = fin(x.pctUast3pm) ? x.pctUast3pm : 0;
    return u2 * x.fg2m36 * 2 + u3 * x.fg3m36 * 3 + (x.ftm36 || 0);
  });
  const rawSituational = n.map((x) => (fin(x.fbPts36) && fin(x.offTovPts36) && fin(x.secondPts36)
    ? x.fbPts36 + x.offTovPts36 + x.secondPts36 : null));
  const rawSwing = n.map((x) => (fin(x.stl36) && fin(x.oreb36) && fin(x.tov36)
    ? x.stl36 + x.oreb36 + 0.6 * (x.blk36 || 0) - x.tov36 - 0.4 * (x.blka36 || 0) : null));
  // Defence-only sibling of Possession Swing: no offensive rebounds, no own turnovers.
  const rawDefSwing = n.map((x) => (fin(x.stl36) && fin(x.blk36)
    ? x.stl36 + 0.6 * x.blk36 + 0.2 * (x.dreb36 || 0) : null));
  const rawWhistle = n.map((x) => (fin(x.pfd36) && fin(x.pf36) ? x.pfd36 - x.pf36 : null));
  const rawDisruptFoul = n.map((x) => (fin(x.stl36) && fin(x.blk36) && x.pf36 > 0
    ? (x.stl36 + x.blk36) / x.pf36 : null));
  const rawCreation = n.map((x) => (fin(x.ast36) && fin(x.fgm36)
    ? x.ast36 + (fin(x.pctUastFgm) ? x.pctUastFgm : 0) * x.fgm36 : null));
  const rawPaint = n.map((x) => x.paintPts36);

  // Efficiency Over Expected: residual against a binned, minutes-weighted usage->TS curve
  // fitted only on players past a possession floor, so garbage-time lines neither set the
  // baseline nor produce absurd residuals against a single global straight line.
  const usg = n.map((x) => x.usg), ts = n.map((x) => x.ts), poss = n.map((x) => x.poss || 0);
  const possFloor = opts.possFloor ?? 200;
  const tsCurve = referenceCurve(usg, ts, mins.map((m, i) => (poss[i] >= possFloor ? m : 0)), { bins: 8 });
  const rawEoe = n.map((x) => (fin(x.usg) && fin(x.ts) ? (x.ts - tsCurve(x.usg)) * 100 : null));

  // Impact Over Expected replaces the old PIE/USG ratio, which exploded as usage approached
  // zero (the audit found a one-game 162.03 and a five-game 178.83 leading the NBA board).
  // A residual against the usage->PIE curve is bounded and answers the same question.
  const pieCurve = referenceCurve(usg, n.map((x) => x.pie), mins.map((m, i) => (poss[i] >= possFloor ? m : 0)), { bins: 8 });
  const rawImpactOE = n.map((x) => (fin(x.usg) && fin(x.pie) ? (x.pie - pieCurve(x.usg)) * 100 : null));

  const selfCreatedPts36 = S(rawSelfCreated);
  const situationalPts36 = S(rawSituational);
  const possessionSwing36 = S(rawSwing);
  const defensiveSwing36 = S(rawDefSwing);
  const whistleDiff36 = S(rawWhistle);
  const disruptionPerFoul = S(rawDisruptFoul);
  const creationLoad36 = S(rawCreation);
  const paintPts36 = S(rawPaint);
  const efficiencyOverExpected = S(rawEoe);
  const impactOverExpected = S(rawImpactOE);

  // --- 0-100 indices, built from the stabilised inputs ----------------------
  const shotLocationValue = n.map((x) => {
    const good = (x.pctPtsPaint || 0) + (x.pctPts3pt || 0) + (x.pctPtsFt || 0);
    const mid = x.pctPts2ptMr || 0;
    return good + mid > 0 ? (100 * good) / (good + mid) : null;
  });

  const sPts = S(n.map((x) => x.pts36)), sReb = S(n.map((x) => x.reb36));
  const sAst = S(n.map((x) => x.ast36)), sTs = S(ts);
  const sStk = S(n.map((x) => (fin(x.stl36) && fin(x.blk36) ? x.stl36 + x.blk36 : null)));
  const sDreb = S(n.map((x) => x.drebPct)), sDefWs36 = S(n.map((x) => x.defWs36));
  const sOff = S(n.map((x) => x.offRtg)), sDef = S(n.map((x) => x.defRtg));

  const pPts = percentiles(sPts), pReb = percentiles(sReb), pAst = percentiles(sAst);
  const pStk = percentiles(sStk), pTs = percentiles(sTs), pDreb = percentiles(sDreb);
  const pDefWs = percentiles(sDefWs36), pOff = percentiles(sOff);
  const pDefInv = percentiles(sDef.map((v) => (fin(v) ? -v : null)));

  // Geometric mean punishes one-dimensionality in a way a weighted sum cannot.
  const versatilityIndex = n.map((_, i) => {
    const parts = [pPts[i], pReb[i], pAst[i], pStk[i], pTs[i]];
    if (parts.some((v) => !fin(v))) return null;
    return Math.pow(parts.reduce((a, v) => a * Math.max(v, 0.5), 1), 1 / parts.length);
  });

  // Two-Way deliberately excludes PIE. NBA.com's PIE already contains defensive rebounds,
  // steals and blocks, so including it on the offensive side while the defensive side adds
  // those same events counted part of defence twice.
  const twoWayIndex = n.map((_, i) => {
    const off = [pOff[i], pTs[i], percentileAt(pPts, i)].filter(fin);
    const def = [pDefInv[i], pDefWs[i], pStk[i], pDreb[i]].filter(fin);
    if (!off.length || !def.length) return null;
    return 0.5 * (off.reduce((a, v) => a + v, 0) / off.length)
         + 0.5 * (def.reduce((a, v) => a + v, 0) / def.length);
  });
  function percentileAt(arr, i) { return arr[i]; }

  const pSelfShare = percentiles(S(n.map((x) => x.pctUastFgm)));
  const pUsg = percentiles(S(usg));
  const selfSufficiencyIndex = n.map((_, i) => (fin(pSelfShare[i]) && fin(pUsg[i])
    ? Math.sqrt(Math.max(pSelfShare[i], 0.5) * Math.max(pUsg[i], 0.5)) : null));

  const defensiveDisruptionIndex = n.map((_, i) => {
    const parts = [pStk[i], pDreb[i], pDefInv[i], pDefWs[i]].filter(fin);
    return parts.length ? parts.reduce((a, v) => a + v, 0) / parts.length : null;
  });

  const custom = rows.map((_, i) => ({
    selfCreatedPts36: round(selfCreatedPts36[i], 2),
    situationalPts36: round(situationalPts36[i], 2),
    possessionSwing36: round(possessionSwing36[i], 2),
    defensiveSwing36: round(defensiveSwing36[i], 2),
    whistleDiff36: round(whistleDiff36[i], 2),
    disruptionPerFoul: round(disruptionPerFoul[i], 3),
    creationLoad36: round(creationLoad36[i], 2),
    paintPts36: round(paintPts36[i], 2),
    efficiencyOverExpected: round(efficiencyOverExpected[i], 2),
    impactOverExpected: round(impactOverExpected[i], 2),
    shotLocationValue: round(shotLocationValue[i], 1),
    versatilityIndex: round(versatilityIndex[i], 1),
    twoWayIndex: round(twoWayIndex[i], 1),
    selfSufficiencyIndex: round(selfSufficiencyIndex[i], 1),
    defensiveDisruptionIndex: round(defensiveDisruptionIndex[i], 1),
    // Unadjusted figures, kept so the reliability correction is inspectable rather than hidden.
    selfCreatedPts36Raw: round(rawSelfCreated[i], 2),
    situationalPts36Raw: round(rawSituational[i], 2),
    possessionSwing36Raw: round(rawSwing[i], 2),
    efficiencyOverExpectedRaw: round(rawEoe[i], 2),
    impactOverExpectedRaw: round(rawImpactOE[i], 2),
    paintPts36Raw: round(rawPaint[i], 2),
  }));

  return { custom, norm: n, K, possFloor, stabilised: true };
}

/**
 * Fixed grade anchors. The shrunk composite is a weighted mean of within-league percentiles;
 * measured across both 2025-26 leagues it spans roughly 31-80. These constants convert that
 * onto 0.0000-9.9999 and MUST NOT be re-derived per build — holding them still is what makes a
 * grade comparable between rebuilds and, later, between seasons.
 */
export const GRADE_ANCHORS = { lo: 30, hi: 80 };

/**
 * Shrinkage strength, as a multiple of the league's median minutes.
 * Chosen from the sensitivity sweep in scripts/k-sensitivity.mjs rather than by preference:
 * at 0.6 the G League top 25 still admitted a 13-game line, while 0.8 removes every sub-16-game
 * line from the top 25 at a rank correlation of 0.9995 against 0.6. Above 0.8 nothing further
 * is excluded and real separation only flattens. Re-run that script before changing this.
 */
export const K_FACTOR = 0.8;

export const COMPONENT_WEIGHTS = {
  scoring: 0.30, playmaking: 0.18, rebounding: 0.14,
  defense: 0.16, efficiency: 0.12, impact: 0.10,
};

/**
 * Ingredient list, generated from the basis actually in use so it can never describe a different
 * model than the one that ran. An earlier version hardcoded a per-36 list and kept showing it
 * after the headline grade moved to per-game.
 */
export function componentIngredients(basis = 'perGame') {
  const v = basis === 'per36' ? 'per 36' : 'per game';
  return {
    scoring: [`points ${v}`, 'TS%', 'usage', `FT attempts ${v}`, `3PT attempts ${v}`, 'self-created points/36'],
    playmaking: [`assists ${v}`, 'AST%', 'AST/TO', `turnover suppression (${v})`, 'creation load/36'],
    rebounding: [`rebounds ${v}`, `OREB ${v}`, `DREB ${v}`, 'OREB%', 'DREB%', 'REB%'],
    defense: [`steals ${v}`, `blocks ${v}`, 'DREB%', 'defensive rating', `DEF WS ${v}`,
      'defensive disruption index', 'defensive swing/36'],
    efficiency: ['TS%', 'eFG%', 'efficiency over expected', 'AST/TO', 'turnover-ratio suppression'],
    impact: ['PIE', 'net rating', 'impact over expected', `plus/minus ${v}`],
  };
}

/** Kept for callers that want the shipped configuration without passing a basis. */
export const COMPONENT_INGREDIENTS = componentIngredients('perGame');

/**
 * Six components, then a minutes-shrunk composite mapped onto 0.0000-9.9999.
 *
 * Three audit fixes are baked in here:
 *  - No ingredient appears twice within a component. Scoring previously inserted the points
 *    percentile twice and Playmaking inserted assists twice, which were undeclared weights.
 *  - Defense no longer contains Possession Swing, which counts offensive rebounds and the
 *    player's own turnovers; it uses the defence-only swing instead. DEF WS enters as a per-36
 *    rate, not a cumulative total.
 *  - Impact no longer contains minutes per game. Minutes already govern the shrinkage, and
 *    rewarding MPG as performance made two identical per-possession players score differently
 *    because one was trusted with a bigger role.
 *
 * The final mapping is an affine stretch of the shrunk composite, NOT another percentile rank.
 * Percentile-ranking at the end made every adjacent gap identical (0.0172 in the NBA), so the
 * grade communicated only order. An affine map keeps differences proportional to real
 * differences in the composite while still spanning the requested range.
 */
export function computeGrades(rows, custom, norm, opts = {}) {
  const basis = opts.basis === 'per36' ? 'per36' : 'perGame';
  const B = (pgSel, r36Sel) => (basis === 'per36' ? r36Sel : pgSel);

  const P = (sel) => percentiles(norm.map(sel));
  const inv = (sel) => percentiles(norm.map((x) => { const v = sel(x); return fin(v) ? -v : null; }));
  const cP = (key) => percentiles(custom.map((c) => c[key]));
  const avg = (...xs) => { const a = xs.filter(fin); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 50; };

  // Volume ingredients follow the chosen basis; rate ingredients (TS%, USG%, REB%…) are
  // already basis-independent and are shared by both grades.
  const pts = P(B((x) => x.ptsPG, (x) => x.pts36));
  const ast = P(B((x) => x.astPG, (x) => x.ast36));
  const reb = P(B((x) => x.rebPG, (x) => x.reb36));
  const oreb = P(B((x) => x.orebPG, (x) => x.oreb36));
  const dreb = P(B((x) => x.drebPG, (x) => x.dreb36));
  const stl = P(B((x) => x.stlPG, (x) => x.stl36));
  const blk = P(B((x) => x.blkPG, (x) => x.blk36));
  const fta = P(B((x) => x.ftaPG, (x) => x.fta36));
  const fg3a = P(B((x) => x.fg3aPG, (x) => x.fg3a36));
  const pm = P(B((x) => x.pmPG, (x) => x.pm36));
  const defWs = P(B((x) => x.defWsPG, (x) => x.defWs36));
  const tovInv = inv(B((x) => x.tovPG, (x) => x.tov36));

  const tsP = P((x) => x.ts), usgP = P((x) => x.usg), astPct = P((x) => x.astPct);
  const astTo = P((x) => x.astTo), tovRatioInv = inv((x) => x.tovPct);
  const orebPct = P((x) => x.orebPct), drebPct = P((x) => x.drebPct), rebPct = P((x) => x.rebPct);
  const defRtgInv = inv((x) => x.defRtg), efg = P((x) => x.efg);
  const pie = P((x) => x.pie), net = P((x) => x.netRtg);
  const selfCreate = cP('selfCreatedPts36'), eoe = cP('efficiencyOverExpected');
  const impactOE = cP('impactOverExpected'), disrupt = cP('defensiveDisruptionIndex');
  const defSwing = cP('defensiveSwing36'), creation = cP('creationLoad36');

  const components = rows.map((_, i) => ({
    scoring: avg(pts[i], tsP[i], usgP[i], fta[i], fg3a[i], selfCreate[i]),
    playmaking: avg(ast[i], astPct[i], astTo[i], tovInv[i], creation[i]),
    rebounding: avg(reb[i], oreb[i], dreb[i], orebPct[i], drebPct[i], rebPct[i]),
    defense: avg(stl[i], blk[i], drebPct[i], defRtgInv[i], defWs[i], disrupt[i], defSwing[i]),
    efficiency: avg(tsP[i], efg[i], eoe[i], astTo[i], tovRatioInv[i]),
    impact: avg(pie[i], net[i], impactOE[i], pm[i]),
  }));

  const raw = components.map((c) =>
    Object.entries(COMPONENT_WEIGHTS).reduce((a, [k, w]) => a + c[k] * w, 0));

  const mins = norm.map((x) => x.min || 0);
  const sorted = [...mins].sort((a, b) => a - b);
  const medianMin = sorted[Math.floor(sorted.length / 2)] || 1;
  const K = opts.K ?? Math.round(medianMin * (opts.kFactor ?? K_FACTOR));
  const totalMin = mins.reduce((a, v) => a + v, 0);
  const prior = totalMin > 0
    ? raw.reduce((a, v, i) => a + v * mins[i], 0) / totalMin
    : 50;
  const shrunk = raw.map((v, i) => (mins[i] * v + K * prior) / (mins[i] + K));
  const reliability = mins.map((m) => (100 * m) / (m + K));

  // FIXED anchors, not the observed extremes. Anchoring to min/max let one freak line rescale
  // everybody else's grade and made a grade meaningless across rebuilds or seasons. These two
  // constants are chosen once from the composite's realistic span (both leagues sit inside
  // roughly 30-81) and then held still, so 8.2 means the same thing every build.
  const { lo: ANCHOR_LO, hi: ANCHOR_HI } = GRADE_ANCHORS;
  const grade = shrunk.map((v) =>
    Number((clamp((v - ANCHOR_LO) / (ANCHOR_HI - ANCHOR_LO), 0, 1) * 9.9999).toFixed(4)));

  return {
    components: components.map((c) => Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, round(v, 1)]))),
    raw: raw.map((v) => round(v, 2)),
    shrunk: shrunk.map((v) => round(v, 2)),
    grade,
    reliability: reliability.map((v) => round(v, 1)),
    model: {
      basis, K, kFactor: opts.kFactor ?? K_FACTOR,
      prior: round(prior, 2), medianMinutes: round(medianMin, 1),
      anchors: GRADE_ANCHORS,
      observedGradeRange: [round(Math.min(...grade), 4), round(Math.max(...grade), 4)],
      observedCompositeRange: [round(Math.min(...shrunk), 2), round(Math.max(...shrunk), 2)],
      mapping: `grade = (shrunk composite - ${GRADE_ANCHORS.lo}) / (${GRADE_ANCHORS.hi - GRADE_ANCHORS.lo}) x 9.9999, clamped. The anchors are fixed constants, not the observed extremes, so no single outlier rescales the field and a grade stays comparable across rebuilds.`,
    },
  };
}

/**
 * Rank within an arbitrary cohort. Powers position-relative and age-cohort ranking, which
 * an audit showed matters here: centres out-grade guards by roughly 0.9 points because
 * rebounding, blocks and finishing efficiency reward the same players across several
 * components at once. The overall grade is left unadjusted and the bias is surfaced instead.
 */
export function cohortRanks(records, keyFn, gradeKey = 'grade') {
  const groups = new Map();
  records.forEach((r) => {
    const k = keyFn(r);
    if (k === null || k === undefined) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const out = new Map();
  for (const [k, list] of groups) {
    list.sort((a, b) => b[gradeKey] - a[gradeKey]);
    list.forEach((r, i) => {
      if (!out.has(r)) out.set(r, {});
      out.get(r)[k] = { rank: i + 1, of: list.length };
    });
  }
  return { groups, out };
}

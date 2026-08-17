// Project-defined composite metrics and the 0.0000-9.9999 performance grade.
//
// Every metric here is computed from official stats.nba.com fields that exist in BOTH
// the NBA and the G League, so the two panels are calculated the same way even though
// they are ranked as separate universes. Nothing is invented for a league that lacks it.
import { round } from './sources.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** Percentile (0-100) of each value within the supplied array, ties averaged. */
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

/** Least-squares fit of y on x over the rows that have both. */
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
 * Build the normalized per-36 / rate view every downstream formula reads.
 * `o` is the combined official line for one player.
 */
export function normalize(o) {
  const t = o.totals, adv = o.advanced, ex = o.exact;
  const min = t.MIN || 0, gp = t.GP || 0;
  const p36 = (v) => (min > 0 && fin(v) ? (Number(v) * 36) / min : null);
  const fromPerGame36 = (v) => (min > 0 && gp > 0 && fin(v) ? (Number(v) * gp * 36) / min : null);

  return {
    gp, min, mpg: gp > 0 ? min / gp : null,
    // per 36
    pts36: p36(t.PTS), reb36: p36(t.REB), oreb36: p36(t.OREB), dreb36: p36(t.DREB),
    ast36: p36(t.AST), stl36: p36(t.STL), blk36: p36(t.BLK), blka36: p36(t.BLKA),
    tov36: p36(t.TOV), pf36: p36(t.PF), pfd36: p36(t.PFD),
    fgm36: p36(t.FGM), fga36: p36(t.FGA), fg3m36: p36(t.FG3M), fg3a36: p36(t.FG3A),
    ftm36: p36(t.FTM), fta36: p36(t.FTA), fg2m36: p36(ex.FG2M), fg2a36: p36(ex.FG2A),
    pm36: p36(t.PLUS_MINUS),
    // misc (source is per game)
    paintPts36: fromPerGame36(o.misc.PTS_PAINT), fbPts36: fromPerGame36(o.misc.PTS_FB),
    offTovPts36: fromPerGame36(o.misc.PTS_OFF_TOV), secondPts36: fromPerGame36(o.misc.PTS_2ND_CHANCE),
    // rates
    ts: ex.TS_PCT, efg: ex.EFG_PCT, fgPct: ex.FG_PCT, fg3Pct: ex.FG3_PCT, ftPct: ex.FT_PCT,
    astTo: ex.AST_TO, usg: adv.USG_PCT, astPct: adv.AST_PCT, astRatio: adv.AST_RATIO,
    orebPct: adv.OREB_PCT, drebPct: adv.DREB_PCT, rebPct: adv.REB_PCT, tovPct: adv.TM_TOV_PCT,
    offRtg: adv.OFF_RATING, defRtg: adv.DEF_RATING, netRtg: adv.NET_RATING,
    pace: adv.PACE, pie: adv.PIE, poss: adv.POSS,
    // scoring profile
    pctUastFgm: o.scoring.PCT_UAST_FGM, pctUast2pm: o.scoring.PCT_UAST_2PM,
    pctUast3pm: o.scoring.PCT_UAST_3PM, pctPts3pt: o.scoring.PCT_PTS_3PT,
    pctPtsPaint: o.scoring.PCT_PTS_PAINT, pctPts2ptMr: o.scoring.PCT_PTS_2PT_MR,
    pctPtsFt: o.scoring.PCT_PTS_FT, pctPtsFb: o.scoring.PCT_PTS_FB,
    pctFga3pt: o.scoring.PCT_FGA_3PT,
    defWs: o.defense.DEF_WS,
    pctPts: o.usage.PCT_PTS, pctAst: o.usage.PCT_AST, pctReb: o.usage.PCT_REB,
  };
}

/**
 * Twelve project-defined metrics. Eight carry real basketball units and can be read
 * directly; four are 0-100 indices built from within-league percentiles.
 * These are NOT official NBA, G League or Basketball-Reference statistics.
 */
export function computeCustom(rows) {
  const n = rows.map(normalize);

  // --- unit-carrying metrics -------------------------------------------------
  const selfCreatedPts36 = n.map((x) => {
    if (!fin(x.fg2m36) || !fin(x.fg3m36)) return null;
    const u2 = fin(x.pctUast2pm) ? x.pctUast2pm : 0;
    const u3 = fin(x.pctUast3pm) ? x.pctUast3pm : 0;
    return u2 * x.fg2m36 * 2 + u3 * x.fg3m36 * 3 + (x.ftm36 || 0);
  });
  const chaosPts36 = n.map((x) => (fin(x.fbPts36) && fin(x.offTovPts36) && fin(x.secondPts36)
    ? x.fbPts36 + x.offTovPts36 + x.secondPts36 : null));
  const possessionSwing36 = n.map((x) => (fin(x.stl36) && fin(x.oreb36) && fin(x.tov36)
    ? x.stl36 + x.oreb36 + 0.6 * (x.blk36 || 0) - x.tov36 - 0.4 * (x.blka36 || 0) : null));
  const whistleDiff36 = n.map((x) => (fin(x.pfd36) && fin(x.pf36) ? x.pfd36 - x.pf36 : null));
  const disruptionPerFoul = n.map((x) => (fin(x.stl36) && fin(x.blk36) && x.pf36 > 0
    ? (x.stl36 + x.blk36) / x.pf36 : null));
  const creationLoad36 = n.map((x) => (fin(x.ast36) && fin(x.fgm36)
    ? x.ast36 + (fin(x.pctUastFgm) ? x.pctUastFgm : 0) * x.fgm36 : null));
  const paintPts36 = n.map((x) => x.paintPts36);

  // Efficiency Over Expected: TS% residual against the league's own usage->TS curve,
  // fitted on minutes so garbage-time lines cannot drag the baseline.
  const usg = n.map((x) => x.usg), ts = n.map((x) => x.ts), wts = n.map((x) => x.min);
  const fit = linfit(usg, ts, wts);
  const efficiencyOverExpected = n.map((x) => (fin(x.usg) && fin(x.ts)
    ? (x.ts - (fit.m * x.usg + fit.b)) * 100 : null));

  // --- 0-100 indices ---------------------------------------------------------
  const shotDietIndex = n.map((x) => {
    const good = (x.pctPtsPaint || 0) + (x.pctPts3pt || 0) + (x.pctPtsFt || 0);
    const mid = x.pctPts2ptMr || 0;
    return good + mid > 0 ? (100 * good) / (good + mid) : null;
  });

  const pPts = percentiles(n.map((x) => x.pts36));
  const pReb = percentiles(n.map((x) => x.reb36));
  const pAst = percentiles(n.map((x) => x.ast36));
  const pStk = percentiles(n.map((x) => (fin(x.stl36) && fin(x.blk36) ? x.stl36 + x.blk36 : null)));
  const pTs = percentiles(ts);
  // Geometric mean punishes one-dimensionality in a way a weighted sum cannot.
  const versatilityIndex = n.map((_, i) => {
    const parts = [pPts[i], pReb[i], pAst[i], pStk[i], pTs[i]];
    if (parts.some((v) => !fin(v))) return null;
    return Math.pow(parts.reduce((a, v) => a * Math.max(v, 0.5), 1), 1 / parts.length);
  });

  const pPie = percentiles(n.map((x) => x.pie));
  const pOff = percentiles(n.map((x) => x.offRtg));
  const pDefInv = percentiles(n.map((x) => (fin(x.defRtg) ? -x.defRtg : null)));
  const pDefWs = percentiles(n.map((x) => x.defWs));
  const pDreb = percentiles(n.map((x) => x.drebPct));
  const twoWayIndex = n.map((_, i) => {
    const off = [pPie[i], pOff[i], pTs[i]].filter(fin);
    const def = [pDefInv[i], pDefWs[i], pStk[i], pDreb[i]].filter(fin);
    if (!off.length || !def.length) return null;
    const o = off.reduce((a, v) => a + v, 0) / off.length;
    const d = def.reduce((a, v) => a + v, 0) / def.length;
    return 0.5 * o + 0.5 * d;
  });

  const pSelfShare = percentiles(n.map((x) => x.pctUastFgm));
  const pUsg = percentiles(usg);
  const selfSufficiencyIndex = n.map((_, i) => (fin(pSelfShare[i]) && fin(pUsg[i])
    ? Math.sqrt(Math.max(pSelfShare[i], 0.5) * Math.max(pUsg[i], 0.5)) : null));

  const defensiveDisruptionIndex = n.map((_, i) => {
    const parts = [pStk[i], pDreb[i], pDefInv[i], pDefWs[i]].filter(fin);
    return parts.length ? parts.reduce((a, v) => a + v, 0) / parts.length : null;
  });

  const roleAdjustedImpact = n.map((x) => (fin(x.pie) && x.usg > 0 ? (x.pie * 100) / x.usg : null));

  const out = rows.map((_, i) => ({
    selfCreatedPts36: round(selfCreatedPts36[i], 2),
    chaosPts36: round(chaosPts36[i], 2),
    possessionSwing36: round(possessionSwing36[i], 2),
    whistleDiff36: round(whistleDiff36[i], 2),
    disruptionPerFoul: round(disruptionPerFoul[i], 3),
    creationLoad36: round(creationLoad36[i], 2),
    paintPts36: round(paintPts36[i], 2),
    efficiencyOverExpected: round(efficiencyOverExpected[i], 2),
    shotDietIndex: round(shotDietIndex[i], 1),
    versatilityIndex: round(versatilityIndex[i], 1),
    twoWayIndex: round(twoWayIndex[i], 1),
    selfSufficiencyIndex: round(selfSufficiencyIndex[i], 1),
    defensiveDisruptionIndex: round(defensiveDisruptionIndex[i], 1),
    roleAdjustedImpact: round(roleAdjustedImpact[i], 2),
  }));
  return { custom: out, norm: n, tsUsgFit: { slope: round(fit.m, 5), intercept: round(fit.b, 5) } };
}

export const COMPONENT_WEIGHTS = {
  scoring: 0.30, playmaking: 0.18, rebounding: 0.14,
  defense: 0.16, efficiency: 0.12, impact: 0.10,
};

/**
 * Six components, then a minutes-shrunk composite mapped to 0.0000-9.9999.
 *
 * The shrinkage is the fix for the previous build's headline defect: its top two
 * G League players had played two and three games. Raw per-game production is still
 * exactly what is being graded, but a player's own signal is weighted against the
 * league mean in proportion to how much of it exists. `sampleConfidence` is the
 * weight the player's own line received, so the two numbers are consistent.
 */
export function computeGrades(rows, custom, norm, opts = {}) {
  const P = (sel) => percentiles(norm.map(sel));
  const inv = (sel) => percentiles(norm.map((x) => { const v = sel(x); return fin(v) ? -v : null; }));
  const cP = (key) => percentiles(custom.map((c) => c[key]));
  const avg = (...xs) => { const a = xs.filter(fin); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 50; };

  const pts = P((x) => x.pts36), tsP = P((x) => x.ts), usgP = P((x) => x.usg);
  const fta = P((x) => x.fta36), fg3a = P((x) => x.fg3a36);
  const ast = P((x) => x.ast36), astPct = P((x) => x.astPct), astTo = P((x) => x.astTo);
  const tovInv = inv((x) => x.tov36), tovPctInv = inv((x) => x.tovPct);
  const reb = P((x) => x.reb36), oreb = P((x) => x.oreb36), dreb = P((x) => x.dreb36);
  const orebPct = P((x) => x.orebPct), drebPct = P((x) => x.drebPct), rebPct = P((x) => x.rebPct);
  const stl = P((x) => x.stl36), blk = P((x) => x.blk36), defRtgInv = inv((x) => x.defRtg);
  const defWs = P((x) => x.defWs), efg = P((x) => x.efg);
  const pie = P((x) => x.pie), net = P((x) => x.netRtg), off = P((x) => x.offRtg);
  const mpg = P((x) => x.mpg), pm = P((x) => x.pm36);
  const selfCreate = cP('selfCreatedPts36'), eoe = cP('efficiencyOverExpected');
  const swing = cP('possessionSwing36'), disrupt = cP('defensiveDisruptionIndex');
  const creation = cP('creationLoad36');

  const components = rows.map((_, i) => ({
    scoring: avg(pts[i], pts[i], tsP[i], usgP[i], fta[i], fg3a[i], selfCreate[i]),
    playmaking: avg(ast[i], ast[i], astPct[i], astTo[i], tovInv[i], creation[i]),
    rebounding: avg(reb[i], oreb[i], dreb[i], orebPct[i], drebPct[i], rebPct[i]),
    defense: avg(stl[i], blk[i], drebPct[i], defRtgInv[i], defWs[i], disrupt[i], swing[i]),
    efficiency: avg(tsP[i], efg[i], eoe[i], astTo[i], tovPctInv[i]),
    impact: avg(pie[i], net[i], off[i], pm[i], mpg[i]),
  }));

  const raw = components.map((c) =>
    Object.entries(COMPONENT_WEIGHTS).reduce((a, [k, w]) => a + c[k] * w, 0));

  // Shrink toward the league mean in proportion to minutes played.
  const mins = norm.map((x) => x.min || 0);
  const sorted = [...mins].sort((a, b) => a - b);
  const medianMin = sorted[Math.floor(sorted.length / 2)] || 1;
  const K = opts.K ?? Math.round(medianMin * 0.6);
  const totalMin = mins.reduce((a, v) => a + v, 0);
  const prior = totalMin > 0
    ? raw.reduce((a, v, i) => a + v * mins[i], 0) / totalMin   // minutes-weighted league mean
    : 50;
  const shrunk = raw.map((v, i) => (mins[i] * v + K * prior) / (mins[i] + K));
  const confidence = mins.map((m) => (100 * m) / (m + K));

  const pShrunk = percentiles(shrunk);
  const grade = pShrunk.map((p) => (fin(p) ? Number(((p / 100) * 9.9999).toFixed(4)) : 0));

  return {
    components: components.map((c) => Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, round(v, 1)]))),
    raw: raw.map((v) => round(v, 2)),
    shrunk: shrunk.map((v) => round(v, 2)),
    grade,
    confidence: confidence.map((v) => round(v, 1)),
    model: { K, prior: round(prior, 2), medianMinutes: medianMin },
  };
}

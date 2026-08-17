// TULIP — Targeted Utilization, Lineup & Impact Projection.
//
// TULIP does not rank bench players. It evaluates a ROLE CHANGE: if this player's job changes in
// a specific way and the minutes come from specific team-mates, what is the expected change in
// team performance, and how much evidence do we actually have for that?
//
// WHAT THIS IMPLEMENTATION CAN AND CANNOT DO, stated up front because the distinction is the
// whole point of the design:
//
//   Available here : one season (2025-26) of season-aggregate and situational-split data,
//                    including starter/bench splits, which are genuine observed role changes for
//                    148 NBA and 119 G League players.
//   NOT available  : possession or lineup data, game logs, historical seasons, injury and
//                    transaction events.
//
// Consequences, enforced in code rather than glossed over:
//   * Lineup Interaction Adjustment is ALWAYS null. Without lineup data there is no defensible
//     way to estimate it, so it is reported as unavailable and contributes nothing.
//   * Evidence Tier A (shock-induced expansion) and Tier C (ordinary high-minute games) cannot
//     be produced at all: both need game-level data. Only Tier B (observed starter/bench role
//     change) and Tier D (pure extrapolation) are reachable.
//   * TULIP Forecast (age/aging priors, multi-season trajectory) is NOT implemented, because a
//     single season cannot support it. Only TULIP Evidence exists.
//   * Every projection is comparison-based, not causal. Comparables who played a role are a
//     selected group; that selection is not corrected for.
import { round } from './sources.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Role bands the frontier is evaluated over. */
export const ROLE_BANDS = [
  { label: '12 MPG', mpg: 12 }, { label: '16 MPG', mpg: 16 }, { label: '20 MPG', mpg: 20 },
  { label: '24 MPG', mpg: 24 }, { label: '28 MPG', mpg: 28 }, { label: '32 MPG', mpg: 32 },
  { label: '36 MPG', mpg: 36 },
];

export const TULIP_CONFIG = {
  bandHalfWidth: 3.0,        // a comparable counts if within +/- this many MPG of the target
  minSimilarity: 62,         // below this a player is not a comparable at all
  minComparables: 8,         // fewer than this and TULIP abstains
  minSupport: 40,            // support below this and TULIP abstains
  minMinutes: 250,           // a comparable needs a real sample of its own
  // Comparables must match on ABILITY as well as style. Measured across the league, mean
  // rateGrade rises from 4.07 at 12 mpg to 6.49 at 36 mpg, so matching on style alone lets
  // quality leak in and an upward frontier merely recovers "better players play more minutes".
  qualityBand: 1.2,          // max |rateGrade - candidate rateGrade| for a comparable
  // A player already in a big role is not a role-expansion question.
  maxCurrentMpgForExpansion: 30,
  minExpansion: 3,           // the target must be at least this many minutes above current
  // A displaced team-mate needs a real sample, or one 4-game outlier defines the delta.
  displacedMinMinutes: 200,
  displacedMinGames: 15,
  netRtgClamp: 25,           // on-court differential is clamped before it enters a delta
  // On-court differential is extremely noisy and confounded by team-mates. Without lineup data
  // it cannot be treated as a causal per-player value, so it is shrunk hard toward the team mean
  // before entering a Rotation Delta. Raw differences of 20 points/100 between team-mates are
  // common and are mostly noise; unshrunk they produced absurd deltas of +20.
  netRtgShrinkMinutes: 900,
  // AUDIT FIX. Measured covariate balance between candidates and their comparables showed
  // starter share standardized-mean-difference -0.735: candidates started 31% of their games,
  // comparables 56%. Matching on ability alone left starter-vs-reserve CONTEXT wide open, which
  // is one of the confounds the design explicitly set out to avoid. Comparables must now be
  // reachable in role terms too.
  // Swept 45/30/20/15/10. Band 20 minimises BOTH the pooled starter SMD (-0.008) and the worst
  // per-band SMD (0.798); tighter bands lose common support without improving balance.
  starterShareBand: 20,     // max percentage-point gap in share of games started
};

/**
 * RESIDUAL, UNFIXABLE CONFOUND — stated rather than buried.
 *
 * Pooled across all candidates the starter-share imbalance is now negligible (SMD -0.008), but
 * WITHIN each target band it remains large (worst band 0.798). That is Simpson's paradox: the
 * pooled figure looks clean only because candidates and comparables are averaged across bands.
 *
 * It cannot be tuned away. A 12-mpg reserve projected to 28 mpg is compared against players who
 * actually play 28 mpg, and almost all of them are starters — a pool of "bench players who play
 * starter minutes" barely exists. The common-support region genuinely does not contain the
 * counterfactual, so every projection at a large target carries a starter-context bias whose
 * direction is known (comparables started more) but whose size is not identified by this data.
 *
 * Fixing it requires the historical/game-level design: role expansions caused by external shocks,
 * where a bench player really did absorb starter minutes for observable reasons.
 */
export const KNOWN_RESIDUAL_BIAS = {
  starterContext: {
    pooledSmd: -0.008,
    worstBandSmd: 0.798,
    direction: 'comparables started a larger share of their games than the candidates do',
    identified: false,
    remedy: 'game-level opportunity-shock data (Tier A), not parameter tuning',
  },
};

/** Share of a player's games that were starts, 0-100. */
export function starterShare(p) {
  const s = p.stats?.sit_starter_gp;
  if (!fin(s) || !fin(p.gp) || !p.gp) return null;
  return (100 * s) / p.gp;
}

/** Similarity between two skill profiles, on the same documented basis the app uses elsewhere. */
function profileSimilarity(a, b, weights) {
  let acc = 0, w = 0;
  for (const [axis, wt] of Object.entries(weights)) {
    const x = a?.[axis], y = b?.[axis];
    if (!fin(x) || !fin(y)) continue;
    acc += wt * (x - y) ** 2; w += wt;
  }
  if (!w) return null;
  return clamp(100 * (1 - Math.sqrt(acc / w) / 100), 0, 100);
}

function weightedStats(values, weights) {
  let sw = 0, sv = 0;
  for (let i = 0; i < values.length; i++) { if (!fin(values[i])) continue; sw += weights[i]; sv += values[i] * weights[i]; }
  if (!sw) return null;
  const mean = sv / sw;
  let sd2 = 0;
  for (let i = 0; i < values.length; i++) { if (!fin(values[i])) continue; sd2 += weights[i] * (values[i] - mean) ** 2; }
  return { mean, sd: Math.sqrt(sd2 / sw), n: values.filter(fin).length };
}

/**
 * TULIP Support, 0-100. Three things make evidence strong: enough comparables, comparables that
 * genuinely resemble the candidate, and a target role that is not far outside what the candidate
 * has actually done. Support is NEVER folded into the projection — an uncertain projection keeps
 * its point estimate and widens its interval instead of being quietly dragged toward zero.
 */
function supportScore({ effectiveN, meanSimilarity, mpgExtrapolation, usageExtrapolation }) {
  const nTerm = clamp(Math.log10(1 + effectiveN) / Math.log10(1 + 40), 0, 1);
  const simTerm = clamp((meanSimilarity - 50) / 40, 0, 1);
  // Extrapolating 4 MPG beyond a player's observed role is mild; 16 is severe.
  const extraTerm = clamp(1 - Math.abs(mpgExtrapolation) / 16, 0, 1);
  const usgTerm = clamp(1 - Math.abs(usageExtrapolation) / 10, 0, 1);
  return round(100 * (0.35 * nTerm + 0.3 * simTerm + 0.25 * extraTerm + 0.1 * usgTerm), 0);
}

/**
 * Evidence tier for a candidate at a target role.
 *   A - shock-induced expansion .... impossible here (needs game logs + transactions)
 *   B - observed role change ....... the candidate himself has >=10 games starting AND off the
 *                                    bench, and the target sits inside that observed span
 *   C - ordinary high-minute games . impossible here (needs game logs)
 *   D - pure extrapolation ......... everything else
 */
export function evidenceTier(player, targetMpg) {
  const sg = player.stats?.sit_starter_gp, bg = player.stats?.sit_bench_gp;
  const sm = player.stats?.sit_starter_mpg, bm = player.stats?.sit_bench_mpg;
  if (fin(sg) && fin(bg) && sg >= 10 && bg >= 10 && fin(sm) && fin(bm)) {
    const lo = Math.min(sm, bm), hi = Math.max(sm, bm);
    if (targetMpg >= lo - 2 && targetMpg <= hi + 2) {
      return { tier: 'B', label: 'Observed role change',
        detail: `Played ${bg} games off the bench at ${bm.toFixed(1)} mpg and ${sg} starting at ${sm.toFixed(1)} mpg; the target sits inside that observed span.` };
    }
  }
  return { tier: 'D', label: 'Statistical extrapolation',
    detail: 'No observed role change of this size for this player. Projection rests entirely on comparable players.' };
}

/**
 * Project a candidate into a target role from comparables who actually occupied it.
 * Returns null when the evidence does not support an estimate — abstention is a feature.
 */
export function projectRole(candidate, pool, targetMpg, { weights, config = TULIP_CONFIG }) {
  const cands = [];
  for (const q of pool) {
    if (q.playerId === candidate.playerId) continue;
    if (!fin(q.mpg) || Math.abs(q.mpg - targetMpg) > config.bandHalfWidth) continue;
    if ((q.minutes || 0) < config.minMinutes) continue;
    // Ability match: rateGrade is per-36 and therefore role-neutral, which is exactly what is
    // needed to avoid comparing a bench player against better players who happen to start.
    if (fin(candidate.rateGrade) && fin(q.rateGrade)
        && Math.abs(q.rateGrade - candidate.rateGrade) > config.qualityBand) continue;
    // Role-context match, added after the balance audit above.
    const cs = starterShare(candidate), qs = starterShare(q);
    if (fin(cs) && fin(qs) && Math.abs(cs - qs) > config.starterShareBand) continue;
    const sim = profileSimilarity(candidate.skillProfile, q.skillProfile, weights);
    if (sim === null || sim < config.minSimilarity) continue;
    cands.push({ q, sim });
  }
  if (cands.length < config.minComparables) {
    return { abstain: true, reason: `Only ${cands.length} comparable players have played at ${targetMpg} mpg; ${config.minComparables} are required.`, comparables: cands.length };
  }
  cands.sort((a, b) => b.sim - a.sim);
  const top = cands.slice(0, 40);
  // Similarity above the floor, squared, so close comparables dominate.
  const w = top.map((c) => ((c.sim - config.minSimilarity) / (100 - config.minSimilarity)) ** 2 + 0.02);
  const impact = weightedStats(top.map((c) => c.q.netRtg), w);
  const pie = weightedStats(top.map((c) => (fin(c.q.pie) ? c.q.pie * 100 : null)), w);
  const usage = weightedStats(top.map((c) => c.q.usg), w);
  if (!impact) return { abstain: true, reason: 'Comparables lack an impact measure.', comparables: top.length };

  const effectiveN = w.reduce((a, v) => a + v, 0) ** 2 / w.reduce((a, v) => a + v * v, 0);
  const meanSimilarity = top.reduce((a, c, i) => a + c.sim * w[i], 0) / w.reduce((a, v) => a + v, 0);
  const support = supportScore({
    effectiveN,
    meanSimilarity,
    mpgExtrapolation: targetMpg - (candidate.mpg || 0),
    usageExtrapolation: fin(usage?.mean) && fin(candidate.usg) ? usage.mean - candidate.usg : 0,
  });

  // 80% interval from the dispersion of comparables, widened when support is thin.
  const widen = 1 + clamp((60 - support) / 60, 0, 1);
  const half = 1.2816 * impact.sd * widen / Math.sqrt(Math.max(1, effectiveN / 4));
  return {
    abstain: false,
    targetMpg,
    projectedImpact: round(impact.mean, 2),
    interval: [round(impact.mean - half, 2), round(impact.mean + half, 2)],
    projectedPie: fin(pie?.mean) ? round(pie.mean, 1) : null,
    projectedUsage: fin(usage?.mean) ? round(usage.mean, 1) : null,
    support,
    comparables: top.length,
    effectiveN: round(effectiveN, 1),
    meanSimilarity: round(meanSimilarity, 1),
    topComparables: top.slice(0, 5).map((c) => ({ name: c.q.name, team: c.q.team,
      similarity: round(c.sim, 1), mpg: c.q.mpg, netRtg: c.q.netRtg })),
  };
}

/** The frontier: projected impact across role sizes, each with its own support. */
export function frontier(candidate, pool, opts) {
  return ROLE_BANDS.map((b) => {
    const r = projectRole(candidate, pool, b.mpg, opts);
    return { mpg: b.mpg, label: b.label, ...r };
  });
}

/**
 * Role-Scale Response: does projected impact RISE, stay FLAT or DECLINE as the target role grows?
 * The shape is measured from the supported part of the frontier, never assumed. Deliberately not
 * called an elasticity: this is an observational comparison across players, not a causal estimate
 * of what happens to one player when his minutes change.
 */
export function roleScaleResponse(frontierPoints) {
  const pts = frontierPoints.filter((f) => !f.abstain && fin(f.projectedImpact) && fin(f.support));
  if (pts.length < 3) {
    return { response: 'INSUFFICIENT EVIDENCE', slopePer10Min: null, supportedBands: pts.length,
      note: 'Fewer than three supported role bands; the shape of the curve cannot be read.' };
  }
  // Support-weighted least squares of impact on target minutes.
  const w = pts.map((p) => p.support / 100);
  const sw = w.reduce((a, v) => a + v, 0);
  const mx = pts.reduce((a, p, i) => a + p.mpg * w[i], 0) / sw;
  const my = pts.reduce((a, p, i) => a + p.projectedImpact * w[i], 0) / sw;
  const sxx = pts.reduce((a, p, i) => a + w[i] * (p.mpg - mx) ** 2, 0);
  const sxy = pts.reduce((a, p, i) => a + w[i] * (p.mpg - mx) * (p.projectedImpact - my), 0);
  const slope = sxx ? sxy / sxx : 0;
  const per10 = slope * 10;
  // Residual spread sets the band inside which a slope is indistinguishable from flat.
  const resid = pts.map((p, i) => p.projectedImpact - (my + slope * (p.mpg - mx)));
  const rss = resid.reduce((a, v, i) => a + w[i] * v * v, 0) / sw;
  const noise = Math.sqrt(rss);
  const flatBand = Math.max(0.35, noise / 2);
  return {
    response: per10 > flatBand ? 'RISES' : per10 < -flatBand ? 'DECLINES' : 'FLAT',
    slopePer10Min: round(per10, 2),
    flatBand: round(flatBand, 2),
    supportedBands: pts.length,
    bandRange: [pts[0].mpg, pts[pts.length - 1].mpg],
    note: 'Measured, not assumed. Comparables at larger roles are a selected group, so a rising curve is evidence about who occupies big roles, not proof that this player would improve in one.',
  };
}

/**
 * Rotation Delta: the point of the whole exercise. Moving minutes to this player means taking
 * them from somebody, so the question is never "is he good" but "is he better than whoever
 * currently has these minutes, in this role".
 *
 * Lineup Interaction Adjustment is reported as null — with no lineup data there is no honest way
 * to estimate it — and therefore contributes nothing to the delta.
 */
export function rotationDelta(candidate, roster, targetMpg, projection, leagueMedianRotationImpact = null) {
  if (!projection || projection.abstain) return null;
  const extra = targetMpg - (candidate.mpg || 0);
  if (extra <= 0) {
    return { abstain: true, reason: 'Target role is not larger than the current role, so no minutes are being reallocated.' };
  }
  // Displaced: team-mates of the same positional family, weakest on-court differential first.
  const CLAMP = TULIP_CONFIG.netRtgClamp;
  const KS = TULIP_CONFIG.netRtgShrinkMinutes;
  // Team mean on-court differential is the prior each player's own figure is pulled toward.
  const teamMean = (() => {
    const w = roster.filter((r) => fin(r.netRtg) && fin(r.minutes));
    const tot = w.reduce((a, r) => a + r.minutes, 0);
    return tot ? w.reduce((a, r) => a + clamp(r.netRtg, -CLAMP, CLAMP) * r.minutes, 0) / tot : 0;
  })();
  const shrunkNet = (r) => {
    const m = r.minutes || 0;
    return (m * clamp(r.netRtg, -CLAMP, CLAMP) + KS * teamMean) / (m + KS);
  };
  const mates = roster.filter((r) => r.playerId !== candidate.playerId && fin(r.netRtg) && fin(r.mpg) && r.mpg > 0)
    // A team-mate with a handful of games cannot define what these minutes are currently worth.
    .filter((r) => (r.minutes || 0) >= TULIP_CONFIG.displacedMinMinutes
                && (r.gp || 0) >= TULIP_CONFIG.displacedMinGames)
    .map((r) => ({ ...r, netRtg: shrunkNet(r) }))
    .filter((r) => !candidate.positionFamily || !r.positionFamily
      || r.positionFamily.split('-').some((f) => candidate.positionFamily.split('-').includes(f)))
    .sort((a, b) => a.netRtg - b.netRtg);
  if (!mates.length) return { abstain: true, reason: 'No comparable team-mates to take minutes from.' };

  let remaining = extra;
  const displaced = [];
  for (const m of mates) {
    if (remaining <= 0.01) break;
    // Nobody gives up more than a third of their own minutes in one change.
    const take = Math.min(remaining, m.mpg / 3);
    if (take <= 0.01) continue;
    displaced.push({ name: m.name, playerId: m.playerId, minutesTaken: round(take, 1), netRtg: m.netRtg });
    remaining -= take;
  }
  if (!displaced.length) return { abstain: true, reason: 'No team-mate can give up these minutes under the one-third cap.' };

  const takenTotal = displaced.reduce((a, x) => a + x.minutesTaken, 0);
  const displacedImpact = displaced.reduce((a, x) => a + x.netRtg * x.minutesTaken, 0) / takenTotal;
  const delta = projection.projectedImpact - displacedImpact;
  // Taking minutes from the WEAKEST available team-mate is favourable almost by construction,
  // so a neutral comparison is reported alongside it: the same projection measured against a
  // median rotation team-mate. The spec's own point is that the same player at the same target
  // is a different decision depending on whose minutes move, so both are shown.
  const rotationPool = mates.filter((m) => m.mpg >= 10).map((m) => m.netRtg).sort((a, b) => a - b);
  const medianMate = rotationPool.length
    ? rotationPool[Math.floor(rotationPool.length / 2)] : displacedImpact;
  const neutralDelta = projection.projectedImpact - medianMate;
  // AUDIT FIX. Measured against the team's own median team-mate, the neutral delta correlated
  // -0.913 with that team-mate's impact and only +0.177 with the candidate's own projection --
  // i.e. it was mostly ranking weak rosters, not players. The league-referenced delta uses a
  // LEAGUE median rotation impact instead, which isolates the player. Both are reported: the
  // team-referenced figure answers "should THIS team do this", the league-referenced one answers
  // "is this player being underused relative to a typical rotation slot anywhere".
  const leagueDelta = fin(leagueMedianRotationImpact)
    ? projection.projectedImpact - leagueMedianRotationImpact : null;
  return {
    abstain: false,
    minutesReallocated: round(takenTotal, 1),
    candidateProjected: projection.projectedImpact,
    displacedImpact: round(displacedImpact, 2),
    lineupInteractionAdjustment: null,
    lineupNote: 'Unavailable: estimating lineup interaction requires possession or lineup data, which this database does not contain. It contributes nothing to the delta rather than being guessed.',
    magnitudeCaveat: 'Both sides of this delta come from on-court differential, which is a team result while a player is on the floor. It is shrunk toward the team mean by minutes, but without lineup data the MAGNITUDE remains unreliable. Treat the sign and the ordering as the usable signal, not the number.',
    rotationDelta: round(delta, 2),
    displacementBasis: 'weakest available team-mate (best case for expansion)',
    neutralRotationDelta: round(neutralDelta, 2),
    medianRotationMateImpact: round(medianMate, 2),
    neutralNote: 'neutralRotationDelta measures the same projection against a MEDIAN rotation team-mate rather than the weakest one. Displacing the weakest player is favourable by construction, so the neutral figure is the fairer read of whether the player himself is being underused.',
    displaced,
    leagueReferencedDelta: fin(leagueDelta) ? round(leagueDelta, 2) : null,
    leagueMedianRotationImpact: fin(leagueMedianRotationImpact) ? round(leagueMedianRotationImpact, 2) : null,
    leagueNote: 'leagueReferencedDelta is a LEAGUE-REFERENCED ROLE-EXPANSION VALUE: the projection compared against a median league rotation slot rather than against this roster. It removes the weak-roster baseline problem — the team-referenced delta correlates -0.91 with the displaced team-mate and only +0.18 with the candidate projection — but it does NOT isolate the player. The candidate projection is itself observational: it comes from comparables who already occupy that role, who started a larger share of their games than the candidate does, and it is measured on a noisy team-dependent outcome. Read it as role-expansion value under a league reference, not as context-free player quality.',
    // Decomposed rather than hidden inside one number.
    decomposition: {
      candidateProjection: projection.projectedImpact,
      displacedProjection: round(displacedImpact, 2),
      medianTeamMate: round(medianMate, 2),
      lineupAdjustment: null,
      intervalOnCandidate: projection.interval,
    },
    // The verdict follows the NEUTRAL (team-referenced) delta, not the best-case one.
    verdict: neutralDelta > 1.5 ? 'EXPAND ROLE' : neutralDelta > 0.3 ? 'MILD GAIN'
           : neutralDelta > -0.3 ? 'NEUTRAL' : 'DO NOT EXPAND',
  };
}

/** Which axes argue for the expansion, and which argue against it. */
export function explain(candidate, projection) {
  const sp = candidate.skillProfile || {};
  const strengths = [], risks = [];
  const push = (arr, axis, text) => { if (fin(sp[axis])) arr.push({ axis, percentile: sp[axis], text }); };
  if (sp.ballSecurity >= 60) push(strengths, 'ballSecurity', 'Ball security holds up; turnover economy is above the league middle.');
  if (sp.shootingEff >= 60) push(strengths, 'shootingEff', 'Shooting efficiency is portable across roles.');
  if (sp.threeVolume >= 60 && sp.selfCreation <= 55) push(strengths, 'threeVolume', 'Off-ball shooting volume does not depend on his own creation.');
  if (sp.selfCreation >= 60) push(strengths, 'selfCreation', 'Creates his own offence, so added usage need not come from team-mates.');
  if (sp.steals >= 60 || sp.rimProtection >= 60) push(strengths, sp.steals >= sp.rimProtection ? 'steals' : 'rimProtection', 'Defensive event creation supports a larger defensive assignment.');

  if (sp.ballSecurity <= 35) push(risks, 'ballSecurity', 'Turnover economy is weak; more usage is likely to cost possessions.');
  if (sp.selfCreation <= 30 && sp.usage >= 55) push(risks, 'selfCreation', 'Current scoring leans on being set up, which a larger role may not preserve.');
  if (sp.shootingEff <= 35) push(risks, 'shootingEff', 'Efficiency is already below average before adding responsibility.');
  if (fin(candidate.pf) && fin(candidate.mpg) && candidate.mpg > 0 && (candidate.pf * 36) / candidate.mpg >= 4.5) {
    risks.push({ axis: 'fouls', percentile: null, text: 'Foul rate per 36 is high, which historically limits high-minute roles.' });
  }
  if (projection && !projection.abstain && projection.support < 45) {
    risks.push({ axis: 'support', percentile: null, text: `Thin historical support (${projection.support}/100) — the projection rests on few close comparables.` });
  }
  if ((candidate.minutes || 0) < 500) {
    risks.push({ axis: 'sample', percentile: null, text: `Only ${Math.round(candidate.minutes || 0)} minutes of evidence for the player himself.` });
  }
  return { strengths: strengths.slice(0, 4), risks: risks.slice(0, 5) };
}

/**
 * Full TULIP card for one candidate at one target role. Returns an abstention rather than a
 * number whenever the evidence does not support one.
 */
export function tulipCard(candidate, pool, roster, targetMpg, opts) {
  const cfg = opts.config || TULIP_CONFIG;
  const tier0 = evidenceTier(candidate, targetMpg);
  // TULIP answers "should this role get bigger", so a player already in a large role, or a
  // target that is barely a change, is not a TULIP question at all.
  if ((candidate.mpg || 0) > cfg.maxCurrentMpgForExpansion) {
    return { candidate: candidate.playerId, targetMpg, abstain: true,
      reason: `Already plays ${(candidate.mpg || 0).toFixed(1)} mpg. TULIP evaluates role EXPANSION; there is no meaningful expansion to test above ${cfg.maxCurrentMpgForExpansion} mpg.`,
      evidenceTier: tier0, support: 0 };
  }
  if (targetMpg - (candidate.mpg || 0) < cfg.minExpansion) {
    return { candidate: candidate.playerId, targetMpg, abstain: true,
      reason: `Target is only ${(targetMpg - (candidate.mpg || 0)).toFixed(1)} minutes above the current role; not a role change worth projecting.`,
      evidenceTier: tier0, support: 0 };
  }
  const projection = projectRole(candidate, pool, targetMpg, opts);
  const tier = tier0;
  if (projection.abstain) {
    return { candidate: candidate.playerId, targetMpg, abstain: true,
      reason: projection.reason, evidenceTier: tier, support: 0 };
  }
  if (projection.support < (opts.config?.minSupport ?? TULIP_CONFIG.minSupport)) {
    return { candidate: candidate.playerId, targetMpg, abstain: true,
      reason: `Support ${projection.support}/100 is below the ${opts.config?.minSupport ?? TULIP_CONFIG.minSupport} threshold. NO RELIABLE TULIP ESTIMATE.`,
      evidenceTier: tier, support: projection.support };
  }
  const delta = rotationDelta(candidate, roster, targetMpg, projection);
  return {
    candidate: candidate.playerId, targetMpg, abstain: false,
    projection, evidenceTier: tier, rotation: delta, ...explain(candidate, projection),
  };
}

/**
 * Rotation optimiser: which realistic reallocations most improve this roster?
 * Greedy and constrained — it will not hand a bench player 40 minutes.
 */
export function optimiseRotation(roster, pool, opts, { maxChange = 6, candidates = 6 } = {}) {
  const moves = [];
  for (const c of roster) {
    if (!fin(c.mpg) || c.mpg < 4 || (c.minutes || 0) < 200) continue;
    const target = Math.min(34, c.mpg + maxChange);
    if (target - c.mpg < 2) continue;
    const proj = projectRole(c, pool, target, opts);
    if (proj.abstain || proj.support < TULIP_CONFIG.minSupport) continue;
    const rot = rotationDelta(c, roster, target, proj);
    if (!rot || rot.abstain) continue;
    moves.push({
      playerId: c.playerId, name: c.name, from: c.mpg, to: round(target, 1),
      rotationDelta: rot.rotationDelta, support: proj.support,
      displaced: rot.displaced.map((d) => `${d.name} -${d.minutesTaken}`),
      verdict: rot.verdict,
    });
  }
  moves.sort((a, b) => b.rotationDelta - a.rotationDelta);
  return moves.slice(0, candidates);
}

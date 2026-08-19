// TULIP v2: within-player minutes response, estimated from ten seasons of game logs.
//
// WHY THE FIRST VERSION COULD NOT WORK. v1 asked "what happens at 28 MPG?" by finding OTHER
// players who played 28 MPG and resembled the candidate. Those comparables are different people on
// different teams, so the projection carried a median interval width of 7.42 while the differences
// between workload bands were only 1-3. The noise was larger than the signal, and no threshold
// could fix that: 66% of players had some band beating their current one on point estimate, but
// only 5% survived on lower bound.
//
// WHAT THIS DOES INSTEAD. It measures the SAME player at different workloads. A player who
// averaged 18 MPG one season and 30 the next is a direct observation of what happened when his
// minutes grew — his identity, skill and era are differenced out. Pooling those within-player
// changes across ten seasons gives thousands of observations instead of a handful of lookalikes.
//
// This is still observational. Minutes are assigned by coaches who see things the box score does
// not, so a player whose minutes rose may have been playing well for reasons this cannot measure.
// The estimate is a population-level response, not a causal effect for any individual.

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const round = (v, d = 3) => (fin(v) ? Number(Number(v).toFixed(d)) : null);
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/**
 * Hollinger Game Score: a per-game box-score summary of individual production.
 * Chosen over plus/minus because plus/minus is a TEAM result while a player is on the floor, and
 * team quality would contaminate a within-player comparison across seasons when the roster changes.
 */
export function gameScore(r) {
  if (!fin(r.pts)) return null;
  return r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm)
    + 0.7 * r.oreb + 0.3 * r.dreb + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
}

export const RESPONSE_CONFIG = {
  minGames: 25,          // a player-season needs a real sample
  minMpg: 8,             // below this the role is not a rotation role
  minMpgChange: 3,       // consecutive seasons must differ enough for the change to be informative
  bands: [[8, 16], [16, 22], [22, 28], [28, 34], [34, 48]],
};

/** Aggregate raw game rows into player-season observations. */
export function playerSeasons(rows) {
  const byPS = new Map();
  for (const r of rows) {
    if (!fin(r.min) || r.min <= 0) continue;
    const k = `${r.playerId}|${r.season}`;
    let a = byPS.get(k);
    if (!a) { a = { playerId: r.playerId, name: r.playerName, season: r.season, g: 0, min: 0, gs: 0 }; byPS.set(k, a); }
    const gs = gameScore(r);
    if (gs === null) continue;
    a.g++; a.min += r.min; a.gs += gs;
  }
  const out = [];
  for (const a of byPS.values()) {
    if (a.g < RESPONSE_CONFIG.minGames) continue;
    const mpg = a.min / a.g;
    if (mpg < RESPONSE_CONFIG.minMpg) continue;
    // Per-36 production: removes role size so the remaining variation is about effectiveness.
    out.push({ ...a, mpg, gsPer36: (a.gs / a.min) * 36 });
  }
  return out;
}

/**
 * Within-player season-over-season changes. Each observation is one player comparing himself to
 * himself, so player quality cancels.
 */
export function withinPlayerChanges(seasons) {
  const byPlayer = new Map();
  for (const s of seasons) {
    if (!byPlayer.has(s.playerId)) byPlayer.set(s.playerId, []);
    byPlayer.get(s.playerId).push(s);
  }
  const changes = [];
  for (const list of byPlayer.values()) {
    list.sort((a, b) => a.season.localeCompare(b.season));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const dMpg = cur.mpg - prev.mpg;
      if (Math.abs(dMpg) < RESPONSE_CONFIG.minMpgChange) continue;
      changes.push({
        playerId: cur.playerId, name: cur.name, from: prev.season, to: cur.season,
        mpgFrom: prev.mpg, mpgTo: cur.mpg, dMpg,
        dGsPer36: cur.gsPer36 - prev.gsPer36,
        baseMpg: prev.mpg, baseGsPer36: prev.gsPer36,
      });
    }
  }
  return changes;
}

/**
 * Estimate, per starting-workload band, how per-36 production moves when minutes change.
 * Fitted separately by band because the response is not assumed to be the same for a 10-minute
 * player being promoted as for a 34-minute player being pushed further.
 */
export function fitResponse(changes) {
  const bands = [];
  for (const [lo, hi] of RESPONSE_CONFIG.bands) {
    const inBand = changes.filter((c) => c.baseMpg >= lo && c.baseMpg < hi);
    if (inBand.length < 40) { bands.push({ lo, hi, n: inBand.length, insufficient: true }); continue; }
    // Ordinary least squares of d(GS/36) on d(MPG). The intercept is retained rather than forced
    // through zero: a nonzero intercept would signal that something other than minutes moves with
    // a role change, which is worth seeing rather than assuming away.
    const n = inBand.length;
    const mx = inBand.reduce((a, c) => a + c.dMpg, 0) / n;
    const my = inBand.reduce((a, c) => a + c.dGsPer36, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const c of inBand) { sxy += (c.dMpg - mx) * (c.dGsPer36 - my); sxx += (c.dMpg - mx) ** 2; syy += (c.dGsPer36 - my) ** 2; }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    // Standard error of the slope, so a band with no real signal can be told apart from one with.
    const resid = inBand.reduce((a, c) => a + (c.dGsPer36 - (intercept + slope * c.dMpg)) ** 2, 0);
    const se = sxx > 0 && n > 2 ? Math.sqrt(resid / (n - 2) / sxx) : null;
    bands.push({
      lo, hi, n, slope: round(slope, 4), intercept: round(intercept, 4), r: round(r, 3),
      se: round(se, 4), t: fin(se) && se > 0 ? round(slope / se, 2) : null,
      medianBaseGsPer36: round(quantile(inBand.map((c) => c.baseGsPer36).sort((a, b) => a - b), 0.5), 3),
    });
  }
  return bands;
}

/** The band whose starting range contains this workload. */
export const bandFor = (bands, mpg) => bands.find((b) => mpg >= b.lo && mpg < b.hi) || bands[bands.length - 1];

/**
 * Optimal workload for one player.
 *
 * TOTAL contribution is per-36 production scaled by minutes actually played:
 *     total(m) = (gsPer36 + slope * (m - currentMpg)) * m / 36
 * Adding minutes helps directly and hurts through the slope when the slope is negative, so the
 * peak is where marginal contribution reaches zero. Searching a grid rather than solving in closed
 * form keeps the band-specific slope honest as the candidate moves between bands.
 *
 * The search is CAPPED near the observed range of the underlying changes. Extrapolating a linear
 * slope to 40 MPG for a 6-MPG player is exactly the failure mode that made v1 unusable.
 */
export function optimalWorkload(player, bands, { maxStep = 10, floor = 8, ceiling = 36 } = {}) {
  const { mpg, gsPer36 } = player;
  if (!fin(mpg) || !fin(gsPer36) || mpg < RESPONSE_CONFIG.minMpg) return null;
  const band = bandFor(bands, mpg);
  if (!band || band.insufficient || !fin(band.slope)) return null;

  const lo = Math.max(floor, mpg - maxStep), hi = Math.min(ceiling, mpg + maxStep);
  const total = (m) => (gsPer36 + band.slope * (m - mpg)) * (m / 36);
  let best = mpg, bestVal = total(mpg);
  for (let m = lo; m <= hi + 1e-9; m += 0.5) {
    const v = total(m);
    if (v > bestVal + 1e-9) { bestVal = v; best = m; }
  }
  const curVal = total(mpg);
  return {
    optimalMpg: round(best, 1),
    minutesDelta: round(best - mpg, 1),
    // Projected gain in total game-score contribution per game at the optimum.
    projectedGain: round(bestVal - curVal, 3),
    gainPct: curVal > 0 ? round(100 * (bestVal - curVal) / curVal, 1) : null,
    bandUsed: `${band.lo}-${band.hi} MPG`,
    bandSlope: band.slope,
    bandT: band.t,
    bandN: band.n,
    capped: best === lo || best === hi,
  };
}

/* ==================================================================================
 * TULIP v2 — team minutes allocation on value above replacement
 *
 * The within-player analysis above found NO evidence that per-36 production falls as minutes rise;
 * both designs found the opposite, because coaches give minutes to players who are playing well.
 * There is no fatigue curve to find a peak on. So "what workload is best" is an ALLOCATION
 * question: a team has 240 minutes and should spend them on its most valuable players.
 *
 * A first attempt ranked players by Hollinger Game Score and failed for three reasons, all fixed
 * here:
 *   1. Game Score is OFFENCE ONLY. Backup centres playing 10-minute bursts looked elite per-36
 *      while 3-and-D wings ranked near the bottom. Now ranked on BPM, whose DBPM half prices
 *      defence directly.
 *   2. Per-36 rates from tiny samples are noise. Now shrunk by MINUTES and gated on a minutes
 *      floor, so a 15-total-minute rate cannot outrank a rotation player.
 *   3. A hard top-9 cliff zeroed out rank 10+, producing -34 minute "recommendations" that were
 *      artifacts of the constraint. Now minutes are water-filled in proportion to value ABOVE
 *      REPLACEMENT, which declines smoothly to zero instead of falling off an edge.
 *
 * Constraints are measured from 2022-25 game logs, not chosen:
 *   240   team minutes per game (median, exactly 240)
 *   35.3  season-MPG ceiling (p95 of 1,409 player-seasons; ZERO exceeded 38.0)
 * Replacement level is BPM -2.0, the standard convention the metric is built around.
 *
 * This is not a prediction of coaching behaviour and not a claim a player would hold his rate in a
 * bigger role. It answers one well-posed question: given what each player has produced per minute,
 * is his team spending its minutes on the right people?
 * ================================================================================== */
export const ALLOC_CONFIG = {
  ceilingMpg: 35.3,      // p95 of 1,409 player-seasons; ZERO exceeded 38.0
  floorMpg: 6,
  maxAdvice: 8,          // widest recommendation this will make in either direction
  minutesPerBpmPoint: 2.2,
  shrinkMinutes: 400,
  minMinutes: 250,
};

/**
 * TULIP: how many more or fewer minutes a player should get, relative to how his team currently
 * spends its minutes.
 *
 * Two earlier formulations were built and discarded, both for reasons visible in their output:
 *
 *   Game Score ranking — offence only, so backup centres in 10-minute bursts looked elite per-36
 *   while 3-and-D wings ranked last. Replaced by BPM, whose DBPM half prices defence.
 *
 *   Full 240-minute re-allocation on value above replacement — brittle, because roughly 30% of
 *   players sit below the BPM -2.0 replacement line and therefore received ZERO minutes. That is
 *   "cut this player", not a workload recommendation, and it produced -34 minute figures that were
 *   artifacts of the constraint. It also handed +25 to players whose own BPM was below replacement,
 *   simply because their team-mates were worse.
 *
 * What this does instead: compare a player to the value his team is ALREADY buying with its
 * minutes — the minute-weighted average BPM of his own roster. A player better than that average
 * should absorb minutes from it; a player worse should give some up. The gap is converted at a
 * measured exchange rate and CLAMPED, because the honest claim is a direction and a rough size,
 * not a precise new workload.
 *
 * The clamp is the point, not a fudge. Nothing in one season of box-score data supports telling a
 * coach to move a rotation by 25 minutes.
 */
export function tulipMinutes(roster, leagueBpm = -0.8) {
  const K = ALLOC_CONFIG.shrinkMinutes;
  const rows = roster
    .filter((p) => fin(p.bpm) && fin(p.mpg) && fin(p.gp) && p.mpg > 0 && p.gp > 0)
    .map((p) => {
      const totalMin = p.mpg * p.gp;
      return { ...p, totalMin, shrunk: (totalMin * p.bpm + K * leagueBpm) / (totalMin + K) };
    });
  const eligible = rows.filter((p) => p.totalMin >= ALLOC_CONFIG.minMinutes);
  if (eligible.length < 5) return null;

  // The team's current "purchase price": value per minute it is actually buying today.
  const totMin = eligible.reduce((a, p) => a + p.totalMin, 0);
  const teamValuePerMinute = eligible.reduce((a, p) => a + p.shrunk * p.totalMin, 0) / totMin;

  return eligible.map((p) => {
    const gap = p.shrunk - teamValuePerMinute;
    const raw = gap * ALLOC_CONFIG.minutesPerBpmPoint;
    const clamped = Math.max(-ALLOC_CONFIG.maxAdvice, Math.min(ALLOC_CONFIG.maxAdvice, raw));
    // Never advise past what anyone actually sustains, or below a real rotation floor.
    const target = Math.max(ALLOC_CONFIG.floorMpg, Math.min(ALLOC_CONFIG.ceilingMpg, p.mpg + clamped));
    return {
      playerId: p.playerId,
      currentMpg: round(p.mpg, 1),
      targetMpg: round(target, 1),
      minutesDelta: round(target - p.mpg, 1),
      bpm: round(p.bpm, 1),
      shrunkBpm: round(p.shrunk, 2),
      teamValuePerMinute: round(teamValuePerMinute, 2),
      gapVsTeam: round(gap, 2),
      atCeiling: target >= ALLOC_CONFIG.ceilingMpg - 1e-9,
      clampedAdvice: Math.abs(raw) > ALLOC_CONFIG.maxAdvice,
    };
  });
}

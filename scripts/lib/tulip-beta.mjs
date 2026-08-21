// TULIP BETA — experimental, zero-sum minute-reallocation estimate.
//
// ANSWERS: given the players available to a team, how many more or fewer MPG should each receive if
// the objective is to maximize winning? Displayed as TULIP = Recommended MPG - Current MPG.
//
// EPISTEMIC STATUS, STATED IN CODE BECAUSE IT MATTERS: the DIRECTION rests on team-relative player
// value; the MAGNITUDE is heuristic. Pre-registered causal testing on 2015-16..2023-24 did NOT
// establish that these deltas maximize wins (reduced form -0.127 pts/SD, Anderson-Rubin 95% CI
// [-1.756, 1.021]). This is decision support, not a validated coaching prescription. Do not present
// it as one.
//
// FOUR THINGS SHAPE THE NUMBER, in order:
//   1. team-relative value    who deserves minutes versus the team-mates actually consuming them
//   2. workload state         a +1 SD player at 12 MPG and at 34 MPG must not get the same delta
//   3. role evidence          expansion is attenuated where history does not support that workload
//   4. zero-sum allocation    every minute granted is sourced from a team-mate; the ledger conserves

export const BETA_CONFIG = {
  shrinkMinutes: 400,      // BPM shrinkage toward league mean for small samples
  minMinutes: 200,         // below this a player is not an allocation candidate
  minMpg: 4,
  minutesPerSd: 6.6,       // HEURISTIC desired movement per SD of team-relative value. Retained
                           // rather than inventing a second arbitrary coefficient; it is only the
                           // STARTING desire, which the constraints below then compress.
  floorMpg: 6,             // a rotation player is not driven below this by reallocation
  ceilingHardCap: 38.0,    // no recommendation exceeds observed sustainable workload
};

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** Career-high and sustained workload from the compact history block (index 4 = mpg, 3 = gp). */
function workloadHistory(p) {
  const rows = Array.isArray(p.history) ? p.history : Object.values(p.history || {});
  let careerHigh = 0, sustained = 0;
  for (const r of rows) {
    if (!Array.isArray(r) || r[1] !== 'Regular Season') continue;
    const gp = Number(r[3]), mpg = Number(r[4]);
    if (!fin(gp) || !fin(mpg) || gp < 20) continue;      // a real season, not a cameo
    if (mpg > careerHigh) careerHigh = mpg;
    if (gp >= 40 && mpg > sustained) sustained = mpg;    // sustained over a substantial season
  }
  return { careerHigh, sustained };
}

/** Highest workload at which Role Evidence does NOT abstain. */
function supportedFrontierMpg(p) {
  const f = (p.tulip && p.tulip.frontier) || [];
  let best = 0;
  for (const pt of f) if (!pt.abstain && fin(pt.mpg) && pt.mpg > best) best = pt.mpg;
  return best;
}

/**
 * Role-evidence multiplier for POSITIVE recommendations only.
 * Negative recommendations are driven by team-relative value and the zero-sum requirement; a player
 * is NOT punished merely because evidence about expanding him is absent.
 */
function evidenceFactor(p, targetMpg) {
  const card = p.tulip && p.tulip.card;
  const tier = card && card.evidenceTier && card.evidenceTier.tier;
  let f = tier === 'A' ? 1.0 : tier === 'B' ? 0.85 : tier === 'C' ? 0.6 : 0.45;
  const rsr = p.tulip && p.tulip.roleScaleResponse;
  if (rsr && /INSUFFICIENT/i.test(rsr.response || '')) f *= 0.8;
  const cs = card && card.projection && card.projection.counterfactualSupport;
  if (cs && cs.status && cs.status !== 'OK') f *= 0.7;
  // If Role Evidence positively supports a workload at or above the target, restore confidence.
  if (supportedFrontierMpg(p) >= targetMpg) f = Math.min(1.0, f * 1.6);
  return Math.max(0.2, Math.min(1.0, f));
}

function confidenceOf(p, finalDelta, ceiling) {
  const mins = Number(p.minutes) || 0;
  const tier = p.tulip && p.tulip.card && p.tulip.card.evidenceTier && p.tulip.card.evidenceTier.tier;
  const inSupport = Math.abs(finalDelta) <= 3 || (Number(p.mpg) + finalDelta) <= ceiling;
  if (mins >= 800 && (tier === 'A' || tier === 'B') && inSupport) return 'HIGH';
  if (mins >= 300 && (tier === 'A' || tier === 'B' || inSupport)) return 'MEDIUM';
  return 'LOW';
}

/**
 * Compute TULIP Beta for one team's eligible roster. Returns a map playerId -> beta object.
 * The ledger conserves exactly: the sum of positive deltas equals the sum of negative deltas.
 */
export function tulipBetaForTeam(roster, { leagueBpm, leagueGapSd }) {
  const elig = roster.filter((p) => p.appeared && fin(p.bpm) && fin(p.mpg)
    && (p.minutes || 0) >= BETA_CONFIG.minMinutes && p.mpg >= BETA_CONFIG.minMpg);
  if (elig.length < 5) return new Map();

  const shrunk = new Map();
  for (const p of elig) {
    const m = Number(p.minutes) || 0;
    shrunk.set(p.playerId, (m * Number(p.bpm) + BETA_CONFIG.shrinkMinutes * leagueBpm) / (m + BETA_CONFIG.shrinkMinutes));
  }
  const totMin = elig.reduce((a, p) => a + Number(p.mpg), 0);
  const teamAvg = elig.reduce((a, p) => a + shrunk.get(p.playerId) * Number(p.mpg), 0) / totMin;

  const rows = [];
  for (const p of elig) {
    const gap = shrunk.get(p.playerId) - teamAvg;
    const gapSd = gap / leagueGapSd;
    const rawSignalDelta = gapSd * BETA_CONFIG.minutesPerSd;
    let desired = rawSignalDelta;

    // --- workload state: what has this player actually sustained? ---
    const wh = workloadHistory(p);
    const ceiling = Math.min(BETA_CONFIG.ceilingHardCap,
      Math.max(Number(p.mpg), wh.careerHigh, wh.sustained, supportedFrontierMpg(p)));
    const headUp = Math.max(0, ceiling - Number(p.mpg));
    const headDown = Math.max(0, Number(p.mpg) - BETA_CONFIG.floorMpg);

    let evF = 1;
    if (desired > 0) {
      evF = evidenceFactor(p, Number(p.mpg) + desired);
      desired = Math.min(desired * evF, headUp);       // evidence attenuates, ceiling caps
    } else {
      desired = Math.max(desired, -headDown);          // cannot take minutes he does not have
    }
    rows.push({ p, gap, gapSd, rawSignalDelta, desired, ceiling, evF, shrunkBpm: shrunk.get(p.playerId) });
  }

  // --- zero-sum: every granted minute is sourced from a team-mate ---
  const pos = rows.filter((r) => r.desired > 0), neg = rows.filter((r) => r.desired < 0);
  const P = pos.reduce((a, r) => a + r.desired, 0);
  const N = neg.reduce((a, r) => a - r.desired, 0);
  const T = Math.min(P, N);                            // only what can actually be sourced moves
  const out = new Map();
  for (const r of rows) {
    let final = 0;
    if (r.desired > 0 && P > 0) final = r.desired * (T / P);
    else if (r.desired < 0 && N > 0) final = r.desired * (T / N);
    const rosterBalanceFactor = r.desired > 0 ? (P > 0 ? T / P : 0)
      : r.desired < 0 ? (N > 0 ? T / N : 0) : 0;
    final = Math.round(final * 10) / 10;
    const rec = Math.round((Number(r.p.mpg) + final) * 10) / 10;
    out.set(r.p.playerId, {
      tulip: final,
      currentMpg: Math.round(Number(r.p.mpg) * 10) / 10,
      recommendedMpg: rec,
      valueGap: Math.round(r.gap * 100) / 100,
      valueGapSd: Math.round(r.gapSd * 100) / 100,
      shrunkBpm: Math.round(r.shrunkBpm * 100) / 100,
      // Explanation-only trace of the existing calculation. These fields expose the path without
      // changing it: team-relative signal -> workload/role constraint -> roster-balanced TULIP.
      rawSignalDelta: Math.round(r.rawSignalDelta * 10) / 10,
      constrainedDelta: Math.round(r.desired * 10) / 10,
      rosterBalanceFactor: Math.round(rosterBalanceFactor * 1000) / 1000,
      supportedCeiling: Math.round(r.ceiling * 10) / 10,
      evidenceTier: (r.p.tulip && r.p.tulip.card && r.p.tulip.card.evidenceTier && r.p.tulip.card.evidenceTier.tier) || null,
      evidenceFactor: Math.round(r.evF * 100) / 100,
      confidence: confidenceOf(r.p, final, r.ceiling),
      abstain: false,
      status: 'BETA',
    });
  }
  return out;
}

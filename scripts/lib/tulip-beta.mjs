import { playerDriverTrace } from './tulip-beta-diagnostics.mjs';
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
//   3. role evidence          expansion is attenuated where history does not support that workload,
//                            but historical workload is not a hard cap on a breakout recommendation
//   4. zero-sum allocation    every minute granted is sourced from a team-mate; the ledger conserves

export const BETA_CONFIG = {
  version: 'tulip-beta-support-v2',
  shrinkMinutes: 400,      // BPM shrinkage toward league mean for small samples
  minMinutes: 200,         // below this a player is not an allocation candidate
  minMpg: 0.5,
  minutesPerSd: 10.0,      // HEURISTIC starting movement per SD of team-relative value.
                           // There is deliberately NO arbitrary +/-8 MPG delta clamp. The actual
                           // bounds come from workload evidence, a 0-40 MPG feasible range, and the
                           // roster's zero-sum minute supply.
  floorMpg: 0,             // a player may be recommended out of the rotation when the signal is strong
  ceilingHardCap: 40.0,    // feasible NBA workload ceiling; not an +/- delta cap
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
function evidenceFactor(p) {
  const card = p.tulip && p.tulip.card;
  const tier = card && card.evidenceTier && card.evidenceTier.tier;
  let f = tier === 'A' ? 1.0 : tier === 'B' ? 0.85 : tier === 'C' ? 0.6 : 0.45;
  const rsr = p.tulip && p.tulip.roleScaleResponse;
  // These diagnostics describe overlapping limitations in the SAME role-comparison sample.
  // Multiplying them counted that weakness repeatedly; use the weakest assessment once.
  if (rsr && /INSUFFICIENT/i.test(rsr.response || '')) f = Math.min(f, 0.8);
  const cs = card && card.projection && card.projection.counterfactualSupport;
  if (cs && cs.status && cs.status !== 'OK') f = Math.min(f, 0.7);
  return f;
}

function confidenceOf(p, finalDelta, ceiling) {
  const mins = Number(p.minutes) || 0;
  const tier = p.tulip && p.tulip.card && p.tulip.card.evidenceTier && p.tulip.card.evidenceTier.tier;
  const inSupport = (Number(p.mpg) + finalDelta) <= ceiling + 0.05;
  if (mins >= 800 && (tier === 'A' || tier === 'B') && inSupport) return 'HIGH';
  if (mins >= 300 && (tier === 'A' || tier === 'B' || tier === 'C') && inSupport) return 'MEDIUM';
  return 'LOW';
}

// Round the two sides to an identical number of tenths. Independent rounding caused the
// published ledger to create/lose up to 0.3 MPG per team. Largest remainder is deterministic,
// preserves direction, and never exceeds the feasible workload bounds.
function roundLedgerSide(rows, targetTenths, sign) {
  const total = rows.reduce((s, r) => s + Math.abs(r.desired), 0);
  const quotas = rows.map((r) => {
    const exact = total ? Math.abs(r.desired) / total * targetTenths : 0;
    const limit = Math.max(0, Math.floor((sign > 0
      ? BETA_CONFIG.ceilingHardCap - Number(r.p.mpg) : Number(r.p.mpg)) * 10 + 1e-7));
    return { r, n: Math.min(Math.floor(exact), limit), fraction: exact % 1, limit };
  });
  let left = targetTenths - quotas.reduce((s, q) => s + q.n, 0);
  quotas.sort((a, b) => b.fraction - a.fraction || String(a.r.p.playerId).localeCompare(String(b.r.p.playerId)));
  while (left > 0) {
    let progress = false;
    for (const q of quotas) if (q.n < q.limit && left > 0) { q.n++; left--; progress = true; }
    if (!progress) throw new Error('TULIP ledger rounding exceeded feasible workload');
  }
  return new Map(quotas.map(({ r, n }) => [r.p.playerId, sign * n / 10]));
}

/**
 * Compute TULIP Beta for one team's eligible roster. Returns a map playerId -> beta object.
 * The ledger conserves exactly: the sum of positive deltas equals the sum of negative deltas.
 */
export function tulipBetaForTeam(roster, { leagueBpm, leagueGapSd, baselineSeason = '2025-26' }) {
  if (!fin(leagueBpm) || !fin(leagueGapSd) || Number(leagueGapSd) <= 0)
    throw new Error('TULIP requires a finite league mean and positive gap standard deviation');
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
    const headUp = Math.max(0, BETA_CONFIG.ceilingHardCap - Number(p.mpg));
    const headDown = Math.max(0, Number(p.mpg) - BETA_CONFIG.floorMpg);

    let evF = 1, extrapolationFactor = 1, supportedGain = 0;
    if (desired > 0) {
      extrapolationFactor = evidenceFactor(p);
      supportedGain = Math.min(desired, Math.max(0, ceiling - Number(p.mpg)));
      // Role-expansion uncertainty concerns the part OUTSIDE demonstrated workload. Do not
      // suppress an already sustained role merely because an expansion-comparison card abstains.
      const supportedAdjusted = supportedGain + (desired - supportedGain) * extrapolationFactor;
      evF = supportedAdjusted / desired;
      desired = Math.min(supportedAdjusted, headUp);
    } else {
      desired = Math.max(desired, -headDown);          // cannot take minutes he does not have
    }
    rows.push({ p, gap, gapSd, rawSignalDelta, desired, ceiling, evF, extrapolationFactor,
      supportedGain, shrunkBpm: shrunk.get(p.playerId) });
  }

  // --- zero-sum: every granted minute is sourced from a team-mate ---
  const pos = rows.filter((r) => r.desired > 0), neg = rows.filter((r) => r.desired < 0);
  const P = pos.reduce((a, r) => a + r.desired, 0);
  const N = neg.reduce((a, r) => a - r.desired, 0);
  const T = Math.min(P, N);                            // only what can actually be sourced moves
  const positiveCapacity = pos.reduce((s, r) => s + Math.floor(Math.max(0, BETA_CONFIG.ceilingHardCap - Number(r.p.mpg)) * 10 + 1e-7), 0);
  const negativeCapacity = neg.reduce((s, r) => s + Math.floor(Number(r.p.mpg) * 10 + 1e-7), 0);
  const tenths = Math.min(Math.floor(T * 10 + 1e-7), positiveCapacity, negativeCapacity);
  const rounded = new Map([...roundLedgerSide(pos, tenths, 1), ...roundLedgerSide(neg, tenths, -1)]);
  const out = new Map();
  for (const r of rows) {
    let final = 0;
    if (r.desired > 0 && P > 0) final = r.desired * (T / P);
    else if (r.desired < 0 && N > 0) final = r.desired * (T / N);
    const rosterBalanceFactor = r.desired > 0 ? (P > 0 ? T / P : 0)
      : r.desired < 0 ? (N > 0 ? T / N : 0) : 0;
    final = rounded.get(r.p.playerId) || 0;
    const currentMpg = Math.round(Number(r.p.mpg) * 10) / 10;
    const rec = Math.round((currentMpg + final) * 10) / 10;
    const result = {
      tulip: final,
      currentMpg,
      baselineSeason,
      baselineTeam: r.p.seasonTeam || r.p.team || null,
      baselineLabel: `${baselineSeason} MPG baseline`,
      recommendedMpg: rec,
      valueGap: Math.round(r.gap * 100) / 100,
      valueGapSd: Math.round(r.gapSd * 100) / 100,
      shrunkBpm: Math.round(r.shrunkBpm * 100) / 100,
      // Trace: reliability-shrunk value -> supported/extrapolated workload -> balanced ledger.
      rawSignalDelta: Math.round(r.rawSignalDelta * 10) / 10,
      constrainedDelta: Math.round(r.desired * 10) / 10,
      rosterBalanceFactor: Math.round(rosterBalanceFactor * 1000) / 1000,
      supportedCeiling: Math.round(r.ceiling * 10) / 10,
      evidenceTier: (r.p.tulip && r.p.tulip.card && r.p.tulip.card.evidenceTier && r.p.tulip.card.evidenceTier.tier) || null,
      evidenceFactor: Math.round(r.evF * 100) / 100,
      extrapolationFactor: r.extrapolationFactor,
      supportedGain: Math.round(r.supportedGain * 10) / 10,
      extrapolated: rec > r.ceiling + 0.05,
      confidence: confidenceOf(r.p, final, r.ceiling),
      version: BETA_CONFIG.version,
      interpretation: 'Experimental reallocation hypothesis; neither direction nor magnitude is validated to improve winning.',
      abstain: false,
      status: 'BETA',
    };
    result.drivers = playerDriverTrace(result);
    out.set(r.p.playerId, result);
  }
  return out;
}

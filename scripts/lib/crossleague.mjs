// Cross-league translation, NBA readiness, and optimal-minutes estimation.
//
// Three separate questions, deliberately kept apart because they have different evidence bases:
//
//   1. OPTIMAL MINUTES  — at what workload is a player's projected impact highest, and how far is
//      that from what he currently plays? TULIP evaluates a FIXED target; this searches the band.
//   2. NBA READINESS    — for a G League player, the modelled probability of being an effective
//      NBA player. Fitted on players who actually appeared in BOTH leagues this season.
//   3. PER-36 TRANSLATION — what a line looks like at 36 minutes, and for G League players what it
//      would look like against NBA competition, pace and scoring environment.
//
// Everything here is observational and single-season. None of it is a forecast.

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const num = (v) => (fin(v) ? Number(v) : null);
const round = (v, d = 2) => (fin(v) ? Number(Number(v).toFixed(d)) : null);
const median = (a) => { const s = a.filter(fin).map(Number).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/* ==================================================================== 1. OPTIMAL MINUTES */

/**
 * Search TULIP's frontier for the workload with the highest projected impact.
 *
 * TULIP answers "what happens at 34 MPG?". It never answers "which workload is best?", because it
 * evaluates one target. The frontier already projects 12/16/20/24/28/32/36 MPG, so the argmax over
 * the SUPPORTED bands is the answer, and it costs no new modelling.
 *
 * Only bands TULIP did not abstain on are eligible. Requiring >= 2 supported bands is the point:
 * with a single point there is no comparison, so "optimal" would just be restating that one band.
 *
 * @returns {{optimalMpg, minutesDelta, projectedAtOptimal, supportedBands, confidence}|null}
 */
export function optimalMinutes(frontierPoints, currentMpg) {
  if (!Array.isArray(frontierPoints)) return null;
  const supported = frontierPoints.filter((p) => p && p.abstain !== true && fin(p.projectedImpact));
  if (supported.length < 2) return null;

  let best = supported[0];
  for (const p of supported) if (p.projectedImpact > best.projectedImpact) best = p;

  // How clearly the peak stands out is REPORTED rather than used to suppress the estimate. An
  // earlier version refused whenever the across-band spread was narrower than the best band's own
  // interval, which dropped 823 of 829 eligible players: that interval is the uncertainty of the
  // LEVEL, not of the DIFFERENCE between bands, so it is the wrong yardstick for a comparison.
  const impacts = supported.map((p) => p.projectedImpact);
  const spread = Math.max(...impacts) - Math.min(...impacts);
  const iv = Array.isArray(best.interval) && best.interval.length === 2
    ? Math.abs(best.interval[1] - best.interval[0]) : null;

  return {
    optimalMpg: best.mpg,
    minutesDelta: fin(currentMpg) ? round(best.mpg - Number(currentMpg), 1) : null,
    projectedAtOptimal: round(best.projectedImpact, 2),
    supportedBands: supported.length,
    // Spread relative to the interval: how clearly the peak stands out from its own uncertainty.
    confidence: fin(iv) && iv > 0 ? round(spread / iv, 2) : null,
  };
}

/* ============================================================== 2. NBA READINESS (G LEAGUE) */

/**
 * Feature blocks. SCORING VOLUME IS DELIBERATELY ABSENT — no points, no usage. A G League player
 * can score heavily against G League defence without any of it translating, and scoring volume is
 * the single most misleading signal at this level. What is used is the skill set that survives a
 * level change: passing, ball security, defensive event creation, effort, and shooting efficiency.
 *
 * The G League publishes NO hustle tracking (deflections, screen assists, loose balls, contested
 * shots are NBA-only), so "hustle" here is a PROXY built from offensive rebounding rate and drawn
 * fouls — effort plays that show up in the box score. That is a real limitation, not a hidden one.
 */
export const READINESS_BLOCKS = {
  playmaking: {
    label: 'Playmaking',
    parts: [['astPct', 1], ['astPer100', 1], ['astTo', 1]],
    note: 'Assist rate, assists per 100 possessions, and assist-to-turnover ratio.',
  },
  connecting: {
    label: 'Connecting',
    parts: [['astRatio', 1], ['toRatio', -1.2], ['fg3Ar', 0.6]],
    note: 'Moves the ball and keeps it: assist ratio and three-point attempt rate, penalised for turnover ratio. Weighted against turnovers more heavily than for volume.',
  },
  defense: {
    label: 'Defense',
    parts: [['stlPer100', 1], ['blkPer100', 1], ['defRtg', -1], ['drebPct', 0.7]],
    note: 'Steals and blocks per 100 possessions, defensive rebound rate, and defensive rating inverted so lower is better.',
  },
  hustle: {
    label: 'Hustle (proxy)',
    parts: [['orebPct', 1], ['pfd', 0.7]],
    note: 'PROXY ONLY. The G League publishes no hustle tracking, so this uses offensive rebound rate and fouls drawn — effort plays visible in a box score.',
  },
  shooting: {
    label: '3PT efficiency',
    parts: [['fg3Pct', 1], ['fg3a', 0.5]],
    note: 'Three-point percentage, with attempt volume at half weight so a small-sample high percentage on no volume cannot dominate.',
  },
};

/** Robust z-score against a population: median and MAD, so outliers do not set the scale. */
function robustZ(values) {
  const s = values.filter(fin).map(Number).sort((a, b) => a - b);
  if (s.length < 8) return () => null;
  const med = quantile(s, 0.5);
  const mad = quantile(s.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5) || 1e-9;
  const scale = 1.4826 * mad;
  return (v) => (fin(v) ? Math.max(-4, Math.min(4, (Number(v) - med) / scale)) : null);
}

/** Build per-block composite scores for a population. */
export function readinessFeatures(pool) {
  const zs = {};
  const allKeys = new Set();
  for (const b of Object.values(READINESS_BLOCKS)) for (const [k] of b.parts) allKeys.add(k);
  for (const k of allKeys) zs[k] = robustZ(pool.map((p) => p[k]));

  return (p) => {
    const out = {};
    for (const [name, b] of Object.entries(READINESS_BLOCKS)) {
      let sum = 0, wsum = 0;
      for (const [k, w] of b.parts) {
        const z = zs[k](p[k]);
        if (z === null) continue;
        sum += z * w; wsum += Math.abs(w);
      }
      out[name] = wsum > 0 ? sum / wsum : null;
    }
    return out;
  };
}

/**
 * Logistic regression by IRLS with L2 (ridge) regularisation.
 * The sample is small — roughly 85 players with real minutes in both leagues — so regularisation
 * is not optional. Without it the coefficients chase noise.
 */
export function fitLogistic(X, y, { lambda = 1.0, iters = 60 } = {}) {
  const n = X.length, d = X[0].length + 1;
  const design = X.map((r) => [1, ...r]);
  let w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const grad = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * design[i][j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const r = p * (1 - p);
      for (let j = 0; j < d; j++) {
        grad[j] += (y[i] - p) * design[i][j];
        for (let k = 0; k < d; k++) H[j][k] += r * design[i][j] * design[i][k];
      }
    }
    // Ridge penalty on every coefficient except the intercept.
    for (let j = 1; j < d; j++) { grad[j] -= lambda * w[j]; H[j][j] += lambda; }
    const step = solve(H, grad);
    if (!step) break;
    let maxStep = 0;
    for (let j = 0; j < d; j++) { w[j] += step[j]; maxStep = Math.max(maxStep, Math.abs(step[j])); }
    if (maxStep < 1e-7) break;
  }
  return w;
}

/** Gaussian elimination with partial pivoting. Returns null on a singular system. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // row[i] IS the diagonal element of this row; an earlier version wrote row[i][i], which indexes
  // into a number, yields undefined, and turned every solution into NaN.
  return M.map((row, i) => row[n] / row[i]);
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export const predict = (w, x) => sigmoid(w[0] + x.reduce((a, v, i) => a + w[i + 1] * v, 0));

/** Area under the ROC curve. 0.5 is a coin flip. */
export function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, rankSum = 0;
  pairs.forEach(([, l], i) => { if (l === 1) { pos++; rankSum += i + 1; } else neg++; });
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

/* ========================================================= 3. PER-36 CROSS-LEAGUE TRANSLATION */

export const PER36_STATS = ['pts', 'reb', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fg3'];

export const per36 = (p, key) => {
  const mins = num(p.minutes);
  if (!fin(mins) || mins < 1 || !fin(p[key])) return null;
  // Season totals are stored as per-game values alongside mpg, so scale from the per-game rate.
  const perGame = num(p[key]);
  const mpg = num(p.mpg);
  if (!fin(mpg) || mpg <= 0) return null;
  return (perGame / mpg) * 36;
};

/**
 * Empirical per-36 translation factors from players who appeared in BOTH leagues this season.
 *
 * Per-36 is used rather than per-game because it removes the role-size change, which is by far the
 * largest confound: a G League star playing 34 minutes who becomes an NBA bench player at 12
 * minutes will see every per-game number collapse for reasons that have nothing to do with level.
 *
 * A separate PACE factor is applied because per-36 still contains possessions-per-minute. The two
 * leagues do not play at the same speed, so minutes are not interchangeable units of opportunity.
 */
export function per36TranslationFactors(pairs, { minMinutes = 150 } = {}) {
  const usable = pairs.filter(({ gl, nba }) =>
    num(gl.minutes) >= minMinutes && num(nba.minutes) >= minMinutes);
  const out = { sampleSize: usable.length, minMinutes, stats: {} };
  for (const s of PER36_STATS) {
    const ratios = usable.map(({ gl, nba }) => {
      const g = per36(gl, s), n = per36(nba, s);
      return fin(g) && fin(n) && g > 0.15 ? n / g : null;   // guard tiny denominators
    }).filter(fin).sort((a, b) => a - b);
    out.stats[s] = ratios.length >= 10
      ? { n: ratios.length, factor: round(quantile(ratios, 0.5), 3),
          p25: round(quantile(ratios, 0.25), 3), p75: round(quantile(ratios, 0.75), 3) }
      : { n: ratios.length, insufficient: true };
  }
  // Efficiency rates are translated as DIFFERENCES, not ratios: a ratio on a percentage compounds
  // badly near the tails (a 0.30 3P% times 0.9 is a different thing from 0.50 times 0.9).
  for (const s of ['ts', 'fg3Pct', 'efg', 'ftPct']) {
    const diffs = usable.map(({ gl, nba }) =>
      fin(gl[s]) && fin(nba[s]) ? Number(nba[s]) - Number(gl[s]) : null).filter(fin).sort((a, b) => a - b);
    out.stats[s] = diffs.length >= 10
      ? { n: diffs.length, delta: round(quantile(diffs, 0.5), 4),
          p25: round(quantile(diffs, 0.25), 4), p75: round(quantile(diffs, 0.75), 4), mode: 'difference' }
      : { n: diffs.length, insufficient: true };
  }
  return out;
}

/** Median pace of each league, used to convert opportunity per minute. */
export function paceAdjustment(nbaPool, glPool) {
  const nbaPace = median(nbaPool.map((p) => p.pace));
  const glPace = median(glPool.map((p) => p.pace));
  return {
    nbaPace: round(nbaPace, 1), glPace: round(glPace, 1),
    factor: fin(nbaPace) && fin(glPace) && glPace > 0 ? round(nbaPace / glPace, 4) : 1,
  };
}

/**
 * Project a G League line to an NBA-equivalent 36-minute line.
 * Counting stats: per-36 x empirical level factor x pace factor.
 * Rate stats: per-36 is irrelevant; the empirical level DIFFERENCE is added.
 */
export function translateTo36(glPlayer, factors, pace) {
  const out = {};
  for (const s of PER36_STATS) {
    const f = factors.stats[s];
    const base = per36(glPlayer, s);
    if (!f || f.insufficient || !fin(base)) { out[s] = null; continue; }
    out[s] = round(base * f.factor * pace.factor, 1);
  }
  for (const s of ['ts', 'fg3Pct', 'efg']) {
    const f = factors.stats[s];
    if (!f || f.insufficient || !fin(glPlayer[s])) { out[s] = null; continue; }
    out[s] = round(Math.max(0, Number(glPlayer[s]) + f.delta), 4);
  }
  return out;
}

/** An NBA player's own line at 36 minutes. No level translation — same league, same competition. */
export function nbaTo36(p) {
  const out = {};
  for (const s of PER36_STATS) out[s] = round(per36(p, s), 1);
  for (const s of ['ts', 'fg3Pct', 'efg']) out[s] = fin(p[s]) ? round(Number(p[s]), 4) : null;
  return out;
}

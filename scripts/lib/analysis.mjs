// Analytical engines: archetypes, similarity, team need/fit, and G League -> NBA translation.
// All four are computed at build time so the interface stays responsive, and all four expose
// their inputs rather than emitting an unexplained number.
import { round } from './sources.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Percentile of each value within the population, ties averaged. 0-100. */
function pct(values) {
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

/* ----------------------------------------------------------------- profile */

/**
 * The skill vector every downstream engine reads. Per-36 so role size does not dominate
 * similarity or archetype, plus rate statistics that are already basis-free.
 */
export const SKILL_AXES = {
  scoringRate:     (p) => per36(p, 'pts'),
  rimPressure:     (p) => per36(p, 'fta'),
  threeVolume:     (p) => per36(p, 'fg3a'),
  threeAccuracy:   (p) => p.fg3Pct,
  shootingEff:     (p) => p.ts,
  selfCreation:    (p) => p.stats?.oscore_pct_uast_fgm,
  playmaking:      (p) => per36(p, 'ast'),
  assistRate:      (p) => p.astPct,
  ballSecurity:    (p) => (fin(p.astTo) ? p.astTo : null),
  offRebounding:   (p) => p.orebPct,
  defRebounding:   (p) => p.drebPct,
  steals:          (p) => per36(p, 'stl'),
  rimProtection:   (p) => per36(p, 'blk'),
  usage:           (p) => p.usg,
  paintScoring:    (p) => p.stats?.oscore_pct_pts_paint,
  size:            (p) => p.heightInches,
};

function per36(p, key) {
  const total = p[key], mpg = p.mpg;
  if (!fin(total) || !fin(mpg) || mpg <= 0) return null;
  return (Number(total) * 36) / mpg;
}

/** Percentile profile across SKILL_AXES for one league's players. */
export function skillProfiles(players) {
  const names = Object.keys(SKILL_AXES);
  const cols = {};
  for (const n of names) cols[n] = pct(players.map((p) => SKILL_AXES[n](p)));
  return players.map((_, i) => Object.fromEntries(names.map((n) => [n, round(cols[n][i], 1)])));
}

/* --------------------------------------------------------------- archetypes */

/**
 * Archetypes as transparent rule sets over the skill percentile profile, not a black-box
 * classifier. Each is a list of [axis, weight] where weight may be negative; the score is the
 * weighted mean of those percentiles, so every membership number can be explained by naming the
 * axes that drove it. A player can belong to several.
 */
export const ARCHETYPES = {
  'Primary Creator':    { playmaking: 1.0, assistRate: 1.0, usage: 0.8, selfCreation: 0.6, scoringRate: 0.4 },
  'Secondary Creator':  { playmaking: 0.8, assistRate: 0.6, scoringRate: 0.6, usage: 0.3, selfCreation: 0.4 },
  'Combo Guard':        { scoringRate: 0.8, playmaking: 0.6, threeVolume: 0.5, usage: 0.5, size: -0.4 },
  'Connector':          { assistRate: 0.6, ballSecurity: 0.8, shootingEff: 0.6, usage: -0.5, threeAccuracy: 0.4 },
  'Movement Shooter':   { threeVolume: 1.0, threeAccuracy: 0.8, selfCreation: 0.4, shootingEff: 0.5, offRebounding: -0.3 },
  'Spot-Up Shooter':    { threeVolume: 1.0, threeAccuracy: 0.7, selfCreation: -0.8, usage: -0.4 },
  'Slasher':            { rimPressure: 1.0, paintScoring: 0.8, threeVolume: -0.5, scoringRate: 0.5 },
  '3&D Wing':           { threeVolume: 0.9, threeAccuracy: 0.5, steals: 0.7, usage: -0.4, playmaking: -0.3 },
  'Two-Way Wing':       { scoringRate: 0.6, steals: 0.7, defRebounding: 0.4, threeVolume: 0.4, rimProtection: 0.3 },
  'Point Forward':      { playmaking: 0.9, assistRate: 0.8, size: 0.6, defRebounding: 0.4 },
  'Stretch Big':        { size: 0.8, threeVolume: 0.9, threeAccuracy: 0.5, defRebounding: 0.5, rimProtection: 0.2 },
  'Rim Runner':         { size: 0.7, paintScoring: 0.9, offRebounding: 0.8, threeVolume: -0.8, shootingEff: 0.5 },
  'Interior Scorer':    { paintScoring: 0.9, scoringRate: 0.7, size: 0.5, rimPressure: 0.5, threeVolume: -0.5 },
  'Passing Big':        { size: 0.7, assistRate: 0.8, playmaking: 0.6, defRebounding: 0.5 },
  'Rim Protector':      { rimProtection: 1.0, size: 0.7, defRebounding: 0.5, threeVolume: -0.4 },
  'Rebounding Big':     { offRebounding: 0.9, defRebounding: 0.9, size: 0.6, threeVolume: -0.4 },
};

export function archetypes(profile) {
  const out = [];
  for (const [name, spec] of Object.entries(ARCHETYPES)) {
    let acc = 0, wsum = 0;
    const drivers = [];
    for (const [axis, w] of Object.entries(spec)) {
      const v = profile[axis];
      if (!fin(v)) continue;
      const contribution = w >= 0 ? v : 100 - v;
      acc += contribution * Math.abs(w);
      wsum += Math.abs(w);
      drivers.push({ axis, weight: w, percentile: v, contribution: round(contribution, 1) });
    }
    if (!wsum) continue;
    const score = acc / wsum;
    drivers.sort((a, b) => b.contribution * Math.abs(b.weight) - a.contribution * Math.abs(a.weight));
    out.push({ name, score: round(score, 1), drivers: drivers.slice(0, 4) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 5);
}

/* --------------------------------------------------------------- similarity */

/**
 * Similarity from Euclidean distance over the skill percentile profile, converted to a 0-100
 * score. Documented so the number is not arbitrary:
 *   d = sqrt( sum_i w_i * (a_i - b_i)^2 / sum_i w_i )   over axes both players have
 *   similarity = 100 * (1 - d / 100)
 * Percentiles put every axis on the same 0-100 footing, so no separate normalisation is needed,
 * and the metric is symmetric by construction.
 */
export const SIMILARITY_WEIGHTS = {
  scoringRate: 1, rimPressure: 0.8, threeVolume: 1, threeAccuracy: 0.6, shootingEff: 0.8,
  selfCreation: 1, playmaking: 1, assistRate: 0.9, ballSecurity: 0.5, offRebounding: 0.8,
  defRebounding: 0.8, steals: 0.7, rimProtection: 0.9, usage: 0.9, paintScoring: 0.8, size: 0.7,
};

export function similarity(a, b, weights = SIMILARITY_WEIGHTS) {
  let acc = 0, wsum = 0;
  const axes = [];
  for (const [axis, w] of Object.entries(weights)) {
    const x = a[axis], y = b[axis];
    if (!fin(x) || !fin(y)) continue;
    const diff = x - y;
    acc += w * diff * diff;
    wsum += w;
    axes.push({ axis, a: x, b: y, diff: round(Math.abs(diff), 1) });
  }
  if (!wsum) return null;
  const d = Math.sqrt(acc / wsum);
  axes.sort((p, q) => p.diff - q.diff);
  return {
    score: round(clamp(100 * (1 - d / 100), 0, 100), 1),
    axesCompared: axes.length,
    mostSimilar: axes.slice(0, 4).map((x) => x.axis),
    biggestDifferences: axes.slice(-4).reverse().map((x) => ({ axis: x.axis, gap: x.diff })),
  };
}

/* ----------------------------------------------------------------- team fit */

/** Need dimensions, each read off the roster's minutes-weighted skill percentiles. */
export const NEED_AXES = ['shootingEff', 'threeVolume', 'selfCreation', 'playmaking', 'assistRate',
  'ballSecurity', 'rimPressure', 'offRebounding', 'defRebounding', 'steals', 'rimProtection', 'size'];

const NEED_LABEL = {
  shootingEff: 'shooting efficiency', threeVolume: 'three-point volume',
  selfCreation: 'shot creation', playmaking: 'passing', assistRate: 'assist rate',
  ballSecurity: 'ball security', rimPressure: 'rim pressure',
  offRebounding: 'offensive rebounding', defRebounding: 'defensive rebounding',
  steals: 'perimeter defensive activity', rimProtection: 'rim protection', size: 'size',
};

/**
 * A team's need profile: the minutes-weighted average percentile of its roster on each axis,
 * inverted into a need (a roster at the 20th percentile in shooting has an 80 need for it).
 */
export function teamNeeds(rosterWithProfiles) {
  const needs = {};
  for (const axis of NEED_AXES) {
    let acc = 0, w = 0;
    for (const { player, profile } of rosterWithProfiles) {
      const v = profile[axis];
      const m = player.minutes || 0;
      if (!fin(v) || m <= 0) continue;
      acc += v * m; w += m;
    }
    if (!w) continue;
    const strength = acc / w;
    needs[axis] = { strength: round(strength, 1), need: round(100 - strength, 1), label: NEED_LABEL[axis] };
  }
  return needs;
}

/**
 * Fit is deliberately NOT quality. It is how well a player's profile answers what the roster is
 * short of, so a 6.8 player can be a better fit than an 8.0 player for a particular team.
 */
export function teamFit(profile, needs, { weights } = {}) {
  let acc = 0, wsum = 0;
  const plus = [], minus = [];
  for (const axis of NEED_AXES) {
    const n = needs[axis];
    const v = profile[axis];
    if (!n || !fin(v)) continue;
    // A need of 80 means the roster is weak there; supplying it is worth more.
    const w = (weights?.[axis] ?? 1) * (n.need / 100);
    if (w <= 0) continue;
    acc += v * w; wsum += w;
    const entry = { axis, label: n.label, playerPercentile: v, teamNeed: n.need };
    if (v >= 60 && n.need >= 55) plus.push(entry);
    else if (v <= 40 && n.need >= 55) minus.push(entry);
  }
  if (!wsum) return null;
  plus.sort((a, b) => (b.playerPercentile * b.teamNeed) - (a.playerPercentile * a.teamNeed));
  minus.sort((a, b) => (a.playerPercentile * (100 - a.teamNeed)) - (b.playerPercentile * (100 - b.teamNeed)));
  return {
    score: round(clamp(acc / wsum, 0, 100), 1),
    strengths: plus.slice(0, 3).map((e) => `+ ${e.label} (player ${e.playerPercentile.toFixed(0)}th, team need ${e.teamNeed.toFixed(0)})`),
    weaknesses: minus.slice(0, 3).map((e) => `- ${e.label} (player ${e.playerPercentile.toFixed(0)}th, team need ${e.teamNeed.toFixed(0)})`),
  };
}

/* -------------------------------------------------------------- translation */

/**
 * G League -> NBA translation factors, measured from players who appeared in BOTH leagues this
 * season. This is ONE season of crossover data: enough to describe what happened, nowhere near
 * enough to predict NBA careers. Ratios are reported with their sample size and dispersion, and
 * the interface labels every estimate exploratory.
 */
export const TRANSLATE_STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'mpg'];
export const TRANSLATE_RATES = ['ts', 'usg', 'astPct', 'orebPct', 'drebPct'];

export function translationFactors(pairs) {
  const out = {};
  const collect = (key, valueOf) => {
    const ratios = pairs.map(({ gl, nba }) => {
      const g = valueOf(gl), n = valueOf(nba);
      return fin(g) && fin(n) && g > 0 ? n / g : null;
    }).filter(fin).sort((a, b) => a - b);
    if (ratios.length < 8) { out[key] = { n: ratios.length, insufficient: true }; return; }
    out[key] = {
      n: ratios.length,
      median: round(quantile(ratios, 0.5), 3),
      p25: round(quantile(ratios, 0.25), 3),
      p75: round(quantile(ratios, 0.75), 3),
    };
  };
  for (const s of TRANSLATE_STATS) collect(s, (p) => p[s]);
  for (const s of TRANSLATE_RATES) collect(s, (p) => p[s]);
  return out;
}

/** Per-36 translation removes the role-size change, which is the largest single confound. */
export function translationFactorsPer36(pairs) {
  const out = {};
  for (const s of ['pts', 'reb', 'ast', 'stl', 'blk']) {
    const ratios = pairs.map(({ gl, nba }) => {
      const g = per36(gl, s), n = per36(nba, s);
      return fin(g) && fin(n) && g > 0 ? n / g : null;
    }).filter(fin).sort((a, b) => a - b);
    out[s] = ratios.length >= 8
      ? { n: ratios.length, median: round(quantile(ratios, 0.5), 3),
          p25: round(quantile(ratios, 0.25), 3), p75: round(quantile(ratios, 0.75), 3) }
      : { n: ratios.length, insufficient: true };
  }
  return out;
}

/** Apply the factors to one G League line, carrying the uncertainty band through. */
export function translate(glPlayer, factors) {
  const est = {};
  for (const s of [...TRANSLATE_STATS, ...TRANSLATE_RATES]) {
    const f = factors[s];
    const v = glPlayer[s];
    if (!f || f.insufficient || !fin(v)) continue;
    est[s] = {
      estimate: round(v * f.median, 2),
      low: round(v * f.p25, 2),
      high: round(v * f.p75, 2),
      basedOn: f.n,
    };
  }
  return est;
}

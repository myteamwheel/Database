// The three grades, their ingredient definitions, coverage accounting and dependency tree.
//
// v3.4 rebuild. The previous model fed derived composites into components that already contained
// the statistics those composites were made from — defensiveDisruptionIndex sat beside STL, BLK,
// DREB%, DefRtg and DEF WS while being built from exactly those; Efficiency Over Expected is a
// TS%-versus-usage residual sitting beside TS% and usage; Impact Over Expected is a PIE residual
// sitting beside PIE. The declared component weights therefore were not the real weights.
//
// Rule now: every ingredient of the headline grade is a primitive or near-primitive statistic,
// and NO statistic appears in more than one place across the whole model. Derived composites
// remain available as descriptive metrics, but never as grade ingredients.
import { round } from './sources.mjs';

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const COMPONENT_WEIGHTS = {
  scoring: 0.30, playmaking: 0.18, rebounding: 0.14,
  defense: 0.16, efficiency: 0.12, impact: 0.10,
};

export const GRADE_ANCHORS = { lo: 30, hi: 80 };
// Measured span of the shrunk weighted robust-z across both 2025-26 leagues is about -2.2 to
// +2.4. These are fixed constants, not the observed extremes, so the scale survives a rebuild.
export const MAGNITUDE_ANCHORS = { lo: -2.2, hi: 2.4 };   // robust z units
export const K_FACTOR = 0.8;

/**
 * Ingredient definitions. `pg` and `p36` name the per-game and per-36 accessors on the
 * normalized row; a single `key` means the statistic is a rate and is basis-independent.
 * `invert` marks statistics where lower is better. `concepts` is the dependency tree: the
 * underlying basketball ideas each ingredient draws on, used to compute effective weights.
 */
export const INGREDIENTS = {
  scoring: [
    // `w` is the ingredient's share of its component. Plain averaging put four volume/role
    // proxies alongside points and left actual scoring at 6.8% of a 30% component.
    { id: 'points',   w: 0.55, pg: 'ptsPG',  p36: 'pts36',  concepts: { scoringVolume: 1 } },
    { id: 'fta',      w: 0.15, pg: 'ftaPG',  p36: 'fta36',  concepts: { rimPressure: 1 } },
    { id: 'fg3a',     w: 0.15, pg: 'fg3aPG', p36: 'fg3a36', concepts: { perimeterVolume: 1 } },
    { id: 'usage',    w: 0.15, key: 'usg',                  concepts: { offensiveRole: 1 } },
  ],
  playmaking: [
    { id: 'assists',  w: 0.50, pg: 'astPG',  p36: 'ast36',  concepts: { playmaking: 1 } },
    { id: 'astPct',   w: 0.20, key: 'astPct',               concepts: { playmaking: 1 } },
    { id: 'astTo',    w: 0.15, key: 'astTo',                concepts: { playmaking: 0.5, ballSecurity: 0.5 } },
    { id: 'astRatio', w: 0.15, key: 'astRatio',             concepts: { playmaking: 1 } },
  ],
  rebounding: [
    { id: 'oreb',     w: 0.25, pg: 'orebPG', p36: 'oreb36', concepts: { offensiveRebounding: 1 } },
    { id: 'dreb',     w: 0.35, pg: 'drebPG', p36: 'dreb36', concepts: { defensiveRebounding: 1 } },
    { id: 'orebPct',  w: 0.18, key: 'orebPct',              concepts: { offensiveRebounding: 1 } },
    { id: 'drebPct',  w: 0.22, key: 'drebPct',              concepts: { defensiveRebounding: 1 } },
  ],
  defense: [
    { id: 'steals',   w: 0.30, pg: 'stlPG',  p36: 'stl36',  concepts: { perimeterDefence: 1 } },
    { id: 'blocks',   w: 0.30, pg: 'blkPG',  p36: 'blk36',  concepts: { rimProtection: 1 } },
    { id: 'defRtg',   w: 0.20, key: 'defRtg', invert: true, concepts: { teamDefensiveContext: 1 } },
    { id: 'defWs',    w: 0.20, pg: 'defWsPG', p36: 'defWs36', concepts: { defensiveValue: 1 } },
  ],
  efficiency: [
    // TS% and eFG% are near-duplicates; eFG% carries a deliberately small share rather than
    // half the component.
    { id: 'ts',       w: 0.45, key: 'ts',                   concepts: { shootingEfficiency: 1 } },
    { id: 'efg',      w: 0.15, key: 'efg',                  concepts: { shootingEfficiency: 1 } },
    { id: 'turnovers', w: 0.25, pg: 'tovPG', p36: 'tov36', invert: true, concepts: { ballSecurity: 1 } },
    { id: 'toRatio',  w: 0.15, key: 'tovPct', invert: true, concepts: { ballSecurity: 1 } },
  ],
  impact: [
    // PIE is itself composed of box-score primitives; that dependency is declared rather than
    // hidden, and it carries only a third of a 10% component.
    { id: 'pie',      w: 0.45, key: 'pie',
      concepts: { scoringVolume: 0.25, defensiveValue: 0.2, playmaking: 0.15,
                  offensiveRebounding: 0.1, defensiveRebounding: 0.1, ballSecurity: 0.1,
                  shootingEfficiency: 0.1 } },
    { id: 'netRtg',   w: 0.30, key: 'netRtg',               concepts: { teamOnCourtContext: 1 } },
    { id: 'plusMinus', w: 0.25, pg: 'pmPG', p36: 'pm36',    concepts: { teamOnCourtContext: 1 } },
  ],
};

/** Minimum ingredients a component needs before its score is trusted. */
export const MIN_COVERAGE = {
  scoring: 3, playmaking: 3, rebounding: 3, defense: 3, efficiency: 3, impact: 2,
};

/** Percentile (0-100) with ties averaged. */
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
 * Robust z-score: (x - median) / (1.4826 * MAD), winsorized at the 1st/99th percentile first.
 * Median and MAD are used instead of mean and SD because a handful of tiny-sample lines would
 * otherwise set the scale for everyone. This is what preserves MAGNITUDE — the distance between
 * 31 and 24 points survives, where a percentile only records that one is ahead of the other.
 */
export function robustZ(values, { weights } = {}) {
  const present = values.map((v, i) => ({ v, w: weights ? weights[i] || 0 : 1 }))
    .filter((x) => fin(x.v));
  if (present.length < 3) return values.map(() => null);
  const sorted = present.map((x) => x.v).sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01), hi = quantile(sorted, 0.99);
  const w = present.map((x) => clamp(x.v, lo, hi)).sort((a, b) => a - b);
  const med = quantile(w, 0.5);
  const devs = w.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = quantile(devs, 0.5) || 1e-9;
  const scale = 1.4826 * mad;
  return values.map((v) => (fin(v) ? (clamp(v, lo, hi) - med) / scale : null));
}

/** Resolve an ingredient's raw value for a normalized row under a given basis. */
export function ingredientValue(ing, row, basis) {
  if (ing.key) return row[ing.key];
  return basis === 'per36' ? row[ing.p36] : row[ing.pg];
}

/**
 * Effective weight of each underlying concept, so composite-on-composite construction cannot
 * hide extra weight. Component weight is split evenly across that component's ingredients, then
 * each ingredient's share is distributed over the concepts it declares.
 */
export function effectiveConceptWeights() {
  const out = {};
  for (const [comp, list] of Object.entries(INGREDIENTS)) {
    const wsum = list.reduce((a, i) => a + (i.w ?? 1 / list.length), 0);
    for (const ing of list) {
      const per = COMPONENT_WEIGHTS[comp] * ((ing.w ?? 1 / list.length) / wsum);
      const total = Object.values(ing.concepts).reduce((a, v) => a + v, 0) || 1;
      for (const [concept, w] of Object.entries(ing.concepts)) {
        out[concept] = (out[concept] || 0) + per * (w / total);
      }
    }
  }
  const sum = Object.values(out).reduce((a, v) => a + v, 0);
  return Object.fromEntries(Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, { weight: round(v, 4), pctOfGrade: round((100 * v) / sum, 2) }]));
}

/** Flat listing of which statistic sits in which component — the dependency tree. */
export function dependencyTree() {
  const tree = {};
  for (const [comp, list] of Object.entries(INGREDIENTS)) {
    tree[comp] = {
      weight: COMPONENT_WEIGHTS[comp],
      minCoverage: MIN_COVERAGE[comp],
      ingredients: list.map((i) => ({
        id: i.id,
        shareOfComponent: round(i.w ?? 1 / list.length, 3),
        shareOfGrade: round(COMPONENT_WEIGHTS[comp] * (i.w ?? 1 / list.length), 4),
        basisDependent: !i.key,
        invert: !!i.invert,
        concepts: i.concepts,
      })),
    };
  }
  return tree;
}

/**
 * Build one grade. `mode` is 'percentile' (relative standing) or 'robust' (magnitude).
 * Returns components, coverage, the shrunk composite and the mapped 0-9.9999 grade.
 */
export function buildGrade(rows, norm, { basis = 'perGame', mode = 'percentile', K } = {}) {
  const mins = norm.map((x) => x.min || 0);
  const sorted = [...mins].sort((a, b) => a - b);
  const medianMin = sorted[Math.floor(sorted.length / 2)] || 1;
  const k = K ?? Math.round(medianMin * K_FACTOR);

  // Transform every ingredient once.
  const transformed = {};
  for (const [comp, list] of Object.entries(INGREDIENTS)) {
    for (const ing of list) {
      const raw = norm.map((r) => {
        const v = ingredientValue(ing, r, basis);
        return fin(v) ? (ing.invert ? -Number(v) : Number(v)) : null;
      });
      transformed[`${comp}.${ing.id}`] = mode === 'robust'
        ? robustZ(raw, { weights: mins })
        : percentiles(raw);
    }
  }

  const components = [];
  const coverage = [];
  for (let i = 0; i < rows.length; i++) {
    const c = {}, cov = {};
    for (const [comp, list] of Object.entries(INGREDIENTS)) {
      let acc = 0, wsum = 0, have = 0;
      for (const ing of list) {
        const v = transformed[`${comp}.${ing.id}`][i];
        if (!fin(v)) continue;
        const w = ing.w ?? 1 / list.length;
        acc += v * w; wsum += w; have++;
      }
      cov[comp] = { have, of: list.length };
      // Renormalised over present ingredients, so a missing one reweights the rest rather than
      // dragging the component toward zero.
      c[comp] = wsum > 0 ? acc / wsum : null;
    }
    components.push(c);
    coverage.push(cov);
  }

  // Composite. A component below its minimum coverage is dropped and its weight redistributed
  // across the components that do qualify, rather than silently averaging a shorter formula.
  const raw = components.map((c, i) => {
    let acc = 0, wsum = 0;
    for (const [comp, w] of Object.entries(COMPONENT_WEIGHTS)) {
      const cv = coverage[i][comp];
      if (c[comp] === null || cv.have < MIN_COVERAGE[comp]) continue;
      acc += c[comp] * w; wsum += w;
    }
    if (wsum === 0) return null;
    return acc / wsum * (mode === 'robust' ? 1 : 1);
  });

  // Reliability shrinkage toward the minutes-weighted league mean.
  const present = raw.map((v, i) => ({ v, m: mins[i] })).filter((x) => fin(x.v));
  const totalMin = present.reduce((a, x) => a + x.m, 0);
  const prior = totalMin > 0
    ? present.reduce((a, x) => a + x.v * x.m, 0) / totalMin
    : (mode === 'robust' ? 0 : 50);
  const shrunk = raw.map((v, i) => (fin(v) ? (mins[i] * v + k * prior) / (mins[i] + k) : null));
  const reliability = mins.map((m) => (100 * m) / (m + k));

  const A = mode === 'robust' ? MAGNITUDE_ANCHORS : GRADE_ANCHORS;
  const grade = shrunk.map((v) => (fin(v)
    ? Number((clamp((v - A.lo) / (A.hi - A.lo), 0, 1) * 9.9999).toFixed(4))
    : null));

  const overallCoverage = coverage.map((cov) => {
    const have = Object.values(cov).reduce((a, x) => a + x.have, 0);
    const of = Object.values(cov).reduce((a, x) => a + x.of, 0);
    return { have, of, pct: round((100 * have) / of, 1) };
  });

  return {
    components: components.map((c) => Object.fromEntries(
      Object.entries(c).map(([k2, v]) => [k2, round(v, mode === 'robust' ? 3 : 1)]))),
    coverage, overallCoverage,
    raw: raw.map((v) => round(v, 3)),
    shrunk: shrunk.map((v) => round(v, 3)),
    grade, reliability: reliability.map((v) => round(v, 1)),
    transformed,
    model: {
      basis, mode, K: k, kFactor: K_FACTOR, medianMinutes: round(medianMin, 1),
      prior: round(prior, 3), anchors: A,
      mapping: mode === 'robust'
        ? `grade = (shrunk weighted robust-z - ${A.lo}) / ${A.hi - A.lo} x 9.9999, clamped. Robust z uses median and 1.4826*MAD after 1st/99th winsorizing, so distances between raw statistics survive instead of collapsing to rank order.`
        : `grade = (shrunk weighted percentile composite - ${A.lo}) / ${A.hi - A.lo} x 9.9999, clamped. Fixed anchors, so a grade is comparable across rebuilds.`,
    },
  };
}

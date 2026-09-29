// Stable historical identities and independently selected, evidence-bounded style analogies.
// No I/O: the builder supplies actual season records and normalized matching coordinates.
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const year = (row) => Number(String(row.season).slice(0, 4));
const sum = (rows, key) => rows.reduce((s, row) => s + Number(row.totals?.[key] || 0), 0);
const round = (v) => Math.round(v * 10) / 10;
const average = (rows, field, key) => {
  const valid = rows.filter((row) => finite(row[field]?.[key]) && row.minutes > 0);
  const weight = valid.reduce((s, row) => s + row.minutes, 0);
  return weight ? valid.reduce((s, row) => s + row.minutes * Number(row[field][key]), 0) / weight : null;
};
const ratio = (rows, numerator, denominator, minimum = 1) => {
  if (!rows.every((row) => finite(row.totals?.[numerator]) && finite(row.totals?.[denominator]))) return null;
  const den = sum(rows, denominator);
  return den >= minimum ? sum(rows, numerator) / den : null;
};

export function aggregateProfile(rows, method = 'highest-exposure-three-year-window') {
  if (!rows.length) return null;
  rows = rows.slice().sort((a, b) => year(a) - year(b));
  const anchor = rows.slice().sort((a, b) => b.minutes - a.minutes || year(b) - year(a))[0];
  const features = {};
  const keys = new Set(rows.flatMap((row) => Object.keys(row.features || {})));
  for (const key of keys) features[key] = average(rows, 'features', key);
  const minutes = rows.reduce((s, row) => s + row.minutes, 0);
  const gp = rows.reduce((s, row) => s + row.gp, 0);
  features.mpg = gp ? minutes / gp : null;
  // Pooled shooting rates use actual makes/attempts, never the average of season percentages.
  for (const [key, num, den, minimum] of [
    ['fg3Pct', 'FG3M', 'FG3A', 50], ['fgPct', 'FGM', 'FGA', 1],
    ['ftPct', 'FTM', 'FTA', 30], ['threeRate', 'FG3A', 'FGA', 1],
    ['ftRate', 'FTA', 'FGA', 1], ['astTo', 'AST', 'TOV', 1],
  ]) features[key] = ratio(rows, num, den, minimum);
  if (rows.every((row) => ['FGA', 'FGM', 'FG3M'].every((key) => finite(row.totals?.[key]))) && sum(rows, 'FGA') > 0) {
    features.efgPct = (sum(rows, 'FGM') + 0.5 * sum(rows, 'FG3M')) / sum(rows, 'FGA');
  }
  // Official TS% is exposure weighted: the G League's one-free-throw rules can make the standard
  // NBA 0.44 formula inappropriate. Do not synthesize a common denominator for different rules.
  const matchFeatures = Object.fromEntries([...new Set(rows.flatMap((row) => Object.keys(row.matchFeatures || {})))]
    .map((key) => [key, average(rows, 'matchFeatures', key)]));
  const seasons = rows.map((row) => row.season);
  const season = seasons.length === 1 ? seasons[0] : `${seasons[0]}–${seasons.at(-1)}`;
  return {
    ...anchor, season, gp, minutes, features, matchFeatures,
    age: rows.reduce((s, row) => s + (finite(row.age) ? row.age * row.minutes : 0), 0) / minutes,
    referenceProfile: {
      method, seasons, games: gp, minutes: round(minutes), seasonCount: seasons.length,
      period: season, limited: seasons.length < 2, teamBasis: 'team in highest-minute season of reference period',
      aggregation: 'per-minute and advanced rates weighted by minutes; shooting percentages pooled from attempts; matching coordinates standardized within each source season before pooling',
    },
  };
}

export function stableReferenceProfiles(rows, minimumMinutes = 300) {
  const byPlayer = new Map();
  for (const row of rows) {
    if (row.minutes < minimumMinutes || !/[A-Za-z]/.test(String(row.name || ''))) continue;
    if (!byPlayer.has(row.playerId)) byPlayer.set(row.playerId, []);
    byPlayer.get(row.playerId).push(row);
  }
  return [...byPlayer.values()].map((seasons) => {
    seasons.sort((a, b) => year(a) - year(b));
    // The same period is used for this person for every target. Choosing their closest season
    // separately for each target creates an outlier identity and rewards long-career cherry-picking.
    const windows = seasons.map((start) => seasons.filter((row) => year(row) >= year(start) && year(row) < year(start) + 3));
    const best = windows.sort((a, b) => {
      const countDiff = Math.min(b.length, 2) - Math.min(a.length, 2);
      if (countDiff) return countDiff;
      return b.reduce((s, row) => s + row.minutes, 0) - a.reduce((s, row) => s + row.minutes, 0)
        || year(b.at(-1)) - year(a.at(-1));
    })[0];
    return aggregateProfile(best);
  });
}

export function historicalFallback(playerId, rows, minimumMinutes = 300, targetSeason = '2025-26') {
  const prior = rows.filter((row) => String(row.playerId) === String(playerId)
    && year(row) < Number(targetSeason.slice(0, 4)) && row.minutes >= minimumMinutes)
    .sort((a, b) => year(b) - year(a));
  if (!prior.length) return null;
  const latest = year(prior[0]);
  const chosen = prior.filter((row) => year(row) >= latest - 2);
  const result = aggregateProfile(chosen, 'latest-meaningful-three-year-window');
  result.targetBasis = 'historical-fallback';
  result.targetSourceSeasons = result.referenceProfile.seasons;
  result.targetHistoryNote = `Historical profile from ${result.season}. No ${targetSeason} playing sample is used; these are recorded past rates, not current-season statistics or a return-to-play forecast.`;
  return result;
}

const TRAITS = {
  physical: { label: 'Size', axes: { height: 2.5, weight: 20, wingspan: 3, standingReach: 3 }, minimumAxes: 2 },
  role: { label: 'Passing and role', axes: { ast36: 2, astPct: 0.075, usg: 0.07, tov36: 1.5 }, minimumAxes: 3 },
  scoring: { label: 'Scoring approach', axes: { threeRate: 0.13, ftRate: 0.14, pts36: 6, fga36: 5, fg3Pct: 0.07 }, minimumAxes: 3 },
  defense: { label: 'Rebounding and disruption', axes: { dreb36: 2.2, oreb36: 1.3, stl36: 0.55, blk36: 0.8 }, minimumAxes: 3 },
};
const join = (items) => items.length < 2 ? items[0] || '' : items.length === 2
  ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
const possessive = (name) => /s$/i.test(name) ? `${name}'` : `${name}'s`;
function positionLabel(target) {
  const pos = String(target.position || '').toUpperCase();
  return pos.includes('C') ? (pos.includes('F') ? 'big man' : 'center')
    : pos.includes('G') ? (pos.includes('F') ? 'wing' : 'guard') : pos.includes('F') ? 'forward' : 'player';
}

function traitDescription(block, target, candidate) {
  const t = target.features, c = candidate.features;
  const both = (key, threshold) => [t, c].every((x) => finite(x[key]) && x[key] >= threshold);
  const below = (key, threshold) => [t, c].every((x) => finite(x[key]) && x[key] < threshold);
  if (block === 'physical') return 'size and build';
  if (block === 'role') {
    if (both('ast36', 6)) return 'offense-running passing role';
    if (both('ast36', 3.5)) return 'secondary playmaking';
    if (below('usg', 0.19)) return 'supporting role on offense';
    if (both('usg', 0.27)) return 'heavy scoring responsibility';
    return 'mix of scoring and passing responsibilities';
  }
  if (block === 'scoring') {
    if (both('threeRate', 0.50)) return 'three-point-heavy shot selection';
    if (both('threeRate', 0.38)) return 'perimeter-oriented scoring mix';
    if (both('ftRate', 0.4)) return 'frequent trips to the foul line';
    if (below('threeRate', 0.15)) return 'two-point-focused scoring';
    return 'balance of two-point and three-point attempts';
  }
  if (both('blk36', 1.5)) return 'shot-blocking presence';
  if (both('dreb36', 7)) return 'work on the defensive glass';
  if (both('oreb36', 2.5)) return 'offensive rebounding';
  if (both('stl36', 1.5)) return 'knack for collecting steals';
  // A similarly low steals/blocks line is not a recognizable defensive skill.
  return null;
}

export function independentStyleRead(target, profiles, blend = []) {
  const references = {};
  for (const [block, spec] of Object.entries(TRAITS)) {
    const physical = block === 'physical';
    const targetValues = physical ? target.physical : target.features;
    const options = [];
    for (const cand of profiles) {
      if (cand.playerId === target.playerId || cand.referenceProfile?.seasonCount < 2) continue;
      const values = physical ? cand.physical : cand.features;
      const axes = Object.entries(spec.axes).filter(([key]) => finite(targetValues?.[key]) && finite(values?.[key]));
      if (axes.length < spec.minimumAxes) continue;
      const evidence = axes.map(([key, scale]) => ({ key, target: targetValues[key], reference: values[key], gap: Math.abs(targetValues[key] - values[key]) / scale }));
      const meanError = evidence.reduce((s, axis) => s + axis.gap ** 2, 0) / evidence.length;
      const coveragePenalty = 0.15 * (1 - axes.length / Object.keys(spec.axes).length);
      const distance = Math.sqrt(meanError) + coveragePenalty;
      const fit = 100 * Math.exp(-0.72 * distance ** 1.55);
      if (fit < 55 || evidence.some((axis) => axis.gap > 2.5)) continue;
      const phrase = traitDescription(block, target, cand);
      if (!phrase) continue;
      options.push({ cand, fit, phrase, evidence });
    }
    const best = options.sort((a, b) => b.fit - a.fit || b.cand.minutes - a.cand.minutes)[0];
    if (!best) continue;
    references[block] = {
      playerId: best.cand.playerId, name: best.cand.name, season: best.cand.season,
      referencePeriod: best.cand.referenceProfile, fit: round(best.fit), phrase: best.phrase,
      axes: best.evidence.map((axis) => axis.key),
      evidence: best.evidence.map((axis) => ({ ...axis, gap: round(axis.gap) })),
    };
  }
  // Passing and scoring describe the job; size/rebounding provide a third recognizable anchor.
  // References are selected independently, then grouped by person for concise prose/cards.
  const selected = new Map();
  const order = ['role', 'scoring', 'physical', 'defense'];
  for (const key of order) {
    const ref = references[key];
    if (!ref) continue;
    if (!selected.has(ref.playerId) && selected.size >= 3) continue;
    if (!selected.has(ref.playerId)) selected.set(ref.playerId, {
      playerId: ref.playerId, name: ref.name, season: ref.season, referencePeriod: ref.referencePeriod,
      fit: ref.fit, phrases: [], evidence: [], narrativeOrder: order.indexOf(key),
    });
    const item = selected.get(ref.playerId);
    item.phrases.push(ref.phrase);
    item.evidence.push(key);
  }
  const components = [...selected.values()].map(({ phrases, ...item }) => ({ ...item, phrase: join(phrases) }));
  const position = positionLabel(target);
  const f = target.features;
  let introduction;
  if (finite(f.ast36) && f.ast36 >= 6) introduction = `${target.name} is a ${position} who sets up teammates as well as scoring.`;
  else if (finite(f.threeRate) && f.threeRate >= 0.5) introduction = `${target.name} is a ${position} whose scoring leans heavily on threes.`;
  else if (finite(f.threeRate) && f.threeRate < 0.15 && finite(f.reb36) && f.reb36 >= 9) introduction = `${target.name} is a ${position} focused on two-point scoring and rebounding.`;
  else if (finite(f.usg) && f.usg >= 0.27) introduction = `${target.name} is a ${position} with a large scoring workload.`;
  else if (finite(f.usg) && f.usg < 0.19) introduction = `${target.name} fills a supporting role as a ${position}.`;
  else introduction = `${target.name} is a ${position} with a balanced offensive role.`;
  const analogies = components.map((item) => `${possessive(item.name)} ${item.phrase}`);
  const text = analogies.length ? `${introduction} Think ${join(analogies)}.`
    : `${introduction} There is not enough shared evidence for a useful named style reference.`;
  return {
    text, references, components, position,
    selectionMethod: 'independent trait search across stable same-league historical profiles; unrelated to blend shares',
    blend: blend.map((item) => `${item.name} ${item.share}%`).join(', '),
    caveat: 'References describe statistical tendencies, not equal talent. Steals, blocks and rebounds do not measure complete defense; athleticism and strength are not inferred.',
  };
}

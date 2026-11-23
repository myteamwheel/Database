// Stable historical identities and independently selected, evidence-bounded style analogies.
// No I/O: the builder supplies actual season records and normalized matching coordinates.
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
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
  const identity = `${rows[0].league}|${rows[0].playerId}`;
  const seen = new Set();
  for (const row of rows) {
    if (`${row.league}|${row.playerId}` !== identity || !/^\d{4}-\d{2}$/.test(row.season)
      || !finite(row.minutes) || row.minutes <= 0 || !finite(row.gp) || row.gp <= 0 || seen.has(row.season)) {
      throw new Error('Reference aggregation requires one valid row per season for the same player and league');
    }
    seen.add(row.season);
  }
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
  features.efgPct = null;
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
    // Unknown ages do not count as zero-year-old seasons in the exposure denominator.
    age: average(rows.map(row => ({ ...row, ageValue: { age: row.age } })), 'ageValue', 'age'),
    referenceProfile: {
      method, seasons, games: gp, minutes: round(minutes), seasonCount: seasons.length,
      period: season, limited: seasons.length < 2, teamBasis: 'team in highest-minute season of reference period',
      aggregation: 'per-minute and advanced rates weighted by minutes; shooting percentages pooled from attempts; matching coordinates standardized within each source season before pooling',
    },
  };
}

export function stableReferenceProfiles(rows, minimumMinutes = 300) {
  const byPlayer = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (!finite(row.minutes) || row.minutes < minimumMinutes || !finite(row.gp) || row.gp <= 0 || !/[A-Za-z]/.test(String(row.name || ''))) continue;
    const key = `${row.league}|${row.playerId}`;
    const rowKey = `${key}|${row.season}`;
    if (seen.has(rowKey)) throw new Error(`Duplicate reference player-season: ${rowKey}`);
    seen.add(rowKey);
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key).push(row);
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

function traitDescription(block, target, candidate, evidence) {
  const t = target.features, c = candidate.features;
  const close = (...keys) => keys.every(key => evidence.some(axis => axis.key === key && axis.gap <= .85));
  const atLeast = (key, n) => close(key) && t[key] >= n && c[key] >= n;
  const below = (key, n) => close(key) && t[key] < n && c[key] < n;
  if (block === 'physical') return close('height', 'weight') ? 'size and build' : null;
  if (block === 'role') {
    if (atLeast('ast36', 6) && (close('astPct') || close('usg'))) return 'lead playmaking';
    if (atLeast('ast36', 3.5) && t.ast36 < 6 && c.ast36 < 6) return 'secondary playmaking';
    if (atLeast('usg', 0.27)) return 'heavy scoring workload';
    if (below('usg', 0.19)) return 'low-usage offensive role';
    return null;
  }
  if (block === 'scoring') {
    if (atLeast('threeRate', .50)) return 'three-point-heavy shot selection';
    if (below('threeRate', .18) && atLeast('ftRate', .35)) return 'two-point attack and frequent free throws';
    if (below('threeRate', .18)) return 'two-point-heavy shot selection';
    if (atLeast('ftRate', .40)) return 'frequent trips to the line';
    if (atLeast('threeRate', .38)) return 'perimeter-oriented shot selection';
    return null;
  }
  if (atLeast('blk36', 1.5)) return 'shot blocking';
  if (atLeast('dreb36', 7)) return 'defensive rebounding';
  if (atLeast('oreb36', 2.5)) return 'offensive rebounding';
  if (atLeast('stl36', 1.5)) return 'steal production';
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
      const heightGap = finite(target.physical?.height) && finite(cand.physical?.height)
        ? Math.abs(target.physical.height - cand.physical.height) : 0;
      // A rate can match across positions. Prefer a similarly sized role when the evidence is close.
      const roleContext = block === 'role' ? .09 * Math.max(0, heightGap - 2) : 0;
      const distance = Math.sqrt(meanError) + coveragePenalty + roleContext;
      const fit = 100 * Math.exp(-0.72 * distance ** 1.55);
      if (fit < 55 || evidence.some((axis) => axis.gap > 2.5)) continue;
      const phrase = traitDescription(block, target, cand, evidence);
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
  const order = ['role', 'scoring', 'defense', 'physical'];
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
  else introduction = `${target.name} is a ${position}${finite(f.ast36) && f.ast36 >= 3.5 ? ' who can share the playmaking' : finite(f.dreb36) && f.dreb36 >= 7 ? ' who contributes on the defensive glass' : ''}.`;
  const analogies = components.map((item) => `${possessive(item.name)} ${item.phrase}`);
  const lead = analogies.shift();
  const example = analogies.length ? `${lead}, with ${join(analogies)}` : lead;
  const text = example ? `${introduction} Think ${example}.`
    : introduction;
  return {
    text, references, components, position,
    selectionMethod: 'independent trait search across stable same-league historical profiles; unrelated to blend shares',
    blend: blend.map((item) => `${item.name} ${item.share}%`).join(', '),
    caveat: 'References describe statistical tendencies, not equal talent. Steals, blocks and rebounds do not measure complete defense; athleticism and strength are not inferred.',
  };
}

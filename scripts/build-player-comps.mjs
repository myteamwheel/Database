// Historical player-comparison engine.
//
// Builds top-three same-league comps for every current database player from the committed
// projection history: NBA 2009-10..2025-26 and G League 2014-15..2025-26.
//
// Design rules:
//   1. Physical profile is a compatibility screen, not a second vote for playing style.
//   2. Position is NOT a hard gate. A guard and wing can compare if their bodies/roles actually match.
//   3. Production, role, shooting mix and defensive activity then refine the match.
//   4. Missing measurements are never invented. Block weights renormalise over available evidence,
//      while missing physical coverage carries an explicit penalty so "unknown size" cannot beat a
//      genuinely close measured match by accident.
//   5. Current-season deep style axes are displayed when both records have them but do not enter the
//      historical rank: otherwise 2025-26 candidates would be scored on a different feature set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableReferenceProfiles, independentStyleRead } from './lib/comparison-profiles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = process.env.COMPS_DATA_PATH || path.join(ROOT, 'public/data.json');
const INPUTS_PATH = path.join(ROOT, 'scripts/data/projection/inputs.json');
const COMBINE_PATH = path.join(ROOT, 'scripts/data/combine_anthro.json');

const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const n = (v) => fin(v) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => fin(v) ? Math.round(Number(v) * 10) / 10 : null;
const r2 = (v) => fin(v) ? Math.round(Number(v) * 100) / 100 : null;
const r3 = (v) => fin(v) ? Math.round(Number(v) * 1000) / 1000 : null;
const rowsOf = (t) => (t?.rows || []).map((row) => Object.fromEntries((t.headers || []).map((h, i) => [h, row[i]])));
const inches = (h) => {
  if (fin(h)) return Number(h);
  const m = String(h || '').trim().match(/^(\d+)-(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);
  const q = String(h || '').match(/(\d+)['’]\s*(\d+(?:\.\d+)?)/);
  return q ? Number(q[1]) * 12 + Number(q[2]) : null;
};
const per36 = (total, minutes) => fin(total) && fin(minutes) && Number(minutes) > 0 ? Number(total) * 36 / Number(minutes) : null;

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const inputs = JSON.parse(fs.readFileSync(INPUTS_PATH, 'utf8'));

const bio = new Map();
const addBio = (x) => bio.set(Number(x.PERSON_ID), {
  playerId: Number(x.PERSON_ID),
  name: [x.PLAYER_FIRST_NAME, x.PLAYER_LAST_NAME].filter(Boolean).join(' ').trim(),
  position: x.POSITION || null,
  height: inches(x.HEIGHT),
  weight: n(x.WEIGHT),
});
rowsOf(inputs.playerIndex).forEach(addBio);
rowsOf(inputs.rosters2627).forEach((x) => { if (!bio.has(Number(x.PERSON_ID))) addBio(x); });

// Current site records fill G League/current-player physical gaps that the NBA player index does not
// cover. This never backfills an old season with a made-up body; it only supplies known listed bio
// information for that actual person.
for (const lg of ['NBA', 'GLEAGUE']) {
  for (const p of data.leagues?.[lg] || []) {
    const pid = Number(p.nbaPersonId ?? p.playerId);
    if (!pid) continue;
    const old = bio.get(pid) || { playerId: pid, name: p.name || String(pid) };
    bio.set(pid, {
      ...old,
      name: old.name || p.name || String(pid),
      position: old.position || p.position || null,
      height: old.height ?? n(p.heightInches) ?? inches(p.height),
      weight: old.weight ?? n(p.weight),
    });
  }
}

const combine = new Map();
if (fs.existsSync(COMBINE_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(COMBINE_PATH, 'utf8'));
    for (const x of raw.rows || []) {
      const pid = Number(x.playerId ?? x.PLAYER_ID);
      if (!pid) continue;
      combine.set(pid, {
        wingspan: n(x.wingspanInches ?? x.WINGSPAN),
        standingReach: n(x.standingReachInches ?? x.STANDING_REACH),
        heightNoShoes: n(x.heightNoShoesInches ?? x.HEIGHT_WO_SHOES),
        combineWeight: n(x.weight ?? x.WEIGHT),
      });
    }
  } catch (e) {
    console.warn('player comps: combine data ignored:', e.message);
  }
}

function historyRows(src, league) {
  const out = [];
  for (const [season, tables] of Object.entries(src || {})) {
    const adv = new Map(rowsOf(tables.adv).map((x) => [Number(x.PLAYER_ID), x]));
    for (const x of rowsOf(tables.base)) {
      const pid = Number(x.PLAYER_ID), minutes = n(x.MIN), gp = n(x.GP);
      if (!pid || !fin(minutes) || minutes <= 0 || !fin(gp) || gp <= 0) continue;
      const a = adv.get(pid) || {};
      const b = bio.get(pid) || {};
      const c = combine.get(pid) || {};
      const fga = n(x.FGA), fg3a = n(x.FG3A), fta = n(x.FTA), fg3m = n(x.FG3M), fgm = n(x.FGM);
      const ftm = n(x.FTM), pts = n(x.PTS), poss = n(a.POSS);
      const ts = fin(a.TS_PCT) ? Number(a.TS_PCT)
        : fin(pts) && fin(fga) && fin(fta) && (fga + 0.44 * fta) > 0 ? pts / (2 * (fga + 0.44 * fta)) : null;
      out.push({
        league, season, seasonType: 'Regular Season', playerId: String(pid), nbaPersonId: pid, name: x.PLAYER_NAME || b.name || null,
        team: x.TEAM_ABBREVIATION || null, teamId: n(x.TEAM_ID), position: b.position || null,
        age: n(x.AGE), gp, minutes,
        totals: Object.fromEntries(['FGA', 'FGM', 'FG3A', 'FG3M', 'FTA', 'FTM', 'PTS', 'AST', 'TOV']
          .map((key) => [key, n(x[key])])),
        physical: {
          height: b.height ?? c.heightNoShoes ?? null,
          weight: b.weight ?? c.combineWeight ?? null,
          wingspan: c.wingspan ?? null,
          standingReach: c.standingReach ?? null,
        },
        features: {
          mpg: minutes / gp,
          usg: n(a.USG_PCT),
          pts36: per36(pts, minutes),
          fga36: per36(fga, minutes),
          threeA36: per36(fg3a, minutes),
          fta36: per36(fta, minutes),
          reb36: per36(n(x.REB), minutes),
          ast36: per36(n(x.AST), minutes),
          stl36: per36(n(x.STL), minutes),
          blk36: per36(n(x.BLK), minutes),
          tov36: per36(n(x.TOV), minutes),
          pf36: per36(n(x.PF), minutes),
          plusMinus36: per36(n(x.PLUS_MINUS), minutes),
          oreb36: per36(n(x.OREB), minutes),
          dreb36: per36(n(x.DREB), minutes),
          threeRate: fin(fga) && fga > 0 && fin(fg3a) ? fg3a / fga : null,
          ftRate: fin(fga) && fga > 0 && fin(fta) ? fta / fga : null,
          fg3Pct: fin(fg3a) && fg3a >= 15 && fin(fg3m) ? fg3m / fg3a : null,
          fgPct: fin(fga) && fga > 0 && fin(fgm) ? fgm / fga : null,
          efgPct: fin(fga) && fga > 0 && fin(fgm) && fin(fg3m) ? (fgm + 0.5 * fg3m) / fga : null,
          ftPct: fin(fta) && fta >= 10 && fin(ftm) ? ftm / fta : null,
          ts,
          astPct: n(a.AST_PCT),
          astTo: n(a.AST_TO) ?? (fin(x.AST) && fin(x.TOV) && Number(x.TOV) > 0 ? Number(x.AST) / Number(x.TOV) : null),
          astRatio: n(a.AST_RATIO),
          orebPct: n(a.OREB_PCT),
          drebPct: n(a.DREB_PCT),
          rebPct: n(a.REB_PCT),
          offRtg: n(a.OFF_RATING),
          defRtg: n(a.DEF_RATING),
          netRtg: n(a.NET_RATING),
          tmTovPct: n(a.TM_TOV_PCT),
          pie: n(a.PIE),
          pace: n(a.PACE),
          poss,
        },
      });
    }
  }
  return out;
}

const histories = {
  NBA: historyRows(inputs.nba, 'NBA'),
  GLEAGUE: historyRows(inputs.gleague, 'GLEAGUE'),
};

// Current 2025-26 records have extra shot-style/tracking information. Attach a small common overlay
// so two current-season players can be distinguished more precisely without pretending old seasons
// had the same tracking coverage.
const currentByLeaguePid = {};
for (const lg of ['NBA', 'GLEAGUE']) {
  currentByLeaguePid[lg] = new Map((data.leagues?.[lg] || []).map((p) => [String(p.nbaPersonId ?? p.playerId), p]));
}
function deepOverlay(p) {
  const s = p?.skillProfile || {};
  const st = p?.stats || {};
  const cu = p?.custom || {};
  return {
    selfCreation: n(s.selfCreation), paintScoring: n(s.paintScoring), rimPressure: n(s.rimPressure),
    threeVolume: n(s.threeVolume), threeAccuracy: n(s.threeAccuracy), shootingEff: n(s.shootingEff),
    playmaking: n(s.playmaking), assistRate: n(s.assistRate), ballSecurity: n(s.ballSecurity),
    offRebounding: n(s.offRebounding), defRebounding: n(s.defRebounding),
    steals: n(s.steals), rimProtection: n(s.rimProtection), usagePctile: n(s.usage),
    // Direct current-season shot-shape signals. These answer "where/how does he shoot?" much more
    // literally than a generic efficiency number: paint share, mid-range share, catch-and-shoot
    // volume and pull-up volume. They are only used when both players actually carry the field.
    pctPtsPaint: n(st.oscore_pct_pts_paint),
    pctPtsMidrange: n(st.oscore_pct_pts_2pt_mr),
    catchShootFga: n(st.trk_catchshoot_catch_shoot_fga),
    pullUpFga: n(st.trk_pullup_pull_up_fga),
    paintPts36: n(cu.paintPts36Raw ?? cu.paintPts36),
    selfCreatedPts36: n(cu.selfCreatedPts36Raw ?? cu.selfCreatedPts36),
    shotLocationValue: n(cu.shotLocationValue),
  };
}

const BLOCKS = {
  physical: {
    // Size matters, but the old 46% weight let a near-identical body overwhelm a different job.
    // Twenty percent keeps obviously incompatible bodies apart while leaving most of the match to
    // role, creation, shot diet and defensive activity.
    weight: 0.20,
    axes: {
      height: { scale: 2.5, weight: 1.25, label: 'height' },
      weight: { scale: 18, weight: 1.0, label: 'weight' },
      wingspan: { scale: 3.0, weight: 1.45, label: 'wingspan' },
      standingReach: { scale: 3.0, weight: 1.0, label: 'standing reach' },
    },
  },
  role: {
    // Archetype/role block: creation load, shot volume, playmaking and rebounding shape.
    weight: 0.35,
    axes: {
      mpg: { scale: 5, weight: 0.45, label: 'minutes/role' },
      usg: { scale: 0.055, weight: 1.0, label: 'usage' },
      fga36: { scale: 3.5, weight: 0.75, label: 'shot volume' },
      ast36: { scale: 2.3, weight: 0.9, label: 'playmaking volume' },
      reb36: { scale: 3.2, weight: 0.65, label: 'rebounding role' },
      tov36: { scale: 1.2, weight: 0.45, label: 'turnover load' },
      astPct: { scale: 0.075, weight: 0.45, label: 'assist rate' },
      astTo: { scale: 1.1, weight: 0.25, label: 'assist-to-turnover profile' },
      astRatio: { scale: 6, weight: 0.18, label: 'assist ratio' },
      tmTovPct: { scale: 0.045, weight: 0.18, label: 'team-turnover share context' },
      rebPct: { scale: 0.055, weight: 0.30, label: 'total rebounding rate' },
    },
  },
  scoring: {
    weight: 0.30,
    axes: {
      pts36: { scale: 5.5, weight: 1.0, label: 'scoring rate' },
      ts: { scale: 0.045, weight: 0.8, label: 'true shooting' },
      threeRate: { scale: 0.12, weight: 0.9, label: 'three-point shot share' },
      fg3Pct: { scale: 0.055, weight: 0.45, label: 'three-point accuracy' },
      ftRate: { scale: 0.13, weight: 0.7, label: 'free-throw pressure' },
      fta36: { scale: 2.5, weight: 0.5, label: 'free-throw volume' },
      efgPct: { scale: 0.045, weight: 0.45, label: 'effective field-goal percentage' },
      ftPct: { scale: 0.085, weight: 0.15, label: 'free-throw accuracy' },
    },
  },
  defense: {
    weight: 0.15,
    axes: {
      stl36: { scale: 0.45, weight: 0.8, label: 'steal activity' },
      blk36: { scale: 0.65, weight: 0.9, label: 'shot blocking' },
      drebPct: { scale: 0.055, weight: 0.65, label: 'defensive rebounding' },
      orebPct: { scale: 0.045, weight: 0.35, label: 'offensive rebounding' },
      pf36: { scale: 1.4, weight: 0.12, label: 'foul activity' },
    },
  },
};

// Similarity uses context-adjusted profiles while every side-by-side value remains the published
// raw statistic. Volume rates are converted from per-36 to per-100 possessions using player-season
// pace, then centered/scaled within league-season so comparisons reflect a player's role relative
// to that era rather than rule/tempo inflation. Reliability shrinkage pulls short samples toward
// their own league-season median before standardizing; it never fills a missing feature.
const MATCH_PRIOR = { mpg: 20, default: 240 };
const PACE_RATE_AXES = new Set(['pts36', 'fga36', 'threeA36', 'fta36', 'reb36', 'ast36', 'stl36', 'blk36', 'tov36', 'pf36', 'plusMinus36', 'oreb36', 'dreb36']);
const MATCH_AXES = Object.entries(BLOCKS).filter(([block]) => block !== 'physical')
  .flatMap(([, spec]) => Object.entries(spec.axes).map(([key, axis]) => ({ key, axis })));
const weightedMedian = (values) => {
  const rows = values.filter((x) => fin(x.value) && x.weight > 0).sort((a, b) => a.value - b.value);
  const total = rows.reduce((s, x) => s + x.weight, 0);
  if (!total) return null;
  let n = 0;
  for (const x of rows) { n += x.weight; if (n >= total / 2) return x.value; }
  return rows[rows.length - 1]?.value ?? null;
};
const featureExposure = (row, key) => key === 'mpg' ? Number(row.gp || 0) : Number(row.minutes || 0);
function matchRawValue(row, key) {
  const value = row.features?.[key];
  if (!fin(value)) return null;
  if (PACE_RATE_AXES.has(key) && fin(row.features?.pace) && Number(row.features.pace) > 0) {
    return Number(value) * 48 / Number(row.features.pace);
  }
  return Number(value);
}
function prepareMatchProfiles(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.league}|${row.season}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const distributions = new Map();
  for (const [season, group] of groups) {
    const stats = {};
    for (const { key } of MATCH_AXES) {
      const values = group.map((row) => ({ value: matchRawValue(row, key), weight: featureExposure(row, key) }))
        .filter((x) => fin(x.value) && x.weight > 0);
      const median = weightedMedian(values);
      const robust = weightedMedian(values.map((x) => ({ value: Math.abs(x.value - median), weight: x.weight }))) * 1.4826;
      const totalWeight = values.reduce((s, x) => s + x.weight, 0);
      const mean = totalWeight ? values.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight : median;
      const variance = totalWeight ? values.reduce((s, x) => s + x.weight * (x.value - mean) ** 2, 0) / totalWeight : 0;
      stats[key] = { median, scale: robust > 1e-9 ? robust : Math.sqrt(variance) || 1 };
    }
    distributions.set(season, stats);
    for (const row of group) row.matchFeatures = normalizeMatchFeatures(row, stats);
  }
  return distributions;
}
function normalizeMatchFeatures(row, stats) {
  const out = {};
  for (const { key, axis } of MATCH_AXES) {
    const value = matchRawValue(row, key), center = stats?.[key]?.median, scale = stats?.[key]?.scale;
    if (!fin(value) || !fin(center) || !fin(scale) || scale <= 0) { out[key] = null; continue; }
    const exposure = featureExposure(row, key);
    const prior = MATCH_PRIOR[key] ?? MATCH_PRIOR.default;
    const reliability = exposure / (exposure + prior);
    const shrunk = center + reliability * (value - center);
    out[key] = clamp((shrunk - center) / scale, -4, 4) * axis.scale;
  }
  return out;
}


const NBA_EQ_MIN_MINUTES = 150;
// NBA-equivalent comps translate the G League target into NBA statistical space before matching.
// MPG is deliberately excluded: G League role size is not an NBA role forecast.
const NBA_EQ_VOLUME_AXES = new Set([
  'pts36','fga36','threeA36','fta36','reb36','ast36','stl36','blk36','tov36','pf36','oreb36','dreb36',
]);
const NBA_EQ_EXTRA_AXES = ['threeA36','oreb36','dreb36','fgPct'];
const NBA_EQ_KEYS = [...new Set([...MATCH_AXES.map(({ key }) => key), ...NBA_EQ_EXTRA_AXES])].filter((key) => key !== 'mpg');
const median = (values) => {
  const x = values.filter(fin).map(Number).sort((a, b) => a - b);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};
function translationSummary(values, mode) {
  const x = values.filter(fin).map(Number);
  if (x.length < 10) return null;
  return mode === 'ratio'
    ? { mode, n: x.length, factor: median(x) }
    : { mode, n: x.length, delta: median(x) };
}
function applyTranslation(value, rule) {
  if (!fin(value) || !rule) return null;
  return rule.mode === 'ratio' ? Number(value) * Number(rule.factor) : Number(value) + Number(rule.delta);
}
function buildNbaEquivalentTranslation(nbaRows, glRows) {
  const gl = new Map(glRows
    .filter((row) => row.season !== '2025-26' && row.minutes >= NBA_EQ_MIN_MINUTES)
    .map((row) => [`${row.season}|${row.playerId}`, row]));
  const pairs = nbaRows
    .filter((row) => row.season !== '2025-26' && row.minutes >= NBA_EQ_MIN_MINUTES)
    .map((nba) => ({ nba, gl: gl.get(`${nba.season}|${nba.playerId}`) }))
    .filter((x) => x.gl);
  const rules = {};
  for (const key of NBA_EQ_KEYS) {
    const mode = NBA_EQ_VOLUME_AXES.has(key) ? 'ratio' : 'difference';
    const raw = [], match = [];
    for (const pair of pairs) {
      const gv = pair.gl.features?.[key], nv = pair.nba.features?.[key];
      if (fin(gv) && fin(nv) && (mode !== 'ratio' || Math.abs(Number(gv)) > 0.05)) {
        raw.push(mode === 'ratio' ? Number(nv) / Number(gv) : Number(nv) - Number(gv));
      }
      const gm = matchRawValue(pair.gl, key), nm = matchRawValue(pair.nba, key);
      if (fin(gm) && fin(nm) && (mode !== 'ratio' || Math.abs(Number(gm)) > 0.05)) {
        match.push(mode === 'ratio' ? Number(nm) / Number(gm) : Number(nm) - Number(gm));
      }
    }
    rules[key] = { raw: translationSummary(raw, mode), match: translationSummary(match, mode) };
  }
  return {
    method: 'same-player same-season historical G League-to-NBA median translation',
    pairCount: pairs.length,
    minimumMinutesEachLeague: NBA_EQ_MIN_MINUTES,
    trainingThrough: '2024-25',
    mpgExcluded: true,
    rules,
  };
}
function nbaEquivalentTarget(p, source, translation, nbaSeasonStats) {
  const features = Object.fromEntries(Object.keys(source.features || {}).map((key) => [key, null]));
  for (const key of NBA_EQ_KEYS) features[key] = applyTranslation(source.features?.[key], translation.rules?.[key]?.raw);
  features.mpg = null;
  const target = {
    ...source,
    league: 'NBA',
    seasonType: 'NBA-equivalent translation of ' + (source.season || 'G League') + ' G League production',
    name: p.name,
    features,
    targetBasis: 'gleague-to-nba-equivalent',
    targetSourceSeasons: source.targetSourceSeasons || [source.season],
    targetHistoryNote: source.targetHistoryNote || 'G League production is translated into NBA statistical space using prior same-season crossover players. Listed body measurements are unchanged. NBA role/minutes are not projected and MPG is excluded from the match.',
  };
  const out = {};
  for (const { key, axis } of MATCH_AXES) {
    if (key === 'mpg') { out[key] = null; continue; }
    const value = applyTranslation(matchRawValue(source, key), translation.rules?.[key]?.match);
    const center = nbaSeasonStats?.[key]?.median, scale = nbaSeasonStats?.[key]?.scale;
    if (!fin(value) || !fin(center) || !fin(scale) || scale <= 0) { out[key] = null; continue; }
    const exposure = featureExposure(source, key);
    const prior = MATCH_PRIOR[key] ?? MATCH_PRIOR.default;
    const reliability = exposure / (exposure + prior);
    const shrunk = center + reliability * (value - center);
    out[key] = clamp((shrunk - center) / scale, -4, 4) * axis.scale;
  }
  target.matchFeatures = out;
  return target;
}

function blockDistance(target, cand, spec, targetPhysical = false) {
  let acc = 0, w = 0, avail = 0, possible = 0;
  const detail = [];
  for (const [key, a] of Object.entries(spec.axes)) {
    possible += a.weight;
    const x = target[key], y = cand[key];
    if (!fin(x) || !fin(y)) continue;
    avail += a.weight;
    const z = Math.abs(Number(x) - Number(y)) / a.scale;
    const capped = Math.min(z, 4);
    acc += a.weight * capped * capped;
    w += a.weight;
    detail.push({ key, label: a.label, gap: Math.abs(Number(x) - Number(y)), z });
  }
  if (!w) return { distance: null, coverage: 0, detail: [] };
  let distance = Math.sqrt(acc / w);
  // Missing body data is materially worse than missing one style statistic because size is the
  // first screen requested for this product.
  const coverage = possible ? avail / possible : 0;
  if (targetPhysical) distance *= 1 + (1 - coverage) * 0.75;
  return { distance, coverage, detail };
}

function similarityFromDistance(distance) {
  if (!fin(distance)) return null;
  // Absolute similarity calibration, not rank normalization:
  // ~90 = extremely close, ~65 = strong, ~50 = moderate, ~35 = loose, <35 = weak reference.
  // The steeper curve prevents the top three nearest neighbors from all looking artificially equal.
  return clamp(100 * Math.exp(-0.72 * Math.pow(Math.max(0, distance), 1.55)), 0, 100);
}

function compare(target, cand) {
  const parts = [];
  let total = 0, totalW = 0;
  for (const [name, spec] of Object.entries(BLOCKS)) {
    const a = name === 'physical' ? target.physical : (target.matchFeatures || target.features);
    const b = name === 'physical' ? cand.physical : (cand.matchFeatures || cand.features);
    const d = blockDistance(a, b, spec, name === 'physical');
    if (!fin(d.distance)) continue;
    total += spec.weight * d.distance * d.distance;
    totalW += spec.weight;
    parts.push({ name, weight: spec.weight, ...d });
  }
  if (!totalW) return null;
  let distance = Math.sqrt(total / totalW);

  // Size-first guardrails. These are penalties, not position rules: cross-position comps still work.
  const dh = fin(target.physical.height) && fin(cand.physical.height)
    ? Math.abs(target.physical.height - cand.physical.height) : null;
  const dw = fin(target.physical.weight) && fin(cand.physical.weight)
    ? Math.abs(target.physical.weight - cand.physical.weight) : null;
  const dws = fin(target.physical.wingspan) && fin(cand.physical.wingspan)
    ? Math.abs(target.physical.wingspan - cand.physical.wingspan) : null;
  if (fin(dh) && dh > 4.5) distance += (dh - 4.5) * 0.35;
  if (fin(dw) && dw > 40) distance += (dw - 40) / 35;
  if (fin(dws) && dws > 5) distance += (dws - 5) * 0.18;

  const physical = parts.find((x) => x.name === 'physical');
  const coverage = totalW > 0 ? parts.reduce((a, x) => a + x.weight * (x.coverage ?? 1), 0) / totalW : 0;
  const score = similarityFromDistance(distance);
  const details = parts.flatMap((x) => x.detail.map((d) => ({ ...d, block: x.name })));
  details.sort((a, b) => a.z - b.z);
  return {
    score, distance, coverage,
    physicalCoverage: physical?.coverage ?? 0,
    blockScores: Object.fromEntries(parts.map((x) => [x.name, r1(similarityFromDistance(x.distance))])),
    blockDetails: Object.fromEntries(parts.map((x) => [x.name,
      x.detail.slice().sort((a, b) => a.z - b.z).slice(0, 4)
        .map((axis) => ({ label: axis.label, gap: r1(axis.gap), normalizedGap: r1(axis.z) }))])),
    best: details.slice(0, 4),
    worst: [...details].sort((a, b) => b.z - a.z).slice(0, 4),
  };
}

function currentHistoricalTarget(p, leagueHist) {
  const pid = String(p.nbaPersonId ?? p.playerId);
  // Prefer the exact committed 2025-26 projection-input row so target/candidate units are identical.
  let row = leagueHist.find((x) => x.playerId === pid && x.season === '2025-26');
  if (row) return row;
  const b = bio.get(Number(pid)) || {};
  const c = combine.get(Number(pid)) || {};
  return {
    league: p.league, season: '2025-26', seasonType: p.league === 'GLEAGUE' ? 'Regular Season + Showcase Cup' : 'Regular Season',
    playerId: pid, nbaPersonId: Number(pid), name: p.name,
    team: p.team, position: p.position, age: p.age, gp: p.gp, minutes: p.minutes,
    physical: {
      height: p.heightInches ?? b.height ?? c.heightNoShoes ?? null,
      weight: p.weight ?? b.weight ?? c.combineWeight ?? null,
      wingspan: c.wingspan ?? null, standingReach: c.standingReach ?? null,
    },
    features: {
      mpg: p.mpg, usg: fin(p.usg) ? (Number(p.usg) > 1 ? Number(p.usg) / 100 : Number(p.usg)) : null,
      pts36: per36(p.pts, p.mpg), fga36: per36(p.fga, p.mpg), threeA36: per36(p.fg3a, p.mpg),
      fta36: per36(p.fta, p.mpg), reb36: per36(p.reb, p.mpg), ast36: per36(p.ast, p.mpg),
      stl36: per36(p.stl, p.mpg), blk36: per36(p.blk, p.mpg), tov36: per36(p.tov, p.mpg),
      pf36: per36(p.pf, p.mpg), plusMinus36: per36(p.plusMinus, p.mpg),
      oreb36: per36(p.oreb, p.mpg), dreb36: per36(p.dreb, p.mpg),
      threeRate: fin(p.fg3a) && fin(p.fga) && p.fga > 0 ? p.fg3a / p.fga : null,
      ftRate: fin(p.fta) && fin(p.fga) && p.fga > 0 ? p.fta / p.fga : null,
      fg3Pct: p.fg3Pct, fgPct: p.fgPct, ftPct: p.ftPct, ts: p.ts,
      astPct: p.astPct, astTo: p.astTo, astRatio: p.astRatio,
      orebPct: p.orebPct, drebPct: p.drebPct, rebPct: p.rebPct,
      offRtg: p.offRtg, defRtg: p.defRtg, netRtg: p.netRtg, tmTovPct: p.tmTovPct,
      pie: p.pie, pace: p.pace,
    },
  };
}


function currentSiteTarget(p) {
  const pid = String(p.nbaPersonId ?? p.playerId);
  const b = bio.get(Number(pid)) || {};
  const cm = combine.get(Number(pid)) || {};
  return {
    league: p.league, season: '2025-26',
    seasonType: p.league === 'GLEAGUE' ? 'Regular Season + Showcase Cup' : 'Regular Season',
    playerId: pid, nbaPersonId: Number(pid), name: p.name,
    team: p.team, position: p.position, age: p.age, gp: p.gp, minutes: p.minutes,
    physical: {
      height: p.heightInches ?? b.height ?? cm.heightNoShoes ?? null,
      weight: p.weight ?? b.weight ?? cm.combineWeight ?? null,
      wingspan: cm.wingspan ?? null, standingReach: cm.standingReach ?? null,
    },
    features: {
      mpg: p.mpg, usg: fin(p.usg) ? (Number(p.usg) > 1 ? Number(p.usg) / 100 : Number(p.usg)) : null,
      pts36: per36(p.pts, p.mpg), fga36: per36(p.fga, p.mpg), threeA36: per36(p.fg3a, p.mpg),
      fta36: per36(p.fta, p.mpg), reb36: per36(p.reb, p.mpg), ast36: per36(p.ast, p.mpg),
      stl36: per36(p.stl, p.mpg), blk36: per36(p.blk, p.mpg), tov36: per36(p.tov, p.mpg),
      pf36: per36(p.pf, p.mpg), plusMinus36: per36(p.plusMinus, p.mpg),
      oreb36: per36(p.oreb, p.mpg), dreb36: per36(p.dreb, p.mpg),
      threeRate: fin(p.fg3a) && fin(p.fga) && p.fga > 0 ? p.fg3a / p.fga : null,
      ftRate: fin(p.fta) && fin(p.fga) && p.fga > 0 ? p.fta / p.fga : null,
      fg3Pct: p.fg3Pct, fgPct: p.fgPct, ftPct: p.ftPct, ts: p.ts, efgPct: p.efg,
      astPct: p.astPct, astTo: p.astTo, astRatio: p.astRatio,
      orebPct: p.orebPct, drebPct: p.drebPct, rebPct: p.rebPct,
      offRtg: p.offRtg, defRtg: p.defRtg, netRtg: p.netRtg, tmTovPct: p.tmTovPct,
      pie: p.pie, pace: p.pace,
    },
  };
}


const REQUESTED_NBA_COMP_NAMES = [
  'Dain Dainja','Dwight Murray Jr','Aaron Scott','Isaiah Wong','Nick Pringle','Dion Brown',
  'Ben Humrichous','Tidjiane Dioumassi','DJ Rodman','Jonathan Pierre','Cedric Nga Mbiaba',
  'Jeriah Coleman','Jordan Dingle','Wooga Poplar','Chaney Johnson','Grant Nelson',
  'Tyler Bilodeau','Ben Saraf','Drake Powell','Joshua Jefferson','Nolan Traore','Danny Wolf',
];
const nameKey = (value) => String(value || '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '');
const REQUESTED_NBA_COMP_KEYS = new Set(REQUESTED_NBA_COMP_NAMES.map(nameKey));
const requestedNbaComp = (p) => REQUESTED_NBA_COMP_KEYS.has(nameKey(p?.name));
const sameIdentity = (a, b) =>
  (String(a?.playerId || '') && String(a?.playerId || '') === String(b?.playerId || ''))
  || (nameKey(a?.name) && nameKey(a?.name) === nameKey(b?.name));

function playerHistoryRows(rows, p) {
  const pid = String(p?.nbaPersonId ?? p?.playerId ?? '');
  const nk = nameKey(p?.name);
  return rows.filter((row) => (pid && String(row.playerId) === pid) || (nk && nameKey(row.name) === nk));
}

function latestGLeagueSource(p) {
  const rows = playerHistoryRows(histories.GLEAGUE, p)
    .slice().sort((a, b) => Number(b.season.slice(0, 4)) - Number(a.season.slice(0, 4)) || b.minutes - a.minutes);
  if (!rows.length) return null;
  const latestSeason = rows[0].season;
  const chosen = rows.filter((row) => row.season === latestSeason);
  const source = { ...chosen[0] };
  source.name = p.name;
  source.targetBasis = 'historical-gleague-source';
  source.targetSourceSeasons = [latestSeason];
  source.targetHistoryNote = 'NBA comparison uses ' + p.name + "'s " + latestSeason + ' G League production rather than NBA production.';
  return source;
}

function positionalClass(position, height) {
  const pos = String(position || '').toUpperCase();
  if (pos.includes('C') && pos.includes('F')) return 2.6;
  if (pos === 'C' || pos.includes('CENTER')) return 3;
  if (pos.includes('F') && pos.includes('G')) return 1.6;
  if (pos === 'F' || pos.includes('FORWARD')) return 2;
  if (pos.includes('G')) return 1;
  if (fin(height)) return Number(height) >= 81 ? 2.7 : Number(height) >= 78 ? 2 : Number(height) >= 75 ? 1.5 : 1;
  return 2;
}

function rookieReferenceRows(rows) {
  const byPlayer = new Map();
  for (const row of rows) {
    if (!/[A-Za-z]/.test(String(row.name || '')) || !(row.minutes > 0)) continue;
    if (!byPlayer.has(row.playerId)) byPlayer.set(row.playerId, []);
    byPlayer.get(row.playerId).push(row);
  }
  return [...byPlayer.values()].map((seasons) =>
    seasons.slice().sort((a, b) => Number(a.season.slice(0, 4)) - Number(b.season.slice(0, 4)))[0]
  ).filter(Boolean);
}

function prospectTargetProfile(p) {
  const pid = String(p.nbaPersonId ?? p.playerId);
  const b = bio.get(Number(pid)) || {};
  const cm = combine.get(Number(pid)) || {};
  return {
    playerId: pid, name: p.name, position: p.position || b.position || null,
    age: p.age,
    physical: {
      height: p.heightInches ?? b.height ?? cm.heightNoShoes ?? null,
      weight: p.weight ?? b.weight ?? cm.combineWeight ?? null,
      wingspan: cm.wingspan ?? null,
      standingReach: cm.standingReach ?? null,
    },
  };
}

function prospectRookieCompSet(p, nbaPool) {
  const target = prospectTargetProfile(p);
  const nbaRecord = (data.leagues?.NBA || []).find((x) => sameIdentity(x, p));
  const cohortNeighbors = nbaRecord?.proj?.why?.rookie?.neighbors || [];
  const cohortById = new Map(cohortNeighbors.map((x) => [String(x.playerId), Number(x.cohortWeightPct || 0)]));
  let candidates = rookieReferenceRows(nbaPool).filter((cand) => !sameIdentity(cand, target));
  if (cohortById.size >= 3) {
    const cohortCandidates = candidates.filter((cand) => cohortById.has(String(cand.playerId)));
    if (cohortCandidates.length >= 3) candidates = cohortCandidates;
  }
  const targetBig = positionalClass(target.position, target.physical.height);
  const maxCohort = Math.max(1, ...cohortById.values());
  const ranked = candidates.map((cand) => {
    const physical = blockDistance(target.physical, cand.physical, BLOCKS.physical, true);
    const posGap = Math.abs(targetBig - positionalClass(cand.position, cand.physical.height)) / 0.65;
    const ageGap = fin(target.age) && fin(cand.age) ? Math.abs(Number(target.age) - Number(cand.age)) / 3 : null;
    const terms = [];
    if (fin(physical.distance)) terms.push({ w: 0.60, d: physical.distance });
    terms.push({ w: 0.25, d: posGap });
    if (fin(ageGap)) terms.push({ w: 0.15, d: ageGap });
    const tw = terms.reduce((s, x) => s + x.w, 0) || 1;
    let distance = Math.sqrt(terms.reduce((s, x) => s + x.w * x.d * x.d, 0) / tw);
    const cohort = cohortById.get(String(cand.playerId));
    if (fin(cohort) && cohort > 0) distance *= 0.88 + 0.12 * (1 - Math.min(1, cohort / maxCohort));
    const score = similarityFromDistance(distance);
    return { cand, distance, score, physical };
  }).sort((a, b) => b.score - a.score).slice(0, 18);
  if (!ranked.length) return null;
  const chosen = ranked.slice(0, 3);
  const rawWeights = chosen.map((x) => Math.exp(-x.distance / 2));
  const sw = rawWeights.reduce((a, x) => a + x, 0) || 1;
  const shares = integerShares(rawWeights.map((x) => x / sw));
  const top3 = chosen.map((x) => ({
    playerId: x.cand.playerId, league: 'NBA', name: x.cand.name, season: x.cand.season,
    referenceProfile: { seasons: [x.cand.season], games: x.cand.gp, minutes: r1(x.cand.minutes), seasonCount: 1, period: x.cand.season, limited: true },
    team: x.cand.team, teamId: x.cand.teamId ?? null, position: x.cand.position,
    similarity: r1(x.score),
    height: fmtSize(x.cand.physical.height), weight: r1(x.cand.physical.weight),
    wingspan: fmtSize(x.cand.physical.wingspan), standingReach: fmtSize(x.cand.physical.standingReach),
    mpg: r1(x.cand.features.mpg), usg: r3(x.cand.features.usg),
    pts36: r1(x.cand.features.pts36), fga36: r1(x.cand.features.fga36),
    fta36: r1(x.cand.features.fta36), reb36: r1(x.cand.features.reb36), ast36: r1(x.cand.features.ast36),
    tov36: r1(x.cand.features.tov36), pf36: r1(x.cand.features.pf36), plusMinus36: r1(x.cand.features.plusMinus36),
    efgPct: r3(x.cand.features.efgPct), fg3Pct: r3(x.cand.features.fg3Pct), ts: r3(x.cand.features.ts),
    threeRate: r3(x.cand.features.threeRate), ftRate: r3(x.cand.features.ftRate), astPct: r3(x.cand.features.astPct),
    astTo: r2(x.cand.features.astTo), astRatio: r2(x.cand.features.astRatio),
    orebPct: r3(x.cand.features.orebPct), drebPct: r3(x.cand.features.drebPct), rebPct: r3(x.cand.features.rebPct),
    offRtg: r1(x.cand.features.offRtg), defRtg: r1(x.cand.features.defRtg), netRtg: r1(x.cand.features.netRtg),
    pie: r3(x.cand.features.pie), stl36: r1(x.cand.features.stl36), blk36: r1(x.cand.features.blk36),
    blockScores: { physical: fin(x.physical.distance) ? r1(similarityFromDistance(x.physical.distance)) : null },
    mostSimilar: [], biggestDifferences: [],
  }));
  const blend = chosen.map((x, i) => ({
    playerId: x.cand.playerId, name: x.cand.name, season: x.cand.season,
    share: shares[i], quality: r1(x.score), matchScore: r1(x.score),
  }));
  const confidence = r1(chosen.reduce((s, x, i) => s + (shares[i] / 100) * x.score, 0));
  const cohortNote = cohortById.size >= 3
    ? 'The candidate pool starts from the site rookie projection cohort (draft slot, positional class and entry age), then re-ranks by listed frame and age.'
    : 'No verified professional statistical sample was available, so the fallback compares listed frame, positional class and age against historical NBA rookies.';
  return {
    top3,
    nearestOverall: top3.map((x) => ({ playerId: x.playerId, league: 'NBA', name: x.name, season: x.season, similarity: x.similarity, referenceProfile: x.referenceProfile })),
    blend,
    blendConfidence: confidence,
    blendReconstructionScore: null,
    blendAxesUsed: [target.physical.height,target.physical.weight,target.physical.wingspan,target.physical.standingReach].filter(fin).length + 1 + (fin(target.age) ? 1 : 0),
    profileRead: {
      text: p.name + ' is matched to historical NBA rookies from the closest available entry-profile cohort.',
      position: p.position || 'Prospect',
      components: [],
      caveat: 'This is a rookie-entry comparison, not a direct translation of college box-score production or a career forecast.',
    },
    targetSeason: 'Pre-NBA / rookie entry profile',
    targetSeasonType: 'Rookie-model comparison',
    targetBasis: 'rookie-model-to-nba',
    targetHistoryNote: cohortNote,
    targetGames: null, targetMinutes: null,
    shorthand: 'Rookie-entry NBA comparison led by ' + top3[0].name + ' (' + top3[0].season + ').',
    targetPhysical: {
      height: fmtSize(target.physical.height), weight: r1(target.physical.weight),
      wingspan: fmtSize(target.physical.wingspan), standingReach: fmtSize(target.physical.standingReach),
    },
    targetStats: {
      mpg:null,usg:null,pts36:null,fga36:null,fta36:null,reb36:null,ast36:null,tov36:null,pf36:null,plusMinus36:null,
      efgPct:null,fg3Pct:null,ts:null,threeRate:null,ftRate:null,astPct:null,astTo:null,astRatio:null,
      orebPct:null,drebPct:null,rebPct:null,offRtg:null,defRtg:null,netRtg:null,pie:null,stl36:null,blk36:null,
    },
    modelEvidence: { method: 'rookie-entry cohort + frame/position/age', cohortNeighborsUsed: cohortById.size },
  };
}

function fmtSize(x) {
  if (!fin(x)) return null;
  const ft = Math.floor(x / 12), inch = Math.round((x - ft * 12) * 10) / 10;
  return `${ft}'${inch}"`;
}
function relation(target, comp) {
  const t = target.features, c = comp.features;
  const mods = [];
  if (fin(t.fg3Pct) && fin(c.fg3Pct) && t.fg3Pct - c.fg3Pct > 0.04) mods.push('better three-point shooting');
  else if (fin(t.fg3Pct) && fin(c.fg3Pct) && c.fg3Pct - t.fg3Pct > 0.04) mods.push('worse three-point shooting');
  if (fin(t.threeRate) && fin(c.threeRate) && t.threeRate - c.threeRate > 0.10) mods.push('more three-point oriented');
  else if (fin(t.threeRate) && fin(c.threeRate) && c.threeRate - t.threeRate > 0.10) mods.push('less three-point oriented');
  if (fin(t.ts) && fin(c.ts) && t.ts - c.ts > 0.045) mods.push('more scoring-efficient');
  else if (fin(t.ts) && fin(c.ts) && c.ts - t.ts > 0.045) mods.push('less scoring-efficient');
  if (fin(t.ast36) && fin(c.ast36) && t.ast36 - c.ast36 > 2.2) mods.push('more playmaking-heavy');
  else if (fin(t.ast36) && fin(c.ast36) && c.ast36 - t.ast36 > 2.2) mods.push('less playmaking-heavy');
  if (fin(t.ftRate) && fin(c.ftRate) && t.ftRate - c.ftRate > 0.12) mods.push('more rim/free-throw pressure');
  if (fin(target.physical.weight) && fin(comp.physical.weight) && target.physical.weight - comp.physical.weight > 18) mods.push('heavier framed');
  else if (fin(target.physical.weight) && fin(comp.physical.weight) && comp.physical.weight - target.physical.weight > 18) mods.push('lighter framed');
  return mods.slice(0, 2);
}
function serializeComp(target, cand, m) {
  // Current tracking cannot describe a historical season just because that player is still active.
  const cur = cand.season === '2025-26' ? currentByLeaguePid[cand.league]?.get(cand.playerId) : null;
  return {
    playerId: cand.playerId, league: cand.league, name: cand.name, season: cand.season,
    referenceProfile: cand.referenceProfile || null,
    team: cand.team, teamId: cand.teamId ?? null, position: cand.position,
    age: r1(cand.age), similarity: r1(m.score), coverage: r1(m.coverage * 100),
    physicalCoverage: r1(m.physicalCoverage * 100),
    heightInches: r1(cand.physical.height), height: fmtSize(cand.physical.height),
    weight: r1(cand.physical.weight), wingspanInches: r1(cand.physical.wingspan),
    wingspan: fmtSize(cand.physical.wingspan), standingReach: fmtSize(cand.physical.standingReach),
    mpg: r1(cand.features.mpg), usg: r3(cand.features.usg),
    pts36: r1(cand.features.pts36), fga36: r1(cand.features.fga36), threeA36: r1(cand.features.threeA36),
    fta36: r1(cand.features.fta36), reb36: r1(cand.features.reb36), ast36: r1(cand.features.ast36),
    tov36: r1(cand.features.tov36), pf36: r1(cand.features.pf36), plusMinus36: r1(cand.features.plusMinus36),
    oreb36: r1(cand.features.oreb36), dreb36: r1(cand.features.dreb36),
    fgPct: r3(cand.features.fgPct), efgPct: r3(cand.features.efgPct), fg3Pct: r3(cand.features.fg3Pct),
    ftPct: r3(cand.features.ftPct), ts: r3(cand.features.ts), threeRate: r3(cand.features.threeRate),
    ftRate: r3(cand.features.ftRate), astPct: r3(cand.features.astPct),
    astTo: r2(cand.features.astTo), astRatio: r2(cand.features.astRatio),
    orebPct: r3(cand.features.orebPct), drebPct: r3(cand.features.drebPct), rebPct: r3(cand.features.rebPct),
    offRtg: r1(cand.features.offRtg), defRtg: r1(cand.features.defRtg), netRtg: r1(cand.features.netRtg),
    tmTovPct: r3(cand.features.tmTovPct), pie: r3(cand.features.pie), stl36: r1(cand.features.stl36), blk36: r1(cand.features.blk36),
    style: deepOverlay(cur),
    blockScores: m.blockScores,
    blockDetails: m.blockDetails,
    mostSimilar: m.best.map((x) => x.label),
    biggestDifferences: m.worst.map((x) => ({ label: x.label, normalizedGap: r1(x.z) })),
    relation: relation(target, cand),
    currentSeasonDetailed: !!cur,
  };
}


function compactReferenceProfile(profile) {
  if (!profile) return null;
  return {
    seasons: profile.seasons || [],
    games: r1(profile.games),
    minutes: r1(profile.minutes),
    seasonCount: profile.seasonCount,
    period: profile.period,
    limited: !!profile.limited,
  };
}

// The NBA-equivalent pool is additive and large (one set for every played G League player).
// Keep only fields the UI actually renders so publication reloads do not have to parse a second
// full copy of same-league comparison diagnostics such as blockDetails and style-source internals.
function serializeNbaEquivalentComp(target, cand, m) {
  return {
    playerId: cand.playerId, league: cand.league, name: cand.name, season: cand.season,
    referenceProfile: compactReferenceProfile(cand.referenceProfile),
    team: cand.team, teamId: cand.teamId ?? null, position: cand.position,
    similarity: r1(m.score),
    height: fmtSize(cand.physical.height), weight: r1(cand.physical.weight),
    wingspan: fmtSize(cand.physical.wingspan), standingReach: fmtSize(cand.physical.standingReach),
    mpg: r1(cand.features.mpg), usg: r3(cand.features.usg),
    pts36: r1(cand.features.pts36), fga36: r1(cand.features.fga36),
    fta36: r1(cand.features.fta36), reb36: r1(cand.features.reb36), ast36: r1(cand.features.ast36),
    tov36: r1(cand.features.tov36), pf36: r1(cand.features.pf36), plusMinus36: r1(cand.features.plusMinus36),
    efgPct: r3(cand.features.efgPct), fg3Pct: r3(cand.features.fg3Pct), ts: r3(cand.features.ts),
    threeRate: r3(cand.features.threeRate), ftRate: r3(cand.features.ftRate), astPct: r3(cand.features.astPct),
    astTo: r2(cand.features.astTo), astRatio: r2(cand.features.astRatio),
    orebPct: r3(cand.features.orebPct), drebPct: r3(cand.features.drebPct), rebPct: r3(cand.features.rebPct),
    offRtg: r1(cand.features.offRtg), defRtg: r1(cand.features.defRtg), netRtg: r1(cand.features.netRtg),
    pie: r3(cand.features.pie), stl36: r1(cand.features.stl36), blk36: r1(cand.features.blk36),
    blockScores: m.blockScores,
    mostSimilar: m.best.map((x) => x.label),
    biggestDifferences: m.worst.map((x) => ({ label: x.label, normalizedGap: r1(x.z) })),
  };
}
function serializeNbaEquivalentOverall(cand, m) {
  return {
    playerId: cand.playerId, league: cand.league, name: cand.name, season: cand.season,
    similarity: r1(m.score),
    referenceProfile: compactReferenceProfile(cand.referenceProfile),
  };
}
function compactProfileRead(read) {
  return {
    text: read?.text || '',
    position: read?.position || null,
    blend: read?.blend || '',
    caveat: read?.caveat || '',
    components: (read?.components || []).map((x) => ({
      playerId: x.playerId, name: x.name, season: x.season, fit: x.fit,
      phrase: x.phrase, evidence: x.evidence || [], narrativeOrder: x.narrativeOrder,
      referencePeriod: compactReferenceProfile(x.referencePeriod),
    })),
  };
}


// A blend should reconstruct the target's listed physical profile and playing style, not merely
// distribute 100 points among the three nearest neighbours. Available listed size dimensions and
// high-coverage player-controlled axes enter the convex fit. Team-context outputs (ratings,
// plus-minus and PIE) remain visible in the side-by-side table but cannot steer the composition.
const BLEND_EXCLUDED = new Set(['offRtg', 'defRtg', 'netRtg', 'plusMinus36', 'pie', 'pace', 'poss']);
const BLEND_AXES = Object.entries(BLOCKS)
  .flatMap(([block, spec]) => {
    const axisTotal = Object.entries(spec.axes)
      .filter(([key]) => !BLEND_EXCLUDED.has(key))
      .reduce((sum, [, axis]) => sum + axis.weight, 0);
    return Object.entries(spec.axes)
      .filter(([key]) => !BLEND_EXCLUDED.has(key))
      .map(([key, axis]) => ({
        key, block, scale: axis.scale,
        // Coordinates are multiplied by sqrt(weight), so squared Euclidean error preserves the
        // declared block and within-block weights.
        weight: spec.weight * axis.weight / axisTotal,
      }));
  });

function blendAxes(target, items) {
  return BLEND_AXES.filter((axis) => {
    const targetProfile = axis.block === 'physical' ? target.physical : (target.matchFeatures || target.features);
    const profile = (rec) => axis.block === 'physical' ? rec.cand.physical : (rec.cand.matchFeatures || rec.cand.features);
    if (!fin(targetProfile[axis.key])) return false;
    const covered = items.filter((x) => fin(profile(x)[axis.key])).length;
    return covered / Math.max(1, items.length) >= 0.80;
  });
}

function blendVector(rec, axes, target) {
  return axes.map((axis) => {
    // Missing historical values are neutral on that one axis and are charged through the explicit
    // coverage penalty below. This avoids inventing a value or letting a sparse row win by making
    // the difficult axes disappear from the objective.
    const features = axis.block === 'physical' ? rec.physical : (rec.matchFeatures || rec.features);
    const targetFeatures = axis.block === 'physical' ? target.physical : (target.matchFeatures || target.features);
    const raw = fin(features[axis.key]) ? Number(features[axis.key]) : Number(targetFeatures[axis.key]);
    return raw / axis.scale * Math.sqrt(axis.weight);
  });
}

function integerShares(weights) {
  const exact = weights.map((x) => 100 * x);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, x) => a + x, 0);
  const order = exact.map((x, i) => ({ i, rem: x - floors[i] }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let j = 0; j < left; j++) floors[order[j % order.length].i]++;
  return floors;
}

function optimizeBlend(target, shortlist) {
  const axes = blendAxes(target, shortlist);
  const tv = blendVector(target, axes, target);
  const vectors = shortlist.map((x) => blendVector(x.cand, axes, target));
  const axisWeight = axes.reduce((sum, axis) => sum + axis.weight, 0) || 1;
  const coverage = shortlist.map((x) => {
    const seen = axes.reduce((sum, axis) => {
      const features = axis.block === 'physical' ? x.cand.physical : (x.cand.matchFeatures || x.cand.features);
      return sum + (fin(features[axis.key]) ? axis.weight : 0);
    }, 0);
    return seen / axisWeight;
  });
  let best = null;
  // Linear costs must participate in weight optimization, not just selection afterwards.
  const costs = shortlist.map((x, i) => {
    const physical = Number(x.m.blockScores?.physical ?? x.m.score ?? 0) / 100;
    const match = Number(x.m.score || 0) / 100;
    return 0.05 * (1 - physical) ** 2 + 0.08 * (1 - coverage[i]) + 0.04 * (1 - match) ** 2;
  });

  const consider = (indices, weights) => {
    const styleError = tv.reduce((sum, t, k) => {
      const predicted = indices.reduce((v, idx, j) => v + weights[j] * vectors[idx][k], 0);
      return sum + (t - predicted) ** 2;
    }, 0) / axisWeight;
    const physicalPenalty = indices.reduce((sum, idx, j) => {
      const physical = Number(shortlist[idx].m.blockScores?.physical ?? shortlist[idx].m.score ?? 0) / 100;
      return sum + weights[j] * (1 - physical) ** 2;
    }, 0);
    const missingPenalty = indices.reduce((sum, idx, j) => sum + weights[j] * (1 - coverage[idx]), 0);
    const individualPenalty = indices.reduce((sum, idx, j) => {
      const match = Number(shortlist[idx].m.score || 0) / 100;
      return sum + weights[j] * (1 - match) ** 2;
    }, 0);
    // A very small complexity cost makes a two-player explanation beat a three-player one when the
    // third player adds no material reconstruction value. It does not force sparse blends.
    const objective = styleError + 0.05 * physicalPenalty + 0.08 * missingPenalty
      + 0.04 * individualPenalty + 0.003 * (indices.length - 1);
    if (!best || objective < best.objective) {
      best = { indices, weights, objective, styleError, coverage: indices.reduce((s, idx, j) => s + weights[j] * coverage[idx], 0) };
    }
  };

  for (let i = 0; i < shortlist.length; i++) consider([i], [1]);
  for (let i = 0; i < shortlist.length; i++) for (let j = i + 1; j < shortlist.length; j++) {
    const d = vectors[i].map((x, k) => x - vectors[j][k]);
    const base = tv.map((x, k) => x - vectors[j][k]);
    const den = d.reduce((s, x) => s + x * x, 0);
    const w = den > 1e-12 ? clamp((d.reduce((s, x, k) => s + x * base[k], 0)
      - axisWeight * (costs[i] - costs[j]) / 2) / den, 0.06, 0.94) : (costs[i] < costs[j] ? 0.94 : 0.06);
    consider([i, j], [w, 1 - w]);
  }
  for (let i = 0; i < shortlist.length; i++) for (let j = i + 1; j < shortlist.length; j++) {
    for (let k = j + 1; k < shortlist.length; k++) {
      const u = vectors[i].map((x, z) => x - vectors[k][z]);
      const v = vectors[j].map((x, z) => x - vectors[k][z]);
      const y = tv.map((x, z) => x - vectors[k][z]);
      const uu = u.reduce((s, x) => s + x * x, 0), vv = v.reduce((s, x) => s + x * x, 0);
      const uv = u.reduce((s, x, z) => s + x * v[z], 0);
      const uy = u.reduce((s, x, z) => s + x * y[z], 0) - axisWeight * (costs[i] - costs[k]) / 2;
      const vy = v.reduce((s, x, z) => s + x * y[z], 0) - axisWeight * (costs[j] - costs[k]) / 2;
      // All three constrained edges, including vertices. This also handles singular interiors.
      for (const [fixed, left, right] of [[i,j,k],[j,i,k],[k,i,j]]) {
        const d = vectors[left].map((x,z) => x-vectors[right][z]);
        const base = tv.map((x,z) => x-0.06*vectors[fixed][z]-0.94*vectors[right][z]);
        const den = d.reduce((s,x) => s+x*x,0);
        const w = den > 1e-12 ? clamp((d.reduce((s,x,z)=>s+x*base[z],0)
          - axisWeight*(costs[left]-costs[right])/2)/den,0.06,0.88) : (costs[left]<costs[right]?0.88:0.06);
        consider([fixed,left,right],[0.06,w,0.94-w]);
      }
      const det = uu * vv - uv * uv;
      if (Math.abs(det) < 1e-10) continue;
      const a = (uy * vv - vy * uv) / det;
      const b = (vy * uu - uy * uv) / det;
      const c = 1 - a - b;
      if (a < 0.06 || b < 0.06 || c < 0.06) continue;
      consider([i, j, k], [a, b, c]);
    }
  }

  const pairs = best.indices.map((idx, i) => ({ item: shortlist[idx], weight: best.weights[i] }))
    .sort((a, b) => b.weight - a.weight);
  const shares = integerShares(pairs.map((x) => x.weight));
  const weightedMatch = pairs.reduce((sum, x) => sum + x.weight * Number(x.item.m.score || 0), 0);
  const reconstructionScore = similarityFromDistance(Math.sqrt(best.styleError));
  const confidence = r1(clamp((0.72 * reconstructionScore + 0.28 * weightedMatch)
    * (0.88 + 0.12 * best.coverage), 0, 100));
  return {
    selected: pairs.map((x) => x.item),
    blend: pairs.map((x, i) => ({
      name: x.item.cand.name, season: x.item.cand.season, playerId: x.item.cand.playerId,
      share: shares[i], quality: r1(x.item.m.score), matchScore: r1(x.item.m.score),
    })),
    confidence,
    reconstructionScore: r1(reconstructionScore),
    objective: r2(best.objective),
    axesUsed: axes.length,
  };
}

const result = { NBA: {}, GLEAGUE: {} };
for (const lg of ['NBA', 'GLEAGUE']) {
  const pool = histories[lg];
  const matchDistributions = prepareMatchProfiles(pool);
  const minMinutes = lg === 'NBA' ? 300 : 200;
  const referencePool = stableReferenceProfiles(pool, minMinutes);
  for (const p of data.leagues?.[lg] || []) {
    // A roster listing is not a statistical target. Keep no-appearance players searchable in the
    // site, but do not invent a current-season comp from their old career line.
    if (!p.appeared || !(p.minutes > 0)) continue;
    const target = currentHistoricalTarget(p, pool);
    if (!target) continue;
    // Prefer the site's canonical display spelling (e.g. RJ rather than source-specific R.J.).
    target.name = p.name;
    if (!target.matchFeatures) {
      target.matchFeatures = normalizeMatchFeatures(target, matchDistributions.get(`${lg}|${target.season}`));
    }
    const targetDeep = deepOverlay(target.targetBasis === 'historical-fallback' ? null : p);
    // Every target sees exactly the same representative identity for each historical player.
    // The nearest overall players and the reconstruction blend are separate outputs.
    const bestByPlayer = new Map();
    for (const cand of referencePool) {
      // A source row with no resolved person name is not an interpretable historical reference.
      // Excluding it is more honest than displaying its raw numeric identifier as a player comp.
      if (cand.playerId === target.playerId || cand.minutes < minMinutes || !/[A-Za-z]/.test(String(cand.name || ''))) continue;
      const m = compare(target, cand);
      if (!m) continue;
      // Prefer known body matches when target body is known. This is a soft penalty, not exclusion.
      let score = m.score;
      if ((fin(target.physical.height) || fin(target.physical.weight)) && m.physicalCoverage < 0.45) score *= 0.82;
      const item = { cand, m: { ...m, score } };
      bestByPlayer.set(cand.playerId, item);
    }
    // The nearest-neighbour score forms a defensible shortlist. The final one-to-three players and
    // their percentages are then chosen together by convex reconstruction of the target profile.
    // This is the important distinction between a real player blend and three ranked comps whose
    // percentages were assigned after the fact.
    const shortlist = [...bestByPlayer.values()].sort((a, b) => b.m.score - a.m.score).slice(0, 18);
    if (!shortlist.length) continue;
    const optimized = optimizeBlend(target, shortlist);
    const best = optimized.selected.map((x) => serializeComp(target, x.cand, x.m));
    const blend = optimized.blend;
    const confidence = optimized.confidence;
    const primary = best[0], rel = primary.relation || [];
    const profileRead = independentStyleRead(target, referencePool, blend);
    result[lg][String(p.playerId)] = {
      top3: best,
      nearestOverall: shortlist.slice(0, 3).map((item) => serializeComp(target, item.cand, item.m)),
      blend,
      blendConfidence: confidence,
      blendReconstructionScore: optimized.reconstructionScore,
      blendAxesUsed: optimized.axesUsed,
      profileRead,
      targetSeason: target.season,
      targetSeasonType: target.seasonType,
      targetBasis: target.targetBasis || 'current-season',
      targetSourceSeasons: target.targetSourceSeasons || [target.season],
      targetHistoryNote: target.targetHistoryNote || null,
      matchMethod: 'pace-adjusted, league-season robust z-scores after exposure-weighted median shrinkage',
      targetGames: target.gp,
      targetMinutes: r1(target.minutes),
      matchSummary: blend.map((x) => ({ name: x.name, season: x.season, share: x.share, matchScore: x.matchScore })),
      shorthand: rel.length
        ? `A ${rel.join(', ')} blend led by ${primary.name} (${primary.season}).`
        : `Historical blend led by ${primary.name} (${primary.season}).`,
      targetPhysical: {
        heightInches: r1(target.physical.height), height: fmtSize(target.physical.height),
        weight: r1(target.physical.weight), wingspanInches: r1(target.physical.wingspan),
        wingspan: fmtSize(target.physical.wingspan), standingReach: fmtSize(target.physical.standingReach),
      },
      targetStats: {
        mpg: r1(target.features.mpg), usg: r3(target.features.usg),
        pts36: r1(target.features.pts36), fga36: r1(target.features.fga36), threeA36: r1(target.features.threeA36),
        fta36: r1(target.features.fta36), reb36: r1(target.features.reb36), ast36: r1(target.features.ast36),
        tov36: r1(target.features.tov36), pf36: r1(target.features.pf36), plusMinus36: r1(target.features.plusMinus36),
        oreb36: r1(target.features.oreb36), dreb36: r1(target.features.dreb36),
        fgPct: r3(target.features.fgPct), efgPct: r3(target.features.efgPct), fg3Pct: r3(target.features.fg3Pct),
        ftPct: r3(target.features.ftPct), ts: r3(target.features.ts), threeRate: r3(target.features.threeRate),
        ftRate: r3(target.features.ftRate), astPct: r3(target.features.astPct),
        astTo: r2(target.features.astTo), astRatio: r2(target.features.astRatio),
        orebPct: r3(target.features.orebPct), drebPct: r3(target.features.drebPct), rebPct: r3(target.features.rebPct),
        offRtg: r1(target.features.offRtg), defRtg: r1(target.features.defRtg), netRtg: r1(target.features.netRtg),
        tmTovPct: r3(target.features.tmTovPct), pie: r3(target.features.pie), stl36: r1(target.features.stl36), blk36: r1(target.features.blk36),
      },
      targetStyle: targetDeep,
    };
  }
}


// Cross-league product: translate each current G League profile into NBA statistical space, then
// run the SAME NBA historical comparison/blend engine. The translation is learned only from prior
// same-player, same-season crossover samples; 2025-26 is held out from the translation fit.
const nbaEquivalentResult = {};
const nbaEquivalentTranslation = buildNbaEquivalentTranslation(histories.NBA, histories.GLEAGUE);
{
  const nbaPool = histories.NBA;
  const nbaDistributions = prepareMatchProfiles(nbaPool);
  const nbaSeasonStats = nbaDistributions.get('NBA|2025-26');
  const referencePool = stableReferenceProfiles(nbaPool, 300);
  for (const p of data.leagues?.GLEAGUE || []) {
    if (!p.appeared || !(p.minutes > 0)) continue;
    const source = currentSiteTarget(p);
    const target = nbaEquivalentTarget(p, source, nbaEquivalentTranslation, nbaSeasonStats);
    const bestByPlayer = new Map();
    for (const cand of referencePool) {
      if (cand.playerId === target.playerId || cand.minutes < 300 || !/[A-Za-z]/.test(String(cand.name || ''))) continue;
      const m = compare(target, cand);
      if (!m) continue;
      let score = m.score;
      if ((fin(target.physical.height) || fin(target.physical.weight)) && m.physicalCoverage < 0.45) score *= 0.82;
      bestByPlayer.set(cand.playerId, { cand, m: { ...m, score } });
    }
    const shortlist = [...bestByPlayer.values()].sort((a, b) => b.m.score - a.m.score).slice(0, 18);
    if (!shortlist.length) continue;
    const optimized = optimizeBlend(target, shortlist);
    const best = optimized.selected.map((x) => serializeNbaEquivalentComp(target, x.cand, x.m));
    const blend = optimized.blend;
    const primarySource = optimized.selected[0]?.cand;
    const primary = best[0], rel = primarySource ? relation(target, primarySource) : [];
    const profileRead = compactProfileRead(independentStyleRead(target, referencePool, blend));
    nbaEquivalentResult[String(p.playerId)] = {
      top3: best,
      nearestOverall: shortlist.slice(0, 3).map((item) => serializeNbaEquivalentOverall(item.cand, item.m)),
      blend,
      blendConfidence: optimized.confidence,
      blendReconstructionScore: optimized.reconstructionScore,
      blendAxesUsed: optimized.axesUsed,
      profileRead,
      targetSeason: target.season,
      targetSeasonType: target.seasonType,
      targetBasis: target.targetBasis,
      targetHistoryNote: target.targetHistoryNote,
      targetGames: target.gp,
      targetMinutes: r1(target.minutes),
      shorthand: rel.length
        ? `An NBA-equivalent ${rel.join(', ')} blend led by ${primary.name} (${primary.season}).`
        : `NBA-equivalent historical blend led by ${primary.name} (${primary.season}).`,
      targetPhysical: {
        height: fmtSize(target.physical.height),
        weight: r1(target.physical.weight),
        wingspan: fmtSize(target.physical.wingspan),
        standingReach: fmtSize(target.physical.standingReach),
      },
      targetStats: {
        mpg: null, usg: r3(target.features.usg),
        pts36: r1(target.features.pts36), fga36: r1(target.features.fga36),
        fta36: r1(target.features.fta36), reb36: r1(target.features.reb36), ast36: r1(target.features.ast36),
        tov36: r1(target.features.tov36), pf36: r1(target.features.pf36), plusMinus36: null,
        efgPct: r3(target.features.efgPct), fg3Pct: r3(target.features.fg3Pct),
        ts: r3(target.features.ts), threeRate: r3(target.features.threeRate),
        ftRate: r3(target.features.ftRate), astPct: r3(target.features.astPct),
        astTo: r2(target.features.astTo), astRatio: r2(target.features.astRatio),
        orebPct: r3(target.features.orebPct), drebPct: r3(target.features.drebPct), rebPct: r3(target.features.rebPct),
        offRtg: null, defRtg: null, netRtg: null, pie: null,
        stl36: r1(target.features.stl36), blk36: r1(target.features.blk36),
      },
      translationEvidence: {
        trainingThrough: nbaEquivalentTranslation.trainingThrough,
        mpgExcluded: true,
      },
    };
  }
}

// Product contract: every player who actually appeared in the current source season must receive
// one to three DISTINCT same-league historical player comps. Fail the build rather than silently
// shipping a broken comparison card for an edge-case player.
for (const lg of ['NBA', 'GLEAGUE']) {
  const expectedIds = (data.leagues?.[lg] || [])
    .filter((p) => p.appeared && Number(p.minutes) > 0)
    .map((p) => String(p.playerId));
  const unexpected = Object.keys(result[lg]).filter((id) => !expectedIds.includes(id));
  const missing = expectedIds.filter((id) => !result[lg][id]);
  const short = Object.entries(result[lg]).filter(([, set]) => {
    const count = (set.top3 || []).length;
    return count < 1 || count > 3 || new Set((set.top3 || []).map((x) => String(x.playerId))).size !== count;
  });
  const wrongLeague = Object.entries(result[lg]).filter(([, set]) =>
    (set.top3 || []).some((x) => x.league !== lg));
  const badBlend = Object.entries(result[lg]).filter(([, set]) =>
    (set.blend || []).length < 1 || (set.blend || []).length > 3
    || set.blend.reduce((a, x) => a + Number(x.share || 0), 0) !== 100
    || !fin(set.blendConfidence));
  if (missing.length || unexpected.length || short.length || wrongLeague.length || badBlend.length) {
    throw new Error(`player comps contract failed for ${lg}: missing=${missing.length}, unexpected=${unexpected.length}, short/duplicate=${short.length}, wrongLeague=${wrongLeague.length}, badBlend=${badBlend.length}`);
  }
}


// Cross-league contract: every played G League target gets a distinct NBA-only blend with honest
// translation provenance. Self-comps are prohibited even when the player has NBA history.
{
  const expectedIds = (data.leagues?.GLEAGUE || [])
    .filter((p) => p.appeared && Number(p.minutes) > 0)
    .map((p) => String(p.playerId));
  const missing = expectedIds.filter((id) => !nbaEquivalentResult[id]);
  const bad = Object.entries(nbaEquivalentResult).filter(([id, set]) => {
    const comps = set.top3 || [], blend = set.blend || [];
    return !expectedIds.includes(id)
      || comps.length < 1 || comps.length > 3
      || new Set(comps.map((x) => String(x.playerId))).size !== comps.length
      || comps.some((x) => x.league !== 'NBA' || String(x.playerId) === id)
      || blend.length !== comps.length
      || blend.reduce((sum, x) => sum + Number(x.share || 0), 0) !== 100
      || !fin(set.blendConfidence)
      || set.targetBasis !== 'gleague-to-nba-equivalent';
  });
  if (missing.length || bad.length) {
    throw new Error(`NBA-equivalent player comps contract failed: missing=${missing.length}, bad=${bad.length}`);
  }
}

const pct = (arr, q) => {
  const x = arr.filter(fin).slice().sort((a, b) => a - b);
  if (!x.length) return null;
  const i = (x.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return r1(x[lo] + (x[hi] - x[lo]) * (i - lo));
};
const scoreDistribution = {}, blendDistribution = {};
for (const lg of ['NBA', 'GLEAGUE']) {
  const sets = Object.values(result[lg]);
  const top1 = sets.map((set) => set.top3?.[0]?.similarity).filter(fin);
  const all = sets.flatMap((set) => (set.top3 || []).map((x) => x.similarity)).filter(fin);
  const leadShares = sets.map((set) => Math.max(...(set.blend || []).map((x) => Number(x.share || 0)))).filter(fin);
  const confidences = sets.map((set) => set.blendConfidence).filter(fin);
  const nearThird = sets.filter((set) => {
    const s = (set.blend || []).map((x) => Number(x.share || 0));
    return s.length === 3 && Math.max(...s) - Math.min(...s) <= 4;
  }).length;
  const patterns = new Set(sets.map((set) => (set.blend || []).map((x) => x.share).join('/')));
  const componentCounts = sets.reduce((acc, set) => {
    const count = (set.blend || []).length;
    acc[count] = (acc[count] || 0) + 1;
    return acc;
  }, {});
  scoreDistribution[lg] = {
    top1: { min: r1(Math.min(...top1)), p10: pct(top1, .10), median: pct(top1, .50), p90: pct(top1, .90), max: r1(Math.max(...top1)) },
    allCandidates: { min: r1(Math.min(...all)), median: pct(all, .50), max: r1(Math.max(...all)) },
  };
  blendDistribution[lg] = {
    leadShare: { min: r1(Math.min(...leadShares)), p10: pct(leadShares, .10), median: pct(leadShares, .50), p90: pct(leadShares, .90), max: r1(Math.max(...leadShares)) },
    confidence: { p10: pct(confidences, .10), median: pct(confidences, .50), p90: pct(confidences, .90) },
    nearThirdCount: nearThird,
    total: sets.length,
    distinctSharePatterns: patterns.size,
    componentCounts,
  };
  console.log(`player comps ${lg} blend distribution: ${JSON.stringify(blendDistribution[lg])}`);
}

data.analysis = data.analysis || {};
data.analysis.playerComps = result;
data.analysis.playerCompsNbaEquivalent = { GLEAGUE: nbaEquivalentResult };
data.analysis.playerCompsMeta = {
  version: '4.2.0',
  generatedAt: process.env.BUILD_GENERATED_AT || new Date().toISOString(),
  sameLeagueOnly: true,
  sameLeagueDefault: true,
  nbaEquivalentAvailableForGLeague: true,
  nbaEquivalent: {
    comparisonPool: 'NBA historical reference profiles',
    target: '2025-26 G League full-season line (Regular Season + Showcase Cup) translated into NBA statistical space',
    translationMethod: nbaEquivalentTranslation.method,
    trainingThrough: nbaEquivalentTranslation.trainingThrough,
    pairedPlayerSeasons: nbaEquivalentTranslation.pairCount,
    minimumMinutesEachLeague: nbaEquivalentTranslation.minimumMinutesEachLeague,
    mpgExcluded: true,
    note: 'This is an NBA-equivalent statistical/style comparison, not a forecast of NBA talent, minutes, career outcome or probability of reaching the NBA.',
  },
  nbaHistory: '2009-10 through 2025-26',
  gleagueHistory: '2014-15 through 2025-26',
  priority: 'overall comparisons, statistical blend shares, and independent style references answer different questions; reference periods are chosen before matching',
  referenceMethod: 'one fixed representative profile per player: the highest-minute three-year calendar window with at least two meaningful seasons when available; pooled shooting attempts and minutes-weighted rate/era coordinates',
  styleMethod: 'independent trait-specific search across the full same-league multi-year reference pool; at least two observed seasons, sufficient shared axes, fit >=55, no selected axis beyond 2.5 scale units; style cards have no blend percentages',
  targetEligibility: 'only players with a 2025-26 appearance and positive minutes receive a player-comparison target; roster-only players remain searchable but have no invented historical fallback comparison',
  physicalWeight: 0.20,
  similarityScale: 'internal absolute match score: 100*exp(-0.72*distance^1.55)',
  blendMethod: 'one to three distinct players chosen jointly from the 18 nearest representative historical profiles by non-negative convex reconstruction of available listed physical dimensions plus pace-adjusted, league-season standardized role, production, shot-diet and defensive-activity axes after sample-size shrinkage; weights sum to 100; missingness and unnecessary complexity remain explicit penalties; nearestOverall is ranked independently and style references search the full stable pool',
  matchAdjustments: {
    pace: 'Per-36 volume axes are converted to per-100 possessions using the player-season pace when available.',
    era: 'Each feature is centered on its weighted median and scaled by weighted median absolute deviation within league and season; this compares historical players relative to their same-era peers.',
    shrinkage: 'Before standardizing, each feature is pulled toward its league-season median by exposure/(exposure+prior): minutes with a 240-minute prior, MPG with a 20-game prior.',
    rawDisplay: 'These adjustments affect similarity and blend weights only. Multi-year side-by-side references show pooled actual rates and pooled shooting attempts, with the exact source periods disclosed.',
  },
  blendConfidence: '72% reconstructed-profile similarity plus 28% blend-weighted individual match quality, adjusted for feature coverage',
  scoreDistribution,
  blendDistribution,
  positionGate: false,
  minimumHistoricalMinutes: { NBA: 300, GLEAGUE: 200 },
  combineMeasurementsLoaded: combine.size,
  combineNote: combine.size
    ? 'Listed professional height/weight stay primary; official combine wingspan and standing reach are added where measured. Players who never attended keep those length fields blank.'
    : 'No combine measurement cache was present in this build. Height/weight still drive the physical block; wingspan/reach remain blank rather than invented.',
  limitations: [
    'NBA-equivalent G League comps apply empirical historical crossover translation before NBA matching. They describe translated statistical/style resemblance, not expected NBA performance or career outcome.',
    'NBA-equivalent comps exclude G League MPG from the match because G League role size is not an NBA minutes forecast.',
    'Statistical Blend Fit is a heuristic fit score, not a calibrated probability or a prediction of career potential. Reliability shrinkage reduces short-sample influence but does not eliminate uncertainty.',
    'G League historical inputs use Regular Season totals; the main database combines Regular Season and Showcase Cup. The target scope is identified above each blend.',
    'Historical physical profiles use available listed measurements, which are not necessarily measurements from the displayed season.',
    'Pace is adjusted where player-season pace is published; missing pace is not invented. League-season standardization reduces, but does not prove away, era effects.',
    'Historical shot-zone/tracking coverage is not uniform across seasons, so old player-seasons are compared on the common historical feature set rather than fabricated paint/mid-range data.',
    'G League historical body coverage is thinner for players who never appeared in the NBA player index.',
    'A player can match across listed positions; position labels are descriptive, not a hard filter.',
    'Representative periods maximize meaningful playing exposure rather than selecting a best-matching season for each target. They describe a stable career phase, not necessarily a whole career or a peak.',
    'Single-season careers may appear as explicitly limited overall references but cannot supply the independent style analogies.',
    'No-appearance roster records are not comparison targets; historical player references describe their own past production, not current ability, health, or expected return performance.',
  ],
};
fs.writeFileSync(DATA_PATH, JSON.stringify(data));
console.log(`player comps: NBA ${Object.keys(result.NBA).length}, G League ${Object.keys(result.GLEAGUE).length}; combine rows ${combine.size}`);

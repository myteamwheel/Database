// Canonical metadata for every field in the database.
//
// Restoring all 604 NBA / 345 G League raw fields made the app MORE confusing, not less: the
// same concept appears as an official value, a Basketball-Reference value, a total, a per-game,
// a per-36 and a per-100, and a bare key like `op100_reb` says none of that. Every field is
// therefore described by source, unit, basis, season scope and direction, and the interface
// reads this rather than guessing from the key.

/** Where a field came from. */
export const SOURCES = {
  off: { label: 'NBA Stats', detail: 'stats.nba.com league dashboard, season totals' },
  oadv: { label: 'NBA Stats · Advanced', detail: 'stats.nba.com Advanced measure type' },
  omisc: { label: 'NBA Stats · Misc', detail: 'stats.nba.com Misc measure type' },
  oscore: { label: 'NBA Stats · Scoring', detail: 'stats.nba.com Scoring measure type' },
  ousage: { label: 'NBA Stats · Usage', detail: 'stats.nba.com Usage measure type' },
  odef: { label: 'NBA Stats · Defense', detail: 'stats.nba.com Defense measure type' },
  obio: { label: 'NBA Stats · Bio', detail: 'stats.nba.com player bio dashboard' },
  op36: { label: 'NBA Stats · Per 36', detail: 'stats.nba.com Base, Per36 mode' },
  op100: { label: 'NBA Stats · Per 100', detail: 'stats.nba.com Base, Per100Possessions mode' },
  trk: { label: 'NBA Stats · Tracking', detail: 'stats.nba.com player tracking (NBA only, except catch-and-shoot / pull-up)' },
  hustle: { label: 'NBA Stats · Hustle', detail: 'stats.nba.com hustle stats (NBA only)' },
  split: { label: 'Season split', detail: 'the two halves of the G League season, kept separate for inspection' },
  bref: { label: 'Basketball-Reference', detail: 'second source; the only source of PER, win shares and the BPM/VORP family' },
  sit: { label: 'Situational split', detail: 'home/road, win/loss, starter/bench, pre/post All-Star, clutch' },
  calc: { label: 'Project-defined', detail: 'calculated here; not an official statistic' },
};

/** Unit vocabulary, so a "%" header never sits above a 0.612. */
export const UNITS = {
  count: { label: 'count', suffix: '' },
  perGame: { label: 'per game', suffix: '/g' },
  per36: { label: 'per 36 minutes', suffix: '/36' },
  per100: { label: 'per 100 possessions', suffix: '/100' },
  fraction: { label: 'fraction 0-1', suffix: '' },
  pctPoints: { label: 'percentage points', suffix: '%' },
  rating: { label: 'points per 100 possessions', suffix: '' },
  minutes: { label: 'minutes', suffix: 'min' },
  index: { label: 'index 0-100', suffix: '' },
  grade: { label: 'grade 0-9.9999', suffix: '' },
  text: { label: 'text', suffix: '' },
  years: { label: 'years', suffix: '' },
};

/** Matched against the field name with any source prefix stripped. */
const WORSE_WHEN_HIGHER = [
  /^tov/, /_tov$/, /turnover/, /^pf$/, /_pf$/, /^blka$/, /_blka$/,
  /def_rating$/, /^def_?rtg/, /^losses$/, /^l$/, /opp_pts/, /_pf_pct$/,
];
/** Volume, role and physical descriptors: more is not better or worse, it is context. */
const NEUTRAL = [
  /^usg/, /usg_pct$/, /^pace/, /_pace/, /^min$/, /_min$/, /^minutes$/, /^gp$/, /_gp$/, /^g$/,
  /^age$/, /height/, /weight/, /^poss$/, /_poss$/, /touches$/, /^fga/, /_fga$/, /^fg3a/, /_fg3a$/,
  /^fta$/, /_fta$/, /attempts$/, /^pct_fga/, /^pct_pts/, /^pct_ast/, /^pct_uast/, /_pct_fga/,
  /^jersey/, /^draft/, /time_of_poss/, /^w$/, /^wins$/, /_rank$/,
];

function directionOf(key) {
  const bare = key.replace(/^(off|oadv|omisc|oscore|ousage|odef|obio|op36|op100|trk|hustle|split|bref|sit)_/, '')
    .replace(/^(month\d+|home|road|wins|losses|starter|bench|preallstar|postallstar|clutch)_/, '');
  if (WORSE_WHEN_HIGHER.some((r) => r.test(bare))) return 'lower is better';
  if (NEUTRAL.some((r) => r.test(bare))) return 'context / neutral';
  return 'higher is better';
}

/**
 * Unit by semantics, not by whether a key happens to end in `_pct`. Derived split fields like
 * `sit_home_ts` are shooting percentages with no `_pct` suffix, and the old regex called them
 * counts.
 */
function guessUnit(key, sample) {
  if (typeof sample === 'string') return 'text';
  const bare = key.replace(/^(off|oadv|omisc|oscore|ousage|odef|obio|op36|op100|trk|hustle|split|bref|sit)_/, '')
    .replace(/^(month\d+|home|road|wins|losses|starter|bench|preallstar|postallstar|clutch)_/, '');
  if (/^op36_/.test(key)) return 'per36';
  if (/^op100_/.test(key)) return 'per100';
  if (/rating$|_rating$/i.test(bare)) return 'rating';
  if (/^(ts|efg|pie)$|_pct$|^pct_|pct$/i.test(bare)) {
    // A 0-1 sample is a fraction; a 0-100 one is already in percentage points.
    return typeof sample === 'number' && Math.abs(sample) > 1.5 ? 'pctPoints' : 'fraction';
  }
  if (/^(min|mpg|minutes)$/i.test(bare)) return 'minutes';
  if (/^(mpg|pts|reb|ast|stl|blk|tov|plusminus)$/i.test(bare) && /^sit_/.test(key)) return 'perGame';
  return 'count';
}

function sourceOf(key) {
  const m = key.match(/^(off|oadv|omisc|oscore|ousage|odef|obio|op36|op100|trk|hustle|split|bref|sit)_/);
  return m ? m[1] : 'calc';
}

/**
 * Season scope of a field. This is the one that silently corrupts analysis: on the G League
 * panel the headline line combines Regular Season and Showcase Cup, while Basketball-Reference
 * fields cover the regular season only.
 */
function scopeOf(key, league, blended) {
  if (league !== 'GLEAGUE') return 'full-season';
  if (key.startsWith('bref_')) return 'regular-season-only';
  // These two are pulled from the regular-season dashboard only and are NOT recombined across
  // the two halves, so labelling them as the combined season would let the Formula Lab mix them
  // with genuinely full-season fields without warning.
  if (key.startsWith('op36_') || key.startsWith('op100_')) return 'regular-season-only';
  if (key.startsWith('split_reg_')) return 'regular-season-only';
  if (key.startsWith('split_showcase_')) return 'showcase-only';
  if (key.startsWith('sit_')) return 'situational-split';
  return blended ? 'regular-season-plus-showcase' : 'full-season';
}

/** Human label for a raw key, e.g. `oadv_ts_pct` -> "NBA Stats · Advanced — TS Pct". */
export function labelFor(key) {
  const src = sourceOf(key);
  const body = key.replace(/^[a-z0-9]+_/, '').replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return src === 'calc' ? body : `${SOURCES[src].label} — ${body}`;
}

/** Build the catalog from the records themselves, so it can never drift from the data. */
export function buildCatalog(leagues) {
  const catalog = {};
  for (const [league, records] of Object.entries(leagues)) {
    const blended = records.some((r) => r.blendedSeason);
    const seen = new Map();
    for (const r of records) {
      for (const [k, v] of Object.entries(r.stats || {})) {
        if (!seen.has(k) && v !== null && v !== undefined) seen.set(k, v);
      }
    }
    for (const [key, sample] of seen) {
      const id = `${league}:stats.${key}`;
      const src = sourceOf(key);
      catalog[id] = {
        league,
        field: `stats.${key}`,
        label: labelFor(key),
        source: SOURCES[src].label,
        sourceDetail: SOURCES[src].detail,
        unit: guessUnit(key, sample),
        basis: /^op36_/.test(key) ? 'per 36 minutes'
          : /^op100_/.test(key) ? 'per 100 possessions'
          : /^(omisc|oscore)_/.test(key) ? 'per game'
          : 'season total or rate',
        seasonScope: scopeOf(key, league, blended),
        direction: directionOf(key),
      };
    }
  }
  return catalog;
}

/** Metadata for the normalized top-level fields, written by hand because they are the ones read most. */
export const TOP_LEVEL_CATALOG = {
  grade: { unit: 'grade', basis: 'per game', direction: 'higher is better', source: 'Project-defined' },
  rateGrade: { unit: 'grade', basis: 'per 36 minutes', direction: 'higher is better', source: 'Project-defined' },
  reliabilityWeight: { unit: 'pctPoints', basis: 'shrinkage weight', direction: 'higher is better', source: 'Project-defined' },
  pts: { unit: 'perGame', basis: 'per game', direction: 'higher is better', source: 'NBA Stats' },
  reb: { unit: 'perGame', basis: 'per game', direction: 'higher is better', source: 'NBA Stats' },
  ast: { unit: 'perGame', basis: 'per game', direction: 'higher is better', source: 'NBA Stats' },
  tov: { unit: 'perGame', basis: 'per game', direction: 'lower is better', source: 'NBA Stats' },
  ts: { unit: 'fraction', basis: 'season rate', direction: 'higher is better', source: 'NBA Stats' },
  efg: { unit: 'fraction', basis: 'season rate', direction: 'higher is better', source: 'NBA Stats' },
  usg: { unit: 'pctPoints', basis: 'season rate', direction: 'context', source: 'NBA Stats · Advanced' },
  pie: { unit: 'fraction', basis: 'season rate', direction: 'higher is better', source: 'NBA Stats · Advanced' },
  offRtg: { unit: 'rating', basis: 'team while on court', direction: 'higher is better', source: 'NBA Stats · Advanced' },
  defRtg: { unit: 'rating', basis: 'team while on court', direction: 'lower is better', source: 'NBA Stats · Advanced' },
  netRtg: { unit: 'rating', basis: 'team while on court', direction: 'higher is better', source: 'NBA Stats · Advanced' },
  per: { unit: 'count', basis: 'season rate', direction: 'higher is better', source: 'Basketball-Reference' },
  bpm: { unit: 'count', basis: 'per 100 possessions', direction: 'higher is better', source: 'Basketball-Reference' },
  vorp: { unit: 'count', basis: 'season total', direction: 'higher is better', source: 'Basketball-Reference' },
};

// Leakage-safe historical role features for future TULIP experiments.
// Every feature for an index game is computed from player-games on STRICTLY EARLIER dates.
// The current game's minutes, starter flag, box score, and result never enter its feature row.

export const ROLE_WINDOWS = [5, 10, 20];
export const ROLE_MINUTE_THRESHOLDS = [20, 24, 28, 32];

const BASE_SCHEMA = [
  'season', 'seasonType', 'indexDate', 'gameId', 'team', 'opponent',
  'priorGames', 'seasonPriorGames', 'restDays', 'teamChangedSincePreviousGame',
];
const WINDOW_FIELDS = [
  'games', 'mpg', 'minutesMedian', 'minutesSd', 'starterKnownGames', 'startShare',
  'pts36', 'reb36', 'ast36', 'stl36', 'blk36', 'tov36', 'plusMinusPg',
  'sameTeamShare', 'ge20Share', 'ge24Share', 'ge28Share', 'ge32Share',
];
export const ROLE_FEATURE_SCHEMA = [
  ...BASE_SCHEMA,
  ...ROLE_WINDOWS.flatMap((w) => WINDOW_FIELDS.map((k) => `w${w}_${k}`)),
];

function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function sd(values) {
  if (values.length < 2) return values.length ? 0 : null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}
function round(v, digits = 4) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function windowFeatures(prior, currentTeam, ix, n) {
  const rows = prior.slice(-n);
  if (!rows.length) return Object.fromEntries(WINDOW_FIELDS.map((k) => [k, null]));
  const get = (r, k) => r[ix[k]];
  const mins = rows.map((r) => Number(get(r, 'minutes')) || 0);
  const minutes = mins.reduce((a, b) => a + b, 0);
  const sum = (k) => rows.reduce((a, r) => a + (Number(get(r, k)) || 0), 0);
  const per36 = (k) => minutes > 0 ? 36 * sum(k) / minutes : null;
  const known = rows.filter((r) => typeof get(r, 'started') === 'boolean');
  const starts = known.filter((r) => get(r, 'started') === true).length;
  const out = {
    games: rows.length,
    mpg: round(minutes / rows.length),
    minutesMedian: round(median(mins)),
    minutesSd: round(sd(mins)),
    starterKnownGames: known.length,
    startShare: known.length ? round(starts / known.length) : null,
    pts36: round(per36('pts')), reb36: round(per36('reb')), ast36: round(per36('ast')),
    stl36: round(per36('stl')), blk36: round(per36('blk')), tov36: round(per36('tov')),
    plusMinusPg: round(sum('plusMinus') / rows.length),
    sameTeamShare: currentTeam ? round(rows.filter((r) => get(r, 'team') === currentTeam).length / rows.length) : null,
  };
  for (const t of ROLE_MINUTE_THRESHOLDS) out[`ge${t}Share`] = round(mins.filter((m) => m >= t).length / rows.length);
  return out;
}

/**
 * Build one feature row for every historical player-game. Rows with no prior games are retained
 * with null rolling values so keys remain one-to-one with the historical game product.
 * Same-date rows are computed together before any of them enter history, preventing same-day leak.
 */
export function buildRoleFeatureProduct(historyProduct, { generatedAt = historyProduct?.generatedAt || new Date().toISOString() } = {}) {
  if (!historyProduct || historyProduct.schemaVersion !== 1 || !Array.isArray(historyProduct.rowSchema) || !historyProduct.byPlayer) {
    throw new Error('Unsupported history game product');
  }
  const ix = Object.fromEntries(historyProduct.rowSchema.map((k, i) => [k, i]));
  for (const required of ['season','seasonType','gameDate','gameId','team','opponent','minutes','pts','reb','ast','stl','blk','tov','plusMinus','started']) {
    if (ix[required] === undefined) throw new Error(`history product missing ${required}`);
  }

  const byPlayer = {};
  let featureRows = 0;
  let zeroPriorRows = 0;
  let rowsWithKnownStarterHistory = 0;

  for (const [playerId, sourceRows] of Object.entries(historyProduct.byPlayer)) {
    const sorted = [...sourceRows].sort((a, b) => String(a[ix.gameDate]).localeCompare(String(b[ix.gameDate])) || String(a[ix.gameId]).localeCompare(String(b[ix.gameId])));
    const prior = [];
    const seasonCounts = new Map();
    const out = [];
    for (let pos = 0; pos < sorted.length;) {
      const date = String(sorted[pos][ix.gameDate]);
      let end = pos + 1;
      while (end < sorted.length && String(sorted[end][ix.gameDate]) === date) end++;
      const sameDate = sorted.slice(pos, end);
      const prev = prior[prior.length - 1] || null;

      for (const row of sameDate) {
        const season = row[ix.season];
        const team = row[ix.team];
        const base = [
          season, row[ix.seasonType], date, row[ix.gameId], team, row[ix.opponent],
          prior.length, seasonCounts.get(season) || 0,
          prev ? daysBetween(String(prev[ix.gameDate]), date) : null,
          prev ? prev[ix.team] !== team : null,
        ];
        const wf = [];
        let hasKnownStarterHistory = false;
        for (const w of ROLE_WINDOWS) {
          const f = windowFeatures(prior, team, ix, w);
          if ((f.starterKnownGames || 0) > 0) hasKnownStarterHistory = true;
          for (const key of WINDOW_FIELDS) wf.push(f[key]);
        }
        out.push([...base, ...wf]);
        if (!prior.length) zeroPriorRows++;
        if (hasKnownStarterHistory) rowsWithKnownStarterHistory++;
        featureRows++;
      }

      // Only now can same-date outcomes enter history.
      for (const row of sameDate) {
        prior.push(row);
        const season = row[ix.season];
        seasonCounts.set(season, (seasonCounts.get(season) || 0) + 1);
      }
      pos = end;
    }
    byPlayer[playerId] = out;
  }

  return {
    schemaVersion: 1,
    generatedAt,
    sourceHistoryGeneratedAt: historyProduct.generatedAt || null,
    featureTiming: 'strictly earlier game dates only; current and same-date outcomes excluded',
    windows: ROLE_WINDOWS,
    minuteThresholds: ROLE_MINUTE_THRESHOLDS,
    rowSchema: ROLE_FEATURE_SCHEMA,
    playerIndex: historyProduct.playerIndex || {},
    caveats: [
      'Feature store only; this is not a fitted TULIP Forecast and carries no predictive-performance claim.',
      'Starter-history denominators exclude null starter status; null is never treated as bench.',
      'Ordinary high-minute exposure is selected by coaching/context and is descriptive, not causal evidence.',
      'Availability, transaction, lineup and possession context are not fabricated when absent.',
    ],
    inventory: {
      players: Object.keys(byPlayer).length,
      featureRows,
      zeroPriorRows,
      rowsWithKnownStarterHistory,
    },
    byPlayer,
  };
}

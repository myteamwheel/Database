// Historical TULIP architecture — SCHEMA AND PIPELINE ONLY. No historical data is loaded yet,
// and nothing here fabricates any.
//
// The point of this file is that the leakage rules and the evidence tiers are decided BEFORE the
// data arrives, not retrofitted afterwards once results are visible. Every function below either
// operates on real inputs or returns an explicit "not available" marker.
//
// Why this is the gate for a predictive TULIP: the current engine compares a candidate against
// players who ALREADY occupy a big role. Those players are selected — they got the role because
// someone judged they deserved it. The audit shows the residual signature directly (comparables
// started far more of their games than candidates, worst-band SMD 0.798). Only role changes
// caused by something external to the player's own performance break that selection, and those
// are visible only at game level with absence and transaction context.

/** One row per player per game. The minimum needed for index-date features without leakage. */
export const GAME_ROW_SCHEMA = {
  season: 'string, e.g. 2024-25',
  gameId: 'string',
  gameDate: 'ISO date — the index date for every feature derived from it',
  playerId: 'official NBA person id',
  teamId: 'string',
  opponentTeamId: 'string',
  isHome: 'boolean',
  started: 'boolean',
  minutes: 'number',
  // Box score, per game, not cumulative.
  pts: 'number', reb: 'number', oreb: 'number', dreb: 'number', ast: 'number',
  stl: 'number', blk: 'number', tov: 'number', pf: 'number',
  fgm: 'number', fga: 'number', fg3m: 'number', fg3a: 'number', ftm: 'number', fta: 'number',
  plusMinus: 'number',
  usageRate: 'number, if the source provides it per game',
  restDays: 'number, days since the player\'s previous game',
  teamGameNumber: 'number, 1..82 within the season',
};

/** Availability, the input the opportunity-shock detector depends on. */
export const AVAILABILITY_ROW_SCHEMA = {
  season: 'string', gameId: 'string', gameDate: 'ISO date', teamId: 'string', playerId: 'string',
  status: 'ACTIVE | OUT | DNP_COACH | INACTIVE | SUSPENDED | REST',
  reason: 'free text from the source, retained verbatim',
  knownBeforeTipoff: 'boolean — REQUIRED. An absence learned after the game cannot inform a '
    + 'prediction made before it, and treating it as known is the classic leak in this design.',
};

export const TRANSACTION_ROW_SCHEMA = {
  date: 'ISO date', playerId: 'string', type: 'TRADE | SIGNING | WAIVER | TWO_WAY | CALL_UP | RELEASE',
  fromTeamId: 'string|null', toTeamId: 'string|null', source: 'url',
};

/**
 * Evidence tiers. A and C are currently unreachable; they become reachable only with the schemas
 * above. Tier weights are deliberately NOT set here — they must be fitted against out-of-sample
 * outcomes once history exists, not chosen by hand now.
 */
export const EVIDENCE_TIERS = {
  A: { label: 'Externally induced role expansion',
       requires: ['game rows', 'availability with knownBeforeTipoff', 'transactions'],
       definition: 'The player\'s minutes rose because an incumbent was unavailable for a reason '
         + 'decided before tip-off (injury, suspension, scheduled rest, trade, roster depletion). '
         + 'Closest thing to a natural experiment: the opportunity did not arrive because the '
         + 'player had been playing well.',
       available: false },
  B: { label: 'Planned or observed role change',
       requires: ['starter/bench splits'],
       definition: 'The player has a real sample both starting and off the bench, and the target '
         + 'sits inside that observed span.',
       available: true },
  C: { label: 'Ordinary high-minute game',
       requires: ['game rows'],
       definition: 'The player simply played more in some games. Heavily selected — a coach '
         + 'usually extends minutes when a player is already producing — so this is weak evidence '
         + 'and must never be weighted like Tier A.',
       available: false },
  D: { label: 'Extrapolation from comparables',
       requires: [],
       definition: 'No observed role change of this size for this player. Everything rests on '
         + 'other players who occupy the role.',
       available: true },
};

/**
 * Detect opportunity shocks. Returns [] when the required inputs are absent — it does not guess.
 *
 * A shock is recorded when an incumbent (a team-mate who had been playing a real role over the
 * prior window) is unavailable for a reason known before tip-off, and the candidate's minutes in
 * that game exceed his own recent baseline.
 */
export function detectOpportunityShocks({ gameRows, availability, priorWindow = 10, minJump = 6 }) {
  if (!Array.isArray(gameRows) || !gameRows.length) {
    return { available: false, reason: 'No game rows loaded. Requires GAME_ROW_SCHEMA data.', shocks: [] };
  }
  if (!Array.isArray(availability) || !availability.length) {
    return { available: false, reason: 'No availability rows loaded. Requires AVAILABILITY_ROW_SCHEMA data with knownBeforeTipoff.', shocks: [] };
  }
  const byTeamGame = new Map();
  for (const r of gameRows) {
    const k = `${r.teamId}|${r.gameId}`;
    if (!byTeamGame.has(k)) byTeamGame.set(k, []);
    byTeamGame.get(k).push(r);
  }
  const absencesByTeamGame = new Map();
  for (const a of availability) {
    if (a.status === 'ACTIVE') continue;
    if (a.knownBeforeTipoff !== true) continue;   // strict: unknown timing is not usable
    const k = `${a.teamId}|${a.gameId}`;
    if (!absencesByTeamGame.has(k)) absencesByTeamGame.set(k, []);
    absencesByTeamGame.get(k).push(a);
  }
  const history = new Map();   // playerId -> rows so far, in date order
  const shocks = [];
  const ordered = [...gameRows].sort((x, y) => String(x.gameDate).localeCompare(String(y.gameDate)));
  for (const row of ordered) {
    const prior = history.get(row.playerId) || [];
    const baseline = prior.slice(-priorWindow);
    const baseMin = baseline.length
      ? baseline.reduce((a, r) => a + (r.minutes || 0), 0) / baseline.length : null;
    const absents = absencesByTeamGame.get(`${row.teamId}|${row.gameId}`) || [];
    // Only incumbents count: a team-mate who was actually playing meaningful minutes before this.
    const incumbents = absents.filter((a) => {
      const h = (history.get(a.playerId) || []).slice(-priorWindow);
      if (h.length < 3) return false;
      return h.reduce((s, r) => s + (r.minutes || 0), 0) / h.length >= 15;
    });
    if (incumbents.length && baseMin !== null && (row.minutes || 0) - baseMin >= minJump) {
      shocks.push({
        tier: 'A', playerId: row.playerId, gameId: row.gameId, gameDate: row.gameDate,
        baselineMinutes: Math.round(baseMin * 10) / 10, gameMinutes: row.minutes,
        jump: Math.round(((row.minutes || 0) - baseMin) * 10) / 10,
        inducedBy: incumbents.map((a) => ({ playerId: a.playerId, status: a.status, reason: a.reason })),
      });
    }
    if (!history.has(row.playerId)) history.set(row.playerId, []);
    history.get(row.playerId).push(row);
  }
  return { available: true, shocks, priorWindow, minJump };
}

/**
 * Index-date features: everything known STRICTLY BEFORE `indexDate`. The filter is `<`, never
 * `<=`, so a prediction for a game can never see that game.
 */
export function featuresAsOf(gameRows, playerId, indexDate, { window = 20 } = {}) {
  const rows = gameRows
    .filter((r) => r.playerId === playerId && String(r.gameDate) < String(indexDate))
    .sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));
  if (!rows.length) return { available: false, reason: 'No prior games before the index date.' };
  const w = rows.slice(-window);
  const sum = (k) => w.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const min = sum('minutes');
  const per36 = (k) => (min > 0 ? (sum(k) * 36) / min : null);
  return {
    available: true, indexDate, gamesBefore: rows.length, windowGames: w.length,
    minutes: min, mpg: w.length ? min / w.length : null,
    startShare: w.length ? w.filter((r) => r.started).length / w.length : null,
    pts36: per36('pts'), reb36: per36('reb'), ast36: per36('ast'),
    stl36: per36('stl'), blk36: per36('blk'), tov36: per36('tov'),
    ts: (sum('fga') || sum('fta')) ? sum('pts') / (2 * (sum('fga') + 0.44 * sum('fta'))) : null,
    leakageRule: 'strictly < indexDate',
  };
}

/** Chronological folds. Random splits leak future seasons into training and are never used. */
export function chronologicalFolds(seasons) {
  const s = [...seasons].sort();
  const folds = [];
  for (let i = 1; i < s.length; i++) folds.push({ train: s.slice(0, i), test: s[i] });
  return folds;
}

/** Baselines TULIP must beat before any predictive claim is made. */
export const REQUIRED_BASELINES = [
  'pts per 36', 'rate composite from grade components', 'Rate Grade', 'Main Grade',
  'TS% + usage + age', 'linear regression on MPG + age + basic rates',
];

/** What is actually missing, machine-readable so the UI can state it without drifting. */
export function historicalReadiness(loaded = {}) {
  const need = {
    gameRows: 'multiple NBA seasons of per-player per-game rows',
    availability: 'per-game availability with knownBeforeTipoff',
    transactions: 'trades, signings, waivers, call-ups',
    lineups: 'possession or lineup data for a cleaner impact target and lineup interaction',
  };
  const missing = Object.entries(need).filter(([k]) => !loaded[k] || !loaded[k].length)
    .map(([k, v]) => ({ dataset: k, description: v }));
  return {
    ready: missing.length === 0,
    missing,
    reachableTiers: missing.length === 0 ? ['A', 'B', 'C', 'D'] : ['B', 'D'],
    forecastAvailable: false,
    note: missing.length
      ? 'TULIP Forecast is NOT built and must not be, until these exist and TULIP has been validated chronologically against the required baselines.'
      : 'Historical inputs present; chronological validation still required before any Forecast claim.',
  };
}

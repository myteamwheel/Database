const STAT_KEYS = ['min','pts','reb','oreb','dreb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta'];

const isFiniteNonNegative = (v) => Number.isFinite(v) && v >= 0;
const sum = (a,b) => a + b;

function validateTotals(totals, label, ftValue = 1) {
  if (!totals || typeof totals !== 'object') throw new Error(`${label} totals are required.`);
  for (const k of STAT_KEYS) {
    if (!isFiniteNonNegative(totals[k])) throw new Error(`${label} total ${k} cannot be negative or missing.`);
  }
  if (totals.fgm > totals.fga + 1e-9) throw new Error(`${label}: FGM exceeds FGA.`);
  if (totals.fg3m > totals.fg3a + 1e-9) throw new Error(`${label}: 3PM exceeds 3PA.`);
  if (totals.fg3m > totals.fgm + 1e-9) throw new Error(`${label}: 3PM exceeds FGM.`);
  if (totals.fg3a > totals.fga + 1e-9) throw new Error(`${label}: 3PA exceeds all field-goal attempts.`);
  if (totals.fgm-totals.fg3m > totals.fga-totals.fg3a + 1e-9) throw new Error(`${label}: Two-point makes exceed two-point attempts.`);
  if (totals.ftm > totals.fta + 1e-9) throw new Error(`${label}: FTM exceeds FTA.`);
  if (Math.abs(totals.reb - totals.oreb - totals.dreb) > 1e-8) throw new Error(`${label}: REB must equal OREB + DREB.`);
  if (Math.abs(totals.pts - (2*totals.fgm + totals.fg3m + totals.ftm*ftValue)) > 1e-8) throw new Error(`${label}: Points must reconcile with made shots.`);
}

function percentages(totals) {
  const fgPct = totals.fga > 0 ? totals.fgm / totals.fga : null;
  const fg3Pct = totals.fg3a > 0 ? totals.fg3m / totals.fg3a : null;
  const ftPct = totals.fta > 0 ? totals.ftm / totals.fta : null;
  const tsDen = 2 * (totals.fga + 0.44 * totals.fta);
  const ts = tsDen > 0 ? totals.pts / tsDen : null;
  return { fgPct, fg3Pct, ftPct, ts };
}

function perGameFromTotals(totals, gp) {
  const pg = {};
  for (const k of STAT_KEYS) pg[k === 'min' ? 'mpg' : k] = gp > 0 ? totals[k] / gp : 0;
  return { ...pg, ...percentages(totals) };
}

function totalsFromPerGame(perGame, gp, ftValue) {
  if (!perGame || typeof perGame !== 'object') throw new Error('Remaining per-game forecast is required.');
  const totals = {};
  for (const k of STAT_KEYS) {
    const src = k === 'min' ? 'mpg' : k;
    const v = perGame[src];
    if (!isFiniteNonNegative(v)) throw new Error(`Remaining per-game field ${src} cannot be negative or missing.`);
    totals[k] = v * gp;
  }
  validateTotals(totals, 'remaining', ftValue);
  return totals;
}

/**
 * Combine completed actual totals with an explicit remaining-season forecast.
 *
 * This helper intentionally does not infer team games elapsed, availability, or injuries.
 * Callers must supply them so actual-to-date, remaining-season and combined full-season
 * outputs cannot silently mix incompatible denominators.
 */
export function combineForecastTimeframes({ season, asOf, scheduledGames, actual, remaining, ftValue = 1 }) {
  if (!Number.isFinite(ftValue) || ftValue <= 0) throw new Error('Free throw value must be positive.');
  if (!season) throw new Error('Forecast season is required.');
  if (!asOf || Number.isNaN(Date.parse(asOf))) throw new Error('A valid as-of date is required.');
  if (!Number.isInteger(scheduledGames) || scheduledGames <= 0) throw new Error('Scheduled games must be a positive integer.');
  if (!actual || !Number.isInteger(actual.teamGamesElapsed) || actual.teamGamesElapsed < 0) {
    throw new Error('Actual team games elapsed must be a non-negative integer.');
  }
  if (actual.teamGamesElapsed > scheduledGames) throw new Error('Team games elapsed cannot exceed scheduled games.');
  if (!Number.isInteger(actual.gp) || actual.gp < 0 || actual.gp > actual.teamGamesElapsed) {
    throw new Error('Actual player games cannot exceed team games elapsed.');
  }
  validateTotals(actual.totals, 'actual', ftValue);
  if (actual.gp === 0 && STAT_KEYS.some(k => actual.totals[k] !== 0)) throw new Error('Zero actual games cannot have positive totals.');

  const teamGamesRemaining = scheduledGames - actual.teamGamesElapsed;
  if (!remaining || !Number.isFinite(remaining.gp) || remaining.gp < 0 || remaining.gp > teamGamesRemaining) {
    throw new Error('Projected remaining player games cannot exceed remaining team games.');
  }
  const remainingTotals = totalsFromPerGame(remaining.perGame, remaining.gp, ftValue);
  const fullTotals = Object.fromEntries(STAT_KEYS.map((k) => [k, sum(actual.totals[k], remainingTotals[k])]));
  validateTotals(fullTotals, 'combined', ftValue);

  const fullGp = actual.gp + remaining.gp;
  const status = teamGamesRemaining === 0 ? 'final' : 'interim';

  return {
    season,
    asOf,
    status,
    scheduledGames,
    actualToDate: {
      teamGamesElapsed: actual.teamGamesElapsed,
      gp: actual.gp,
      totals: { ...actual.totals },
      perGame: perGameFromTotals(actual.totals, actual.gp),
    },
    remainingSeason: {
      teamGamesRemaining,
      gp: remaining.gp,
      totals: remainingTotals,
      perGame: { ...remaining.perGame, ...percentages(remainingTotals) },
    },
    fullSeason: {
      teamGames: scheduledGames,
      gp: fullGp,
      totals: fullTotals,
      perGame: perGameFromTotals(fullTotals, fullGp),
    },
  };
}

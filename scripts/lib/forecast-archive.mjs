import crypto from 'node:crypto';
import { actualLine, historyBefore, prevSeason } from './projection.mjs';

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function projectionIdentity(league, player) {
  const lg = String(league || '').toUpperCase();
  const id = player?.nbaPersonId ?? player?.playerId;
  if (!lg || id === null || id === undefined || id === '') {
    throw new Error('Forecast archive player identity requires league and canonical player id.');
  }
  return `${lg}:${id}`;
}

export function extractArchivedPlayer(league, player) {
  const proj = player?.proj;
  if (!proj) throw new Error(`Cannot archive ${player?.name || 'player'} without projection or abstention.`);

  const row = {
    identity: projectionIdentity(league, player),
    league: String(league).toUpperCase(),
    playerId: player.playerId ?? null,
    nbaPersonId: player.nbaPersonId ?? null,
    name: player.name ?? null,
    forecastTeam: proj.team ?? player.team ?? null,
    status: proj.status ?? null,
    basis: proj.basis ?? null,
    age: Number.isFinite(proj.age) ? proj.age : (Number.isFinite(player.age) ? player.age : null),
  };

  if (proj.abstain) {
    if (!proj.reason) throw new Error(`${row.identity}: abstention requires a reason.`);
    return { ...row, abstain: true, reason: String(proj.reason) };
  }

  return { ...row, abstain: false, projection: clone(proj) };
}

function near(a, b, tolerance = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function validateProjectedRow(row) {
  const p = row.projection;
  if (!p || typeof p !== 'object') throw new Error(`${row.identity}: projected row is missing projection data.`);

  for (const [key, value] of Object.entries(p)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${row.identity}: projection field ${key} is not finite.`);
    }
  }

  const a = p.accounting;
  if (!a || typeof a !== 'object') throw new Error(`${row.identity}: projection accounting is required.`);
  for (const key of ['pts', 'reb', 'oreb', 'dreb', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta']) {
    if (!Number.isFinite(a[key])) throw new Error(`${row.identity}: accounting ${key} is not finite.`);
  }

  if (a.fgm > a.fga + 1e-9) throw new Error(`${row.identity}: FGM exceeds FGA.`);
  if (a.fg3m > a.fg3a + 1e-9) throw new Error(`${row.identity}: FG3M/3PM exceeds FG3A/3PA.`);
  if (a.ftm > a.fta + 1e-9) throw new Error(`${row.identity}: FTM exceeds FTA.`);
  if (a.fg3m > a.fgm + 1e-9) throw new Error(`${row.identity}: FG3M exceeds FGM.`);
  if (!near(a.reb, a.oreb + a.dreb, 1e-6)) {
    throw new Error(`${row.identity}: rebound accounting mismatch (REB != OREB + DREB).`);
  }

  const ftValue = Number.isFinite(a.ftValue) ? a.ftValue : 1;
  const points = 2 * (a.fgm - a.fg3m) + 3 * a.fg3m + a.ftm * ftValue;
  if (!near(a.pts, points, 1e-6)) {
    throw new Error(`${row.identity}: points accounting mismatch (PTS does not match made shots/free throws).`);
  }
}

export function validateArchive(archive) {
  if (!archive || typeof archive !== 'object') throw new Error('Forecast archive must be an object.');
  if (!archive.leagues || typeof archive.leagues !== 'object') throw new Error('Forecast archive requires leagues.');

  const seen = new Set();
  const byLeague = {};
  let projected = 0;
  let abstained = 0;

  for (const league of ['NBA', 'GLEAGUE']) {
    const rows = archive.leagues[league] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${league}: archive league payload must be an array.`);
    const counts = { total: rows.length, projected: 0, abstained: 0 };

    for (const row of rows) {
      const expected = projectionIdentity(league, row);
      if (row.identity !== expected) {
        throw new Error(`${league}: identity ${row.identity} does not match canonical identity ${expected}.`);
      }
      if (seen.has(row.identity)) throw new Error(`Duplicate forecast archive identity: ${row.identity}`);
      seen.add(row.identity);

      if (row.abstain) {
        if (!row.reason) throw new Error(`${row.identity}: abstention requires a reason.`);
        if ('projection' in row) throw new Error(`${row.identity}: abstention cannot contain a numeric projection.`);
        counts.abstained++;
        abstained++;
      } else {
        validateProjectedRow(row);
        counts.projected++;
        projected++;
      }
    }
    byLeague[league] = counts;
  }

  return { projected, abstained, byLeague };
}


const BASELINE_FIELDS = ['mpg', 'pts', 'reb', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fga', 'fg3a', 'fta', 'fgm', 'fg3m', 'ftm'];

export function nbaBaselines(D, pid, targetSeason) {
  const league = D?.nba;
  if (!league?.seasons || typeof league.teamGames !== 'function') {
    throw new Error('NBA baseline calculation requires prepared NBA season history.');
  }
  const hist = historyBefore(league, Number(pid), targetSeason);
  const last = hist.find(Boolean);
  if (!last) return { repeat: null, avg3: null, evidence: { seasons: [] } };

  const idx = hist.indexOf(last);
  const repeat = actualLine(last);
  const lastSeason = prevSeason(targetSeason, idx + 1);
  repeat.gp = Math.min(1, last.gp / league.teamGames(lastSeason, last.team)) * 82;

  const weights = [5, 4, 3];
  const lines = hist.map((row) => row ? actualLine(row) : null);
  const den = hist.reduce((sum, row, i) => sum + (row ? weights[i] * row.gp : 0), 0);
  const avg3 = {};
  for (const key of BASELINE_FIELDS) {
    let sum = 0;
    hist.forEach((row, i) => {
      if (row) sum += weights[i] * row.gp * lines[i][key];
    });
    avg3[key] = sum / den;
  }

  const weightedTotal = (key) => hist.reduce((sum, row, i) =>
    sum + (row ? weights[i] * row[key] : 0), 0);
  avg3.fgPct = weightedTotal('fga') > 0 ? weightedTotal('fgm') / weightedTotal('fga') : null;
  avg3.fg3Pct = weightedTotal('fg3a') > 0 ? weightedTotal('fg3m') / weightedTotal('fg3a') : null;
  avg3.ftPct = weightedTotal('fta') > 0 ? weightedTotal('ftm') / weightedTotal('fta') : null;

  let weightedShare = 0;
  let weightSum = 0;
  hist.forEach((row, i) => {
    if (!row) return;
    weightedShare += weights[i] * Math.min(1, row.gp / league.teamGames(prevSeason(targetSeason, i + 1), row.team));
    weightSum += weights[i];
  });
  avg3.gp = (weightedShare / weightSum) * 82;

  return {
    repeat,
    avg3,
    evidence: {
      method: 'pre-existing-backtest-baselines',
      weights,
      seasons: hist.map((row, i) => row ? {
        season: row.season || prevSeason(targetSeason, i + 1),
        team: row.team,
        gp: row.gp,
        weight: weights[i],
      } : null).filter(Boolean),
    },
  };
}

export function gleagueBaseline(D, pid, targetSeason, games) {
  const league = D?.gleague;
  if (!league?.seasons) throw new Error('G League baseline calculation requires prepared G League season history.');
  const hist = historyBefore(league, Number(pid), targetSeason);
  const last = hist.find(Boolean);
  if (!last) return { repeat: null, evidence: { seasons: [] } };
  const repeat = actualLine(last);
  return {
    repeat,
    evidence: {
      method: 'pre-existing-repeat-baseline',
      games,
      season: last.season || prevSeason(targetSeason, hist.indexOf(last) + 1),
      team: last.team,
      gp: last.gp,
    },
  };
}


const SCORE_METRICS = ['gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m', 'fgPct', 'fg3Pct', 'ftPct'];
const PCT_ATTEMPTS = { fgPct: ['fga', 100], fg3Pct: ['fg3a', 50], ftPct: ['fta', 50] };
const COHORT_ORDER = [
  'rookie',
  'recent-history-veteran',
  'older-history-returner',
  'same-team',
  'new-team',
  'unsigned-at-forecast',
  'age-23-and-under',
  'age-33-and-over',
  'prior-high-minutes',
  'prior-lower-minutes',
];

export function deriveCohorts(player) {
  const out = [];
  const rookie = player?.status === 'rookie' || player?.basis === 'rookie-cohort-fallback';
  if (rookie) out.push('rookie');
  if (!rookie && player?.basis === 'multi-year-history') out.push('recent-history-veteran');
  if (player?.basis === 'older-history-fallback') out.push('older-history-returner');
  if (player?.status === 'same') out.push('same-team');
  if (player?.status === 'new') out.push('new-team');
  if (player?.status === 'unsigned') out.push('unsigned-at-forecast');
  if (Number.isFinite(player?.age) && player.age <= 23) out.push('age-23-and-under');
  if (Number.isFinite(player?.age) && player.age >= 33) out.push('age-33-and-over');
  const lastMpg = player?.projection?.why?.minutes?.last;
  if (Number.isFinite(lastMpg)) out.push(lastMpg >= 24 ? 'prior-high-minutes' : 'prior-lower-minutes');
  return COHORT_ORDER.filter((name) => out.includes(name));
}

function eligibleMetric(metric, actual, interim) {
  if (metric === 'gp' && interim) return false;
  if (!Number.isFinite(actual?.[metric])) return false;
  const rule = PCT_ATTEMPTS[metric];
  if (!rule) return true;
  const [attemptKey, minimum] = rule;
  return Number.isFinite(actual?.gp)
    && Number.isFinite(actual?.[attemptKey])
    && actual.gp * actual[attemptKey] >= minimum;
}

function statsFromErrors(errors) {
  if (!errors.length) return { available: false, n: 0 };
  const n = errors.length;
  const abs = errors.reduce((sum, e) => sum + Math.abs(e), 0);
  const sq = errors.reduce((sum, e) => sum + e * e, 0);
  const bias = errors.reduce((sum, e) => sum + e, 0);
  return { available: true, n, mae: abs / n, rmse: Math.sqrt(sq / n), bias: bias / n };
}

function modelMetric(rows, actualByIdentity, metric, interim) {
  const errors = [];
  for (const row of rows) {
    const actual = actualByIdentity.get(row.identity);
    const forecast = row?.projection?.[metric];
    if (!Number.isFinite(forecast) || !eligibleMetric(metric, actual, interim)) continue;
    errors.push(forecast - actual[metric]);
  }
  return statsFromErrors(errors);
}

function pairedMetric(rows, actualByIdentity, metric, baselineName, interim) {
  const modelErrors = [];
  const baselineErrors = [];
  for (const row of rows) {
    const actual = actualByIdentity.get(row.identity);
    const model = row?.projection?.[metric];
    const baseline = row?.baselines?.[baselineName]?.[metric];
    if (!Number.isFinite(model) || !Number.isFinite(baseline) || !eligibleMetric(metric, actual, interim)) continue;
    modelErrors.push(model - actual[metric]);
    baselineErrors.push(baseline - actual[metric]);
  }
  if (!modelErrors.length) return { available: false, n: 0 };
  return {
    available: true,
    n: modelErrors.length,
    model: statsFromErrors(modelErrors),
    baseline: statsFromErrors(baselineErrors),
  };
}

function scoreGroup(rows, actualByIdentity, league, interim) {
  const metrics = SCORE_METRICS.filter((metric) => !(interim && metric === 'gp'));
  const model = {};
  for (const metric of metrics) model[metric] = modelMetric(rows, actualByIdentity, metric, interim);
  const paired = {};
  const baselineNames = league === 'NBA' ? ['repeat', 'avg3'] : ['repeat'];
  for (const baselineName of baselineNames) {
    paired[baselineName] = {};
    for (const metric of metrics) paired[baselineName][metric] = pairedMetric(rows, actualByIdentity, metric, baselineName, interim);
  }
  return { model, paired };
}

function actualIdentityMap(league, rows) {
  if (!Array.isArray(rows)) throw new Error(`${league}: actual-results league payload must be an array.`);
  const map = new Map();
  for (const row of rows) {
    const identity = projectionIdentity(league, row);
    if (map.has(identity)) throw new Error(`${league}: duplicate actual-results identity ${identity}.`);
    map.set(identity, row);
  }
  return map;
}

function baselineCoverage(rows, league) {
  const result = { repeat: rows.filter((row) => row?.baselines?.repeat).length };
  if (league === 'NBA') result.avg3 = rows.filter((row) => row?.baselines?.avg3).length;
  return result;
}

export function scoreArchive(archive, actuals, { interim = false } = {}) {
  if (!archive?.season || !actuals?.season || archive.season !== actuals.season) {
    throw new Error(`Forecast season ${archive?.season || 'missing'} does not match actual season ${actuals?.season || 'missing'}.`);
  }
  if (!actuals?.asOf || Number.isNaN(Date.parse(actuals.asOf))) {
    throw new Error('Actual-results input requires a valid asOf date.');
  }
  if (!['final', 'interim'].includes(actuals?.status)) {
    throw new Error('Actual-results status must be final or interim.');
  }
  if (actuals.status === 'interim' && !interim) {
    throw new Error('Interim actual results require explicit interim scoring mode.');
  }
  if (actuals.status === 'final' && interim) {
    throw new Error('Interim scoring mode cannot be used with final actual results.');
  }

  const report = {
    forecastId: archive.forecastId ?? null,
    season: archive.season,
    actuals: { asOf: actuals.asOf, status: actuals.status },
    leagues: {},
  };

  for (const league of ['NBA', 'GLEAGUE']) {
    const archivedRows = Array.isArray(archive?.leagues?.[league]) ? archive.leagues[league] : [];
    const projectedRows = archivedRows.filter((row) => !row.abstain && row.projection);
    const actualByIdentity = actualIdentityMap(league, actuals?.leagues?.[league] ?? []);
    const matchedActuals = projectedRows.filter((row) => actualByIdentity.has(row.identity)).length;
    const leagueReport = {
      coverage: {
        archived: archivedRows.length,
        projected: projectedRows.length,
        abstained: archivedRows.length - projectedRows.length,
        matchedActuals,
        missingActuals: projectedRows.length - matchedActuals,
        baselineAvailable: baselineCoverage(projectedRows, league),
      },
      overall: scoreGroup(projectedRows, actualByIdentity, league, actuals.status === 'interim'),
      cohorts: {},
    };

    for (const cohort of COHORT_ORDER) {
      const rows = projectedRows.filter((row) => deriveCohorts(row).includes(cohort));
      if (!rows.length) continue;
      leagueReport.cohorts[cohort] = {
        archivedPlayers: rows.length,
        ...scoreGroup(rows, actualByIdentity, league, actuals.status === 'interim'),
      };
    }
    report.leagues[league] = leagueReport;
  }

  return report;
}

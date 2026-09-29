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

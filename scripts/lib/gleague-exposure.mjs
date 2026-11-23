// The season dashboard can retain an appearance after the official box is revised to a DNP.
const countingFields = 'PTS FGM FGA FG3M FG3A FTM FTA OREB DREB REB AST STL BLK TOV PF PLUS_MINUS'.split(' ');
export const traditionalBoxUrl = gameId =>
  'https://stats.gleague.nba.com/stats/boxscoretraditionalv2?' +
  new URLSearchParams({ GameID: gameId, StartPeriod: 0, EndPeriod: 0, StartRange: 0, EndRange: 0, RangeType: 0 });

function records(table) {
  if (!Array.isArray(table?.headers) || !Array.isArray(table.rowSet)) throw Error('Missing G League box score table');
  return table.rowSet.map(row => {
    if (row.length !== table.headers.length) throw Error('Malformed G League box score');
    return Object.fromEntries(table.headers.map((key, i) => [key, row[i]]));
  });
}

export async function verifyMissingDashboardMinutes(phase, logged, playerIds, loadBox, loadBoxV3) {
  const teamLog = new Map(records(phase.teamGameLog.resultSets[0]).map(row => [row.GAME_ID+':'+row.TEAM_ID,row]));
  const result = [];
  for (const playerId of playerIds) {
    const games = [], excluded = [];
    for (const entry of logged.get(playerId).games) {
      const gameId = entry.GAME_ID;
      const box = await loadBox(gameId);
      const team = records(box.resultSets?.find(t => t.name === 'TeamStats'))
        .find(t => t.TEAM_ID === entry.TEAM_ID && t.GAME_ID === gameId);
      const matches = records(box.resultSets?.find(t => t.name === 'PlayerStats')).filter(p => p.PLAYER_ID === playerId);
      const line = matches[0], time = /^(\d+):([0-5]\d)$/.exec(line?.MIN ?? '');
      const teamPoints = teamLog.get(gameId+':'+entry.TEAM_ID)?.PTS;
      if (box.parameters?.GameID === gameId && team?.PTS === teamPoints && !matches.length && entry.MIN === 0 && entry.PTS === 0) {
        const alternate = (await loadBoxV3(gameId)).boxScoreTraditional;
        const side = [alternate?.homeTeam, alternate?.awayTeam].find(t => t?.teamId === entry.TEAM_ID);
        if (alternate?.gameId === gameId && side?.statistics?.points === teamPoints
          && Array.isArray(side.players) && side.players.length >= 5 && !side.players.some(p => p.personId === playerId)) {
          excluded.push(gameId);
          continue;
        }
      }
      if (box.parameters?.GameID !== gameId || !team || team.PTS !== teamLog.get(gameId+':'+entry.TEAM_ID)?.PTS
        || matches.length !== 1 || line.GAME_ID !== gameId || line.TEAM_ID !== entry.TEAM_ID || line.COMMENT || !time
        || countingFields.some(k => !Number.isFinite(entry[k]) || line[k === 'TOV' ? 'TO' : k] !== entry[k])) {
        throw Error('Cannot verify missing G League dashboard minutes for ' + playerId + ' in ' + gameId);
      }
      const seconds = Number(time[1]) * 60 + Number(time[2]);
      if (!seconds) throw Error('Missing positive G League playing time in ' + gameId);
      games.push({ gameId, seconds });
    }
    result.push({ playerId, games, excluded });
  }
  return result;
}

export async function reconcileDashboardExposure(phase, logged, loadBox) {
  const table = phase.stats.resultSets[0];
  const ix = Object.fromEntries(table.headers.map((key, i) => [key, i]));
  const rows = table.rowSet.slice(), corrections = [], boxes = new Map();
  for (const [index, row] of rows.entries()) {
    const playerId = row[ix.PLAYER_ID], teamId = row[ix.TEAM_ID], log = logged.get(playerId);
    if (!log || row[ix.GP] <= log.GP) continue;
    if (row[ix.TEAM_COUNT] !== 1 || log.games.some(g => g.TEAM_ID !== teamId)) {
      throw Error('Cannot resolve multi-team appearance discrepancy for ' + playerId);
    }
    const byId = new Map(log.games.map(g => [g.GAME_ID, g]));
    const games = records(phase.teamGameLog.resultSets[0]).filter(g => g.TEAM_ID === teamId);
    const played = [], dnps = [];
    let seconds = 0;
    for (const game of games) {
      const id = game.GAME_ID;
      if (!boxes.has(id)) boxes.set(id, await loadBox(id));
      const box = boxes.get(id);
      const result = name => records(box.resultSets?.find(t => t.name === name));
      const team = result('TeamStats').filter(t => t.TEAM_ID === teamId);
      if (box.parameters?.GameID !== id || team.length !== 1 || team[0].GAME_ID !== id || team[0].PTS !== game.PTS) {
        throw Error('Individual box and final team result disagree for ' + id);
      }
      const lines = result('PlayerStats').filter(p => p.PLAYER_ID === playerId);
      const line = lines[0], entry = byId.get(id);
      if (lines.length > 1 || (line && (line.GAME_ID !== id || line.TEAM_ID !== teamId))) throw Error('Conflicting player identity in box ' + id);
      if (!line && !entry) continue;
      if (!entry && line && !line.MIN && /^DNP\b/i.test(line.COMMENT) &&
          countingFields.every(k => line[k === 'TOV' ? 'TO' : k] == null || line[k === 'TOV' ? 'TO' : k] === 0)) {
        dnps.push(id);
        continue;
      }
      const time = /^(\d+):([0-5]\d)$/.exec(line?.MIN ?? '');
      if (!entry || !time || line.COMMENT || countingFields.some(k => !Number.isFinite(entry[k]) || line[k === 'TOV' ? 'TO' : k] !== entry[k])) {
        throw Error('Player log and individual box disagree for ' + playerId + ' in ' + id);
      }
      seconds += Number(time[1]) * 60 + Number(time[2]);
      played.push(id);
    }
    if (played.length !== log.GP || dnps.length < row[ix.GP] - log.GP) throw Error('Insufficient DNP evidence for ' + playerId);
    const wins = log.games.filter(g => g.WL === 'W').length;
    const values = { GP: log.GP, W: wins, L: log.GP - wins, W_PCT: wins / log.GP, MIN: seconds / 60 };
    for (const field of countingFields) values[field] = log.games.reduce((n, g) => n + g[field], 0);
    const identity = new Set(['PLAYER_ID','PLAYER_NAME','NICKNAME','TEAM_ID','TEAM_ABBREVIATION','AGE','TEAM_COUNT']);
    // Only retain measured totals or identity fields. Derived fields are rebuilt from the corrected counts.
    rows[index] = table.headers.map((key, i) => identity.has(key) ? row[i] : values[key] ?? null);
    corrections.push({ playerId, dashboardGP: row[ix.GP], finalGP: log.GP, seconds, played, dnps });
  }
  if (!corrections.length) return phase.stats;
  return { ...phase.stats, exposureCorrections: corrections, resultSets: [{ ...table, rowSet: rows }, ...phase.stats.resultSets.slice(1)] };
}

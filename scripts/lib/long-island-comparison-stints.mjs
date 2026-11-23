export const longIslandTeamId = 1612709921;
const boxFields = 'PTS FGM FGA FG3M FG3A FTM FTA OREB DREB REB AST STL BLK TOV PF'.split(' ');
const blank = () => ({ games: {}, MIN: 0, ...Object.fromEntries(boxFields.map(key => [key, 0])) });

export function longIslandCurrentStints(snapshot, players) {
  const stints = new Map();
  const byId = new Map(players.map(player => [String(player.nbaPersonId ?? player.playerId), player]));
  for (const phase of snapshot.phases) {
    const { headers, rowSet } = phase.gameLog.resultSets[0];
    const index = Object.fromEntries(headers.map((key, i) => [key, i]));
    const appearances = new Map();
    const playedForOtherTeam = new Set();
    for (const row of rowSet) {
      const id = String(row[index.PLAYER_ID]);
      if (row[index.TEAM_ID] !== longIslandTeamId) {
        playedForOtherTeam.add(id);
        continue;
      }
      const stint = appearances.get(id) ?? blank();
      stint.games[phase.apiSeasonType] = (stint.games[phase.apiSeasonType] ?? 0) + 1;
      for (const key of ['MIN', ...boxFields]) stint[key] += row[index[key]];
      appearances.set(id, stint);
    }
    for (const [id, line] of appearances) {
      const actual = byId.get(id)?.gLeagueSeasonActual?.phases?.[phase.apiSeasonType];
      const games = line.games[phase.apiSeasonType];
      const exactMinutes = !playedForOtherTeam.has(id) && actual?.gp === games && Number.isFinite(actual?.totals?.min);
      const total = stints.get(id) ?? blank();
      total.MIN += exactMinutes ? actual.totals.min : line.MIN;
      total.roundedMinutes ||= !exactMinutes || Boolean(actual?.roundedMinutesGame);
      total.games[phase.apiSeasonType] = games;
      for (const key of boxFields) total[key] += line[key];
      stints.set(id, total);
    }
  }
  return Object.fromEntries([...stints].filter(([, row]) => row.MIN >= 1));
}

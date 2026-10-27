import { combineForecastTimeframes } from './forecast-timeframes.mjs';

export const SEASON_PROGRESS_VERSION = 1;
const TEAMS = 'ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split(' ');
const STATS = {min:'MIN',pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
const zero = () => Object.fromEntries(Object.keys(STATS).map(k => [k,0]));

export function parseSeasonProgress(schedule, stats, {season, fetchedAt} = {}) {
  if (!/^\d{4}-\d{2}$/.test(season || '') || Number(season.slice(5)) !== (Number(season.slice(0,4))+1)%100) throw new Error('Invalid season');
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid fetch date');
  if (schedule?.leagueSchedule?.seasonYear !== season || schedule.leagueSchedule.leagueId !== '00') throw new Error('Schedule season/league mismatch');
  if (!Array.isArray(schedule.leagueSchedule.gameDates)) throw new Error('Missing schedule');
  const teams = Object.fromEntries(TEAMS.map(t => [t,{completed:0,scheduled:0}]));
  const ids = new Set();
  let completedGames = 0;
  let completedPoints = 0;
  for (const day of schedule.leagueSchedule.gameDates) {
    if (!Array.isArray(day.games)) throw new Error('Malformed schedule date');
    for (const game of day.games) {
      // Preseason, playoffs and the Cup final do not count in regular-season totals.
      if (!String(game.gameId).startsWith(`002${season.slice(2,4)}`)) continue;
      if (ids.has(game.gameId)) throw new Error('Duplicate scheduled game');
      ids.add(game.gameId);
      if (![1,2,3].includes(game.gameStatus)) throw new Error('Unknown game status');
      const home=game.homeTeam?.teamTricode, away=game.awayTeam?.teamTricode;
      // Future Cup placeholders can lack participants; completed games cannot.
      if (!teams[home] || !teams[away]) {
        if (game.gameStatus===3) throw new Error('Completed game has unknown participants');
        continue;
      }
      if (home===away) throw new Error('Schedule repeats a team');
      for (const team of [home,away]) {
        teams[team].scheduled++;
        if (game.gameStatus===3) teams[team].completed++;
      }
      if (game.gameStatus===3) {
        if (!Number.isFinite(Date.parse(game.gameDateTimeUTC)) || Date.parse(game.gameDateTimeUTC)>Date.parse(fetchedAt)) throw new Error('Future completed game');
        if (![game.homeTeam.score,game.awayTeam.score].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('Invalid final score');
        completedPoints+=game.homeTeam.score+game.awayTeam.score;
        completedGames++;
      }
    }
  }
  if (!ids.size || Object.values(teams).some(t=>!t.scheduled || t.scheduled>82 || t.completed>82)) throw new Error('Incomplete or invalid NBA schedule');
  const table=stats?.resultSets?.find(t=>t.name==='LeagueDashPlayerStats') || stats?.resultSets?.[0];
  if (!Array.isArray(table?.headers) || !Array.isArray(table?.rowSet) || new Set(table.headers).size!==table.headers.length) throw new Error('Invalid player totals table');
  const required=['PLAYER_ID','GP',...Object.values(STATS)];
  if (required.some(k=>!table.headers.includes(k))) throw new Error('Missing player totals columns');
  const players={};
  for (const row of table.rowSet) {
    if (!Array.isArray(row) || row.length!==table.headers.length) throw new Error('Malformed player totals row');
    const r=Object.fromEntries(table.headers.map((h,i)=>[h,row[i]]));
    if (!Number.isSafeInteger(r.PLAYER_ID) || r.PLAYER_ID<=0 || players[r.PLAYER_ID]) throw new Error('Invalid/duplicate player identity');
    if (!Number.isSafeInteger(r.GP) || r.GP<0 || r.GP>completedGames) throw new Error('Invalid player games');
    const totals=Object.fromEntries(Object.entries(STATS).map(([key,column])=>[key,r[column]]));
    // Reuse independently tested shot/rebound accounting, allowing only rounding of NBA MIN.
    combineForecastTimeframes({season,asOf:fetchedAt,scheduledGames:Math.max(82,r.GP),actual:{gp:r.GP,teamGamesElapsed:Math.max(r.GP,...Object.values(teams).map(t=>t.completed)),totals},remaining:{gp:0,perGame:{...zero(),mpg:0}}});
    players[r.PLAYER_ID]={gp:r.GP,totals};
  }
  if (completedGames>0 && !Object.keys(players).length) throw new Error('Completed games without player statistics');
  const playerGames=Object.values(players).reduce((n,p)=>n+p.gp,0);
  if (completedGames>0 && (playerGames<completedGames*10 || playerGames>completedGames*36)) throw new Error('Schedule/player statistics coverage mismatch');
  if (Object.values(players).reduce((n,p)=>n+p.totals.pts,0)!==completedPoints) throw new Error('Schedule/player points mismatch; sources are incomplete or out of sync');
  return {version:SEASON_PROGRESS_VERSION,season,fetchedAt,completedGames,teams,players,
    status:completedGames?'in-season':'preseason',
    scheduleSource:'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
    statsSource:'https://stats.nba.com/stats/leaguedashplayerstats'};
}

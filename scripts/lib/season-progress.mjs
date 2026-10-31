import { combineForecastTimeframes } from './forecast-timeframes.mjs';

export const SEASON_PROGRESS_VERSION = 1;
const TEAMS = 'ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split(' ');
const STATS = {min:'MIN',pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
const COUNT_COLUMNS=Object.values(STATS).filter(k=>k!=='MIN');
const zero = () => Object.fromEntries(Object.keys(STATS).map(k => [k,0]));

export function reconcileGameLog(schedule,stats,gameLog,season) {
  const table=gameLog?.resultSets?.[0],headers=table?.headers;
  const needed=['PLAYER_ID','TEAM_ABBREVIATION','GAME_ID',...COUNT_COLUMNS];
  if(!Array.isArray(headers)||!Array.isArray(table?.rowSet)||new Set(headers).size!==headers.length||needed.some(k=>!headers.includes(k)))throw new Error('Invalid official player game-log schema');
  const ix=Object.fromEntries(headers.map((k,i)=>[k,i]));
  const games=new Map();
  for(const day of schedule.leagueSchedule.gameDates)for(const g of day.games){
    if(!String(g.gameId).startsWith(`002${season.slice(2,4)}`)||g.gameStatus!==3)continue;
    games.set(g.gameId,new Map([[g.homeTeam.teamTricode,g.homeTeam.score],[g.awayTeam.teamTricode,g.awayTeam.score]]));
  }
  const totals=new Map(),teamPoints=new Map(),teamCounts=new Map(),seen=new Set();
  for(const row of table.rowSet){
    if(!Array.isArray(row)||row.length!==headers.length)throw new Error('Invalid player game-log row width');
    const id=row[ix.PLAYER_ID],game=row[ix.GAME_ID],team=row[ix.TEAM_ABBREVIATION];
    if(!Number.isSafeInteger(id)||id<=0||!games.get(game)?.has(team)||seen.has(`${game}:${id}`))throw new Error('Invalid, duplicate or unscheduled player game-log identity');
    seen.add(`${game}:${id}`);
    const v=Object.fromEntries(COUNT_COLUMNS.map(k=>[k,row[ix[k]]]));
    if(Object.values(v).some(n=>!Number.isSafeInteger(n)||n<0)||v.REB!==v.OREB+v.DREB||v.PTS!==2*v.FGM+v.FG3M+v.FTM||v.FGM>v.FGA||v.FG3M>v.FG3A||v.FTM>v.FTA)throw new Error('Invalid player game-log scoring or rebound identity');
    const key=`${game}:${team}`;teamPoints.set(key,(teamPoints.get(key)||0)+v.PTS);teamCounts.set(key,(teamCounts.get(key)||0)+1);
    const a=totals.get(id)||{GP:0,...Object.fromEntries(COUNT_COLUMNS.map(k=>[k,0]))};a.GP++;
    for(const k of COUNT_COLUMNS)a[k]+=v[k];totals.set(id,a);
  }
  if(!games.size)throw new Error('Game-log validation requires completed games');
  for(const [game,teams] of games)for(const [team,score] of teams){const key=`${game}:${team}`;
    if(teamPoints.get(key)!==score||!(teamCounts.get(key)>=5&&teamCounts.get(key)<=20))throw new Error(`Incomplete official player game log for ${key}`);
  }
  const dash=stats?.resultSets?.find(t=>t.name==='LeagueDashPlayerStats')||stats?.resultSets?.[0];
  if(!Array.isArray(dash?.headers)||!Array.isArray(dash?.rowSet)||['PLAYER_ID','GP',...COUNT_COLUMNS].some(k=>!dash.headers.includes(k)))throw new Error('Invalid season dashboard for game-log reconciliation');
  const di=Object.fromEntries(dash.headers.map((k,i)=>[k,i])),corrections=[];
  if(dash.rowSet.length!==totals.size)throw new Error('Season dashboard and game log have different player coverage');
  for(const row of dash.rowSet){
    const id=row[di.PLAYER_ID],agg=totals.get(id);
    if(!agg||agg.GP!==row[di.GP])throw new Error('Season dashboard and game log have different player games');
    for(const k of COUNT_COLUMNS)if(row[di[k]]!==agg[k])corrections.push({playerId:id,field:k,dashboard:row[di[k]],gameLog:agg[k]});
  }
  return {totals,corrections,completedGames:games.size,source:'stats.nba.com/stats/leaguegamelog?PlayerOrTeam=P'};
}

export function parseSeasonProgress(schedule, stats, {season, fetchedAt, gameLog} = {}) {
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
  const reconciled=gameLog?reconcileGameLog(schedule,stats,gameLog,season):null;
  const players={};
  for (const row of table.rowSet) {
    if (!Array.isArray(row) || row.length!==table.headers.length) throw new Error('Malformed player totals row');
    const r=Object.fromEntries(table.headers.map((h,i)=>[h,row[i]]));
    if (!Number.isSafeInteger(r.PLAYER_ID) || r.PLAYER_ID<=0 || players[r.PLAYER_ID]) throw new Error('Invalid/duplicate player identity');
    if (!Number.isSafeInteger(r.GP) || r.GP<0 || r.GP>completedGames) throw new Error('Invalid player games');
    const gameTotals=reconciled?.totals.get(r.PLAYER_ID);
    const totals=Object.fromEntries(Object.entries(STATS).map(([key,column])=>[key,column==='MIN'?r[column]:(gameTotals?gameTotals[column]:r[column])]));
    // Reuse independently tested shot/rebound accounting, allowing only rounding of NBA MIN.
    combineForecastTimeframes({season,asOf:fetchedAt,scheduledGames:Math.max(82,r.GP),actual:{gp:r.GP,teamGamesElapsed:Math.max(r.GP,...Object.values(teams).map(t=>t.completed)),totals},remaining:{gp:0,perGame:{...zero(),mpg:0}}});
    players[r.PLAYER_ID]={gp:r.GP,totals};
  }
  if (completedGames>0 && !Object.keys(players).length) throw new Error('Completed games without player statistics');
  const playerGames=Object.values(players).reduce((n,p)=>n+p.gp,0);
  if (completedGames>0 && (playerGames<completedGames*10 || playerGames>completedGames*36)) throw new Error('Schedule/player statistics coverage mismatch');
  const playerPoints=Object.values(players).reduce((n,p)=>n+p.totals.pts,0);
  if (playerPoints!==completedPoints) throw new Error(`Schedule/player points mismatch (schedule ${completedPoints}, player totals ${playerPoints}; completed games ${completedGames}); sources are incomplete or out of sync`);
  return {version:SEASON_PROGRESS_VERSION,season,fetchedAt,completedGames,teams,players,
    sourceCorrections:reconciled?.corrections||[],
    status:completedGames?'in-season':'preseason',
    scheduleSource:'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
    statsSource:'https://stats.nba.com/stats/leaguedashplayerstats',gameLogSource:reconciled?.source||null};
}

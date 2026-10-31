import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=f=>JSON.parse(fs.readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const data=read('public/data.json'),raw=read('scripts/data/live/season-progress.json');
const table=raw.stats.resultSets[0],ix=Object.fromEntries(table.headers.map((h,i)=>[h,i]));
const players=new Map(data.leagues.NBA.map(p=>[Number(p.nbaPersonId),p]));
const sourceKeys={min:'MIN',pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
const gameTotals=new Map(),gameTeamPoints=new Map();
if(raw.gameLog){
  const game=raw.gameLog.resultSets[0],gi=Object.fromEntries(game.headers.map((h,i)=>[h,i]));
  const seen=new Set();
  for(const row of game.rowSet){
    const id=row[gi.PLAYER_ID],gameId=row[gi.GAME_ID],key=`${gameId}:${id}`,teamKey=`${gameId}:${row[gi.TEAM_ABBREVIATION]}`;
    assert.ok(!seen.has(key),`Duplicate game/player ${key}`);seen.add(key);
    const a=gameTotals.get(id)||{gp:0,...Object.fromEntries(Object.keys(sourceKeys).filter(k=>k!=='min').map(k=>[k,0]))};a.gp++;
    for(const [k,column] of Object.entries(sourceKeys))if(k!=='min')a[k]+=row[gi[column]];
    gameTotals.set(id,a);gameTeamPoints.set(teamKey,(gameTeamPoints.get(teamKey)||0)+row[gi.PTS]);
  }
  for(const day of raw.schedule.leagueSchedule.gameDates)for(const game of day.games){
    if(game.gameStatus!==3||!String(game.gameId).startsWith('00226'))continue;
    for(const side of [game.homeTeam,game.awayTeam])assert.equal(gameTeamPoints.get(`${game.gameId}:${side.teamTricode}`),side.score);
  }
  assert.equal(gameTotals.size,table.rowSet.length);
}
const expectedCorrections=[];
for(const row of table.rowSet){
  const p=players.get(row[ix.PLAYER_ID]);assert.ok(p,`Missing current-season player ${row[ix.PLAYER_ID]}`);
  const a=p.seasonActual;assert.equal(a.gp,row[ix.GP]);
  for(const [key,column] of Object.entries(sourceKeys)){
    const expected=key==='min'?row[ix[column]]:gameTotals.size?gameTotals.get(row[ix.PLAYER_ID])?.[key]:row[ix[column]];
    assert.equal(a.totals[key],expected);assert.equal(a.perGame[key==='min'?'mpg':key],a.gp?expected/a.gp:null);
    if(key!=='min'&&gameTotals.size&&expected!==row[ix[column]])expectedCorrections.push({playerId:row[ix.PLAYER_ID],field:column,dashboard:row[ix[column]],gameLog:expected});
  }
}
assert.deepEqual([...expectedCorrections].sort((a,b)=>a.playerId-b.playerId||a.field.localeCompare(b.field)),[...(data.seasonProgress.sourceCorrections||[])].sort((a,b)=>a.playerId-b.playerId||a.field.localeCompare(b.field)));
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
let forecasts=0;
for(const p of players.values()){
  const f=p.seasonForecast;if(!f||f.status==='unavailable')continue;forecasts++;
  close(f.actualToDate.gp+f.remainingSeason.gp,f.fullSeason.gp);
  if(p.rosterContext?.contract==='two-way')assert.ok(f.fullSeason.gp<=50+1e-6);
  for(const key of Object.keys(sourceKeys)){
    close(f.fullSeason.totals[key],f.actualToDate.totals[key]+f.remainingSeason.totals[key]);
    if(f.fullSeason.gp)close(f.fullSeason.perGame[key==='min'?'mpg':key],f.fullSeason.totals[key]/f.fullSeason.gp);
  }
  if(f.fullSeason.totals.fga)close(f.fullSeason.perGame.fgPct,f.fullSeason.totals.fgm/f.fullSeason.totals.fga);
  if(f.remainingSeason.gp){
    const n=p.seasonActual.gp,a=p.proj.accounting,t=p.seasonActual.totals;
    const expected=(key,k)=>(k*a[key]+t[key])/(k+n);
    close(f.remainingSeason.perGame.mpg,(10*a.mpg+t.min)/(10+n));
    if(n)close(f.remainingSeason.perGame.pts,2*expected('fgm',20)+expected('fg3m',20)+expected('ftm',20));
    else close(f.remainingSeason.perGame.pts,2*a.fgm+a.fg3m+a.ftm);
  }
  if(!p.seasonActual.gp)assert.equal(p.seasonActual.perGame.pts,null);
}
assert.ok(forecasts>400);
console.log(`Current-season independent accounting: ${table.rowSet.length} player-total rows, ${expectedCorrections.length} independently reconciled game-log corrections and ${forecasts} actual/remaining/combined forecast identities passed.`);

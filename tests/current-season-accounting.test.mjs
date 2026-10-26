import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=f=>JSON.parse(fs.readFileSync(new URL('../'+f,import.meta.url),'utf8'));
const data=read('public/data.json'),raw=read('scripts/data/live/season-progress.json');
const table=raw.stats.resultSets[0],ix=Object.fromEntries(table.headers.map((h,i)=>[h,i]));
const players=new Map(data.leagues.NBA.map(p=>[Number(p.nbaPersonId),p]));
const sourceKeys={min:'MIN',pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
for(const row of table.rowSet){
  const p=players.get(row[ix.PLAYER_ID]);assert.ok(p,`Missing current-season player ${row[ix.PLAYER_ID]}`);
  const a=p.seasonActual;assert.equal(a.gp,row[ix.GP]);
  for(const [key,column] of Object.entries(sourceKeys)){assert.equal(a.totals[key],row[ix[column]]);assert.equal(a.perGame[key==='min'?'mpg':key],a.gp?row[ix[column]]/a.gp:null);}
}
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
    close(f.remainingSeason.perGame.pts,2*p.proj.accounting.fgm+p.proj.accounting.fg3m+p.proj.accounting.ftm);
    close(f.remainingSeason.perGame.mpg,p.proj.accounting.mpg);
  }
  if(!p.seasonActual.gp)assert.equal(p.seasonActual.perGame.pts,null);
}
assert.ok(forecasts>400);
console.log(`Current-season independent accounting: ${table.rowSet.length} original player-total rows and ${forecasts} actual/remaining/combined forecast identities passed.`);

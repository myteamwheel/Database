const COUNTS=['PTS','REB','AST','STL','BLK','TOV','FGM','FGA','FG3M','FG3A','FTM','FTA'];
export const CURRENT_SCOPES=[['00','Regular Season'],['20','Showcase'],['20','Regular Season']];
function table(payload,name,columns){
 const t=payload?.resultSets?.find(t=>t.name===name);
 if(!Array.isArray(t?.headers)||!Array.isArray(t?.rowSet)||new Set(t.headers).size!==t.headers.length||columns.some(k=>!t.headers.includes(k)))throw new Error('Current team/game schema mismatch');
 return t.rowSet.map(row=>{if(row.length!==t.headers.length)throw new Error('Current team/game row width mismatch');return Object.fromEntries(t.headers.map((k,i)=>[k,row[i]]));});
}
export function parseCurrentTeams(snapshot){
 if(snapshot?.version!==1||snapshot.season!=='2026-27'||!Number.isFinite(Date.parse(snapshot.fetchedAt))||snapshot.records?.length!==3)throw new Error('Invalid current team snapshot');
 const scopes={};
 for(const r of snapshot.records){
  const key=(r.leagueId==='00'?'NBA':'GLEAGUE')+':'+r.seasonType;
  if(!CURRENT_SCOPES.some(([lg,type])=>r.leagueId===lg&&r.seasonType===type)||scopes[key])throw new Error('Duplicate/invalid current team scope');
  for(const [payload,endpoint,source] of [[r.stats,'leaguedashteamstats',r.source],[r.games,'leaguegamelog',r.gamesSource]]){
   const p=payload?.parameters,u=new URL(source);
   if(!p||String(p.LeagueID)!==r.leagueId||p.Season!==snapshot.season||p.SeasonType!==r.seasonType||u.protocol!=='https:'||u.hostname!=='stats.gleague.nba.com'||u.pathname!=='/stats/'+endpoint||u.searchParams.get('LeagueID')!==r.leagueId||u.searchParams.get('Season')!==snapshot.season||u.searchParams.get('SeasonType')!==r.seasonType)throw new Error('Current team/game scope mismatch');
  }
  if(r.stats.parameters.PerMode!=='Totals'||r.stats.parameters.MeasureType!=='Base'||r.games.parameters.PlayerOrTeam!=='T')throw new Error('Current team/game measure mismatch');
  const teams=table(r.stats,'LeagueDashTeamStats',['TEAM_ID','TEAM_NAME','GP','W','L',...COUNTS]);
  const games=table(r.games,'LeagueGameLog',['TEAM_ID','GAME_ID','GAME_DATE','WL',...COUNTS]);
  const ids=new Set(),seen=new Set(),byGame=new Map(),byTeam=new Map(),corrections=[];
  for(const g of games){
   const id=String(g.GAME_ID).padStart(10,'0'),key=g.TEAM_ID+':'+id;
   if(!Number.isSafeInteger(g.TEAM_ID)||g.TEAM_ID<=0||!/^\d{10}$/.test(id)||seen.has(key)||!['W','L'].includes(g.WL)||!Number.isFinite(Date.parse(g.GAME_DATE))||COUNTS.some(k=>!Number.isSafeInteger(g[k])||g[k]<0))throw new Error('Invalid/duplicate current team game');
   seen.add(key);(byGame.get(id)||byGame.set(id,[]).get(id)).push(g);(byTeam.get(g.TEAM_ID)||byTeam.set(g.TEAM_ID,[]).get(g.TEAM_ID)).push(g);
  }
  for(const pair of byGame.values())if(pair.length!==2||pair[0].TEAM_ID===pair[1].TEAM_ID||pair[0].WL===pair[1].WL)throw new Error('Incomplete current team game pair');
  const rows=teams.map(t=>{
   if(!Number.isSafeInteger(t.TEAM_ID)||t.TEAM_ID<=0||ids.has(t.TEAM_ID)||!t.TEAM_NAME||!Number.isSafeInteger(t.GP)||t.GP<0||!Number.isSafeInteger(t.W)||!Number.isSafeInteger(t.L)||t.W<0||t.L<0||t.W+t.L!==t.GP||COUNTS.some(k=>!Number.isSafeInteger(t[k])||t[k]<0))throw new Error('Invalid/duplicate current team totals');ids.add(t.TEAM_ID);
   for(const [m,a] of [['FGM','FGA'],['FG3M','FG3A'],['FTM','FTA']])if(t[m]>t[a])throw new Error('Invalid current team shooting');
   const played=byTeam.get(t.TEAM_ID)||[];
   if(played.length!==t.GP||played.filter(g=>g.WL==='W').length!==t.W)throw new Error('Current team exposure/game log disagree; retry after synchronization');
   // The official dashboard can lag corrections to individual game counts.
   // With identical game exposure, prefer summed game logs and retain every difference.
   for(const k of COUNTS){const value=played.reduce((sum,g)=>sum+g[k],0);if(value!==t[k])corrections.push({teamId:t.TEAM_ID,field:k,dashboard:t[k],gameLog:value});t[k]=value;}

   return {teamId:t.TEAM_ID,name:t.TEAM_NAME,gp:t.GP,wins:t.W,losses:t.L,latestGameDate:played.map(g=>g.GAME_DATE.slice(0,10)).sort().at(-1)||null,totals:Object.fromEntries(COUNTS.map(k=>[k.toLowerCase(),t[k]])),perGame:Object.fromEntries(COUNTS.map(k=>[k.toLowerCase(),t.GP?t[k]/t.GP:null]))};
  });
  if([...byTeam.keys()].some(id=>!ids.has(id)))throw new Error('Game-log team absent from current totals');
  scopes[key]={teams:rows,completedGames:byGame.size,latestGameDate:rows.map(t=>t.latestGameDate).filter(Boolean).sort().at(-1)||null,source:r.source,gamesSource:r.gamesSource,corrections};
 }
 return {season:snapshot.season,asOf:snapshot.fetchedAt,scopes};
}

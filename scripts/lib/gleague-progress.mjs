const COUNTS={pts:'PTS',oreb:'OREB',dreb:'DREB',reb:'REB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
function rows(payload,required){const t=payload?.resultSets?.[0];if(!t||!Array.isArray(t.headers)||!Array.isArray(t.rowSet)||required.some(k=>!t.headers.includes(k)))throw Error('Invalid G League final-game schema');return t.rowSet.map(r=>{if(r.length!==t.headers.length)throw Error('Invalid G League game row');return Object.fromEntries(t.headers.map((k,i)=>[k,r[i]]));});}
export function reconcileGLeagueLogs(phase,cutoff){
 if(!phase.gameLog&&!phase.teamGameLog)return null;
 for(const p of [phase.gameLog,phase.teamGameLog])if(p?.parameters?.Season!=='2026-27'||String(p.parameters.LeagueID)!=='20'||p.parameters.SeasonType!==phase.apiSeasonType||p.parameters.DateTo!==phase.stats.parameters.DateTo)throw Error('G League game-log scope/window mismatch');
 const teams=rows(phase.teamGameLog,['TEAM_ID','GAME_ID','GAME_DATE','WL','PTS']),games=new Map(),totals=new Map(),seen=new Set(),points=new Map(),counts=new Map();
 for(const t of teams){const key=t.GAME_ID+':'+t.TEAM_ID;if(!['W','L'].includes(t.WL)||String(t.GAME_DATE).slice(0,10)>cutoff||games.has(key))throw Error('Incomplete/duplicate G League final team game');games.set(key,t);}
 for(const r of rows(phase.gameLog,['PLAYER_ID','TEAM_ID','GAME_ID','GAME_DATE','WL',...Object.values(COUNTS)])){
  const key=r.GAME_ID+':'+r.PLAYER_ID,team=r.GAME_ID+':'+r.TEAM_ID;if(!Number.isSafeInteger(r.PLAYER_ID)||seen.has(key)||!games.has(team)||r.WL!==games.get(team).WL||String(r.GAME_DATE).slice(0,10)>cutoff)throw Error('Invalid/duplicate G League final player game');seen.add(key);
  if(Object.values(COUNTS).some(k=>!Number.isSafeInteger(r[k])||r[k]<0))throw Error('Invalid G League game counts');
  const sum=totals.get(r.PLAYER_ID)||{GP:0,...Object.fromEntries(Object.values(COUNTS).map(k=>[k,0]))};sum.GP++;for(const k of Object.values(COUNTS))sum[k]+=r[k];totals.set(r.PLAYER_ID,sum);points.set(team,(points.get(team)||0)+r.PTS);counts.set(team,(counts.get(team)||0)+1);
 }
 for(const [key,t]of games)if(points.get(key)!==t.PTS||counts.get(key)<5||counts.get(key)>20)throw Error('Incomplete G League final player/team points');
 return totals;
}
export function parseGLeagueProgress(snapshot){
  if(snapshot?.version!==1||snapshot.season!=='2026-27'||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.phases)||snapshot.phases.length!==2)throw new Error('Invalid G League progress snapshot');
  const phases={};
  for(const phase of snapshot.phases){
    if(!['Regular Season','Showcase'].includes(phase.apiSeasonType)||phases[phase.apiSeasonType])throw new Error('Invalid/duplicate G League competition phase');
    if(phase.stats?.parameters&&(phase.stats.parameters.Season!==snapshot.season||String(phase.stats.parameters.LeagueID)!=='20'||phase.stats.parameters.SeasonType!==phase.apiSeasonType||phase.stats.parameters.PerMode!=='Totals'))throw new Error('G League phase source scope mismatch');
    const table=phase.stats?.resultSets?.find(t=>t.name==='LeagueDashPlayerStats')||phase.stats?.resultSets?.[0];
    if(!Array.isArray(table?.headers)||!Array.isArray(table?.rowSet)||new Set(table.headers).size!==table.headers.length||['PLAYER_ID','GP','MIN',...Object.values(COUNTS)].some(k=>!table.headers.includes(k)))throw new Error('Invalid G League current-stat schema');
    const ix=Object.fromEntries(table.headers.map((k,i)=>[k,i])),players={},reconciled=reconcileGLeagueLogs(phase,snapshot.completedThrough),corrections=[];
    if(reconciled&&reconciled.size!==table.rowSet.length)throw Error('G League dashboard/game-log player coverage mismatch');
    for(const row of table.rowSet){
      const id=row[ix.PLAYER_ID],gp=row[ix.GP],min=row[ix.MIN];
      if(row.length!==table.headers.length||!Number.isSafeInteger(id)||id<=0||players[id]||!Number.isSafeInteger(gp)||gp<=0||!Number.isFinite(min)||min<0)throw new Error('Invalid G League current-stat identity/exposure');
      const log=reconciled?.get(id);if(reconciled&&log?.GP!==gp)throw Error('G League dashboard/game-log appearance mismatch');
      const totals=Object.fromEntries(Object.entries(COUNTS).map(([k,c])=>{if(log&&log[c]!==row[ix[c]])corrections.push({playerId:id,field:c,dashboard:row[ix[c]],gameLog:log[c]});return [k,log?log[c]:row[ix[c]]];}));
      if(Object.values(totals).some(v=>!Number.isSafeInteger(v)||v<0)||totals.fgm>totals.fga||totals.fg3m>totals.fg3a||totals.ftm>totals.fta||totals.fg3a>totals.fga||totals.fg3m>totals.fgm||totals.reb!==totals.oreb+totals.dreb)throw new Error('Invalid G League current count accounting');
      const freeThrowPoints=totals.pts-2*totals.fgm-totals.fg3m;
      // A made G League free throw can be worth 1, 2 or 3 points. Never apply NBA's
      // one-point-per-make identity or fabricate a free-throw-trip conversion.
      if(freeThrowPoints<totals.ftm||freeThrowPoints>3*totals.ftm)throw new Error('Invalid G League free-throw scoring');
      players[id]={gp,totals:{min,...totals,freeThrowPoints},perGame:{mpg:min/gp,...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v/gp]))}};
    }
    phases[phase.apiSeasonType]={label:phase.apiSeasonType==='Showcase'?'Tip-Off Tournament / Showcase':'Regular season',status:table.rowSet.length?'results-available':'no-published-player-results',source:phase.source,gameLogSource:phase.gameLogSource||null,sourceCorrections:corrections,players};
  }
  return {season:snapshot.season,asOf:snapshot.fetchedAt,completedThrough:snapshot.completedThrough||null,phases,note:'Competition phases remain separate; zero source rows mean no published results, not measured zero performance. G League free-throw points are derived from official scoring totals and can differ from free throws made.'};
}

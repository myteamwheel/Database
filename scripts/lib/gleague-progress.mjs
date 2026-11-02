const COUNTS={pts:'PTS',oreb:'OREB',dreb:'DREB',reb:'REB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
export function parseGLeagueProgress(snapshot){
  if(snapshot?.version!==1||snapshot.season!=='2026-27'||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.phases)||snapshot.phases.length!==2)throw new Error('Invalid G League progress snapshot');
  const phases={};
  for(const phase of snapshot.phases){
    if(!['Regular Season','Showcase'].includes(phase.apiSeasonType)||phases[phase.apiSeasonType])throw new Error('Invalid/duplicate G League competition phase');
    if(phase.stats?.parameters&&(phase.stats.parameters.Season!==snapshot.season||String(phase.stats.parameters.LeagueID)!=='20'||phase.stats.parameters.SeasonType!==phase.apiSeasonType||phase.stats.parameters.PerMode!=='Totals'))throw new Error('G League phase source scope mismatch');
    const table=phase.stats?.resultSets?.find(t=>t.name==='LeagueDashPlayerStats')||phase.stats?.resultSets?.[0];
    if(!Array.isArray(table?.headers)||!Array.isArray(table?.rowSet)||new Set(table.headers).size!==table.headers.length||['PLAYER_ID','GP','MIN',...Object.values(COUNTS)].some(k=>!table.headers.includes(k)))throw new Error('Invalid G League current-stat schema');
    const ix=Object.fromEntries(table.headers.map((k,i)=>[k,i])),players={};
    for(const row of table.rowSet){
      const id=row[ix.PLAYER_ID],gp=row[ix.GP],min=row[ix.MIN];
      if(row.length!==table.headers.length||!Number.isSafeInteger(id)||id<=0||players[id]||!Number.isSafeInteger(gp)||gp<=0||!Number.isFinite(min)||min<0)throw new Error('Invalid G League current-stat identity/exposure');
      const totals=Object.fromEntries(Object.entries(COUNTS).map(([k,c])=>[k,row[ix[c]]]));
      if(Object.values(totals).some(v=>!Number.isSafeInteger(v)||v<0)||totals.fgm>totals.fga||totals.fg3m>totals.fg3a||totals.ftm>totals.fta||totals.fg3a>totals.fga||totals.fg3m>totals.fgm||totals.reb!==totals.oreb+totals.dreb)throw new Error('Invalid G League current count accounting');
      const freeThrowPoints=totals.pts-2*totals.fgm-totals.fg3m;
      // A made G League free throw can be worth 1, 2 or 3 points. Never apply NBA's
      // one-point-per-make identity or fabricate a free-throw-trip conversion.
      if(freeThrowPoints<totals.ftm||freeThrowPoints>3*totals.ftm)throw new Error('Invalid G League free-throw scoring');
      players[id]={gp,totals:{min,...totals,freeThrowPoints},perGame:{mpg:min/gp,...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v/gp]))}};
    }
    phases[phase.apiSeasonType]={label:phase.apiSeasonType==='Showcase'?'Tip-Off Tournament / Showcase':'Regular season',status:table.rowSet.length?'results-available':'no-published-player-results',source:phase.source,players};
  }
  return {season:snapshot.season,asOf:snapshot.fetchedAt,phases,note:'Competition phases remain separate; zero source rows mean no published results, not measured zero performance. G League free-throw points are derived from official scoring totals and can differ from free throws made.'};
}

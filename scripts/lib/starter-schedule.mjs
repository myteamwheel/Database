// Resolve completed NBA games against the independent ESPN box-score dates and
// home/away team identities. Mutable upstream crosswalk event IDs are advisory.
export function reconcileOfficialSchedule({schedule,box,official,season}) {
  const start=Number(season?.slice(0,4));
  if(!/^\d{4}-\d{2}$/.test(season||'')||Number(season.slice(5))!==(start+1)%100)throw Error('Invalid schedule season');
  const required=(csv,keys)=>{if(!Array.isArray(csv?.rows)||keys.some(k=>!Number.isInteger(csv.index?.[k])))throw Error('Missing schedule reconciliation columns');};
  required(schedule,['nba_game_id','espn_game_id','home_espn_team_id','away_espn_team_id','nba_home_team_id','nba_away_team_id','match_method','match_confidence','season_type','game_date']);
  required(box,['game_id','game_date','season_type','team_id','home_away']);
  const get=(csv,row,key)=>String(row[csv.index[key]]??'').trim();
  const teams=new Map(),inverse=new Map();
  for(const r of schedule.rows)for(const side of ['home','away']){
    const e=get(schedule,r,`${side}_espn_team_id`),n=get(schedule,r,`nba_${side}_team_id`);
    if(!e||!n)continue;
    if((teams.has(e)&&teams.get(e)!==n)||(inverse.has(n)&&inverse.get(n)!==e))throw Error('Ambiguous team crosswalk');
    teams.set(e,n);inverse.set(n,e);
  }
  const date=s=>{const d=s.slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d).toISOString().slice(0,10)!==d)throw Error('Invalid game date');return d;};
  const events=new Map(),nonNbaEvents=new Set();
  for(const row of box.rows){
    const id=get(box,row,'game_id'),phase=get(box,row,'season_type');
    if(!['2','3'].includes(phase))continue;
    const when=date(get(box,row,'game_date')),side=get(box,row,'home_away'),team=get(box,row,'team_id');
    if(!id||!['home','away'].includes(side))throw Error(`Invalid ESPN game identity: event=${id}, team=${team}, side=${side}`);
    // ESPN also codes All-Star exhibitions as season_type=2. They cannot
    // enter the official NBA game universe; require full coverage below.
    if(!teams.has(team)){nonNbaEvents.add(id);continue;}
    let e=events.get(id);if(!e){e={id,when,phase,home:null,away:null};events.set(id,e);}
    if(e.when!==when||e.phase!==phase||(e[side]&&e[side]!==team))throw Error('Inconsistent ESPN game context');
    e[side]=team;
  }
  const key=(when,phase,home,away)=>[when,phase,...[home,away].sort()].join('|');
  const byContext=new Map();
  for(const e of events.values()){
    if(nonNbaEvents.has(e.id))continue;
    if(!e.home||!e.away||e.home===e.away)throw Error('ESPN game lacks two teams');
    const k=key(e.when,e.phase,teams.get(e.home),teams.get(e.away)),ids=byContext.get(k)||[];
    ids.push(e.id);byContext.set(k,ids);
  }
  const rows=[],corrections=[],used=new Set(),seenGames=new Set();
  for(const {phase,payload} of official){
    const code=phase==='Regular Season'?'2':phase==='Playoffs'?'4':null,espnPhase=code==='2'?'2':'3';
    const t=payload?.resultSets?.find(t=>t.name==='LeagueGameLog')||payload?.resultSets?.[0];
    if(!code||!Array.isArray(t?.headers)||!Array.isArray(t.rowSet)||!t.rowSet.length||new Set(t.headers).size!==t.headers.length)throw Error('Invalid official schedule table');
    const ix=Object.fromEntries(t.headers.map((h,i)=>[h,i]));
    if(['SEASON_ID','GAME_ID','GAME_DATE','TEAM_ID','MATCHUP'].some(k=>ix[k]===undefined))throw Error('Missing official schedule columns');
    const games=new Map();
    for(const row of t.rowSet){
      const id=String(row[ix.GAME_ID]);
      if(row.length!==t.headers.length||String(row[ix.SEASON_ID])!==code+start||!new RegExp(`^00${code==='2'?'2':'4'}${String(start).slice(2)}\\d{5}$`).test(id))throw Error('Official schedule season/phase mismatch');
      const list=games.get(id)||[];list.push(row);games.set(id,list);
    }
    for(const [id,pair] of games){
      if(seenGames.has(id))throw Error('Duplicate official game');seenGames.add(id);
      const home=pair.filter(r=>String(r[ix.MATCHUP]).includes(' vs. ')),away=pair.filter(r=>String(r[ix.MATCHUP]).includes(' @ '));
      const neutral=home.length===0&&away.length===2;
      if(pair.length!==2||(!neutral&&(home.length!==1||away.length!==1))||pair[0][ix.TEAM_ID]===pair[1][ix.TEAM_ID])throw Error('Official game needs two team rows with home/away identities');
      const when=date(String(pair[0][ix.GAME_DATE]));
      if(date(String(pair[1][ix.GAME_DATE]))!==when)throw Error('Inconsistent official game date');
      const first=String(pair[0][ix.TEAM_ID]),second=String(pair[1][ix.TEAM_ID]);
      const matches=byContext.get(key(when,espnPhase,first,second))||[];
      if(matches.length!==1||used.has(matches[0]))throw Error(`No unique ESPN event for official game ${id}`);
      const event=events.get(matches[0]);used.add(event.id);
      const h=teams.get(event.home),a=teams.get(event.away);
      if(!neutral&&(h!==String(home[0][ix.TEAM_ID])||a!==String(away[0][ix.TEAM_ID])))throw Error(`No unique ESPN home/away match for official game ${id}`);
      const old=schedule.rows.filter(r=>get(schedule,r,'nba_game_id')===id);
      const prior=old.length===1?get(schedule,old[0],'espn_game_id'):null;
      if(prior!==event.id)corrections.push({nbaGameId:id,before:prior,after:event.id,date:when,homeTeamId:h,awayTeamId:a});
      const values={nba_game_id:id,espn_game_id:event.id,home_espn_team_id:event.home,away_espn_team_id:event.away,nba_home_team_id:h,nba_away_team_id:a,match_method:'official-date-teams',match_confidence:'1',season_type:phase,game_date:when};
      rows.push(schedule.headers.map(k=>values[k]??''));
    }
  }
  if(!rows.length)throw Error('Empty official schedule');
  return {schedule:{...schedule,rows},corrections};
}

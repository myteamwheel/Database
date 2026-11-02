import {allocateRotation} from './rotation-allocation.mjs';
export function buildRotationPlans(data,snapshot){
  const rows=data?.leagues?.NBA;
  if(!Array.isArray(rows)||!snapshot?.schedule?.leagueSchedule?.gameDates||!Number.isFinite(Date.parse(snapshot.fetchedAt)))throw new Error('Rotation plan requires a dated official schedule');
  const games=snapshot.schedule.leagueSchedule.gameDates.flatMap(d=>d.games).filter(g=>String(g.gameId).startsWith('00226')&&g.gameStatus!==3&&Date.parse(g.gameDateTimeUTC)>=Date.parse(snapshot.fetchedAt)).sort((a,b)=>Date.parse(a.gameDateTimeUTC)-Date.parse(b.gameDateTimeUTC)||a.gameId.localeCompare(b.gameId));
  const teams=[...new Set(rows.filter(p=>p.currentRoster&&p.currentTeam).map(p=>p.currentTeam))].sort();
  return Object.fromEntries(teams.map(team=>{
    const game=games.find(g=>g.homeTeam.teamTricode===team||g.awayTeam.teamTricode===team);
    if(!game)return [team,{status:'unavailable',reason:'No verified upcoming scheduled game',asOf:snapshot.fetchedAt}];
    const date=game.gameDateEst.slice(0,10),matchup=`${game.awayTeam.teamTricode}@${game.homeTeam.teamTricode}`;
    const roster=rows.filter(p=>p.currentRoster&&p.currentTeam===team),unmodeled=[];
    const inputs=roster.map(p=>{
      const base=p.seasonForecast?.remainingSeason?.perGame?.mpg??p.proj?.accounting?.mpg;
      const measured=Number.isFinite(base)&&!p.proj?.abstain;
      if(!measured)unmodeled.push({id:p.playerId,name:p.name,reason:'No supported workload forecast'});
      const out=(p.reportedAvailability||[]).some(a=>a.status==='Out'&&a.gameDate===date&&a.matchup===matchup);
      const signal=!p.tulipBeta?.abstain&&Number.isFinite(p.tulipBeta?.tulip)?p.tulipBeta.tulip:0;
      return {id:p.playerId,position:p.position,baselineTarget:measured?Math.max(0,Math.min(40,base)):0,target:measured?Math.max(0,Math.min(40,base+signal)):0,maxMinutes:measured?40:0,out};
    });
    const pending=(data.injuryMeta?.notSubmitted||[]).some(r=>r.team===team&&r.gameDate===date&&r.matchup===matchup);
    const matchingReport=roster.some(p=>(p.reportedAvailability||[]).some(a=>a.gameDate===date&&a.matchup===matchup));
    const baseline=allocateRotation(inputs.map(p=>({...p,target:p.baselineTarget})));
    const result=allocateRotation(inputs);
    return [team,{...result,baselinePlayers:baseline.players,availabilityStatus:pending?'team-report-pending':matchingReport?'dated-report-available':'no-matching-game-report',gameId:game.gameId,gameDate:date,matchup,asOf:snapshot.fetchedAt,unmodeled,
      status:result.status==='feasible'?(unmodeled.length?'partial-roster':'feasible'):'infeasible',
      targetDefinition:'Observed/preseason blended workload plus the historical TULIP Beta minute signal; rounded to whole minutes under listed-position and 40-minute bounds.',
      availabilityDefinition:'Only an official Out listing for this exact game removes a player. Missing or pending reports are unverified; no recovery date is inferred.',
      rosterDefinition:'Current official NBA roster, including rookies and two-way players. Players without a workload forecast are withheld and listed explicitly.',
      evidence:'Experimental decision support. Mathematical feasibility does not establish a gain in wins.'}];
  }));
}

export const ROTATION_TULIP_VERSION='rotation-tulip-v1';
export function attachRotationRecommendations(data){
  const plans=data.rotationPlans||{};
  for(const p of [...data.leagues.NBA,...data.leagues.GLEAGUE]){
    if(p.league!=='NBA'||!p.currentRoster||!p.currentTeam){p.tulipRotation={abstain:true,reason:p.league!=='NBA'?'not_supported_for_gleague':'not_on_current_nba_roster'};continue;}
    const plan=plans[p.currentTeam],row=plan?.players?.find(r=>r.id===String(p.playerId)),base=plan?.baselinePlayers?.find(r=>r.id===String(p.playerId));
    if(!plan||plan.status!=='feasible'||!row||!base){p.tulipRotation={abstain:true,reason:plan?.status==='infeasible'?'incomplete_positional_capacity':'unsupported_roster_plan',gameDate:plan?.gameDate||null};continue;}
    const gp=p.seasonActual?.gp||0,observed=gp>0?p.seasonActual.perGame?.mpg:null,legacy=p.tulipBeta&&!p.tulipBeta.abstain?p.tulipBeta:null;
    const pending=plan.availabilityStatus!=='dated-report-available';
    const support=!row.out&&!pending&&legacy&&gp>=3&&['HIGH','MEDIUM'].includes(legacy.confidence)?gp>=20&&legacy.confidence==='HIGH'?'HIGH':'MEDIUM':'LOW';
    p.tulipRotation={version:ROTATION_TULIP_VERSION,abstain:false,currentMpg:Number.isFinite(observed)?observed:null,observedGames:gp,recommendedMpg:row.minutes,
      tulip:!row.out&&Number.isFinite(observed)?Math.round((row.minutes-observed)*10)/10:null,
      baselineAllocationMpg:base.minutes,allocationDelta:row.minutes-base.minutes,targetMpg:row.target,
      gameDate:plan.gameDate,matchup:plan.matchup,availability:row.out?'Reported Out':plan.availabilityStatus,inputSupport:support,
      valueSignal:legacy?.tulip??null,baselineSeason:'2026-27',asOf:plan.asOf,
      interpretation:row.out?'Officially reported Out for this game; no performance-based play-less judgment.':gp===0?'No measured 2026-27 MPG baseline; the planned role remains available but a play-more/play-less score is withheld.':'Experimental next-game rotation minus measured 2026-27 per-appearance MPG. Availability, college/observed-role forecasts and listed positions constrain the plan; improved winning is not established.'};
  }
  data.tulipRotationMeta={version:ROTATION_TULIP_VERSION,baselineSeason:'2026-27',target:'next scheduled NBA game per team',method:'Project workload from multiyear/college rates and observed current-team role; add the preserved reliability-adjusted historical TULIP value signal; minimize squared target deviations under listed-position capacities, exact-game Out exclusions, 40 MPG limits and 48 minutes at each of five positions.',
    scoreDefinition:'Planned minutes minus measured current-season per-appearance MPG. No appearance or a reported Out status withholds the directional score. The separate allocation delta compares two feasible 240-minute rotations and conserves exactly.',
    boundary:'Historical per-appearance averages combine different games and must not be summed as one 240-minute baseline. Input support describes evidence coverage, not a probability of improved winning. Missing historical value evidence supplies no directional value adjustment; it is not zero player ability.',
    feasibleTeams:Object.values(plans).filter(p=>p.status==='feasible').length,infeasibleTeams:Object.entries(plans).filter(([,p])=>p.status==='infeasible').map(([t])=>t)};
  return data;
}

const clean=line=>line?Object.fromEntries(Object.entries(line).map(([k,v])=>[k,typeof v==='number'?Math.round(v*1e6)/1e6:v])):null;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const BOX={pts:0.30,ast:0.20,reb:0.15,stl:0.10,blk:0.10,ts:0.10,tov:0.05};
export function boxReviewGrades(actuals,models){
 // Use the measured season as one fixed reference for both sides. Percentile
 // ties have half weight; no later data change the underlying forecast counts.
 const reference=Object.fromEntries(Object.keys(BOX).map(k=>[k,actuals.map(a=>a?.[k]).filter(finite).sort((a,b)=>a-b)]));
 const score=line=>{if(!line||!(line.gp>0)||!finite(line.mpg))return null;let sum=0,w=0;for(const [k,weight] of Object.entries(BOX)){const v=line[k],r=reference[k];if(!finite(v)||!r.length)continue;let less=0,equal=0;for(const n of r){if(n<v)less++;else if(n===v)equal++;}let p=(less+equal*0.5)/r.length;if(k==='tov')p=1-p;sum+=p*weight;w+=weight;}if(!w)return null;const minutes=line.gp*line.mpg,reliability=minutes/(minutes+300);return Math.round(Math.min(9.9999,(reliability*sum/w+(1-reliability)*0.5)*9.9999)*1e4)/1e4;};
 return {actual:actuals.map(score),model:models.map(score),formula:'Comparable box-score grade: measured-season percentile reference for points 30%, assists 20%, rebounds 15%, steals 10%, blocks 10%, true shooting 10%, inverse turnovers 5%; missing ingredients renormalize. Both sides shrink toward 5 with K=300 total minutes. This comparison grade is distinct from the full performance grade and was not a saved grade forecast.'};
}
export function buildSeasonReview(data,source,{gLeagueRegular={}}={}){
 if(source.season!=='2025-26'||source.trainedThrough!=='2024-25'||source.gleagueTrainedThrough!=='2024-25'||source.retrospective!==true)throw new Error('Season review chronology/source mismatch');
 const leagues={};
 for(const league of ['NBA','GLEAGUE']){
  const inputs=league==='NBA'?source.rows:source.gleagueRows;if(!Array.isArray(inputs))throw new Error('Missing season review league');
  const predictions=new Map();for(const r of inputs){if(predictions.has(String(r.playerId))||r.season!=='2025-26')throw new Error('Invalid season review identity');predictions.set(String(r.playerId),r);}
  const rows=data.leagues[league].filter(p=>p.appeared).map(p=>{
   const r=predictions.get(String(p.playerId));
   const combined={gp:p.gp,mpg:p.gp?p.minutes/p.gp:null,...Object.fromEntries(Object.entries({pts:'pts',reb:'reb',ast:'ast',stl:'stl',blk:'blk',tov:'tov',fg3m:'fg3m'}).map(([k,v])=>[k,p.gp&&finite(p.stats?.['off_'+v])?p.stats['off_'+v]/p.gp:null])),ts:p.ts,fgPct:p.fgPct,fg3Pct:p.fg3Pct,ftPct:p.ftPct};
   const actual=league==='NBA'?combined:(gLeagueRegular[p.nbaPersonId]||{gp:0});
   // The fit's evaluated averages must reconcile with the independently built
   // actual database before they can be joined as a comparison for this person.
   if(r)for(const k of ['mpg','pts','reb','ast','stl','blk'])if(!finite(r.actual[k])||Math.abs(r.actual[k]-actual[k])>0.06)throw new Error(`Review actual mismatch ${league} ${p.name} ${k}`);
   return {playerId:p.playerId,name:p.name,team:p.seasonTeam||p.team,actual:clean(actual),fullGradeScope:league==='GLEAGUE'?'2025-26 regular + Showcase':'2025-26 regular',model:clean(r?.model),grade:p.grade,rateGrade:p.rateGrade,magnitudeGrade:p.magnitudeGrade,historicalTulip:p.tulipBeta&&!p.tulipBeta.abstain?p.tulipBeta.tulip:null,tulipEvidence:p.tulip?.card?.rotation?.leagueReferencedDelta??null,forecastStatus:r?'retrospective-holdout':'no-supported-backtest-row'};
  });
  const grades=boxReviewGrades(rows.map(r=>r.actual),rows.map(r=>r.model));rows.forEach((r,i)=>{r.actualBoxGrade=grades.actual[i];r.modelBoxGrade=grades.model[i];});
  leagues[league]={rows,projected:rows.filter(r=>r.model).length,measured:rows.length,boxGradeFormula:grades.formula};
 }
 return {season:'2025-26',basis:'retrospective-chronological-backtest',trainedThrough:source.trainedThrough,prospectiveArchiveAvailable:false,boundary:'No dated pre-season 2025-26 prediction archive is present. These estimates are reconstructed with model parameters trained only through 2024-25, using historical test cohorts. They are retrospective backtests, not proof of forecasts published before the games. Rookies and unsupported histories without a test row remain blank. Historical TULIP is a recommendation/diagnostic, not an observed truth or a forecast that can be scored against final minutes.',leagues};
}

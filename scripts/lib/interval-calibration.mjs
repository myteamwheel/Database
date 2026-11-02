const STATS=['gp','mpg','pts','reb','ast','stl','blk','tov','fg3m'];
const finite=n=>Number.isFinite(n);
const round=n=>Math.round(n*1000)/1000;

function quantile(sorted,p){
  if(!sorted.length)throw new Error('Cannot estimate a residual quantile from an empty sample');
  return sorted[Math.max(0,Math.min(sorted.length-1,Math.round(p*(sorted.length-1))))];
}

export function fitResidualBands(rows,stat){
  if(!STATS.includes(stat))throw new Error(`Unsupported interval statistic ${stat}`);
  const sample=rows.filter(r=>finite(r.model?.[stat])&&finite(r.actual?.[stat]))
    .map(r=>({prediction:r.model[stat],residual:r.actual[stat]-r.model[stat]}))
    .sort((a,b)=>a.prediction-b.prediction);
  if(sample.length<80)throw new Error(`Insufficient calibration rows for ${stat}`);
  return [0,1,2,3].map(i=>{
    const part=sample.slice(Math.floor(i*sample.length/4),Math.floor((i+1)*sample.length/4));
    const errors=part.map(r=>r.residual).sort((a,b)=>a-b);
    return {upperPrediction:i===3?null:part.at(-1).prediction,n:part.length,
      lowerResidual:quantile(errors,0.1),upperResidual:quantile(errors,0.9)};
  });
}

export function evaluateResidualBands(rows,stat,bands,select=()=>true){
  if(!Array.isArray(bands)||bands.length!==4)throw new Error('Four calibration bands are required');
  const sample=rows.filter(r=>select(r)&&finite(r.model?.[stat])&&finite(r.actual?.[stat])&&finite(r.repeat?.[stat])&&finite(r.avg3?.[stat]));
  if(!sample.length)return {n:0,coverage:null,modelMae:null,repeatMae:null,avg3Mae:null,meanWidth:null};
  let covered=0,modelErr=0,repeatErr=0,avgErr=0,width=0;
  for(const r of sample){
    const p=r.model[stat],a=r.actual[stat];
    const band=bands.find(b=>b.upperPrediction===null||p<=b.upperPrediction)||bands.at(-1);
    const lo=Math.max(0,p+band.lowerResidual),hi=Math.max(lo,p+band.upperResidual);
    if(a>=lo&&a<=hi)covered++;
    modelErr+=Math.abs(a-p);repeatErr+=Math.abs(a-r.repeat[stat]);avgErr+=Math.abs(a-r.avg3[stat]);width+=hi-lo;
  }
  return {n:sample.length,coverage:round(covered/sample.length),modelMae:round(modelErr/sample.length),
    repeatMae:round(repeatErr/sample.length),avg3Mae:round(avgErr/sample.length),meanWidth:round(width/sample.length)};
}

export function evaluateChronologicalIntervals(calibration,test){
  if(calibration?.season!=='2024-25'||test?.season!=='2025-26'||calibration?.trainedThrough!=='2023-24'||test?.trainedThrough!=='2024-25')
    throw new Error('Expected 2024-25 calibration and 2025-26 chronological test');
  const cohorts={all:()=>true,rotation1000:r=>r.cohort.rotation1000,moved:r=>r.cohort.moved,
    missedPriorSeason:r=>r.cohort.missedPriorSeason};
  const out={};
  for(const stat of STATS){
    const bands=fitResidualBands(calibration.rows,stat);
    out[stat]={calibrationN:bands.reduce((n,b)=>n+b.n,0),bands:bands.map(b=>({
      upperPrediction:b.upperPrediction===null?null:round(b.upperPrediction),n:b.n,
      lowerResidual:round(b.lowerResidual),upperResidual:round(b.upperResidual)})),
      cohorts:Object.fromEntries(Object.entries(cohorts).map(([name,select])=>[name,evaluateResidualBands(test.rows,stat,bands,select)]))};
  }
  return {protocol:'Fit through 2023-24, calibrate 10th/90th residual bands on 2024-25; refit through 2024-25 and test coverage on 2025-26. No 2025-26 outcomes select bands.',
    nominalCoverage:0.8,calibrationSeason:calibration.season,testSeason:test.season,
    boundary:'Veterans with recent history who appeared in the target season only. The historical evaluation uses opening-team data when present but falls back to a player’s final team when the player missed the opening fortnight. It excludes rookies, no-appearance players, current-season adaptive updates and the later roster-minute reconciliation. Structural model choices were examined in development, so this is not a pristine prospective validation of the entire shipped stack.',stats:out};
}

import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {replayForecast} from './lib/historical-forecast-replay.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=process.argv.find(a=>a.startsWith('--fit-cache='));const cache=option?option.slice(12):fs.mkdtempSync(path.join(os.tmpdir(),'database-full-replay-'));fs.mkdirSync(cache,{recursive:true});
const rawInputs=fs.readFileSync(path.join(root,'scripts/data/projection/inputs.json'));
const templateCard=JSON.parse(fs.readFileSync(path.join(root,'PROJECTION_2026_27.json'))),entrySource=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/projection/entry-production.json'))),birthdates=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/birthdates.json')));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/projection/replay/manifest.json')));
const samples=[];
for(const entry of manifest.records){
  const year=Number(entry.season.slice(0,4));
  const fitFile=path.join(cache,`fit-${year}.json`);
  const inputsHash=crypto.createHash('sha256').update(rawInputs).digest('hex');
  const cached=fs.existsSync(fitFile)?JSON.parse(fs.readFileSync(fitFile)):null;
  if(!cached||cached.inputsSha256!==inputsHash||cached.season!==entry.season||cached.trainedThrough!==`${year-1}-${String(year).slice(-2)}`)execFileSync(process.execPath,['scripts/fit-projections.mjs'],{cwd:root,env:{...process.env,PROJ_EVAL_ROWS:fitFile,PROJ_EVAL_TRAIN_YEAR:String(year-1)},stdio:['ignore','pipe','inherit'],maxBuffer:32*1024*1024});
  const fit=JSON.parse(fs.readFileSync(fitFile));
  const season=entry.season,packed=fs.readFileSync(path.join(root,entry.path)),decoded=zlib.gunzipSync(packed);
  if(crypto.createHash('sha256').update(packed).digest('hex')!==entry.sha256||crypto.createHash('sha256').update(decoded).digest('hex')!==entry.decodedSha256)throw new Error('Replay source hash mismatch');
  const games=JSON.parse(decoded);if(games.length!==entry.rows)throw new Error('Replay source row coverage mismatch');
  const first=[...games].map(r=>r.gameDate).sort()[0],cutoff=new Date(Date.parse(first+'T00:00:00Z')+13*86400000).toISOString().slice(0,10);
  const sample=replayForecast({rawInputs,templateCard,entrySource,birthdates,fit,games,season,cutoff});
  console.log(`Replayed ${season}: ${sample.rosterPlayers} observed roster players at ${cutoff}`);samples.push(sample);
}
const calibration={season:'2016-17 through 2024-25; normal 82-game seasons only',cutoff:'first fourteen calendar days per season',rows:samples.filter(s=>s.season!=='2025-26').flatMap(s=>s.rows),unmodeledFuturePlayers:samples.filter(s=>s.season!=='2025-26').reduce((n,s)=>n+s.unmodeledFuturePlayers,0)},test=samples.find(s=>s.season==='2025-26');
const metric=(row,key)=>key==='ptsTotal'?{p:row.projectedTotals?.pts,a:row.actualTotals?.pts}:key==='minutesTotal'?{p:row.projectedTotals?.min,a:row.actualTotals?.min}:{p:row.model?.[key],a:row.actual?.[key]};
const cohorts={all:()=>true,rookies:r=>r.cohort.rookie,returners:r=>r.cohort.returner,movers:r=>r.cohort.moved,olderFallback:r=>r.cohort.olderFallback};
const preferred=r=>r.cohort.rookie?'rookies':r.cohort.olderFallback?'olderFallback':r.cohort.returner?'returners':r.cohort.moved?'movers':'all';
const stats={};
for(const key of ['gp','mpg','pts','reb','ast','stl','blk','tov','fg3m','ptsTotal','minutesTotal']){
  const fitBands=sample=>{
    const cal=sample.map(r=>metric(r,key)).filter(v=>Number.isFinite(v.p)&&Number.isFinite(v.a)).sort((a,b)=>a.p-b.p);
    const bins=cal.length>=320?4:cal.length>=80?2:1;
    return {n:cal.length,bands:Array.from({length:bins},(_,i)=>{const q=cal.slice(Math.floor(i*cal.length/bins),Math.floor((i+1)*cal.length/bins)),e=q.map(v=>v.a-v.p).sort((a,b)=>a-b);return {upTo:i===bins-1?null:q.at(-1).p,n:q.length,p10:e[Math.round(0.1*(e.length-1))],p90:e[Math.round(0.9*(e.length-1))]};})};
  };
  const calRows=calibration.rows.filter(r=>!r.abstain&&Number.isFinite(metric(r,key).a)&&Number.isFinite(metric(r,key).p));
  const global=fitBands(calRows);if(global.n<80)throw new Error('Too few full-model calibration rows');
  const cohortBands={},cohortCalibration={};
  for(const [name,select] of Object.entries(cohorts)){
    let sample=calRows.filter(select),borrowedFrom=null;
    if(sample.length<40&&name==='olderFallback'){sample=calRows.filter(cohorts.returners);borrowedFrom='returners';}
    if(sample.length<40){sample=calRows;borrowedFrom='all';}
    const fit=fitBands(sample);cohortBands[name]=fit.bands;cohortCalibration[name]={n:fit.n,borrowedFrom};
  }
  stats[key]={bands:global.bands,cohortBands,cohortCalibration,cohorts:Object.fromEntries(Object.entries(cohorts).map(([name,select])=>{
    const rows=test.rows.filter(r=>!r.abstain&&select(r)).map(r=>({r,...metric(r,key)})).filter(v=>Number.isFinite(v.p)&&Number.isFinite(v.a));
    const mean=(list,f)=>list.length?list.reduce((s,v)=>s+f(v),0)/list.length:null;
    const paired=kind=>{const list=rows.filter(v=>Number.isFinite(v.r[kind]?.[key]));return {n:list.length,modelMae:mean(list,v=>Math.abs(v.p-v.a)),baselineMae:mean(list,v=>Math.abs(v.r[kind][key]-v.a))};};
    return [name,{n:rows.length,modelMae:mean(rows,v=>Math.abs(v.p-v.a)),coverage:mean(rows,v=>{const list=cohortBands[preferred(v.r)]||global.bands;const b=list.find(b=>b.upTo===null||v.p<=b.upTo)||list.at(-1);return v.a>=Math.max(0,v.p+b.p10)&&v.a<=Math.max(0,v.p+b.p90)?1:0;}),repeat:paired('repeat'),avg3:paired('avg3')}];
  }))};
}
const report={sourceSha256:crypto.createHash('sha256').update(rawInputs).digest('hex'),implementationSha256:crypto.createHash('sha256').update(['scripts/build-projections.mjs','scripts/build-season-progress.mjs','scripts/lib/projection.mjs','scripts/lib/projection-context.mjs','scripts/lib/entry-production.mjs','scripts/lib/forecast-timeframes.mjs'].map(f=>fs.readFileSync(path.join(root,f))).reduce((s,b)=>Buffer.concat([s,b]),Buffer.alloc(0))).digest('hex'),version:'full-forecast-replay-v1',protocol:'Run the production buildProjections and buildSeasonForecasts functions at the end of each season’s first fourteen calendar days. Veteran parameters train only before the target season. The college-model metric-selection policy uses the development class three years before the target; college coefficients train only on earlier classes. After development on 2024-25 identified rookie undercoverage, pool historical replay residuals through 2024-25; condition on rookie/returner/mover status. Use 1/2/4 prediction bands at <80/<320/320+ observations, borrow a parent group below 40, then freeze and evaluate 2025-26 without using its outcomes to select widths. Both preseason context and current-team observed updates run through production code.',nominalCoverage:0.8,
 boundary:'Roster membership is reconstructed from appearances known at the cutoff, not archived signed-contract rosters; signed nonappearers are unobserved and future entrants are counted outside the cohort. Listed positions and immutable birthdates use the preserved identity index. Historical schedule reconstruction uses final schedule dates. Historical injury/contract reports are unavailable, so those input states use the same unavailable fallback as production. Unit/source tests separately cover dated official Out reports and two-way ceilings. This is a chronological replay with stated source limitations, not a pristine prospective trial or proof of calibrated probabilities in 2026-27.',
 sourceManifest:manifest,samples:samples.map(s=>({season:s.season,cutoff:s.cutoff,players:s.rows.length})),calibration:{throughSeason:'2024-25',season:calibration.season,cutoff:calibration.cutoff,players:calibration.rows.length,abstentions:calibration.rows.filter(r=>r.abstain).length,unmodeledFuturePlayers:calibration.unmodeledFuturePlayers},test:{season:test.season,cutoff:test.cutoff,players:test.rows.length,abstentions:test.rows.filter(r=>r.abstain).length,zeroFutureAppearances:test.rows.filter(r=>r.actual.gp===0).length,unmodeledFuturePlayers:test.unmodeledFuturePlayers},stats};
const rounded=JSON.parse(JSON.stringify(report,(k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v));
fs.writeFileSync(path.join(root,'docs/FULL_FORECAST_EVALUATION.json'),JSON.stringify(rounded,null,2)+'\n');
fs.writeFileSync(path.join(root,'FORECAST_REFERENCE_RANGES.json'),JSON.stringify({version:'full-stack-reference-ranges-v1',calibration:rounded.calibration,test:rounded.test,nominalCoverage:rounded.nominalCoverage,boundary:rounded.boundary,bands:Object.fromEntries(Object.entries(rounded.stats).map(([k,v])=>[k,v.bands])),cohortBands:Object.fromEntries(Object.entries(rounded.stats).map(([k,v])=>[k,v.cohortBands])),cohortCalibration:Object.fromEntries(Object.entries(rounded.stats).map(([k,v])=>[k,v.cohortCalibration])),testCoverage:Object.fromEntries(Object.entries(rounded.stats).map(([k,v])=>[k,Object.fromEntries(Object.entries(v.cohorts).map(([c,m])=>[c,{n:m.n,coverage:m.coverage}]))])),evaluationReportSha256:crypto.createHash('sha256').update(JSON.stringify(rounded,null,2)+'\n').digest('hex')},null,2)+'\n');
console.log(JSON.stringify({test:report.test,points:rounded.stats.pts.cohorts.all,pointsTotals:rounded.stats.ptsTotal.cohorts.all}));

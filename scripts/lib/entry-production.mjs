import crypto from 'node:crypto';
import {ridge,RATE_STATS,PCT_STATS,seasonName,seasonPriors} from './projection.mjs';
import {rookieCohort,rookieProjection} from './projection-context.mjs';
export const ENTRY_PRODUCTION_VERSION='entry-college-residual-v1';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const KEYS=['mpg','share',...RATE_STATS.filter(k=>k!=='pf'),...Object.keys(PCT_STATS)];
export function verifyEntryProduction(data){
  if(data?.version!==1||!Array.isArray(data.records)||!Array.isArray(data.sources)||data.sources.length<2)throw new Error('Invalid entry production source');
  const seen=new Set();
  for(const r of data.records){
    const id=`${r.playerId}:${r.seasonEndYear}`,t=r.totals;
    if(seen.has(id)||!/^\d+$/.test(r.playerId)||!Number.isInteger(r.seasonEndYear)||!Number.isInteger(r.games)||r.games<10||!t||!Number.isFinite(t.min)||t.min<100||typeof r.lastGameDate!=='string'||r.lastGameDate>=`${r.seasonEndYear}-10-01`)throw new Error('Invalid/duplicate college season identity');
    seen.add(id);
    for(const k of ['pts','oreb','dreb','reb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta'])if(!Number.isSafeInteger(t[k])||t[k]<0)throw new Error('Invalid college count');
    if(t.pts!==2*t.fgm+t.fg3m+t.ftm||t.reb!==t.oreb+t.dreb||t.fgm>t.fga||t.fg3m>t.fg3a||t.ftm>t.fta||t.fg3a>t.fga||t.fg3m>t.fgm)throw new Error('College accounting mismatch');
  }
  return data;
}
export function collegeInputFor(data,pid,targetYear){
  return data.records.filter(r=>r.playerId===String(pid)&&r.seasonEndYear<=targetYear&&r.seasonEndYear>=targetYear-3).sort((a,b)=>b.seasonEndYear-a.seasonEndYear)[0]||null;
}
function features(r,bio,key){
  const t=r.totals,per40=k=>40*t[k]/t.min;
  const shooting={fg2:[t.fgm-t.fg3m,t.fga-t.fg3a,0.5],fg3:[t.fg3m,t.fg3a,0.33],ft:[t.ftm,t.fta,0.7]};
  const s=shooting[key];
  const own=s?(s[0]+20*s[2])/(s[1]+20):key==='mpg'||key==='share'?per40('pts')/30:per40(key)/10;
  return [1,own,t.min/r.games/40,Math.log((bio.draftNumber>0?bio.draftNumber:61)+3)/4,(bio.big??2)-2];
}
const baseOf=(p,key)=>key==='mpg'||key==='share'?p[key]:p.pr.rate[key]??p.pr.pct[key];
function actualOf(a,key,games){if(key==='share')return a?clamp(a.gp/games,0,1):0;if(!a?.gp)return null;if(key==='mpg')return a.min/a.gp;if(RATE_STATS.includes(key))return a.poss>0?a[key]/a.poss*100:null;const [made,att]=PCT_STATS[key];return a[att]>=25?a[made]/a[att]:null;}
function adjusted(base,key,delta){return key==='share'?clamp(base+delta,0.05,0.98):key==='mpg'?clamp(base+delta,1,36):Object.hasOwn(PCT_STATS,key)?clamp(base+delta,0.05,0.95):clamp(base+delta,Math.max(0,base*0.25),Math.min(100,base*3));}
export function entryTrainingRows(D,data,{firstYear=2016,lastYear=2025}={}){
  verifyEntryProduction(data);const out=[];
  for(let y=firstYear;y<=lastYear;y++){
    const season=seasonName(y),actuals=D.nba.seasons.get(season),previous=D.nba.seasons.get(seasonName(y-1));
    if(!actuals||!previous)continue;
    const priors=seasonPriors(previous,D.bio),cohort=rookieCohort(D,season);
    for(const [pid,bio] of D.bio){
      // Any prior NBA appearance prevents a player entering a first-season sample.
      if([...D.nba.seasons].some(([s,rows])=>Number(s.slice(0,4))<y&&rows.get(pid)?.gp>0))continue;
      if((bio.fromYear||bio.draftYear)!==y)continue;
      const college=collegeInputFor(data,pid,y);if(!college)continue;
      const baseline=rookieProjection(bio,null,cohort,priors);if(!baseline)continue;
      const actual=actuals.get(pid),games=D.nba.teamGames(season,actual?.team);
      out.push({year:y,pid,bio,college,baseline,actual,games});
    }
  }
  return out;
}
export function fitEntryModels(rows){
  const models={};
  for(const key of KEYS){
    const sample=rows.map(r=>({...r,value:actualOf(r.actual,key,r.games)})).filter(r=>Number.isFinite(r.value)&&(key==='share'||(r.actual?.min??0)>=200));
    if(sample.length<50)continue;
    const X=sample.map(r=>features(r.college,r.bio,key)),y=sample.map(r=>r.value-baseOf(r.baseline,key));
    models[key]={n:sample.length,coefficients:ridge(X,y,null,30,[])};
  }
  return models;
}
export function applyEntryProduction(rookie,bio,college,card){
  if(!college)return rookie;
  const result=structuredClone(rookie),changes={};
  for(const [key,model] of Object.entries(card.models||{})){
    if(!card.enabled?.includes(key))continue;
    const f=features(college,bio,key),delta=f.reduce((s,v,i)=>s+v*model.coefficients[i],0),base=baseOf(rookie,key),next=adjusted(base,key,delta);
    if(key==='mpg'||key==='share')result[key]=next;else if(Object.hasOwn(result.pr.rate,key))result.pr.rate[key]=next;else result.pr.pct[key]=next;
    changes[key]={cohort:base,collegeAdjusted:next};
  }
  result.pr.rate.fg3a=Math.min(result.pr.rate.fg3a,result.pr.rate.fga);
  result.evidence.preNbaStats='verified-college-production';
  result.evidence.production={source:'SportsDataverse ESPN NCAA box scores',sourcePlayerId:college.collegeAthleteId,school:college.teams,seasonEndYear:college.seasonEndYear,games:college.games,minutes:college.totals.min,lastGameDate:college.lastGameDate,identityMethod:college.identityMethod,modelVersion:card.version,trainedThrough:card.trainedThrough,changes};
  result.evidence.coverage.preNbaProduction={available:true,source:'SportsDataverse ESPN NCAA box scores',status:'available'};
  result.evidence.note='Draft/position/age cohort with learned college-production adjustments where held-out development supported them; team opportunity is reconciled separately. International or missing college inputs retain an explicit cohort fallback.';
  return result;
}
export function scoreEntryModels(rows,models,enabled=KEYS){
  return Object.fromEntries(KEYS.map(key=>{
    const sample=rows.filter(r=>Number.isFinite(actualOf(r.actual,key,r.games))&&(key==='share'||(r.actual?.min??0)>=200));
    let baseline=0,model=0;
    for(const r of sample){const a=actualOf(r.actual,key,r.games),base=baseOf(r.baseline,key),m=models[key];const next=m&&enabled.includes(key)?adjusted(base,key,features(r.college,r.bio,key).reduce((s,v,i)=>s+v*m.coefficients[i],0)):base;baseline+=Math.abs(base-a);model+=Math.abs(next-a);}
    return [key,{n:sample.length,baselineMae:sample.length?baseline/sample.length:null,modelMae:sample.length?model/sample.length:null}];
  }));
}

/** The same chronological fitting policy is used by production and historical replays. */
export function fitEntryCard(D,source,targetYear){
  if(!Number.isInteger(targetYear)||targetYear<2016||targetYear>2100)throw new Error('Invalid entry model target year');
  const rows=entryTrainingRows(D,source,{lastYear:targetYear-1}),developmentYear=targetYear-3;
  const development=scoreEntryModels(rows.filter(r=>r.year===developmentYear),fitEntryModels(rows.filter(r=>r.year<developmentYear)));
  const enabled=Object.entries(development).filter(([,v])=>v.n>=20&&v.modelMae<v.baselineMae*0.99).map(([k])=>k);
  return JSON.parse(JSON.stringify({version:ENTRY_PRODUCTION_VERSION,targetYear,trainedThrough:targetYear-1,enabled,models:fitEntryModels(rows),trainingPlayers:rows.length,sourceSha256:crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')},(k,v)=>typeof v==='number'?Math.round(v*1e9)/1e9:v));
}

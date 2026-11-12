import fs from 'node:fs';import path from 'node:path';
import {defaultStageRunner} from './owner-refresh.mjs';
export const DAILY_SOURCE_FILES=['roster.json','gleague-index.json','gleague-rosters.json','gleague-progress.json','transactions.json','season-progress.json','current-grade-inputs.json','current-team-stats.json','current-specialist-inputs.json','two-way-roster.json','injuries.json','news.json','daily-refresh.json'].map(f=>'scripts/data/live/'+f).concat('scripts/data/player_bios.json');
export const DAILY_ARTIFACT_FILES=['public/data.json','public/data-status.json','public/standalone.html'];
export function dailyRefreshStages(){return [
 ...['transactions','live-roster','gleague-index','gleague-rosters','two-way-roster','injuries','season-progress','gleague-progress','current-grade-inputs','current-teams','current-specialists'].map(name=>({id:'fetch-'+name,command:'npm',args:['run','fetch:'+name],optional:['transactions','two-way-roster','injuries'].includes(name),file:{transactions:'transactions.json','two-way-roster':'two-way-roster.json',injuries:'injuries.json'}[name]})),
 {id:'fetch-news',command:'npm',args:['run','fetch:news'],optional:true,file:'news.json'},
 // Supplemental biographies must not consume the morning results window. Run
 // Node directly so the timeout terminates the fetch process, not an npm wrapper.
 {id:'fetch-bios',command:process.execPath,args:['scripts/fetch-player-bios.mjs'],optional:true,sourcePath:'scripts/data/player_bios.json',timeoutMs:120000},
 {id:'build',command:'npm',args:['run','build']},
 {id:'verify',command:'npm',args:['run','verify']},
 {id:'verify-freshness',command:'node',args:['scripts/verify-daily-refresh.mjs']},
];}
export function verifyDailyFreshness(data,{now=new Date(),maxAgeHours=6}={}){
 const sources={nba:data.seasonProgress?.asOf,gleague:data.gLeagueSeasonProgress?.asOf,teams:data.currentTeamStats?.asOf,...Object.fromEntries(Object.entries(data.currentGradeMeta?.cohorts||{}).map(([k,v])=>['grade:'+k,v.asOf]))};
 if(Object.keys(sources).length!==6)throw new Error('Daily refresh is missing required competition sources');
 for(const [key,value] of Object.entries(sources)){const age=now-Date.parse(value);if(!Number.isFinite(age)||age< -300000||age>maxAgeHours*3600000)throw new Error('Daily source is not fresh: '+key);}
 for(const lg of ['NBA','GLEAGUE'])for(const p of data.leagues[lg])for(const type of lg==='NBA'?['Regular Season']:['Showcase','Regular Season']){
  const a=lg==='NBA'?p.seasonActual:p.gLeagueSeasonActual?.phases?.[type],g=p.currentGrades?.[type];
  if(a?.gp>0&&!Number.isFinite(g?.grade))throw new Error('Measured player is missing a current grade: '+p.name);
  if(!a?.gp&&g?.grade!=null)throw new Error('No-appearance player has an invented current grade: '+p.name);
 }
 return sources;
}
export async function runDailyRefresh({root,runStage=null,now=()=>new Date().toISOString()}={}){
 if(!root)throw new Error('Daily refresh root required');
 const backups=new Map([...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES].map(f=>{const p=path.join(root,f);return[p,fs.existsSync(p)?fs.readFileSync(p):null];}));
 const record={version:1,season:'2026-27',startedAt:now(),finishedAt:null,state:'running',stages:[],retainedSources:[]};
 const log=path.join(root,'scripts/data/refresh-runs/daily-latest.json');fs.mkdirSync(path.dirname(log),{recursive:true});
 const save=()=>fs.writeFileSync(log,JSON.stringify(record,null,2)+'\n');save();
 const runner=runStage||defaultStageRunner(root,{BUILD_GENERATED_AT:record.startedAt});
 try{
  for(const stage of dailyRefreshStages()){
   if(stage.id==='build'){
    const info=path.join(root,'scripts/data/live/daily-refresh.json');fs.mkdirSync(path.dirname(info),{recursive:true});fs.writeFileSync(info,JSON.stringify({version:1,checkedAt:now(),retainedSources:record.retainedSources})+'\n');
   }
   let result;try{result=await runner(stage);}catch(error){result={code:1,stderr:error.message};}
   const sourcePath=stage.optional?path.join(root,stage.sourcePath??`scripts/data/live/${stage.file}`):null;
   const canRetain=result.code!==0&&sourcePath&&backups.get(sourcePath);
   record.stages.push({id:stage.id,status:result.code===0?'ok':canRetain?'retained':'failed',stdout:String(result.stdout||'').slice(-3000),stderr:String(result.stderr||'').slice(-3000)});save();
   if(canRetain){fs.writeFileSync(sourcePath,backups.get(sourcePath));record.retainedSources.push({source:stage.id,reason:'Source update did not complete; previous verified snapshot retained. See the Actions run for details.'});}
   else if(result.code!==0)throw new Error(stage.id+': '+(result.stderr||result.stdout||'failed'));
  }
  record.state='verified-ready-to-publish';
 }catch(error){
  for(const [p,bytes] of backups){if(bytes===null)fs.rmSync(p,{force:true});else{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);}}
  record.state='failed';record.failure=String(error.message).slice(-3000);
 }
 record.finishedAt=now();save();return record;
}

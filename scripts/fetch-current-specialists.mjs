import {reconcileSpears} from './lib/gleague-spears.mjs';
import fs from 'node:fs';
import {fetchJson} from './lib/refresh.mjs';
import {specialistJobs,SPECIALIST_SCOPES,validateSpecialist} from './lib/current-specialists.mjs';
const core=JSON.parse(fs.readFileSync(new URL('./data/live/season-progress.json',import.meta.url))),cutoff=core.completedThrough;
if(!cutoff)throw Error('A completed-game window is required before fetching specialist statistics');
const jobs=SPECIALIST_SCOPES.flatMap(([leagueId,type])=>specialistJobs(leagueId,type,cutoff)),records=new Array(jobs.length);let next=0;
async function worker(){while(next<jobs.length){const i=next++,j=jobs[i];try{const payload=reconcileSpears(await fetchJson(j.url,{timeoutMs:18000,attempts:1})),rows=validateSpecialist(payload,j,cutoff);records[i]={...j,status:rows.length?'available':'no-published-rows',payload};}catch(e){records[i]={...j,status:'unavailable',reason:String(e.message).slice(0,240)};}console.log(j.leagueId,j.seasonType,j.name,records[i].status);}}
await Promise.all(Array.from({length:4},worker));
const snapshot={version:1,season:'2026-27',completedThrough:cutoff,fetchedAt:new Date().toISOString(),records};
const target=new URL('./data/live/current-specialist-inputs.json',import.meta.url),tmp=new URL('./data/live/current-specialist-inputs.json.tmp-'+process.pid,import.meta.url);
try{fs.writeFileSync(tmp,JSON.stringify(snapshot)+'\n');fs.renameSync(tmp,target);}finally{if(fs.existsSync(tmp))fs.rmSync(tmp);}
console.log('Specialist sources',Object.fromEntries(['available','no-published-rows','unavailable'].map(s=>[s,records.filter(r=>r.status===s).length])));

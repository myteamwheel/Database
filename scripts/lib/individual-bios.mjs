import fs from 'node:fs';
import path from 'node:path';
import {writeAtomicJson} from './official-table.mjs';
import {verifyLiveRosterSnapshot} from './live-roster.mjs';

const personId=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
export function validBirthdate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z?)?$/.test(value))return false;
  const day=value.slice(0,10),date=new Date(day+'T00:00:00Z');
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===day&&date.getUTCFullYear()>=1900&&date.valueOf()<=Date.now();
}
const text=value=>value==null||value===''?null:(typeof value==='string'?value.trim()||null:typeof value==='number'&&Number.isFinite(value)?String(value):null);

export function parseIndividualBio(body,id) {
  if(!personId(id))throw new Error('Invalid requested bio identity');
  const sets=Array.isArray(body?.resultSets)?body.resultSets:[];
  const table=sets.find(s=>s.name==='CommonPlayerInfo');
  if(!Array.isArray(table?.headers)||!['PERSON_ID','HEIGHT','WEIGHT','BIRTHDATE'].every(h=>table.headers.includes(h))||new Set(table.headers).size!==table.headers.length||table.headers.some(h=>typeof h!=='string'||!h)||!Array.isArray(table.rowSet)||table.rowSet.length!==1)throw new Error('Invalid individual bio table');
  const row=table.rowSet[0];
  if(!Array.isArray(row)||row.length!==table.headers.length)throw new Error('Invalid individual bio row width');
  const r=Object.fromEntries(table.headers.map((h,i)=>[h,row[i]]));
  if(!personId(r.PERSON_ID)||r.PERSON_ID!==id)throw new Error('Individual bio identity mismatch');
  const height=text(r.HEIGHT),weight=text(r.WEIGHT),birthdate=text(r.BIRTHDATE);
  if(height!==null&&!/^\d{1,2}-(?:[0-9]|1[01])$/.test(height))throw new Error('Invalid individual bio height');
  if(weight!==null&&(!/^\d+(?:\.\d+)?$/.test(weight)||Number(weight)<=0||Number(weight)>1000))throw new Error('Invalid individual bio weight');
  if(birthdate!==null&&!validBirthdate(birthdate))throw new Error('Invalid individual bio birthdate');
  return {height,weight,birthdate,position:text(r.POSITION),country:text(r.COUNTRY),school:text(r.SCHOOL),draftYear:text(r.DRAFT_YEAR),draftRound:text(r.DRAFT_ROUND),draftNumber:text(r.DRAFT_NUMBER)};
}

export function individualBioPeople(root,{missingSizeOnly=false}={}) {
  const data=JSON.parse(fs.readFileSync(path.join(root,'public/data.json'),'utf8')),people=new Map();
  const add=(id,name)=>{if(personId(id))people.set(id,name);};
  for(const league of ['NBA','GLEAGUE'])for(const p of data.leagues[league])if(!missingSizeOnly||!p.height||!p.weight)add(p.nbaPersonId,p.name);
  // Include newly signed/rookie players before they appear in the rebuilt product.
  const rosterFile=path.join(root,'scripts/data/live/roster.json');
  if(fs.existsSync(rosterFile)) {
    const roster=verifyLiveRosterSnapshot(JSON.parse(fs.readFileSync(rosterFile,'utf8'))),pos=k=>roster.headers.indexOf(k);
    for(const r of roster.rows)if(!missingSizeOnly||!r[pos('HEIGHT')]||!r[pos('WEIGHT')])add(r[pos('PERSON_ID')],`${r[pos('PLAYER_FIRST_NAME')]} ${r[pos('PLAYER_LAST_NAME')]}`.trim());
  }
  return people;
}

export function readBioCache(file) {
  if(!fs.existsSync(file))return {};
  const store=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!store||Array.isArray(store)||typeof store!=='object'||Object.entries(store).some(([id,r])=>!/^[1-9][0-9]*$/.test(id)||!r||Array.isArray(r)||typeof r!=='object'))throw new Error('Invalid individual bio cache; previous file retained');
  return store;
}

export async function fetchIndividualBio(id,{fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  let failure;
  for(const league of ['', '20']) {
    try {
      const response=await fetchImpl(`https://stats.nba.com/stats/commonplayerinfo?PlayerID=${id}&LeagueID=${league}`,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.nba.com/','Origin':'https://www.nba.com','Accept':'application/json','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      return parseIndividualBio(await response.json(),id);
    } catch(error) {failure=error;}
    if(league==='')await wait(500);
  }
  throw failure;
}

export async function refreshIndividualBioCache({file,people,birthdatesOnly=false,fetchBio=fetchIndividualBio,wait=ms=>new Promise(r=>setTimeout(r,ms)),report=console.log}={}) {
  const store=readBioCache(file);
  let fetched=0,failed=0,unavailable=0;
  for(const [id,name] of people) {
    if(!personId(id))throw new Error('Invalid bio refresh identity');
    const old=store[id];
    if(birthdatesOnly?validBirthdate(old?.birthdate):old?.height&&old?.weight&&validBirthdate(old?.birthdate))continue;
    let bio;
    for(let attempt=0;attempt<3;attempt++) {
      try {bio=await fetchBio(id);break;}
      catch(error){if(attempt===2){failed++;report(`Bio source unavailable for ${name} (${id}): ${error.message}; cached evidence retained`);}else await wait(1500*(attempt+1));}
    }
    if(bio) {
      const fields=birthdatesOnly?['birthdate']:Object.keys(bio),present=fields.filter(k=>bio[k]!==null&&bio[k]!==undefined);
      // Never downgrade known evidence or save a failed null placeholder.
      if(present.length){store[id]={...old,name,...Object.fromEntries(present.map(k=>[k,bio[k]]))};fetched++;}
      if(birthdatesOnly?!validBirthdate(bio.birthdate):!bio.height||!bio.weight||!validBirthdate(bio.birthdate))unavailable++;
    }
    await wait(450);
  }
  if(fetched)writeAtomicJson(file,store);
  return {fetched,failed,unavailable,stored:Object.keys(store).length};
}

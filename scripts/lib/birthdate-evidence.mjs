import fs from 'node:fs';import path from 'node:path';
import {validBirthdate,readBioCache} from './individual-bios.mjs';
import {verifyGLeagueRosters} from './gleague-rosters.mjs';
const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
export function rosterBirthdate(value){
 if(validBirthdate(value))return value.slice(0,10);
 const m=typeof value==='string'&&value.match(/^([A-Z]{3}) (\d{2}), (\d{4})$/);
 if(!m||!months.includes(m[1]))return null;
 const iso=`${m[3]}-${String(months.indexOf(m[1])+1).padStart(2,'0')}-${m[2]}`;
 return validBirthdate(iso)?iso:null;
}
export function mergeBirthdateEvidence(existing,bios,roster){
 const merged=structuredClone(existing);
 const add=(id,name,date,source,asOf)=>{const birthdate=rosterBirthdate(date);if(birthdate&&!validBirthdate(merged[id]?.birthdate))merged[id]={name,birthdate,source,asOf};};
 for(const [id,b] of Object.entries(bios))add(id,b.name,b.birthdate,'official CommonPlayerInfo',null);
 if(roster){const checked=verifyGLeagueRosters(roster);for(const p of checked.players)add(String(p.playerId),p.name,p.birthdate,checked.source,checked.fetchedAt);}
 return merged;
}
export function loadBirthdateEvidence(root){
 const rosterFile=path.join(root,'scripts/data/live/gleague-rosters.json');
 return mergeBirthdateEvidence(readBioCache(path.join(root,'scripts/data/birthdates.json')),readBioCache(path.join(root,'scripts/data/player_bios.json')),fs.existsSync(rosterFile)?JSON.parse(fs.readFileSync(rosterFile)):null);
}

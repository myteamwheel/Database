import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TWO_WAY_URL,parseTwoWayTable,reconcileTwoWayRoster} from './lib/two-way-roster.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const response=await fetch(TWO_WAY_URL,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0'}});
if(!response.ok)throw new Error(`Two-way source HTTP ${response.status}`);
const html=await response.text(), fetchedAt=new Date().toISOString();
const parsed=parseTwoWayTable(html,{fetchedAt});
const roster=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/live/roster.json'),'utf8'));
const result=reconcileTwoWayRoster(parsed,roster);
const file=path.join(root,'scripts/data/live/two-way-roster.json'),temp=`${file}.tmp-${process.pid}`;
try{fs.writeFileSync(temp,JSON.stringify({season:parsed.season,fetchedAt,html})+'\n');fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.rmSync(temp);}
console.log(JSON.stringify({confirmed:result.confirmed.length,unresolved:result.unresolved}));

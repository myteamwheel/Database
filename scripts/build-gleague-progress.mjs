import fs from 'node:fs';import crypto from 'node:crypto';
import {parseGLeagueProgress} from './lib/gleague-progress.mjs';
const file=new URL('../public/data.json',import.meta.url),source=new URL('./data/live/gleague-progress.json',import.meta.url),bytes=fs.readFileSync(source);
const data=JSON.parse(fs.readFileSync(file)),progress=parseGLeagueProgress(JSON.parse(bytes));
for(const p of data.leagues.GLEAGUE)p.gLeagueSeasonActual={season:progress.season,asOf:progress.asOf,phases:Object.fromEntries(Object.entries(progress.phases).map(([type,phase])=>[type,{label:phase.label,...(phase.players[p.nbaPersonId]||{gp:0,totals:null,perGame:null,status:'no-recorded-appearance'})}]))};
data.gLeagueSeasonProgress={season:progress.season,asOf:progress.asOf,note:progress.note,sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),phases:Object.fromEntries(Object.entries(progress.phases).map(([type,p])=>[type,{label:p.label,status:p.status,players:Object.keys(p.players).length,source:p.source}]))};
fs.writeFileSync(file,JSON.stringify(data));console.log('Built separate G League current-season competition phases.');

import fs from 'node:fs';import {appendCurrentParticipants} from './lib/current-participants.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const data=read('public/data.json'),nba=read('scripts/data/live/season-progress.json'),gl=read('scripts/data/live/gleague-progress.json');
appendCurrentParticipants(data,{NBA:[nba.stats.resultSets[0]],GLEAGUE:gl.phases.map(p=>p.stats.resultSets[0])});
fs.writeFileSync(new URL('../public/data.json',import.meta.url),JSON.stringify(data));

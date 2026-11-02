import fs from 'node:fs';
import crypto from 'node:crypto';
import {prepare} from './lib/projection.mjs';
import {ENTRY_PRODUCTION_VERSION,fitEntryCard,entryTrainingRows,fitEntryModels,scoreEntryModels} from './lib/entry-production.mjs';
const root=new URL('../',import.meta.url),raw=fs.readFileSync(new URL('scripts/data/projection/entry-production.json',root));
const D=prepare(JSON.parse(fs.readFileSync(new URL('scripts/data/projection/inputs.json',root))));
const data=JSON.parse(raw),rows=entryTrainingRows(D,data);
const development=scoreEntryModels(rows.filter(r=>r.year===2023),fitEntryModels(rows.filter(r=>r.year<2023)));
const enabled=Object.entries(development).filter(([,v])=>v.n>=20&&v.modelMae<v.baselineMae*0.99).map(([k])=>k);
const holdouts=Object.fromEntries([2024,2025].map(y=>[y,scoreEntryModels(rows.filter(r=>r.year===y),fitEntryModels(rows.filter(r=>r.year<y)),enabled)]));
const round=o=>JSON.parse(JSON.stringify(o,(k,v)=>typeof v==='number'?Math.round(v*1e9)/1e9:v));
const card=round({...fitEntryCard(D,data,2026),lambda:30,
 protocol:'College-production residual adjustments to the historical entry-cohort model. Ridge penalty 30 fixed before holdout evaluation; 2023 development enables metrics improving MAE by at least 1%, then 2024/2025 holdouts score unchanged structure. Production refits through 2025 for 2026 entry.',
 boundary:'Retrospective unique-name NBA/college joins and NBA index entry labels; missing international/college inputs keep cohort fallbacks. Historical index coverage can omit undrafted nonappearers. Live age and team-minute reconciliation are evaluated separately.'});
fs.writeFileSync(new URL('ENTRY_PRODUCTION_MODEL.json',root),JSON.stringify(card,null,2)+'\n');
fs.writeFileSync(new URL('docs/ENTRY_PRODUCTION_EVALUATION.json',root),JSON.stringify(round({version:card.version,protocol:card.protocol,boundary:card.boundary,development,enabled,holdouts}),null,2)+'\n');
console.log(JSON.stringify({trainingPlayers:rows.length,enabled,holdouts}));

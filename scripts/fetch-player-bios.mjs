// Backfill missing official measurements without caching failed lookups as facts.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {individualBioPeople,refreshIndividualBioCache} from './lib/individual-bios.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=await refreshIndividualBioCache({file:path.join(root,'scripts/data/player_bios.json'),people:individualBioPeople(root,{missingSizeOnly:true})});
console.log(JSON.stringify({source:'official individual bios',...result}));

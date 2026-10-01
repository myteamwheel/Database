// Unknown/failed dates remain retryable; preserve valid dates and source identities.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {individualBioPeople,refreshIndividualBioCache,readBioCache,validBirthdate} from './lib/individual-bios.mjs';
import {writeAtomicJson} from './lib/official-table.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..'),file=path.join(root,'scripts/data/birthdates.json');
const store=readBioCache(file),bios=readBioCache(path.join(root,'scripts/data/player_bios.json'));
let seeded=0;
for(const [id,bio] of Object.entries(bios))if(validBirthdate(bio.birthdate)&&!validBirthdate(store[id]?.birthdate)){store[id]={name:bio.name,birthdate:bio.birthdate};seeded++;}
if(seeded)writeAtomicJson(file,store);
const result=await refreshIndividualBioCache({file,people:individualBioPeople(root),birthdatesOnly:true});
console.log(JSON.stringify({source:'official individual birthdates',seeded,...result}));

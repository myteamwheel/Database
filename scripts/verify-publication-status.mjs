import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveModelProvenance, deriveSourceDomains, validatePublicationStatus } from './lib/publication.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataPath=path.join(ROOT,'public/data.json');
const statusPath=path.join(ROOT,'public/data-status.json');
if(!fs.existsSync(dataPath)) throw new Error('public/data.json is missing');
if(!fs.existsSync(statusPath)) throw new Error('public/data-status.json is missing; run npm run publish:status');

const publicDataBytes=fs.readFileSync(dataPath);
const publicData=JSON.parse(publicDataBytes.toString('utf8'));
const status=JSON.parse(fs.readFileSync(statusPath,'utf8'));
validatePublicationStatus(status,{publicData,publicDataBytes,root:ROOT});

const expected=deriveSourceDomains({root:ROOT,publicData});
if(JSON.stringify(status.sourceDomains)!==JSON.stringify(expected)){
  throw new Error('Publication source-domain status is stale relative to tracked source/provenance files.');
}
const expectedModels=deriveModelProvenance({root:ROOT,publicData});
if(JSON.stringify(status.modelProvenance)!==JSON.stringify(expectedModels)){
  throw new Error('Publication model provenance is stale relative to implementation/input files.');
}
console.log('publication status verified: '+status.publicationId+' · '+status.season+' · '+status.dataSha256.slice(0,12));

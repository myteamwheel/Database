import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {refreshGLeagueIndex} from './lib/live-gleague-index.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=await refreshGLeagueIndex({file:path.join(root,'scripts/data/live/gleague-index.json')});
console.log(`Verified official provisional ${result.season} G League index: ${result.rows.length} players, ${result.fetchedAt}`);

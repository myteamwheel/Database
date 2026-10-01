import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnerRefresh } from './lib/owner-refresh.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const seasonArg=args.indexOf('--season');
const season=seasonArg>=0 ? args[seasonArg+1] : (process.env.REFRESH_SEASON || '2025-26');

const result=await runOwnerRefresh({root:ROOT,season});
console.log(JSON.stringify({season:result.season,state:result.state,startedAt:result.startedAt,finishedAt:result.finishedAt,failure:result.failure},null,2));
if(result.state!=='verified-ready-to-publish') process.exit(1);

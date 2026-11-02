import fs from 'node:fs';
import {refreshGLeagueRosters} from './lib/gleague-rosters.mjs';
import {verifyGLeagueIndex} from './lib/live-gleague-index.mjs';
const index=verifyGLeagueIndex(JSON.parse(fs.readFileSync(new URL('./data/live/gleague-index.json',import.meta.url))));
const fetchJson=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://stats.gleague.nba.com/',Origin:'https://stats.gleague.nba.com','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});if(!r.ok)throw new Error(`Official G League roster HTTP ${r.status}`);return r.json();};
const result=await refreshGLeagueRosters({file:new URL('./data/live/gleague-rosters.json',import.meta.url).pathname,index,fetchJson});
console.log(`Verified ${result.players.length} team-level G League roster listings across 31 teams as of ${result.fetchedAt}`);

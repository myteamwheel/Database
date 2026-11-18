import {reconcileDashboardSegments} from './lib/dashboard-segments.mjs';
import {parseGLeagueProgress} from './lib/gleague-progress.mjs';
import {fetchJson} from './lib/refresh.mjs';
import {reconcileSpears} from './lib/gleague-spears.mjs';
import fs from 'node:fs';import {advancedTable} from './lib/current-season-grades.mjs';
const progress=JSON.parse(fs.readFileSync(new URL('./data/live/season-progress.json',import.meta.url))),baseUrl=progress.sourceUrls.stats;
const records=[],gLeague=parseGLeagueProgress(JSON.parse(fs.readFileSync(new URL('./data/live/gleague-progress.json',import.meta.url))));
for(const [leagueId,seasonType] of [['00','Regular Season'],['20','Showcase'],['20','Regular Season']]){
 const url=new URL(baseUrl);url.searchParams.set('LeagueID',leagueId);url.searchParams.set('SeasonType',seasonType);url.searchParams.set('MeasureType','Advanced');
 const source=await fetchJson(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://stats.gleague.nba.com/',Origin:'https://stats.gleague.nba.com','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});
 const expected=leagueId==='20'?new Map(Object.entries(gLeague.phases[seasonType].players).map(([id,p])=>[Number(id),{GP:p.gp}])):null;
 const payload=reconcileDashboardSegments(reconcileSpears(source),expected);const parsed=advancedTable(payload,{leagueId,seasonType});records.push({leagueId,seasonType,source:url.href,payload});console.log(leagueId,seasonType,parsed.size);
}
// Reject cross-request snapshot races before atomically installing the new cache.
const expected=new Map(progress.stats.resultSets[0].rowSet.map(r=>[r[progress.stats.resultSets[0].headers.indexOf('PLAYER_ID')],r[progress.stats.resultSets[0].headers.indexOf('GP')]]));
const measured=advancedTable(records[0].payload,records[0]);if(measured.size!==expected.size||[...expected].some(([id,gp])=>measured.get(id)?.GP!==gp))throw new Error('NBA base/advanced snapshot changed during refresh; prior advanced snapshot retained');
const snapshot={version:1,season:'2026-27',fetchedAt:new Date().toISOString(),records};
const file=new URL('./data/live/current-grade-inputs.json',import.meta.url),temp=new URL('./data/live/current-grade-inputs.json.tmp-'+process.pid,import.meta.url);
if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).fetchedAt>snapshot.fetchedAt)throw new Error('Current advanced snapshot moved backwards');
try{fs.writeFileSync(temp,JSON.stringify(snapshot)+'\n');fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.rmSync(temp);}

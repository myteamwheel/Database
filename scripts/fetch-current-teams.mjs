import fs from 'node:fs';
import {CURRENT_SCOPES,parseCurrentTeams} from './lib/current-teams.mjs';
import {fetchJson} from './lib/refresh.mjs';
const progress=JSON.parse(fs.readFileSync(new URL('./data/live/season-progress.json',import.meta.url))),records=[];
for(const [leagueId,seasonType] of CURRENT_SCOPES){
 const team=new URL(progress.sourceUrls.stats);team.pathname='/stats/leaguedashteamstats';team.searchParams.set('LeagueID',leagueId);team.searchParams.set('SeasonType',seasonType);
 const games=new URL(progress.sourceUrls.gameLog);games.searchParams.set('PlayerOrTeam','T');games.searchParams.set('LeagueID',leagueId);games.searchParams.set('SeasonType',seasonType);
 const [stats,log]=await Promise.all([fetchJson(team.href),fetchJson(games.href)]);
 records.push({leagueId,seasonType,source:team.href,gamesSource:games.href,stats,games:log});
}
const snapshot={version:1,season:'2026-27',fetchedAt:new Date().toISOString(),records},parsed=parseCurrentTeams(snapshot);
const file=new URL('./data/live/current-team-stats.json',import.meta.url),tmp=new URL('./data/live/current-team-stats.json.tmp-'+process.pid,import.meta.url);
if(fs.existsSync(file)){const old=parseCurrentTeams(JSON.parse(fs.readFileSync(file)));for(const key of Object.keys(old.scopes))if(parsed.scopes[key].completedGames<old.scopes[key].completedGames)throw new Error('Team completed games moved backwards');}
try{fs.writeFileSync(tmp,JSON.stringify(snapshot)+'\n');fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.rmSync(tmp);}
console.log(Object.fromEntries(Object.entries(parsed.scopes).map(([k,v])=>[k,{games:v.completedGames,teams:v.teams.length,latest:v.latestGameDate}])));

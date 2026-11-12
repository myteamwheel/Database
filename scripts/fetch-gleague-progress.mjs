import fs from 'node:fs';import {parseGLeagueProgress} from './lib/gleague-progress.mjs';
import {windowedUrl} from './lib/completed-window.mjs';
import {fetchJson} from './lib/refresh.mjs';
const completedThrough=JSON.parse(fs.readFileSync(new URL('./data/live/season-progress.json',import.meta.url))).completedThrough;
if(!completedThrough)throw Error('Fetch the shared completed-game window before G League statistics');
const phases=[];
for(const apiSeasonType of ['Showcase','Regular Season']){
 const params=new URLSearchParams({College:'',Conference:'',Country:'',DateFrom:'',DateTo:'',Division:'',DraftPick:'',DraftYear:'',GameScope:'',GameSegment:'',Height:'',LastNGames:'0',LeagueID:'20',Location:'',MeasureType:'Base',Month:'0',OpponentTeamID:'0',Outcome:'',PORound:'0',PaceAdjust:'N',PerMode:'Totals',Period:'0',PlayerExperience:'',PlayerPosition:'',PlusMinus:'N',Rank:'N',Season:'2026-27',SeasonSegment:'',SeasonType:apiSeasonType,ShotClockRange:'',StarterBench:'',TeamID:'0',TwoWay:'0',VsConference:'',VsDivision:'',Weight:''});
 const source=windowedUrl('https://stats.gleague.nba.com/stats/leaguedashplayerstats?'+params,completedThrough);
 const response=await fetch(source,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://stats.gleague.nba.com/',Origin:'https://stats.gleague.nba.com','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});
 if(!response.ok)throw new Error('G League current stats HTTP '+response.status+': '+(await response.text()).slice(0,800));
 const log=new URL(JSON.parse(fs.readFileSync(new URL('./data/live/season-progress.json',import.meta.url))).sourceUrls.gameLog);log.searchParams.set('LeagueID','20');log.searchParams.set('SeasonType',apiSeasonType);
 const gameLogSource=log.href;log.searchParams.set('PlayerOrTeam','T');const teamGameLogSource=log.href;
 const [gameLog,teamGameLog]=await Promise.all([fetchJson(gameLogSource),fetchJson(teamGameLogSource)]);
 phases.push({apiSeasonType,source,stats:await response.json(),gameLogSource,gameLog,teamGameLogSource,teamGameLog});
}
const snapshot={version:1,season:'2026-27',fetchedAt:new Date().toISOString(),completedThrough,phases},checked=parseGLeagueProgress(snapshot);
const file=new URL('./data/live/gleague-progress.json',import.meta.url),tmp=new URL('./data/live/gleague-progress.json.tmp-'+process.pid,import.meta.url);
if(fs.existsSync(file)){const previous=parseGLeagueProgress(JSON.parse(fs.readFileSync(file)));if(previous.asOf>checked.asOf)throw new Error('G League progress moved backwards');for(const type of Object.keys(previous.phases))if(Object.keys(previous.phases[type].players).length>0&&Object.keys(checked.phases[type].players).length===0)throw new Error('G League published phase unexpectedly empty; retain prior snapshot');}
try{fs.writeFileSync(tmp,JSON.stringify(snapshot)+'\n');fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.rmSync(tmp);}
console.log(JSON.stringify(Object.fromEntries(Object.entries(checked.phases).map(([k,v])=>[k,{players:Object.keys(v.players).length,status:v.status}]))));

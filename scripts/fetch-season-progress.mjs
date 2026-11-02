import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchJson} from './lib/refresh.mjs';
import {parseSeasonProgress} from './lib/season-progress.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const season='2026-27';
const params=new URLSearchParams({College:'',Conference:'',Country:'',DateFrom:'',DateTo:'',Division:'',DraftPick:'',DraftYear:'',GameScope:'',GameSegment:'',Height:'',LastNGames:'0',LeagueID:'00',Location:'',MeasureType:'Base',Month:'0',OpponentTeamID:'0',Outcome:'',PORound:'0',PaceAdjust:'N',PerMode:'Totals',Period:'0',PlayerExperience:'',PlayerPosition:'',PlusMinus:'N',Rank:'N',Season:season,SeasonSegment:'',SeasonType:'Regular Season',ShotClockRange:'',StarterBench:'',TeamID:'0',TwoWay:'0',VsConference:'',VsDivision:'',Weight:''});
const gameParams=new URLSearchParams({Counter:'0',DateFrom:'',DateTo:'',Direction:'ASC',LeagueID:'00',PlayerOrTeam:'P',Season:season,SeasonType:'Regular Season',Sorter:'DATE'});
const sourceUrls={schedule:'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',stats:`https://stats.gleague.nba.com/stats/leaguedashplayerstats?${params.toString().replaceAll('+','%20')}`,gameLog:`https://stats.gleague.nba.com/stats/leaguegamelog?${gameParams.toString().replaceAll('+','%20')}`};
const fetchStats=async url=>{const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://stats.gleague.nba.com/',Origin:'https://stats.gleague.nba.com','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});if(!response.ok)throw new Error('Official shared NBA stats HTTP '+response.status);const body=await response.json();if(!body?.resultSets)throw new Error('Official NBA statistics response is missing its table');return body;};
const [schedule,stats,gameLog]=await Promise.all([
  fetchJson(sourceUrls.schedule),
  fetchStats(sourceUrls.stats),
  fetchStats(sourceUrls.gameLog),
]);
const fetchedAt=new Date().toISOString();
const progress=parseSeasonProgress(schedule,stats,{season,fetchedAt,gameLog,sourceUrls});
const file=path.join(root,'scripts/data/live/season-progress.json');
if(fs.existsSync(file)) {
  const old=JSON.parse(fs.readFileSync(file,'utf8'));
  const previous=parseSeasonProgress(old.schedule,old.stats,old);
  if(previous.season===season && progress.completedGames<previous.completedGames) throw new Error('Completed-game source moved backwards; previous snapshot preserved');
}
fs.mkdirSync(path.dirname(file),{recursive:true});
const temp=`${file}.tmp-${process.pid}`;
try {fs.writeFileSync(temp,JSON.stringify({season,fetchedAt,schedule,stats,gameLog,sourceUrls})+'\n');fs.renameSync(temp,file);}
finally {if(fs.existsSync(temp))fs.rmSync(temp);}
console.log(JSON.stringify({season,fetchedAt,status:progress.status,completedGames:progress.completedGames,players:Object.keys(progress.players).length,officialDashboardCorrections:progress.sourceCorrections}));

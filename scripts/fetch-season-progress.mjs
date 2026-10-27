import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchJson} from './lib/refresh.mjs';
import {parseSeasonProgress} from './lib/season-progress.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const season='2026-27';
const params=new URLSearchParams({College:'',Conference:'',Country:'',DateFrom:'',DateTo:'',Division:'',DraftPick:'',DraftYear:'',GameScope:'',GameSegment:'',Height:'',LastNGames:'0',LeagueID:'00',Location:'',MeasureType:'Base',Month:'0',OpponentTeamID:'0',Outcome:'',PORound:'0',PaceAdjust:'N',PerMode:'Totals',Period:'0',PlayerExperience:'',PlayerPosition:'',PlusMinus:'N',Rank:'N',Season:season,SeasonSegment:'',SeasonType:'Regular Season',ShotClockRange:'',StarterBench:'',TeamID:'0',TwoWay:'0',VsConference:'',VsDivision:'',Weight:''});
const [schedule,stats]=await Promise.all([
  fetchJson('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json'),
  fetchJson(`https://stats.nba.com/stats/leaguedashplayerstats?${params}`),
]);
const fetchedAt=new Date().toISOString();
const progress=parseSeasonProgress(schedule,stats,{season,fetchedAt});
const file=path.join(root,'scripts/data/live/season-progress.json');
if(fs.existsSync(file)) {
  const old=JSON.parse(fs.readFileSync(file,'utf8'));
  const previous=parseSeasonProgress(old.schedule,old.stats,{season:old.season,fetchedAt:old.fetchedAt});
  if(previous.season===season && progress.completedGames<previous.completedGames) throw new Error('Completed-game source moved backwards; previous snapshot preserved');
}
fs.mkdirSync(path.dirname(file),{recursive:true});
const temp=`${file}.tmp-${process.pid}`;
try {fs.writeFileSync(temp,JSON.stringify({season,fetchedAt,schedule,stats})+'\n');fs.renameSync(temp,file);}
finally {if(fs.existsSync(temp))fs.rmSync(temp);}
console.log(JSON.stringify({season,fetchedAt,status:progress.status,completedGames:progress.completedGames,players:Object.keys(progress.players).length}));

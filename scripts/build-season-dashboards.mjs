import {parseCurrentTeams} from './lib/current-teams.mjs';
import {DAILY_REFRESH_SCHEDULE} from './lib/refresh-schedule.mjs';
import {attachGLeagueTracker} from './lib/gleague-tracker.mjs';
import {readVerifiedForecast} from './verify-forecast-archive.mjs';
import {savedForecastReview} from './lib/saved-forecast-review.mjs';
import fs from 'node:fs';import crypto from 'node:crypto';
import {advancedTable,gradeCurrentRows} from './lib/current-season-grades.mjs';
import {parseSeasonProgress} from './lib/season-progress.mjs';import {parseGLeagueProgress} from './lib/gleague-progress.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const data=read('public/data.json'),nbaRaw=read('scripts/data/live/season-progress.json'),glRaw=read('scripts/data/live/gleague-progress.json'),input=read('scripts/data/live/current-grade-inputs.json');
attachGLeagueTracker(data,read('scripts/data/gleague-tracker-source.json'),read('scripts/data/live/gleague-rosters.json'));
if(input.version!==1||input.season!=='2026-27'||input.records?.length!==3||!Number.isFinite(Date.parse(input.fetchedAt)))throw new Error('Invalid current-grade source snapshot');
const nba=parseSeasonProgress(nbaRaw.schedule,nbaRaw.stats,nbaRaw),gl=parseGLeagueProgress(glRaw);
const records=new Map(input.records.map(r=>[r.leagueId+':'+r.seasonType,r]));if(records.size!==3)throw new Error('Duplicate current-grade source scope');
const meta={};
for(const [leagueId,type] of [['00','Regular Season'],['20','Showcase'],['20','Regular Season']]){
 const r=records.get(leagueId+':'+type);const url=new URL(r?.source);if(url.protocol!=='https:'||!['stats.gleague.nba.com','stats.nba.com'].includes(url.hostname)||url.pathname!=='/stats/leaguedashplayerstats'||url.searchParams.get('LeagueID')!==leagueId||url.searchParams.get('MeasureType')!=='Advanced'||url.searchParams.get('Season')!=='2026-27'||url.searchParams.get('SeasonType')!==type)throw new Error('Current advanced source URL mismatch');const adv=advancedTable(r?.payload,{leagueId,seasonType:type});
 const league=leagueId==='00'?'NBA':'GLEAGUE',actual=league==='NBA'?nba.players:gl.phases[type].players;
 if(adv.size!==Object.keys(actual).length)throw new Error('Current advanced/base coverage changed; refresh both snapshots together');
 const base=league==='NBA'?nbaRaw.stats.resultSets[0]:glRaw.phases.find(p=>p.apiSeasonType===type).stats.resultSets[0];
 const grades=gradeCurrentRows(data.leagues[league],actual,base,adv);
 for(const p of data.leagues[league]){p.currentGrades??={};p.currentGrades[type]=grades.get(String(p.playerId))||{grade:null,rateGrade:null,magnitudeGrade:null,reliability:null,reason:'No measured appearance in this competition'};}
 meta[league+':'+type]={graded:grades.size,asOf:input.fetchedAt,source:r.source};
}
data.currentGradeMeta={season:'2026-27',version:'3.4-current-1',cohorts:meta,note:'Full performance, per-36 and magnitude grades use the existing grade model on current-season base and official advanced inputs. NBA and each G League phase rank separately. Missing defensive win shares are disclosed through coverage; nonappearers have no grade. Early samples shrink toward their league mean.',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('./data/live/current-grade-inputs.json',import.meta.url))).digest('hex')};
const teamPath='scripts/data/live/current-team-stats.json';
data.currentTeamStats=parseCurrentTeams(read(teamPath));
data.currentTeamStats.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(new URL('../'+teamPath,import.meta.url))).digest('hex');
if(data.currentTeamStats.scopes['NBA:Regular Season'].completedGames!==data.seasonProgress.completedGames)throw new Error('NBA schedule and team game counts disagree; refresh together');
for(const type of ['Showcase','Regular Season'])if(Boolean(data.currentTeamStats.scopes['GLEAGUE:'+type].completedGames)!==Boolean(Object.keys(gl.phases[type].players).length))throw new Error('G League player/team phase publication mismatch');
data.refreshSchedule=DAILY_REFRESH_SCHEDULE;
const dailyFile=new URL('./data/live/daily-refresh.json',import.meta.url);
if(fs.existsSync(dailyFile)){data.dailyRefresh=JSON.parse(fs.readFileSync(dailyFile));data.dailyRefresh.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(dailyFile)).digest('hex');}
delete data.seasonReview;
data.savedForecastReview=savedForecastReview(readVerifiedForecast({forecastId:'2026-27-preseason-2026-09-29-e718284'}).archive);
fs.writeFileSync(new URL('../public/data.json',import.meta.url),JSON.stringify(data));console.log('Built current-season grades and verified September 29 preseason forecast comparison');

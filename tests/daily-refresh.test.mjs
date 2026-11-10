import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseCurrentTeams,CURRENT_SCOPES} from '../scripts/lib/current-teams.mjs';
import {appendCurrentParticipants} from '../scripts/lib/current-participants.mjs';
import {runDailyRefresh,dailyRefreshStages,DAILY_SOURCE_FILES,DAILY_ARTIFACT_FILES,verifyDailyFreshness} from '../scripts/lib/daily-refresh.mjs';
import {DAILY_REFRESH_SCHEDULE} from '../scripts/lib/refresh-schedule.mjs';
const counts=['PTS','REB','AST','STL','BLK','TOV','FGM','FGA','FG3M','FG3A','FTM','FTA'],zero=counts.map(()=>0);
function fixture(){return {version:1,season:'2026-27',fetchedAt:'2026-11-02T12:30:00Z',records:CURRENT_SCOPES.map(([leagueId,seasonType])=>{const params={LeagueID:leagueId,Season:'2026-27',SeasonType:seasonType},url=e=>'https://stats.gleague.nba.com/stats/'+e+'?'+new URLSearchParams(params);return {leagueId,seasonType,source:url('leaguedashteamstats'),gamesSource:url('leaguegamelog'),stats:{parameters:{...params,MeasureType:'Base',PerMode:'Totals'},resultSets:[{name:'LeagueDashTeamStats',headers:['TEAM_ID','TEAM_NAME','GP','W','L',...counts],rowSet:leagueId==='00'?[[1,'A',1,1,0,...zero],[2,'B',1,0,1,...zero]]:[]}]},games:{parameters:{...params,PlayerOrTeam:'T'},resultSets:[{name:'LeagueGameLog',headers:['TEAM_ID','GAME_ID','GAME_DATE','WL',...counts],rowSet:leagueId==='00'?[[1,'0022600001','2026-11-01','W',...zero],[2,'0022600001','2026-11-01','L',...zero]]:[]}]}};})};}
const valid=fixture();assert.equal(parseCurrentTeams(valid).scopes['NBA:Regular Season'].completedGames,1);
for(const mutate of [x=>x.records[0].games.resultSets[0].rowSet.pop(),x=>x.records[0].stats.resultSets[0].rowSet[0][2]=2,x=>x.records[0].games.parameters.LeagueID='20',x=>x.records.push(x.records[0])]){const x=structuredClone(valid);mutate(x);assert.throws(()=>parseCurrentTeams(x));}
const corrected=structuredClone(valid);corrected.records[0].stats.resultSets[0].rowSet[0][5]=1;const fixed=parseCurrentTeams(corrected).scopes['NBA:Regular Season'];assert.equal(fixed.corrections.length,1);assert.equal(fixed.teams[0].totals.pts,0,'identical game exposure reconciles dashboard corrections to logs');
const data={leagues:{NBA:[],GLEAGUE:[]}},table={headers:['PLAYER_ID','PLAYER_NAME'],rowSet:[[123,'Signed Then Waived']]};appendCurrentParticipants(data,{NBA:[table],GLEAGUE:[]});appendCurrentParticipants(data,{NBA:[table],GLEAGUE:[]});assert.equal(data.leagues.NBA.length,1);assert.equal(data.leagues.NBA[0].currentRoster,false);assert.equal(data.leagues.NBA[0].grade,null);
const dual={leagues:{NBA:[{nbaPersonId:124,currentTeam:'CLE',currentRoster:true}],GLEAGUE:[]}};
appendCurrentParticipants(dual,{NBA:[],GLEAGUE:[{headers:['PLAYER_ID','PLAYER_NAME'],rowSet:[[123,'Unsigned Player'],[124,'Dual League Player']]}]});
assert.equal(dual.leagues.GLEAGUE[0].currentNbaTeam,null);
assert.equal(dual.leagues.GLEAGUE[1].currentNbaTeam,'CLE');
for(const player of dual.leagues.GLEAGUE)assert.deepEqual(player.tulipBeta,{abstain:true,status:'BETA',reason:'not_supported_for_gleague'});
for(const player of dual.leagues.GLEAGUE)assert.deepEqual(player.tulipCapacity,{abstain:true,reason:'not_validated_for_gleague',version:'TULIP_CAPACITY_V1'});
assert.deepEqual(data.leagues.NBA[0].tulipCapacity,{abstain:true,reason:'no_game_log_for_source_season',version:'TULIP_CAPACITY_V1'});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-refresh-'));
try{
 for(const f of [...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES]){const p=path.join(root,f);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'original');}
 const failed=await runDailyRefresh({root,runStage:async stage=>{for(const f of [...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES])fs.writeFileSync(path.join(root,f),'changed');return{code:stage.id==='verify'?1:0,stderr:'intentional rejection'};}});
 assert.equal(failed.state,'failed');for(const f of [...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES])assert.equal(fs.readFileSync(path.join(root,f),'utf8'),'original');
 const calls=[];const good=await runDailyRefresh({root,runStage:async s=>{calls.push(s.id);return {code:0};}});assert.equal(good.state,'verified-ready-to-publish');assert.deepEqual(calls,dailyRefreshStages().map(s=>s.id));assert.equal(calls.at(-1),'verify-freshness');
 const optional=await runDailyRefresh({root,runStage:async s=>({code:s.id==='fetch-transactions'?1:0})});assert.equal(optional.state,'verified-ready-to-publish');assert.equal(optional.retainedSources[0].source,'fetch-transactions');assert.equal(fs.readFileSync(path.join(root,'scripts/data/live/transactions.json'),'utf8'),'original');assert.ok(!calls.includes('fetch-official'),'historical/model inputs stay frozen');
 const bioCache=path.join(root,'scripts/data/player_bios.json');
 const unavailableBios=await runDailyRefresh({root,runStage:async stage=>{
  if(stage.id!=='fetch-bios')return {code:0};
  assert.equal(stage.command,process.execPath);
  assert.equal(stage.timeoutMs,120000);
  fs.writeFileSync(bioCache,'partial bio update');
  return {code:1,stderr:'Bio process timed out'};
 }});
 assert.equal(unavailableBios.state,'verified-ready-to-publish');
 assert.equal(unavailableBios.retainedSources[0].source,'fetch-bios');
 assert.equal(fs.readFileSync(bioCache,'utf8'),'original');
}finally{fs.rmSync(root,{recursive:true,force:true});}
const stamp='2026-11-02T12:30:00Z',fresh={leagues:{NBA:[],GLEAGUE:[]},seasonProgress:{asOf:stamp},gLeagueSeasonProgress:{asOf:stamp},currentTeamStats:{asOf:stamp},currentGradeMeta:{cohorts:Object.fromEntries(CURRENT_SCOPES.map(([l,t])=>[l+':'+t,{asOf:stamp}]))}};
assert.doesNotThrow(()=>verifyDailyFreshness(fresh,{now:new Date(stamp)}));assert.throws(()=>verifyDailyFreshness(fresh,{now:new Date('2026-11-03T12:30:00Z')}),/fresh/);fresh.leagues.NBA.push({name:'Missing',seasonActual:{gp:1}});assert.throws(()=>verifyDailyFreshness(fresh,{now:new Date(stamp)}),/missing a current grade/);
const workflow=fs.readFileSync('.github/workflows/daily-season-refresh.yml','utf8'),publish=fs.readFileSync('scripts/publish-daily-refresh.mjs','utf8');
assert.match(workflow,/cron: '17 7,10 \* \* \*'/);assert.match(workflow,/timezone: America\/New_York/);assert.equal(DAILY_REFRESH_SCHEDULE.timezone,'America/New_York');assert.match(workflow,/github.ref == 'refs\/heads\/v3-official-data'/);assert.ok(workflow.indexOf('npm run refresh:daily')<workflow.indexOf('node scripts/publish-daily-refresh.mjs'));assert.ok(workflow.indexOf('node scripts/publish-daily-refresh.mjs')<workflow.indexOf('gh workflow run deploy-pages.yml'));assert.match(publish,/FETCH_HEAD.*expected/);assert.doesNotMatch(publish,/--force|rebase/);assert.ok(DAILY_SOURCE_FILES.every(f=>f.startsWith('scripts/data/live/')||f==='scripts/data/player_bios.json'));
// Execute the publisher against a fake git transport: refuse an advanced base,
// unexpected staged file or failed push, and never silently deploy after failure.
const pubRoot=fs.mkdtempSync(path.join(os.tmpdir(),'daily-publish-'));
try{
 fs.mkdirSync(path.join(pubRoot,'bin'));fs.mkdirSync(path.join(pubRoot,'public'));fs.mkdirSync(path.join(pubRoot,'scripts/data/refresh-runs'),{recursive:true});
 const snapshot=structuredClone(fresh);snapshot.leagues.NBA=[];const current=new Date().toISOString();snapshot.seasonProgress.asOf=current;snapshot.gLeagueSeasonProgress.asOf=current;snapshot.currentTeamStats.asOf=current;for(const v of Object.values(snapshot.currentGradeMeta.cohorts))v.asOf=current;
 fs.writeFileSync(path.join(pubRoot,'public/data.json'),JSON.stringify(snapshot));fs.writeFileSync(path.join(pubRoot,'scripts/data/refresh-runs/daily-latest.json'),JSON.stringify({state:'verified-ready-to-publish',finishedAt:current}));
 const shim=`#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_TRACE_FILE"
case "$1" in
 rev-parse) if [ "$2" = FETCH_HEAD ] && [ "$PUBLISH_CASE" = advanced ]; then echo changed; else echo expected; fi ;;
 diff) if [ "$PUBLISH_CASE" = unexpected ]; then echo app.js; else echo public/data.json; fi ;;
 -c) if [ "$PUBLISH_CASE" = pushfail ]; then exit 1; fi ;;
esac
`;
 fs.writeFileSync(path.join(pubRoot,'bin/git'),shim,{mode:0o755});
 for(const scenario of ['success','advanced','unexpected','pushfail','wrongref']){
  const trace=path.join(pubRoot,scenario+'.log');const out=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/publish-daily-refresh.mjs',import.meta.url))],{cwd:pubRoot,encoding:'utf8',env:{...process.env,PATH:path.join(pubRoot,'bin')+':'+process.env.PATH,GIT_TRACE_FILE:trace,PUBLISH_CASE:scenario,GITHUB_REF:scenario==='wrongref'?'refs/heads/feature':'refs/heads/v3-official-data'}});
  assert.equal(out.status,scenario==='success'?0:1,out.stderr);const calls=fs.existsSync(trace)?fs.readFileSync(trace,'utf8'):'';if(['advanced','unexpected','wrongref'].includes(scenario))assert.doesNotMatch(calls,/push/);assert.doesNotMatch(calls,/--force|rebase/);
 }
}finally{fs.rmSync(pubRoot,{recursive:true,force:true});}
console.log('Daily refresh: schedules, source/competition integrity, missing participant inclusion, fail-safe rollback, current-grade coverage and publication sequencing passed.');

assert.ok(dailyRefreshStages().some(s=>s.id==='fetch-news'));assert.ok(dailyRefreshStages().some(s=>s.id==='fetch-bios'));

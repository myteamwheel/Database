import './gleague-exposure.test.mjs';
import './dashboard-segments.test.mjs';
import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseGLeagueProgress} from '../scripts/lib/gleague-progress.mjs';
const source=JSON.parse(fs.readFileSync(new URL('../scripts/data/live/gleague-progress.json',import.meta.url)));
const result=parseGLeagueProgress(source);assert.equal(Object.keys(result.phases).length,2);
for(const p of Object.values(result.phases))assert.equal(p.status,Object.keys(p.players).length?'results-available':'no-published-player-results');
const fixture=structuredClone(source),t=fixture.phases[0].stats.resultSets[0],ix=Object.fromEntries(t.headers.map((k,i)=>[k,i]));
delete fixture.phases[0].gameLog;delete fixture.phases[0].teamGameLog;delete fixture.phases[0].verifiedBoxMinutes; // Isolate the free-throw fixture from real final-game evidence.
const row=Array(t.headers.length).fill(0);for(const [k,v] of Object.entries({PLAYER_ID:12345,GP:1,MIN:20,PTS:12,FGM:3,FGA:7,FG3M:1,FG3A:3,FTM:3,FTA:4,OREB:1,DREB:2,REB:3}))row[ix[k]]=v;
t.rowSet=[row]; // Seven field-goal points + five free-throw points from three makes.
assert.equal(parseGLeagueProgress(fixture).phases.Showcase.players[12345].totals.freeThrowPoints,5);
row[ix.PTS]=8;assert.throws(()=>parseGLeagueProgress(fixture),/free-throw/);
assert.throws(()=>parseGLeagueProgress({...source,phases:source.phases.slice(0,1)}),/snapshot/);
// Two fully logged finals. The dashboard still reflects the first one only.
const lagSnapshot=structuredClone(source),phase=lagSnapshot.phases.find(p=>p.apiSeasonType==='Showcase');
delete phase.verifiedBoxMinutes; // The synthetic game logs replace the source evidence.
const columns=['PTS','OREB','DREB','REB','AST','STL','BLK','TOV','FGM','FGA','FG3M','FG3A','FTM','FTA'];
const oldCounts=[6,0,1,1,0,0,0,0,3,3,0,0,0,0],newCounts=[8,0,2,2,0,0,0,0,4,4,0,0,0,0];
const collect=(headers,rowSet)=>({parameters:phase.stats.parameters,resultSets:[{headers,rowSet}]});
const teamRows=[],gameRows=[],dashboardRows=[];
lagSnapshot.completedThrough='2026-11-16';
for(const [team,wl] of [[1,'W'],[2,'L']]){
 for(const [game,date,counts] of [['2052600001','2026-11-15',oldCounts],['2052600002','2026-11-16',newCounts]]){
  teamRows.push([team,game,date,wl,counts[0]*5,240]);
  for(let i=1;i<=5;i++)gameRows.push([10*team+(i===5&&counts===oldCounts?6:i),team,game,date,wl,48,...counts]);
 }
 for(let i=1;i<=5;i++)dashboardRows.push([10*team+(i===5?6:i),1,48,...oldCounts]);
}
const dashboard=collect(['PLAYER_ID','GP','MIN',...columns],dashboardRows);
phase.stats=dashboard;
phase.teamGameLog=collect(['TEAM_ID','GAME_ID','GAME_DATE','WL','PTS','MIN'],teamRows);
phase.gameLog=collect(['PLAYER_ID','TEAM_ID','GAME_ID','GAME_DATE','WL','MIN',...columns],gameRows);
// The dashboard also has a stale shot attempt count for a returning player.
dashboardRows[0][3+columns.indexOf('FGA')]=4;
const repaired=parseGLeagueProgress(lagSnapshot).phases.Showcase;
assert.equal(repaired.players[11].gp,2);
assert.equal(repaired.players[11].totals.pts,14);
assert.equal(repaired.players[11].totals.min,96);
assert.equal(repaired.players[15].totals.pts,8,'A debut missing from the dashboard is sourced from the final log');
assert.equal(repaired.players[16].gp,1,'An unaffected player keeps the dashboard exposure');
assert.deepEqual(repaired.roundedMinutesGames,['2052600002']);
// Overtime can change the combined playing time on both final team lines.
for(const row of teamRows)if(row[1]==='2052600002')row[5]=250;
for(const row of gameRows)if(row[2]==='2052600002')row[5]=50;
assert.equal(parseGLeagueProgress(lagSnapshot).phases.Showcase.players[11].totals.min,98);
teamRows[1][5]=251;
assert.throws(()=>parseGLeagueProgress(lagSnapshot),/final team minutes/);
teamRows[1][5]=250;
dashboardRows[0]=[11,2,96,...columns.map((k,i)=>oldCounts[i]+newCounts[i])];
assert.throws(()=>parseGLeagueProgress(lagSnapshot),/whole final game/);
console.log('Separate competition phases, source emptiness and 1/2/3-point G League free-throw scoring passed.');

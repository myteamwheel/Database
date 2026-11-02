import assert from 'node:assert/strict';
import {buildRotationPlans,attachRotationRecommendations} from '../scripts/lib/rotation-plan.mjs';
const roster=Array.from({length:10},(_,i)=>({playerId:String(i),name:`Player ${i}`,position:['G','G','F','F','C'][i%5],currentRoster:true,currentTeam:'AAA',proj:{accounting:{mpg:24}},seasonForecast:{remainingSeason:{perGame:{mpg:24}}}}));
const snapshot={fetchedAt:'2026-11-01T12:00:00Z',schedule:{leagueSchedule:{gameDates:[{games:[{gameId:'0022600010',gameStatus:1,gameDateTimeUTC:'2026-11-02T00:00:00Z',gameDateEst:'2026-11-01T00:00:00',homeTeam:{teamTricode:'AAA'},awayTeam:{teamTricode:'BBB'}}]}]}}};
const data={leagues:{NBA:roster}};
assert.equal(buildRotationPlans(data,snapshot).AAA.status,'feasible');
roster[4].reportedAvailability=[{status:'Out',gameDate:'2026-10-30',matchup:'BBB@AAA'}];
assert.equal(buildRotationPlans(data,snapshot).AAA.players.find(p=>p.id==='4').out,false);
roster[4].reportedAvailability=[{status:'Out',gameDate:'2026-11-01',matchup:'BBB@AAA'}];
const out=buildRotationPlans(data,snapshot).AAA;
assert.equal(out.status,'infeasible');assert.equal(out.players.find(p=>p.id==='4').minutes,0);
roster[4].reportedAvailability=[];roster[4].proj={abstain:true};
assert.equal(buildRotationPlans(data,snapshot).AAA.unmodeled[0].id,'4');
assert.equal(buildRotationPlans(data,{...snapshot,schedule:{leagueSchedule:{gameDates:[]}}}).AAA.status,'unavailable');
console.log('Game-specific availability, unsupported-player withholding and schedule boundaries passed.');

// Both candidate and workload-only plans must conserve a full rotation; current
// per-appearance MPG is a measured individual baseline, not a team minute budget.
const current=Array.from({length:10},(_,i)=>({playerId:String(i),name:`Player ${i}`,league:'NBA',position:['G','G','F','F','C'][i%5],currentRoster:true,currentTeam:'AAA',proj:{accounting:{mpg:24}},seasonForecast:{remainingSeason:{perGame:{mpg:24}}},seasonActual:{gp:6,perGame:{mpg:20}},tulipBeta:{abstain:false,tulip:i===0?8:i===1?-8:0,confidence:'MEDIUM'}}));
const full={leagues:{NBA:current,GLEAGUE:[]},injuryMeta:{notSubmitted:[]}};
current[9].reportedAvailability=[{status:'Available',gameDate:'2026-11-01',matchup:'BBB@AAA'}];
full.rotationPlans=buildRotationPlans(full,snapshot);attachRotationRecommendations(full);
assert.equal(current.reduce((a,p)=>a+p.tulipRotation.recommendedMpg,0),240);
assert.equal(current.reduce((a,p)=>a+p.tulipRotation.baselineAllocationMpg,0),240);
assert.equal(current.reduce((a,p)=>a+p.tulipRotation.allocationDelta,0),0);
assert.equal(current[0].tulipRotation.tulip,current[0].tulipRotation.recommendedMpg-20);
assert.equal(current[0].tulipRotation.inputSupport,'MEDIUM');
current[0].seasonActual={gp:0,perGame:{mpg:null}};attachRotationRecommendations(full);
assert.equal(current[0].tulipRotation.tulip,null);assert.ok(Number.isFinite(current[0].tulipRotation.recommendedMpg));
current[0].reportedAvailability=[{status:'Out',gameDate:'2026-11-01',matchup:'BBB@AAA'}];
full.rotationPlans=buildRotationPlans(full,snapshot);attachRotationRecommendations(full);
assert.equal(current[0].tulipRotation.recommendedMpg,0);assert.equal(current[0].tulipRotation.tulip,null);
current[4].reportedAvailability=current[0].reportedAvailability;
full.rotationPlans=buildRotationPlans(full,snapshot);attachRotationRecommendations(full);
assert.equal(current[0].tulipRotation.abstain,true);assert.equal(current[0].tulipRotation.reason,'incomplete_positional_capacity');
console.log('Rotation TULIP: measured baseline, exact conservation, missing/Out score withholding and infeasibility passed.');

current.forEach(p=>p.reportedAvailability=[]);full.rotationPlans=buildRotationPlans(full,snapshot);attachRotationRecommendations(full);
assert.equal(full.rotationPlans.AAA.availabilityStatus,'no-matching-game-report');assert.equal(current[1].tulipRotation.inputSupport,'LOW');

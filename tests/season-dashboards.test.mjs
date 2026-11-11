import fs from 'node:fs';import assert from 'node:assert/strict';
import {advancedTable,gradeCurrentRows} from '../scripts/lib/current-season-grades.mjs';import {boxReviewGrades} from '../scripts/lib/season-review.mjs';
import {readVerifiedForecast} from '../scripts/verify-forecast-archive.mjs';
import {savedForecastReview} from '../scripts/lib/saved-forecast-review.mjs';
const data=JSON.parse(fs.readFileSync('public/data.json')),source=JSON.parse(fs.readFileSync('scripts/data/live/current-grade-inputs.json'));
const nba=source.records.find(r=>r.leagueId==='00'),parsed=advancedTable(nba.payload,nba);
assert.equal(parsed.size,data.leagues.NBA.filter(p=>p.seasonActual?.gp>0).length);
for(const p of data.leagues.NBA){const g=p.currentGrades['Regular Season'];if(p.seasonActual.gp>0){assert.ok(Number.isFinite(g.grade));assert.ok(g.grade>=0&&g.grade<10);assert.equal(g.version,'3.4');assert.ok(g.coverage.have<=g.coverage.of);}else assert.equal(g.grade,null);}
for(const p of data.leagues.GLEAGUE)for(const [phase,g] of Object.entries(p.currentGrades)){if(p.gLeagueSeasonActual?.phases?.[phase]?.gp>0)assert.ok(Number.isFinite(g.grade));else assert.equal(g.grade,null,'No appearance means no current GL grade');}
const bad=structuredClone(nba.payload);bad.parameters.LeagueID='20';assert.throws(()=>advancedTable(bad,nba),/scope/);
const dup=structuredClone(nba.payload);dup.resultSets[0].rowSet.push(dup.resultSets[0].rowSet[0]);assert.throws(()=>advancedTable(dup,nba),/identity/);
assert.equal(data.seasonReview,undefined);
assert.equal(data.savedForecastReview.season,'2026-27');
assert.equal(data.savedForecastReview.publishedAt,'2026-09-29');
for(const lg of ['NBA','GLEAGUE'])assert.ok(data.savedForecastReview.leagues[lg].some(p=>p.projection));
assert.deepEqual(data.savedForecastReview,savedForecastReview(readVerifiedForecast({forecastId:data.savedForecastReview.forecastId}).archive),'Published baseline must match the verified frozen archive, never revised projections');
const lines=[{gp:20,mpg:25,pts:10,ast:3,reb:5,stl:1,blk:1,ts:.5,tov:2},{gp:20,mpg:25,pts:20,ast:4,reb:7,stl:2,blk:2,ts:.6,tov:1}];const g=boxReviewGrades(lines,lines);assert.deepEqual(g.actual,g.model);assert.ok(g.actual[1]>g.actual[0]);assert.equal(boxReviewGrades(lines,[null]).model[0],null);
console.log('Current-year grades, no-appearance semantics, source identity and honest regular-season retrospective review passed.');

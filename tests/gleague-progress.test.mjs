import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseGLeagueProgress} from '../scripts/lib/gleague-progress.mjs';
const source=JSON.parse(fs.readFileSync(new URL('../scripts/data/live/gleague-progress.json',import.meta.url)));
const result=parseGLeagueProgress(source);assert.equal(Object.keys(result.phases).length,2);
for(const p of Object.values(result.phases))assert.equal(p.status,Object.keys(p.players).length?'results-available':'no-published-player-results');
const fixture=structuredClone(source),t=fixture.phases[0].stats.resultSets[0],ix=Object.fromEntries(t.headers.map((k,i)=>[k,i]));
const row=Array(t.headers.length).fill(0);for(const [k,v] of Object.entries({PLAYER_ID:12345,GP:1,MIN:20,PTS:12,FGM:3,FGA:7,FG3M:1,FG3A:3,FTM:3,FTA:4,OREB:1,DREB:2,REB:3}))row[ix[k]]=v;
t.rowSet=[row]; // Seven field-goal points + five free-throw points from three makes.
assert.equal(parseGLeagueProgress(fixture).phases.Showcase.players[12345].totals.freeThrowPoints,5);
row[ix.PTS]=8;assert.throws(()=>parseGLeagueProgress(fixture),/free-throw/);
assert.throws(()=>parseGLeagueProgress({...source,phases:source.phases.slice(0,1)}),/snapshot/);
console.log('Separate competition phases, source emptiness and 1/2/3-point G League free-throw scoring passed.');

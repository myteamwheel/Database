import assert from 'node:assert/strict';import fs from 'node:fs';
import {reconcileGLeagueTracker,normalizeTrackerName} from '../scripts/lib/gleague-tracker.mjs';
const read=f=>JSON.parse(fs.readFileSync(new URL('../'+f,import.meta.url)));
const source=read('scripts/data/gleague-tracker-source.json'),snapshot=read('scripts/data/live/gleague-rosters.json'),data=read('public/data.json');
const result=reconcileGLeagueTracker(source,snapshot,{nbaPlayers:data.leagues.NBA});
assert.equal(result.teams.length,31);assert.equal(result.records.filter(r=>r.listed).length,result.summary.listed);
assert.equal(new Set(result.records.filter(r=>r.listed).map(r=>r.playerId)).size,result.summary.listed);
assert.equal(result.records.length,source.records.length+result.summary.added);
for(const r of source.records){const updated=result.records.find(p=>p.trackerId===r.trackerId);assert.ok(updated);assert.equal(updated.notes,r.notes);assert.equal(updated.originalName,r.name);assert.equal(updated.source,r.source);}
for(const r of result.records.filter(r=>!r.listed)){assert.equal(r.playerId,null);assert.equal(r.currentTeam,null);assert.match(r.currentStatus,/prior evidence retained/);}
assert.equal(normalizeTrackerName('Dāvid Jones Jr.'),normalizeTrackerName('David Jones'));
assert.notEqual(normalizeTrackerName('Benny Williams'),normalizeTrackerName('Benjamin Williams'),'nicknames require reviewed identity evidence');
const duplicate=structuredClone(source);duplicate.records.push({...duplicate.records[0]});assert.throws(()=>reconcileGLeagueTracker(duplicate,snapshot),/Duplicate/);
console.log('G League tracker: complete official membership, unique IDs, stable sheet IDs, retained historical evidence and unlisted boundaries passed',result.summary);

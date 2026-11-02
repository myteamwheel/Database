import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {verifyGLeagueRosters,parseGLeagueTeamRoster,refreshGLeagueRosters} from '../scripts/lib/gleague-rosters.mjs';
const snapshot=JSON.parse(fs.readFileSync(new URL('../scripts/data/live/gleague-rosters.json',import.meta.url)));
const verified=verifyGLeagueRosters(snapshot);assert.equal(snapshot.teams.length,31);assert.ok(verified.players.length>=400);
const missing=structuredClone(snapshot);missing.teams.pop();assert.throws(()=>verifyGLeagueRosters(missing),/snapshot/);
const duplicate=structuredClone(snapshot);duplicate.teams[1].payload.resultSets.find(t=>t.name==='CommonTeamRoster').rowSet[0][14]=snapshot.teams[0].payload.resultSets.find(t=>t.name==='CommonTeamRoster').rowSet[0][14];assert.throws(()=>verifyGLeagueRosters(duplicate),/multiple/);
const wrong=structuredClone(snapshot.teams[0]);wrong.payload.parameters.LeagueID='00';assert.throws(()=>parseGLeagueTeamRoster(wrong.payload,{...wrong,season:snapshot.season}),/scope/);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gl-roster-test-')),file=path.join(dir,'roster.json');
try{
 fs.writeFileSync(file,JSON.stringify(snapshot));const before=fs.readFileSync(file);
 const index=JSON.parse(fs.readFileSync(new URL('../scripts/data/live/gleague-index.json',import.meta.url)));
 await assert.rejects(refreshGLeagueRosters({file,index,fetchJson:async()=>{throw new Error('source unavailable');}}),/unavailable/);
 assert.deepEqual(fs.readFileSync(file),before);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
const data=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url)));
const expected=new Map();
// Read the raw official tables independently from the production parser.
for(const team of snapshot.teams){const t=team.payload.resultSets.find(t=>t.name==='CommonTeamRoster'),ix=t.headers.indexOf('PLAYER_ID');for(const r of t.rowSet)expected.set(String(r[ix]),team.team);}
for(const p of data.leagues.GLEAGUE){assert.equal(p.currentGLeagueRosterTeam,expected.get(String(p.nbaPersonId))||null);expected.delete(String(p.nbaPersonId));}
assert.equal(expected.size,0,'Every team-roster identity must be searchable');
for(const p of data.leagues.GLEAGUE)for(const a of p.reportedGLeagueAssignments||[]){const nba=data.leagues.NBA.find(q=>q.playerId===p.playerId);assert.ok(nba?.reportedAvailability.some(r=>r.source===a.source&&r.gameDate===a.gameDate&&/On Assignment/.test(r.reason)));}
console.log('All 31 official team rosters independently reconcile; source scope, malformed feed, duplicate identity, failed refresh retention and assignment provenance passed.');

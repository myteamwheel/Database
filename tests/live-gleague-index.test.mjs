import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseGLeagueIndex,verifyGLeagueIndex} from '../scripts/lib/live-gleague-index.mjs';
const snapshot=JSON.parse(fs.readFileSync(new URL('../scripts/data/live/gleague-index.json',import.meta.url)));
const verified=verifyGLeagueIndex(snapshot);
assert.equal(verified.rows.length,snapshot.rows.length);
assert.equal(new Set(verified.rows.map(r=>r[3])).size,31);
assert.equal(new Set(verified.rows.map(r=>r[0])).size,verified.rows.length);
const corrupt=structuredClone(snapshot);corrupt.rows[1][0]=corrupt.rows[0][0];
assert.throws(()=>verifyGLeagueIndex(corrupt),/duplicate/);
const old=structuredClone(snapshot);old.scope='confirmed-assignment';
assert.throws(()=>verifyGLeagueIndex(old),/scope/);
const withUnassigned={resultSets:[{headers:[...snapshot.headers,'ROSTER_STATUS'],rowSet:snapshot.rows.map(r=>[...r,1])}]};
withUnassigned.resultSets[0].rowSet.push([999999,'Unassigned','Player',null,0,null,null]);
assert.equal(parseGLeagueIndex(withUnassigned,{fetchedAt:snapshot.fetchedAt}).rows.length,snapshot.rows.length);
for(const [team,teamId] of [['CLC',0],[null,1610612739],[null,null]]) {
 const ambiguous=structuredClone(withUnassigned);const r=ambiguous.resultSets[0].rowSet.at(-1);r[3]=team;r[4]=teamId;
 assert.throws(()=>parseGLeagueIndex(ambiguous,{fetchedAt:snapshot.fetchedAt}),/status/);
}
const table={resultSets:[{headers:[...snapshot.headers,'ROSTER_STATUS'],rowSet:snapshot.rows.map(r=>[...r,1])}]};
table.resultSets[0].rowSet[0][3]='BAD';
assert.throws(()=>parseGLeagueIndex(table,{fetchedAt:snapshot.fetchedAt}),/unassigned/);
console.log(`G League provisional index verified: ${verified.rows.length} identities across 31 teams; malformed statuses and identities rejected.`);

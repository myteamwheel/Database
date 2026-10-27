import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseTwoWayTable,reconcileTwoWayRoster} from '../scripts/lib/two-way-roster.mjs';
const read=f=>JSON.parse(fs.readFileSync(new URL('../scripts/data/live/'+f,import.meta.url),'utf8'));
const raw=read('two-way-roster.json'), roster=read('roster.json');
const tracker=parseTwoWayTable(raw.html,raw);
const result=reconcileTwoWayRoster(tracker,roster);
assert.ok(result.confirmed.length>50);
assert.equal(new Set(result.confirmed.map(r=>r.playerId)).size,result.confirmed.length);
const ix=Object.fromEntries(roster.headers.map((h,i)=>[h,i]));
for(const row of result.confirmed){const p=roster.rows.find(p=>p[ix.PERSON_ID]===row.playerId);assert.equal(p[ix.TEAM_ABBREVIATION],row.team);}
assert.equal(result.confirmed.length+result.unresolved.length,tracker.rows.length);
const wrongTeam=structuredClone(tracker);wrongTeam.rows[0].team='NOT';
assert.ok(reconcileTwoWayRoster(wrongTeam,roster).unresolved.some(r=>r.name===tracker.rows[0].name));
const duplicate=structuredClone(tracker);duplicate.rows.push(duplicate.rows.find(p=>result.confirmed.some(r=>r.name===p.name)));
assert.throws(()=>reconcileTwoWayRoster(duplicate,roster),/Duplicate/);
assert.throws(()=>parseTwoWayTable(raw.html.replaceAll('Two-Way Players from the 2026-27 season','Two-Way Players from the 2025-26 season'),raw),/season/);
assert.throws(()=>parseTwoWayTable(raw.html.replaceAll('Boston Celtics','Unknown Team'),raw),/Malformed/);
console.log(`Two-way roster: ${result.confirmed.length} identities independently reconciled; ${result.unresolved.length} discrepancies withheld; duplicate, team and season controls passed.`);

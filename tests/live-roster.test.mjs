import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLiveRoster, refreshLiveRoster, verifyLiveRosterSnapshot } from '../scripts/lib/live-roster.mjs';

const headers = ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'TEAM_ID',
  'TEAM_ABBREVIATION', 'POSITION', 'HEIGHT', 'WEIGHT', 'COUNTRY', 'DRAFT_YEAR',
  'DRAFT_ROUND', 'DRAFT_NUMBER', 'ROSTER_STATUS', 'FROM_YEAR', 'TO_YEAR'];
const row = (id, team = 'DEN') => [id, 'Test', String(id), 1610612743, team,
  'C', '6-11', '284', 'Serbia', 2014, 2, 41, 1, 2015, 2026];
const response = { resultSets: [{ headers, rowSet: [row(203999), row(1630162, 'MIN')] }] };

const parsed = parseLiveRoster(response, {
  season: '2026-27', fetchedAt: '2026-09-30T12:00:00.000Z', minRows: 2,
});
assert.equal(parsed.season, '2026-27');
assert.equal(parsed.source, 'stats.nba.com/stats/playerindex');
assert.equal(parsed.rows.length, 2);
assert.deepEqual(parsed.headers, headers);
assert.equal(parsed.rows[0][0], 203999);
assert.equal(verifyLiveRosterSnapshot(parsed, { minRows: 2 }).rows.length, 2);
const options={season:'2026-27',fetchedAt:'2026-09-30T12:00:00Z',minRows:1};
for (const id of [true,false,[203999],{},null,'',' 203999','203999.0','2e5',0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
  assert.throws(()=>parseLiveRoster({resultSets:[{headers,rowSet:[row(id)]}]},options),/player ID/);
}
const stringId=row('203999');stringId[headers.indexOf('ROSTER_STATUS')]='1';
assert.equal(parseLiveRoster({resultSets:[{headers,rowSet:[stringId]}]},options).rows[0][0],203999);
assert.throws(()=>parseLiveRoster({resultSets:[{headers,rowSet:[row(203999),row('203999')]}]},options),/duplicate/);
for (const status of [true,false,[1],{},null,'',' 1','1.0',2,-1]) {
  const r=row(203999);r[headers.indexOf('ROSTER_STATUS')]=status;
  assert.throws(()=>parseLiveRoster({resultSets:[{headers,rowSet:[r]}]},options),/roster status/);
}
const inactive=row(123);inactive[headers.indexOf('ROSTER_STATUS')]=0;
assert.equal(parseLiveRoster({resultSets:[{headers,rowSet:[inactive,row(203999)]}]},options).rows.length,1);
assert.throws(()=>parseLiveRoster({resultSets:[{headers:[...headers,'PERSON_ID'],rowSet:[[...row(203999),999]]}]},options),/duplicate columns/);
for(const minRows of [0,-1,1.5,true,'1',Infinity])assert.throws(()=>parseLiveRoster(response,{...options,minRows}),/minimum row count/);
assert.throws(() => verifyLiveRosterSnapshot({ ...parsed, source: 'other.example' }, { minRows: 2 }), /source/i);
assert.throws(() => parseLiveRoster({ resultSets: [{ headers, rowSet: [] }] },
  { season: '2026-27', fetchedAt: '2026-09-30T12:00:00Z', minRows: 2 }), /too few/i);
assert.throws(() => parseLiveRoster({ resultSets: [{ headers, rowSet: [row(203999), row(203999)] }] },
  { season: '2026-27', fetchedAt: '2026-09-30T12:00:00Z', minRows: 2 }), /duplicate/i);
assert.throws(() => parseLiveRoster({ resultSets: [{ headers, rowSet: [row(203999), row(1630162, 'ZZZ')] }] },
  { season: '2026-27', fetchedAt: '2026-09-30T12:00:00Z', minRows: 2 }), /team/i);
assert.throws(() => parseLiveRoster(response,
  { season: '2025-26', fetchedAt: '2026-09-30T12:00:00Z', minRows: 2 }), /season/i);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-roster-'));
try {
  const file = path.join(dir, 'roster.json');
  fs.writeFileSync(file, 'prior verified roster');
  await assert.rejects(refreshLiveRoster({ file, season: '2026-27', minRows: 2,
    now: () => '2026-09-30T12:00:00Z', fetchJson: async () => ({ resultSets: [{ headers, rowSet: [] }] }),
  }), /too few/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'prior verified roster');
  for (const malformed of [row(true),row([203999])]) {
    await assert.rejects(refreshLiveRoster({file,season:'2026-27',minRows:1,
      now:()=>options.fetchedAt,fetchJson:async()=>({resultSets:[{headers,rowSet:[malformed]}]})}),/player ID/);
    assert.equal(fs.readFileSync(file,'utf8'),'prior verified roster');
  }
  await refreshLiveRoster({ file, season: '2026-27', minRows: 2,
    now: () => '2026-09-30T12:00:00Z', fetchJson: async () => response,
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rows.length, 2);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('live roster parser tests passed');

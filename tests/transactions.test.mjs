import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTransactions, verifyTransactionSnapshot, refreshTransactions, playerTransactionIndex, TRANSACTION_URL } from '../scripts/lib/transactions.mjs';
const fetchedAt = '2026-10-01T12:00:00Z';
const row = { Transaction_Type:'Signing', TRANSACTION_DATE:'2026-09-30T00:00:00',
  TRANSACTION_DESCRIPTION:'Team signed a player.', TEAM_ID:1610612752, PLAYER_ID:1643022 };
const payload = rows => ({ NBA_Player_Movement:{ rows } });
const snapshot = parseTransactions(payload([row,{...row,PLAYER_ID:0,Transaction_Type:'Trade'},row]),{fetchedAt,minRows:1});
assert.deepEqual(snapshot.summary,{rawRows:3,uniqueEvents:2,duplicateRows:1,playerEvents:1,nonPlayerEvents:1,firstEventDate:'2026-09-30',latestEventDate:'2026-09-30'});
assert.equal(snapshot.source,TRANSACTION_URL);
const playerIndex = playerTransactionIndex(snapshot,{minRows:1});
assert.equal(playerIndex.size,1);
assert.equal(playerIndex.has('0'),false);
assert.equal(playerIndex.get(String(row.PLAYER_ID)).length,1);
assert.equal(playerIndex.get(String(row.PLAYER_ID))[0].description,row.TRANSACTION_DESCRIPTION);
assert.equal(playerTransactionIndex(snapshot,{minRows:1,fromDate:'2026-10-01'}).size,0);
assert.throws(()=>playerTransactionIndex(snapshot,{minRows:1,fromDate:'2026-02-30'}),/scope/);
assert.throws(()=>playerTransactionIndex(snapshot,{minRows:1,limit:0}),/scope/);
const multiple = parseTransactions(payload([row,...[29,28,27,26].map(day=>({...row,TRANSACTION_DATE:`2026-09-${day}T00:00:00`}))]),{fetchedAt,minRows:1});
assert.deepEqual(playerTransactionIndex(multiple,{minRows:1}).get(String(row.PLAYER_ID)).map(e=>e.date),['2026-09-30','2026-09-29','2026-09-28']);
assert.equal(verifyTransactionSnapshot(snapshot,{minRows:1}).rawSha256,snapshot.rawSha256);
assert.throws(()=>verifyTransactionSnapshot({...snapshot,rawSha256:'0'.repeat(64)},{minRows:1}),/hash/i);
assert.throws(()=>verifyTransactionSnapshot({...snapshot,summary:{...snapshot.summary,playerEvents:99}},{minRows:1}),/summary/i);
assert.throws(()=>verifyTransactionSnapshot({...snapshot,source:'other'},{minRows:1}),/source/i);
assert.throws(()=>parseTransactions(payload([]),{fetchedAt,minRows:1}),/small/i);
for(const changed of [
  {PLAYER_ID:true},{PLAYER_ID:-1},{PLAYER_ID:1.2},{TEAM_ID:0},
  {Transaction_Type:'Rumor'},{TRANSACTION_DESCRIPTION:''},
  {TRANSACTION_DATE:'2026-02-30T00:00:00'}, {TRANSACTION_DATE:'2026-10-02T00:00:00'},
]) assert.throws(()=>parseTransactions(payload([{...row,...changed}]),{fetchedAt,minRows:1}));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'transactions-'));
try {
  const file=path.join(dir,'transactions.json');
  await refreshTransactions({file,minRows:1,now:()=>fetchedAt,fetchImpl:async()=>payload([row])});
  const before=fs.readFileSync(file,'utf8');
  await assert.rejects(refreshTransactions({file,minRows:1,now:()=>fetchedAt,fetchImpl:async()=>{throw new Error('offline');}}),/offline/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  await assert.rejects(refreshTransactions({file,minRows:1,now:()=>fetchedAt,fetchImpl:async()=>payload([{...row,TRANSACTION_DATE:'2026-09-29T00:00:00'}])}),/backwards/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  await assert.rejects(refreshTransactions({file,minRows:1,now:()=>fetchedAt,fetchImpl:async()=>payload([{...row,TRANSACTION_DESCRIPTION:'Revised without review.'}])}),/removed|revised/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  await refreshTransactions({file,minRows:1,now:()=>fetchedAt,fetchImpl:async()=>payload([row,{...row,PLAYER_ID:1630162,TRANSACTION_DATE:'2026-10-01T00:00:00'}])});
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).summary.uniqueEvents,2);
  assert.equal(fs.readdirSync(dir).some(file=>file.includes('.tmp-')),false);
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('Transactions passed: official identities, dates, nonplayer events, duplicate handling, tamper detection, atomic promotion, failure/backward/revision preservation');

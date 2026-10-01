import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const read = name => JSON.parse(fs.readFileSync(new URL(`../${name}`,import.meta.url),'utf8'));
const data = read('public/data.json');
const snapshot = read('scripts/data/live/transactions.json');
const hash = row => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
const meta = data.transactionMeta;
assert.equal(meta.sourceRawSha256,hash(snapshot.rows));
assert.equal(meta.fetchedAt,snapshot.fetchedAt);
assert.equal(meta.fromDate,`${data.projectionMeta.season.slice(0,4)}-07-01`);
assert.equal(meta.perPlayerLimit,3);
let records=0,events=0;
for (const player of Object.values(data.leagues).flat()) {
  const identity = Number(player.nbaPersonId || player.playerId);
  const seen = new Set();
  const expected = snapshot.rows.filter(row => row.PLAYER_ID > 0 && row.PLAYER_ID === identity && row.TRANSACTION_DATE.slice(0,10) >= meta.fromDate)
    .sort((a,b)=>b.TRANSACTION_DATE.localeCompare(a.TRANSACTION_DATE)||hash(a).localeCompare(hash(b)))
    .filter(row=>{const id=hash(row);if(seen.has(id))return false;seen.add(id);return true;})
    .slice(0,3).map(row=>({id:hash(row),date:row.TRANSACTION_DATE.slice(0,10),type:row.Transaction_Type,teamId:row.TEAM_ID,description:row.TRANSACTION_DESCRIPTION}));
  assert.deepEqual(player.recentNbaTransactions,expected,`${player.name}: exact official person-ID transaction join`);
  if(expected.length)records++;
  events+=expected.length;
}
assert.equal(meta.attachedPlayerRecords,records);
assert.ok(records>0);
console.log(`Independent transaction context audit: all ${Object.values(data.leagues).flat().length} records; ${records} linked records / ${events} displayed events; no draft-pick pseudo-player joins`);

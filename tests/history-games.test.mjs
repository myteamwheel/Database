import fs from 'node:fs';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const file = new URL('../public/history-games.json.gz', import.meta.url);
assert.ok(fs.existsSync(file), 'compressed history game product must exist');
const product = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
assert.equal(product.schemaVersion, 1);
assert.ok(Array.isArray(product.rowSchema) && product.rowSchema.length > 10);
assert.ok(product.byPlayer && typeof product.byPlayer === 'object');
const ix = Object.fromEntries(product.rowSchema.map((k, i) => [k, i]));
for (const required of ['season','seasonType','gameDate','gameId','team','opponent','minutes','pts','reb','ast','started']) {
  assert.notEqual(ix[required], undefined, `missing game-log field ${required}`);
}
const covered = new Set(product.starterCoveragePhases || []);
let rows = 0, known = 0;
const seen = new Set();
for (const [playerId, list] of Object.entries(product.byPlayer)) {
  let prev = '';
  for (const r of list) {
    rows++;
    assert.equal(r.length, product.rowSchema.length, `row/schema mismatch for ${playerId}`);
    const key = `${playerId}|${r[ix.gameId]}`;
    assert.ok(!seen.has(key), `duplicate player-game ${key}`); seen.add(key);
    assert.ok(String(r[ix.gameDate]) >= prev, `rows not chronological for ${playerId}`); prev = String(r[ix.gameDate]);
    assert.ok(Number(r[ix.minutes]) >= 0 && Number(r[ix.minutes]) <= 70);
    const phaseKey = `${r[ix.season]} ${r[ix.seasonType]}`;
    const started = r[ix.started];
    if (covered.has(phaseKey)) {
      assert.equal(typeof started, 'boolean', `accepted starter phase must be known: ${phaseKey}`);
      known++;
    } else {
      assert.equal(started, null, `unaccepted starter phase must remain null: ${phaseKey}`);
    }
  }
}
assert.equal(rows, product.inventory.playerGameRows);
assert.equal(Object.keys(product.byPlayer).length, product.inventory.playersWithGames);
assert.ok(rows > 100000, 'history game product unexpectedly small');
assert.ok(known > 0, 'accepted starter phase should contribute known starter rows');
console.log(`history game product/test passed: ${rows.toLocaleString()} rows · ${Object.keys(product.byPlayer).length} current players · ${known.toLocaleString()} starter-known`);

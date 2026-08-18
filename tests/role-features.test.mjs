import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildRoleFeatureProduct, ROLE_FEATURE_SCHEMA } from '../scripts/lib/role-features.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = ['season','seasonType','gameDate','gameId','team','opponent','minutes','pts','reb','ast','stl','blk','tov','plusMinus','started'];
const row = (date, gameId, team, min, pts, started, extra = {}) => [
  extra.season || '2023-24', extra.seasonType || 'Regular Season', date, gameId, team, extra.opp || 'BBB',
  min, pts, extra.reb || 0, extra.ast || 0, extra.stl || 0, extra.blk || 0, extra.tov || 0, extra.pm || 0, started,
];
const fixture = {
  schemaVersion: 1,
  generatedAt: '2026-08-18T00:00:00Z',
  rowSchema: schema,
  playerIndex: { '1': { name: 'Test Player', currentLeagues: ['NBA'] } },
  byPlayer: {
    '1': [
      row('2023-10-20','g1','AAA',10,10,null),
      row('2023-10-22','g2','AAA',20,20,true,{reb:5,ast:4,tov:2,pm:3}),
      row('2023-10-24','g3','AAA',30,30,false,{reb:10,ast:8,tov:4,pm:-1}),
      row('2023-10-26','g4','CCC',40,40,true,{reb:8,ast:6,tov:3,pm:9}),
    ],
  },
};

const ix = Object.fromEntries(ROLE_FEATURE_SCHEMA.map((k, i) => [k, i]));
const product = buildRoleFeatureProduct(fixture, { generatedAt: 'fixed' });
assert.equal(product.inventory.featureRows, 4);
assert.equal(product.inventory.players, 1);
assert.equal(product.byPlayer['1'].length, 4);

const [g1,g2,g3,g4] = product.byPlayer['1'];
assert.equal(g1[ix.priorGames], 0);
assert.equal(g1[ix.w5_games], null);
assert.equal(g2[ix.priorGames], 1);
assert.equal(g2[ix.restDays], 2);
assert.equal(g2[ix.w5_mpg], 10);
assert.equal(g2[ix.w5_startShare], null, 'unknown starter status must not become bench');
assert.equal(g3[ix.w5_games], 2);
assert.equal(g3[ix.w5_mpg], 15);
assert.equal(g3[ix.w5_starterKnownGames], 1);
assert.equal(g3[ix.w5_startShare], 1);
assert.equal(g4[ix.teamChangedSincePreviousGame], true);
assert.equal(g4[ix.w5_sameTeamShare], 0, 'new-team feature is known pregame and should expose context discontinuity');
assert.ok(Math.abs(g4[ix.w5_ge20Share] - 2/3) < 0.0001, 'rounded high-minute exposure share drifted');

// Current-game and future-game outcomes must be unable to change an earlier feature row.
const mutated = structuredClone(fixture);
mutated.byPlayer['1'][2][schema.indexOf('minutes')] = 49;
mutated.byPlayer['1'][2][schema.indexOf('pts')] = 99;
mutated.byPlayer['1'][3][schema.indexOf('minutes')] = 1;
mutated.byPlayer['1'][3][schema.indexOf('pts')] = 0;
const mutatedProduct = buildRoleFeatureProduct(mutated, { generatedAt: 'fixed' });
assert.deepEqual(mutatedProduct.byPlayer['1'][2], g3, 'g3 features leaked current/future game outcomes');

// Same-date rows are all computed before any same-date outcome is admitted into history.
const sameDate = structuredClone(fixture);
sameDate.byPlayer['1'] = [
  row('2023-10-20','a','AAA',10,5,false),
  row('2023-10-22','b','AAA',20,10,true),
  row('2023-10-22','c','AAA',45,45,true),
];
const sameProduct = buildRoleFeatureProduct(sameDate, { generatedAt: 'fixed' });
const b = sameProduct.byPlayer['1'][1];
const c = sameProduct.byPlayer['1'][2];
assert.equal(b[ix.priorGames], 1);
assert.equal(c[ix.priorGames], 1);
assert.equal(b[ix.w5_mpg], 10);
assert.equal(c[ix.w5_mpg], 10);

// Season prior count resets without discarding previous-season information from rolling windows.
const seasons = structuredClone(fixture);
seasons.byPlayer['1'][2][schema.indexOf('season')] = '2024-25';
seasons.byPlayer['1'][3][schema.indexOf('season')] = '2024-25';
const seasonProduct = buildRoleFeatureProduct(seasons, { generatedAt: 'fixed' });
assert.equal(seasonProduct.byPlayer['1'][2][ix.seasonPriorGames], 0);
assert.equal(seasonProduct.byPlayer['1'][2][ix.priorGames], 2);
assert.equal(seasonProduct.byPlayer['1'][2][ix.w5_games], 2);

// When the materialized products exist (CI/build:history), verify one feature row per game row,
// identity preservation, source-binding, and strict first-row timing across the full real dataset.
const historyPath = path.join(ROOT, 'public/history-games.json.gz');
const featurePath = path.join(ROOT, 'public/history-role-features.json.gz');
if (fs.existsSync(historyPath) && fs.existsSync(featurePath)) {
  const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(historyPath)));
  const features = JSON.parse(zlib.gunzipSync(fs.readFileSync(featurePath)));
  assert.equal(features.schemaVersion, 1);
  assert.equal(features.sourceHistoryGeneratedAt, history.generatedAt);
  assert.equal(features.inventory.featureRows, history.inventory.playerGameRows);
  assert.equal(features.inventory.players, Object.keys(history.byPlayer).length);
  assert.deepEqual(Object.keys(features.byPlayer).sort(), Object.keys(history.byPlayer).sort());
  const fix = Object.fromEntries(features.rowSchema.map((k, i) => [k, i]));
  let counted = 0;
  for (const [playerId, rows] of Object.entries(features.byPlayer)) {
    assert.equal(rows.length, history.byPlayer[playerId].length, `row count mismatch player ${playerId}`);
    if (rows.length) assert.equal(rows[0][fix.priorGames], 0, `first row leaked prior games player ${playerId}`);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(String(rows[i][fix.indexDate]) >= String(rows[i - 1][fix.indexDate]), `nonmonotonic dates player ${playerId}`);
      assert.ok(Number(rows[i][fix.priorGames]) >= Number(rows[i - 1][fix.priorGames]), `priorGames regressed player ${playerId}`);
    }
    counted += rows.length;
  }
  assert.equal(counted, history.inventory.playerGameRows);
  assert.match(features.featureTiming, /strictly earlier/i);
  console.log(`role-features: real artifact verified · ${counted.toLocaleString()} rows`);
}

console.log('role-features: leakage-safe fixture tests passed');

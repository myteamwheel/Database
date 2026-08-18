import assert from 'node:assert/strict';
import { buildRoleFeatureProduct, ROLE_FEATURE_SCHEMA } from '../scripts/lib/role-features.mjs';

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
assert.equal(g4[ix.w5_ge20Share], 2/3);

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

console.log('role-features: leakage-safe fixture tests passed');

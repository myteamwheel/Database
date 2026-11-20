import assert from 'node:assert/strict';
import { reconcileDashboardExposure } from '../scripts/lib/gleague-exposure.mjs';
const table = (name, records) => {
  const headers = Object.keys(records[0]);
  return { name, headers, rowSet: records.map(row => headers.map(k => row[k])) };
};
const counts = Object.fromEntries('PTS FGM FGA FG3M FG3A FTM FTA OREB DREB REB AST STL BLK TOV PF PLUS_MINUS'.split(' ').map(k => [k, 0]));
const team = id => ({ GAME_ID: id, TEAM_ID: 1, PTS: 100 });
const game = { ...team('A'), ...counts, PLAYER_ID: 7, WL: 'W' };
const log = new Map([[7, { GP: 1, games: [game] }]]);
const stats = { resultSets: [table('LeagueDashPlayerStats', [{ PLAYER_ID: 7, TEAM_ID: 1, TEAM_COUNT: 1, GP: 2, MIN: 1, PFD: 0 }])] };
const phase = { stats, teamGameLog: { resultSets: [table('LeagueGameLog', ['A','B'].map(team))] } };
const box = (id, time, comment) => {
  const { TOV, ...other } = counts;
  return { parameters: { GameID: id }, resultSets: [
    table('TeamStats', [team(id)]),
    table('PlayerStats', [{ GAME_ID: id, TEAM_ID: 1, PLAYER_ID: 7, ...other, TO: TOV, MIN: time, COMMENT: comment }])
  ] };
};
const load = id => id === 'A' ? box(id, '0:03', '') : box(id, null, "DNP - Coach's Decision");
const repaired = await reconcileDashboardExposure(phase, log, load);
assert.deepEqual(repaired.resultSets[0].rowSet[0], [7, 1, 1, 1, 0.05, null]);
assert.deepEqual(repaired.exposureCorrections[0].dnps, ['B']);
assert.equal(stats.resultSets[0].rowSet[0][3], 2);
assert.equal(await reconcileDashboardExposure({ ...phase, stats: repaired }, log, () => assert.fail('Unnecessary request')), repaired);
await assert.rejects(reconcileDashboardExposure(phase, log, id => id === 'B' ? box(id, '0:03', '') : load(id)), /disagree/);
await assert.rejects(reconcileDashboardExposure(phase, log, id => id === 'B' ? box(id, null, '') : load(id)), /disagree/);
await assert.rejects(reconcileDashboardExposure(phase, log, id => {
  const b = load(id); b.resultSets[0].rowSet[0][2]++; return b;
}), /team result disagree/);

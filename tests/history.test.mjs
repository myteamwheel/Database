import fs from 'node:fs';
import assert from 'node:assert/strict';
import { featuresAsOf, rollingRoleFeaturesAsOf, historicalReadiness } from '../scripts/lib/history.mjs';

const summary = JSON.parse(fs.readFileSync(new URL('../scripts/data/history/player_history_product.json', import.meta.url), 'utf8'));
const hx = Object.fromEntries(summary.rowSchema.map((k, i) => [k, i]));
let rows = 0, knownRows = 0;
for (const [playerId, list] of Object.entries(summary.byPlayer)) for (const r of list) {
  rows++;
  const gp = r[hx.gp], starts = r[hx.starts], share = r[hx.startShareOfAppearances], coverage = r[hx.starterCoverage], known = r[hx.starterKnownAppearances];
  assert.ok(gp > 0, 'historical product rows are appearance-based');
  assert.ok(starts === null || (starts >= 0 && starts <= gp));
  assert.ok(share === null || (share >= 0 && share <= 1));
  assert.ok(coverage >= 0 && coverage <= 1);
  assert.ok(known >= 0 && known <= gp);
  const phaseKey = `${r[hx.season]} ${r[hx.seasonType]}`;
  if ((summary.starterFullCensusPhases || []).includes(phaseKey)) {
    assert.notEqual(starts, null, `covered starter phase must be established: ${phaseKey}`);
    // A covered phase is a full census EXCEPT for enumerated upstream source gaps: appearances
    // leaguegamelog reports that the box score omits entirely, so no source can establish them.
    // Only rows with a recorded gap may fall short, and only by exactly the recorded amount.
    const gaps = (summary.starterSourceGaps || []).filter(
      (g) => g.season === r[hx.season] && g.seasonType === r[hx.seasonType] && g.playerId === Number(playerId)).length;
    assert.equal(known, gp - gaps,
      `covered phase must establish every appearance except enumerated source gaps: ${phaseKey} (${gaps} gap(s))`);
    if (!gaps) assert.equal(coverage, 1, `accepted full-census starter phase must have complete coverage: ${phaseKey}`);
    knownRows += gp;
  } else if ((summary.starterPartialPhases || []).includes(phaseKey)) {
    // Reconstruction fills only what is forced in EVERY feasible solution, so a partial phase may
    // legitimately be anywhere from 0 to fully covered. What must hold is that nothing is invented:
    // coverage never exceeds 1 and known never exceeds appearances (both asserted above).
    assert.ok(coverage >= 0 && coverage <= 1, `partial phase coverage out of range: ${phaseKey}`);
  } else {
    assert.equal(starts, null, `uncovered starter phase must stay unknown: ${phaseKey}`);
    assert.equal(coverage, 0);
    assert.equal(known, 0);
  }
}
assert.equal(rows, summary.inventory.currentPlayerSeasonPhaseRows);
assert.equal(Object.keys(summary.byPlayer).length, summary.inventory.currentPlayersWithHistory);
assert.equal(summary.inventory.allPlayerSeasonPhaseRows, 7561);
assert.equal(summary.inventory.allHistoricalPlayers, 1453);
// Coverage moved from 28,086 to 216,452 once the remaining seven regular seasons and nine playoff
// phases were crawled. Pinning the exact number keeps an accidental coverage REGRESSION visible.
// 216,452 direct + 17,075 reconstructed. Pinned so a coverage REGRESSION stays visible.
assert.equal(summary.inventory.starterKnownAppearancesAll, 233527);
assert.ok(Array.isArray(summary.starterCoveragePhases) && summary.starterCoveragePhases.length > 0, 'starter coverage phases must come from canonical artifact scope');
assert.ok(summary.starterCoveragePhases.includes('2023-24 Regular Season'));
assert.ok(summary.starterCoveragePhases.includes('2023-24 Playoffs'));
// Every clean-era phase is now a full census; the two corrupted seasons must NOT appear.
for (const season of ['2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23', '2024-25']) {
  assert.ok(summary.starterCoveragePhases.includes(`${season} Regular Season`), `${season} regular must be covered`);
  assert.ok(summary.starterCoveragePhases.includes(`${season} Playoffs`), `${season} playoffs must be covered`);
}
// The corrupted seasons must NEVER be claimed as a full census. They may appear as partial,
// because reconstruction fills only logically forced assignments there.
for (const season of ['2015-16', '2016-17']) {
  assert.ok(!summary.starterFullCensusPhases.some((p) => p.startsWith(season)),
    `${season} START_POSITION is corrupted league-wide; it must never be reported as a full census`);
}
// Exactly one appearance in the whole ten-season history has no establishable starter status.
assert.equal((summary.starterSourceGaps || []).length, 1, 'enumerated upstream source gaps');
assert.ok(knownRows > 0, 'starter-known current-player history should exist');

const fixture = [
  { playerId: 1, gameDate: '2024-01-01', minutes: 10, started: null, pts: 2, reb: 1, ast: 0, stl: 0, blk: 0, tov: 0, fga: 2, fta: 0 },
  { playerId: 1, gameDate: '2024-01-02', minutes: 20, started: false, pts: 4, reb: 2, ast: 1, stl: 0, blk: 0, tov: 1, fga: 4, fta: 0 },
  { playerId: 1, gameDate: '2024-01-03', minutes: 30, started: true, pts: 6, reb: 3, ast: 2, stl: 1, blk: 0, tov: 2, fga: 6, fta: 0 },
  // target-date and future rows must never leak into features for 2024-01-04
  { playerId: 1, gameDate: '2024-01-04', minutes: 99, started: true, pts: 99, reb: 99, ast: 99, stl: 9, blk: 9, tov: 9, fga: 99, fta: 0 },
  { playerId: 1, gameDate: '2024-01-05', minutes: 99, started: true, pts: 99, reb: 99, ast: 99, stl: 9, blk: 9, tov: 9, fga: 99, fta: 0 },
];
const f = featuresAsOf(fixture, 1, '2024-01-04', { window: 20 });
assert.equal(f.windowGames, 3);
assert.equal(f.minutes, 60);
assert.equal(f.mpg, 20);
assert.equal(f.starterKnownGames, 2);
assert.equal(f.starts, 1);
assert.equal(f.startShare, 0.5, 'unknown starter row must not be counted as bench');
assert.equal(f.starterCoverage, 2 / 3);
assert.equal(f.minutesMedian, 20);
assert.equal(Math.round(f.minutesSd * 1000) / 1000, 10);
assert.equal(f.leakageRule, 'strictly < indexDate');

const rolling = rollingRoleFeaturesAsOf(fixture, 1, '2024-01-04');
assert.deepEqual(Object.keys(rolling), ['5', '10', '20']);
assert.equal(rolling[5].windowGames, 3);

// Readiness must distinguish "exists in the project" from "consumed by the current estimator".
const readiness = historicalReadiness({
  project: { gameRows: true, availability: false, transactions: false, lineups: false },
  estimator: { gameRows: false, availability: false, transactions: false, lineups: false },
});
assert.equal(readiness.projectAvailable.gameRows, true);
assert.equal(readiness.consumedByCurrentEstimator.gameRows, false);
assert.deepEqual(readiness.reachableTiersCurrentEstimator, ['B', 'D']);
assert.deepEqual(readiness.potentiallyReachableWithProjectData, ['B', 'C', 'D']);
assert.equal(readiness.forecastAvailable, false);
assert.match(readiness.note, /Historical game rows exist/);

console.log(`history product/test passed: ${rows.toLocaleString()} current-player season-phase rows · ${summary.inventory.starterKnownAppearancesAll.toLocaleString()} starter-known appearances in full history`);

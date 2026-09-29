import assert from 'node:assert/strict';
import {
  sha256,
  projectionIdentity,
  extractArchivedPlayer,
  validateArchive,
  nbaBaselines,
  gleagueBaseline,
} from '../scripts/lib/forecast-archive.mjs';

let pass = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); pass++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const projection = {
  season: '2026-27', team: 'PHI', status: 'same', basis: 'multi-year-history', age: 27,
  modelVersion: 'PROJECTION_2026_27+context-1', timeframe: 'preseason-full-season',
  gp: 72.1, mpg: 31.2, pts: 20.2, reb: 6.7, oreb: 1.4, dreb: 5.3,
  ast: 4.4, stl: 1.1, blk: 0.5, tov: 2.3,
  fgm: 7.4, fga: 15.3, fg3m: 2.2, fg3a: 6.1, ftm: 3.2, fta: 4.0,
  fgPct: 0.484, fg3Pct: 0.361, ftPct: 0.800, ts: 0.592,
  ptsLo: 16.8, ptsHi: 23.9, rebLo: 5.3, rebHi: 8.1, astLo: 3.4, astHi: 5.6,
  mpgLo: 27.0, mpgHi: 34.8, gpLo: 61, gpHi: 80,
  accounting: {
    gp: 72.1, mpg: 31.2, pts: 20.2, reb: 6.7, oreb: 1.4, dreb: 5.3,
    ast: 4.4, stl: 1.1, blk: 0.5, tov: 2.3, fgm: 7.4, fga: 15.3,
    fg3m: 2.2, fg3a: 6.1, ftm: 3.2, fta: 4.0, ftValue: 1,
    totals: { pts: 1456.42 }
  },
  uncertainty: { method: 'legacy-veteran-residuals', calibratedForContextVersion: false },
  availability: { basis: 'historical-appearance-rate', injuryStatus: 'not-verified' },
  why: { seasons: [{ season: '2025-26', gp: 70, min: 2100, weight: 1 }], minutes: { last: 30, projected: 31.2 } },
};

const player = { playerId: 'p1', nbaPersonId: 123, name: 'Test Player', proj: projection };

test('sha256 is deterministic', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('identity is scoped by league', () => {
  assert.notEqual(projectionIdentity('NBA', player), projectionIdentity('GLEAGUE', player));
  assert.equal(projectionIdentity('NBA', player), 'NBA:123');
});

test('projected row preserves published forecast and evidence', () => {
  const out = extractArchivedPlayer('NBA', player);
  assert.equal(out.identity, 'NBA:123');
  assert.equal(out.name, 'Test Player');
  assert.equal(out.team, 'PHI');
  assert.equal(out.status, 'same');
  assert.equal(out.basis, 'multi-year-history');
  assert.equal(out.projection.pts, 20.2);
  assert.deepEqual(out.uncertainty, projection.uncertainty);
  assert.deepEqual(out.availability, projection.availability);
  assert.deepEqual(out.why, projection.why);
});

test('abstention has reason and no numeric projection', () => {
  const out = extractArchivedPlayer('NBA', {
    playerId: 'p2', nbaPersonId: 456, name: 'No History',
    proj: { abstain: true, reason: 'No NBA minutes in recent seasons.' },
  });
  assert.equal(out.abstain, true);
  assert.equal(out.reason, 'No NBA minutes in recent seasons.');
  assert.equal('projection' in out, false);
});

test('same canonical id may appear once per league', () => {
  const nba = extractArchivedPlayer('NBA', player);
  const gl = extractArchivedPlayer('GLEAGUE', { ...player, playerId: 'g1' });
  assert.doesNotThrow(() => validateArchive({ players: [nba, gl] }));
});

test('duplicate identity in one league fails', () => {
  const row = extractArchivedPlayer('NBA', player);
  assert.throws(() => validateArchive({ players: [row, structuredClone(row)] }), /duplicate.*NBA:123/i);
});

test('abstention carrying numeric projection fails', () => {
  const row = { identity: 'NBA:9', league: 'NBA', nbaPersonId: 9, playerId: '9', name: 'Bad', abstain: true, reason: 'none', projection: { pts: 0 } };
  assert.throws(() => validateArchive({ players: [row] }), /abstention.*projection/i);
});

test('invalid makes or attempts fail', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.fgm = 16;
  assert.throws(() => validateArchive({ players: [row] }), /FGM.*FGA/i);
});

test('inconsistent rebounds fail', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.reb = 8.0;
  assert.throws(() => validateArchive({ players: [row] }), /REB.*OREB.*DREB/i);
});

test('inconsistent points accounting fails when accounting data is present', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.pts = 30;
  assert.throws(() => validateArchive({ players: [row] }), /points accounting/i);
});

const seasonRecord = (season, gp, mpg, pts, reb, ast, fgm, fga, fg3m, fg3a, ftm, fta) => ({
  season, team: 'AAA', gp, min: gp * mpg, pts: gp * pts,
  oreb: gp * reb * 0.25, dreb: gp * reb * 0.75, ast: gp * ast, stl: gp, blk: gp * 0.5, tov: gp * 2, pf: gp * 2.2,
  fgm: gp * fgm, fga: gp * fga, fg3m: gp * fg3m, fg3a: gp * fg3a, ftm: gp * ftm, fta: gp * fta,
});

const rec25 = seasonRecord('2025-26', 80, 30, 20, 8, 5, 7, 14, 2, 5, 4, 5);
const rec24 = seasonRecord('2024-25', 60, 24, 12, 6, 4, 4, 10, 1, 4, 3, 4);
const rec23 = seasonRecord('2023-24', 40, 18, 8, 4, 2, 3, 8, 1, 3, 1, 2);
const nbaSeasons = new Map([
  ['2025-26', new Map([[7, rec25]])],
  ['2024-25', new Map([[7, rec24]])],
  ['2023-24', new Map([[7, rec23]])],
  ['2022-23', new Map([[8, seasonRecord('2022-23', 50, 20, 10, 5, 3, 4, 9, 1, 3, 1, 2)]])],
]);
const D = {
  nba: { seasons: nbaSeasons, teamGames: () => 82 },
  gleague: { seasons: new Map([['2025-26', new Map([[7, rec25]])]]), teamGames: () => 50 },
};

test('NBA repeat baseline matches last season and scales GP by appearance share', () => {
  const { repeat } = nbaBaselines(D, 7, '2026-27');
  assert.equal(repeat.pts, 20);
  assert.equal(repeat.mpg, 30);
  assert.equal(repeat.gp, 80);
});

test('NBA three-year baseline uses 5/4/3 times games for per-game stats', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const den = 5*80 + 4*60 + 3*40;
  const expectedPts = (5*80*20 + 4*60*12 + 3*40*8) / den;
  assert.ok(Math.abs(avg3.pts - expectedPts) < 1e-12);
  const expectedMpg = (5*80*30 + 4*60*24 + 3*40*18) / den;
  assert.ok(Math.abs(avg3.mpg - expectedMpg) < 1e-12);
});

test('NBA three-year percentages pool weighted makes and attempts', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const made = 5*rec25.fgm + 4*rec24.fgm + 3*rec23.fgm;
  const att = 5*rec25.fga + 4*rec24.fga + 3*rec23.fga;
  assert.ok(Math.abs(avg3.fgPct - made/att) < 1e-12);
});

test('NBA three-year GP uses weighted appearance shares', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const expected = ((5*(80/82) + 4*(60/82) + 3*(40/82)) / (5+4+3)) * 82;
  assert.ok(Math.abs(avg3.gp - expected) < 1e-12);
});

test('NBA naive baselines do not reach back beyond the recent three seasons', () => {
  const out = nbaBaselines(D, 8, '2026-27');
  assert.equal(out.repeat, null);
  assert.equal(out.avg3, null);
});

test('G League exposes repeat only', () => {
  const out = gleagueBaseline(D, 7, '2026-27', 50);
  assert.equal(out.repeat.pts, 20);
  assert.equal('avg3' in out, false);
});

if (!process.exitCode) console.log(`ALL PASS · ${pass} tests`);

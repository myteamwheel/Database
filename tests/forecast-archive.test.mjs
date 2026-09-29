import assert from 'node:assert/strict';
import {
  sha256,
  projectionIdentity,
  extractArchivedPlayer,
  validateArchive,
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

if (!process.exitCode) console.log(`ALL PASS · ${pass} tests`);

// Forecast archive regression tests. Node-only, deterministic.
import crypto from 'node:crypto';

let mod = null;
let importError = null;
try {
  mod = await import('../scripts/lib/forecast-archive.mjs');
} catch (err) {
  importError = err;
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
};
const throws = (fn, pattern) => {
  try { fn(); return false; } catch (err) { return pattern ? pattern.test(String(err?.message || err)) : true; }
};

if (importError) {
  check('forecast archive module exists', false, importError.message);
} else {
  const { sha256, projectionIdentity, extractArchivedPlayer, validateArchive } = mod;

  check('sha256 is deterministic',
    sha256('abc') === crypto.createHash('sha256').update('abc').digest('hex'));

  const projection = {
    season: '2026-27',
    team: 'PHI',
    status: 'same',
    age: 25,
    modelVersion: 'PROJECTION_2026_27+context-1',
    timeframe: 'preseason-full-season',
    basis: 'multi-year-history',
    role: 'core rotation',
    effectiveMpg: 31.2,
    usage: 0.221,
    availability: { basis: 'historical-appearance-rate', injuryStatus: 'not-verified' },
    uncertainty: { method: 'legacy-veteran-residuals', calibratedForContextVersion: false },
    gp: 72.4,
    mpg: 34.5,
    pts: 22.1,
    reb: 6.0,
    oreb: 1.0,
    dreb: 5.0,
    ast: 5.2,
    stl: 1.1,
    blk: 0.6,
    tov: 2.8,
    fgm: 8.0,
    fga: 16.0,
    fg3m: 2.0,
    fg3a: 5.0,
    ftm: 4.1,
    fta: 5.0,
    fgPct: 0.5,
    fg3Pct: 0.4,
    ftPct: 0.82,
    ts: 0.61,
    ptsLo: 17.0,
    ptsHi: 27.0,
    rebLo: 4.0,
    rebHi: 8.0,
    astLo: 3.0,
    astHi: 7.0,
    mpgLo: 29.0,
    mpgHi: 38.0,
    gpLo: 58,
    gpHi: 82,
    accounting: {
      pts: 22.1, reb: 6.0, oreb: 1.0, dreb: 5.0,
      fgm: 8.0, fga: 16.0, fg3m: 2.0, fg3a: 5.0,
      ftm: 4.1, fta: 5.0, ftValue: 1
    },
    why: {
      seasons: [{ season: '2025-26', team: 'PHI', gp: 70, min: 2300, weight: 1 }],
      minutes: { last: 33.1, projected: 34.5 },
      team: { usage: 0.01, pace: 99.8 }
    }
  };
  const player = {
    nbaPersonId: 123,
    playerId: 'nba-123',
    name: 'Archive Example',
    team: 'PHI',
    age: 25,
    proj: projection
  };

  check('identity is league scoped',
    projectionIdentity('NBA', player) === 'NBA:123'
      && projectionIdentity('GLEAGUE', player) === 'GLEAGUE:123');

  const archived = extractArchivedPlayer('NBA', player);
  check('projected row preserves stable identity and context',
    archived.identity === 'NBA:123'
      && archived.league === 'NBA'
      && archived.playerId === 'nba-123'
      && archived.nbaPersonId === 123
      && archived.name === 'Archive Example'
      && archived.forecastTeam === 'PHI'
      && archived.status === 'same'
      && archived.basis === 'multi-year-history'
      && archived.age === 25
      && archived.abstain === false);

  check('projected row preserves published forecast and evidence',
    archived.projection.gp === 72.4
      && archived.projection.pts === 22.1
      && archived.projection.fgPct === 0.5
      && archived.projection.uncertainty.method === 'legacy-veteran-residuals'
      && archived.projection.availability.injuryStatus === 'not-verified'
      && archived.projection.why.minutes.last === 33.1);

  const abstained = extractArchivedPlayer('GLEAGUE', {
    nbaPersonId: 456,
    playerId: 'gl-456',
    name: 'No History',
    team: 'LIN',
    proj: { abstain: true, reason: 'No G League minutes in prior seasons.' }
  });
  check('abstention preserves reason without numeric forecast',
    abstained.abstain === true
      && abstained.reason === 'No G League minutes in prior seasons.'
      && !('projection' in abstained));

  const baseArchive = {
    schemaVersion: 1,
    forecastId: 'fixture',
    season: '2026-27',
    forecastType: 'preseason-full-season',
    leagues: { NBA: [archived], GLEAGUE: [abstained] }
  };
  const summary = validateArchive(baseArchive);
  check('valid archive returns coverage counts',
    summary.projected === 1
      && summary.abstained === 1
      && summary.byLeague.NBA.projected === 1
      && summary.byLeague.GLEAGUE.abstained === 1);

  check('duplicate identity keys are rejected',
    throws(() => validateArchive({
      ...baseArchive,
      leagues: { NBA: [archived, { ...archived }], GLEAGUE: [] }
    }), /duplicate/i));

  const invalidProjection = (patch) => ({
    ...archived,
    projection: {
      ...archived.projection,
      accounting: { ...archived.projection.accounting, ...patch }
    }
  });
  check('FGM greater than FGA is rejected',
    throws(() => validateArchive({ ...baseArchive, leagues: { NBA: [invalidProjection({ fgm: 17 })], GLEAGUE: [] } }), /fgm|fga/i));
  check('3PM greater than 3PA is rejected',
    throws(() => validateArchive({ ...baseArchive, leagues: { NBA: [invalidProjection({ fg3m: 6 })], GLEAGUE: [] } }), /3pm|3pa|fg3m|fg3a/i));
  check('FTM greater than FTA is rejected',
    throws(() => validateArchive({ ...baseArchive, leagues: { NBA: [invalidProjection({ ftm: 6 })], GLEAGUE: [] } }), /ftm|fta/i));
  check('rebound accounting mismatch is rejected',
    throws(() => validateArchive({ ...baseArchive, leagues: { NBA: [invalidProjection({ reb: 9 })], GLEAGUE: [] } }), /reb/i));
  check('points accounting mismatch is rejected',
    throws(() => validateArchive({ ...baseArchive, leagues: { NBA: [invalidProjection({ pts: 99 })], GLEAGUE: [] } }), /points|pts/i));
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

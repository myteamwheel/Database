// Forecast archive regression tests. Node-only, deterministic.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mod = null;
let captureMod = null;
let importError = null;
let captureImportError = null;
try {
  mod = await import('../scripts/lib/forecast-archive.mjs');
} catch (err) {
  importError = err;
}
try {
  captureMod = await import('../scripts/archive-forecast.mjs');
} catch (err) {
  captureImportError = err;
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
  const { sha256, projectionIdentity, extractArchivedPlayer, validateArchive, nbaBaselines, gleagueBaseline } = mod;

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

  const seasonRow = (season, gp, mpg, pts, shotScale = 1) => ({
    season, team: 'PHI', gp, min: gp * mpg,
    pts: gp * pts,
    oreb: gp * 1, dreb: gp * 4,
    ast: gp * 3, stl: gp * 1, blk: gp * 0.5, tov: gp * 2, pf: gp * 2,
    fgm: gp * 4 * shotScale, fga: gp * 8 * shotScale,
    fg3m: gp * 1 * shotScale, fg3a: gp * 3 * shotScale,
    ftm: gp * 2 * shotScale, fta: gp * 2.5 * shotScale,
  });
  const nbaD = {
    nba: {
      seasons: new Map([
        ['2025-26', new Map([[999, seasonRow('2025-26', 10, 20, 10, 1)]])],
        ['2024-25', new Map([[999, seasonRow('2024-25', 20, 15, 8, 2)]])],
        ['2023-24', new Map([[999, seasonRow('2023-24', 30, 10, 6, 3)]])],
      ]),
      teamGames: () => 82,
    },
    gleague: {
      seasons: new Map([
        ['2025-26', new Map([[999, seasonRow('2025-26', 12, 22, 12, 1)]])],
      ]),
      teamGames: () => 50,
    },
  };

  check('NBA baseline functions are exported', typeof nbaBaselines === 'function');
  check('G League baseline function is exported', typeof gleagueBaseline === 'function');

  if (typeof nbaBaselines === 'function') {
    const b = nbaBaselines(nbaD, 999, '2026-27');
    check('repeat baseline uses the most recent recent season',
      Math.abs(b.repeat.pts - 10) < 1e-12
        && Math.abs(b.repeat.mpg - 20) < 1e-12
        && Math.abs(b.repeat.gp - 10) < 1e-12);
    check('NBA avg3 uses exact 5/4/3 x games weighting',
      Math.abs(b.avg3.pts - 7.636363636363637) < 1e-12
        && Math.abs(b.avg3.mpg - 14.090909090909092) < 1e-12
        && Math.abs(b.avg3.gp - 18.333333333333332) < 1e-12);
    check('NBA avg3 shooting percentages use weighted makes and attempts',
      Math.abs(b.avg3.fgPct - 0.5) < 1e-12
        && Math.abs(b.avg3.fg3Pct - (1 / 3)) < 1e-12
        && Math.abs(b.avg3.ftPct - 0.8) < 1e-12);

    const noRecent = {
      nba: { seasons: new Map([['2022-23', new Map([[999, seasonRow('2022-23', 40, 20, 15)]])]]), teamGames: () => 82 }
    };
    const missing = nbaBaselines(noRecent, 999, '2026-27');
    check('NBA naive baselines do not reach back beyond the recent three-year window',
      missing.repeat === null && missing.avg3 === null);
  }

  if (typeof gleagueBaseline === 'function') {
    const g = gleagueBaseline(nbaD, 999, '2026-27', 50);
    check('G League archive baseline exposes repeat only',
      Math.abs(g.repeat.pts - 12) < 1e-12
        && Math.abs(g.repeat.mpg - 22) < 1e-12
        && Math.abs(g.repeat.gp - 12) < 1e-12
        && !('avg3' in g));
  }


  check('forecast capture module exists', !captureImportError, captureImportError?.message || '');
  if (!captureImportError) {
    const { readGitFile, resolveGitCommit, buildArchive, writeArchiveFiles, captureForecast } = captureMod;
    check('capture interfaces are exported',
      typeof readGitFile === 'function'
        && typeof resolveGitCommit === 'function'
        && typeof buildArchive === 'function'
        && typeof writeArchiveFiles === 'function'
        && typeof captureForecast === 'function');

    if (typeof readGitFile === 'function') {
      const testPath = 'tests/forecast-archive.test.mjs';
      const original = fs.readFileSync(testPath);
      try {
        fs.appendFileSync(testPath, '\n// working-tree-only mutation\n');
        const committed = readGitFile('HEAD', testPath);
        check('git-ref reads ignore working-tree mutations',
          !committed.equals(fs.readFileSync(testPath))
            && committed.equals(original));
      } finally {
        fs.writeFileSync(testPath, original);
      }
      check('missing required git-ref artifact fails closed',
        throws(() => readGitFile('HEAD', 'definitely-not-a-release-artifact.json'), /git show|artifact|exist|path|fatal/i));
    }

    if (typeof resolveGitCommit === 'function') {
      const resolved = resolveGitCommit('HEAD');
      check('git ref resolves to full commit provenance',
        /^[0-9a-f]{40}$/.test(resolved.sha)
          && !Number.isNaN(Date.parse(resolved.committedAt)));
    }

    if (typeof buildArchive === 'function') {
      const fixtureProjection = {
        ...projection,
        accounting: { ...projection.accounting },
      };
      const fixtureData = {
        projectionMeta: {
          id: 'PROJECTION_2026_27',
          season: '2026-27',
          contextVersion: 'context-1',
          timeframe: 'preseason-full-season',
          rostersAsOf: '2026-09-29',
          rosterSha256: null,
        },
        leagues: {
          NBA: [{ ...player, proj: fixtureProjection }],
          GLEAGUE: [{ nbaPersonId: 777, playerId: 'gl-777', name: 'G League Example', team: 'LIN', proj: { abstain: true, reason: 'No history.' } }],
        },
      };
      const fixtureInputs = {
        fetchedAt: '2026-09-29T12:00:00Z',
        rosters2627: [{ PERSON_ID: 123, TEAM_ABBREVIATION: 'PHI' }],
        playerIndex: [],
        nba: {},
        nbaOpening: {},
        gleague: {},
      };
      const rawInputsFixture = Buffer.from(JSON.stringify(fixtureInputs));
      fixtureData.projectionMeta.rosterSha256 = crypto.createHash('sha256')
        .update(JSON.stringify(fixtureInputs.rosters2627)).digest('hex');
      const rawDataFixture = Buffer.from(JSON.stringify(fixtureData));
      const fixtureCard = { id: 'PROJECTION_2026_27', gleague: { games: 50 } };
      const rawCardFixture = Buffer.from(JSON.stringify(fixtureCard));

      const archive = buildArchive({
        data: fixtureData,
        card: fixtureCard,
        rawData: rawDataFixture,
        rawCard: rawCardFixture,
        rawInputs: rawInputsFixture,
        rosterBytes: null,
        sourceCommit: 'a'.repeat(40),
        publishedAt: '2026-09-29T12:00:00Z',
        publicationBasis: 'source-commit-time',
        forecastId: 'fixture-capture',
      });
      check('capture preserves exact model/context/roster metadata',
        archive.model.id === 'PROJECTION_2026_27'
          && archive.model.contextVersion === 'context-1'
          && archive.model.timeframe === 'preseason-full-season'
          && archive.model.rostersAsOf === '2026-09-29'
          && archive.sources.liveRoster === null);
      check('capture hashes raw release artifacts',
        archive.sources.publicData.sha256 === crypto.createHash('sha256').update(rawDataFixture).digest('hex')
          && archive.sources.projectionCard.sha256 === crypto.createHash('sha256').update(rawCardFixture).digest('hex')
          && archive.sources.projectionInputs.sha256 === crypto.createHash('sha256').update(rawInputsFixture).digest('hex'));

      const badRosterData = JSON.parse(JSON.stringify(fixtureData));
      badRosterData.projectionMeta.rosterSha256 = '0'.repeat(64);
      check('capture rejects a projection roster hash mismatch',
        throws(() => buildArchive({
          data: badRosterData,
          card: fixtureCard,
          rawData: Buffer.from(JSON.stringify(badRosterData)),
          rawCard: rawCardFixture,
          rawInputs: rawInputsFixture,
          rosterBytes: null,
          sourceCommit: 'a'.repeat(40),
          publishedAt: '2026-09-29T12:00:00Z',
          publicationBasis: 'source-commit-time',
          forecastId: 'bad-roster',
        }), /roster.*hash|rosterSha/i));

      const noTimeframe = JSON.parse(JSON.stringify(fixtureData));
      delete noTimeframe.projectionMeta.timeframe;
      check('capture rejects ambiguous forecast timeframe',
        throws(() => buildArchive({
          data: noTimeframe,
          card: fixtureCard,
          rawData: Buffer.from(JSON.stringify(noTimeframe)),
          rawCard: rawCardFixture,
          rawInputs: rawInputsFixture,
          rosterBytes: null,
          sourceCommit: 'a'.repeat(40),
          publishedAt: '2026-09-29T12:00:00Z',
          publicationBasis: 'source-commit-time',
          forecastId: 'no-timeframe',
        }), /timeframe/i));

      if (typeof writeArchiveFiles === 'function') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-archive-'));
        try {
          const first = writeArchiveFiles(archive, { archiveDir: dir });
          check('archive writer creates snapshot and manifest',
            fs.existsSync(first.snapshotPath) && fs.existsSync(first.manifestPath));
          check('duplicate forecast id is rejected instead of overwritten',
            throws(() => writeArchiveFiles(archive, { archiveDir: dir }), /already exists|duplicate/i));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      if (typeof captureForecast === 'function') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-dry-run-'));
        try {
          const before = fs.readdirSync(dir);
          captureForecast({
            ref: 'HEAD',
            forecastId: 'dry-run-fixture',
            archiveDir: dir,
            dryRun: true,
            artifactPaths: {
              data: 'public/data.json',
              card: 'PROJECTION_2026_27.json',
              inputs: 'scripts/data/projection/inputs.json',
              roster: 'scripts/data/live/roster.json',
            },
          });
          check('dry-run capture creates no archive files',
            JSON.stringify(fs.readdirSync(dir)) === JSON.stringify(before));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }

}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

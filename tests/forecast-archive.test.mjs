// Forecast archive regression tests. Node-only, deterministic.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let mod = null;
let captureMod = null;
let verifyMod = null;
let importError = null;
let captureImportError = null;
let verifyImportError = null;
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
try {
  verifyMod = await import('../scripts/verify-forecast-archive.mjs');
} catch (err) {
  verifyImportError = err;
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
  const { sha256, projectionIdentity, extractArchivedPlayer, validateArchive, nbaBaselines, gleagueBaseline, deriveCohorts, scoreArchive } = mod;

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
    publishedAt: '2026-09-29',
    sourceCommit: 'a'.repeat(40),
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
        rosters2627: {
          headers: ['PERSON_ID', 'TEAM_ABBREVIATION', 'ROSTER_STATUS', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'POSITION', 'HEIGHT', 'WEIGHT', 'DRAFT_NUMBER', 'DRAFT_YEAR', 'FROM_YEAR'],
          rows: [[123, 'PHI', 1, 'Archive', 'Example', 'G', '6-5', 205, 10, 2024, 2024]],
        },
        playerIndex: {
          headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'POSITION', 'HEIGHT', 'WEIGHT', 'DRAFT_NUMBER', 'DRAFT_YEAR', 'FROM_YEAR'],
          rows: [],
        },
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



  check('forecast scoring interfaces are exported',
    typeof deriveCohorts === 'function' && typeof scoreArchive === 'function');

  if (typeof deriveCohorts === 'function' && typeof scoreArchive === 'function') {
    const scoreRowA = {
      ...archived,
      identity: 'NBA:1001',
      playerId: 'nba-1001',
      nbaPersonId: 1001,
      name: 'Score A',
      status: 'same',
      basis: 'multi-year-history',
      age: 22,
      projection: {
        ...archived.projection,
        gp: 70,
        mpg: 30,
        pts: 22.1,
        fgPct: 0.50,
        fg3Pct: 0.40,
        ftPct: 0.80,
        why: { ...archived.projection.why, minutes: { last: 26, projected: 30 } },
      },
      baselines: {
        repeat: { gp: 68, mpg: 29, pts: 19.1, fgPct: 0.48, fg3Pct: 0.36, ftPct: 0.78 },
        avg3: { gp: 66, mpg: 28, pts: 21.1, fgPct: 0.49, fg3Pct: 0.37, ftPct: 0.79 },
      },
    };
    const scoreRowB = {
      ...archived,
      identity: 'NBA:1002',
      playerId: 'nba-1002',
      nbaPersonId: 1002,
      name: 'Score B',
      status: 'new',
      basis: 'older-history-fallback',
      age: 34,
      projection: {
        ...archived.projection,
        gp: 50,
        mpg: 20,
        pts: 12,
        fgPct: 0.44,
        fg3Pct: 0.31,
        ftPct: 0.70,
        why: { ...archived.projection.why, minutes: { last: 12, projected: 20 } },
      },
      baselines: {
        repeat: null,
        avg3: { gp: 45, mpg: 18, pts: 18, fgPct: 0.46, fg3Pct: 0.33, ftPct: 0.72 },
      },
    };
    const glRow = {
      ...archived,
      identity: 'GLEAGUE:2001',
      league: 'GLEAGUE',
      playerId: 'gl-2001',
      nbaPersonId: 2001,
      name: 'Score GL',
      status: 'gleague',
      basis: 'multi-year-history',
      age: 24,
      projection: { ...archived.projection, gp: 30, mpg: 25, pts: 10 },
      baselines: { repeat: { gp: 28, mpg: 24, pts: 9 } },
    };
    const scoreFixture = {
      schemaVersion: 1,
      forecastId: 'score-fixture',
      season: '2026-27',
      forecastType: 'preseason-full-season',
      leagues: { NBA: [scoreRowA, scoreRowB], GLEAGUE: [glRow] },
    };
    const finalActuals = {
      season: '2026-27',
      asOf: '2027-04-15',
      status: 'final',
      leagues: {
        NBA: [
          {
            nbaPersonId: 1001, gp: 10, mpg: 31, pts: 20.1, reb: 6, ast: 5, stl: 1, blk: 0.5, tov: 2, fg3m: 1.5,
            fgPct: 0.45, fg3Pct: 0.35, ftPct: 0.75, fga: 11, fg3a: 4, fta: 6,
          },
          {
            nbaPersonId: 1002, gp: 5, mpg: 19, pts: 16, reb: 5, ast: 4, stl: 0.8, blk: 0.3, tov: 1.8, fg3m: 1,
            fgPct: null, fg3Pct: 0.30, ftPct: 0.70, fga: 30, fg3a: 5, fta: 8,
          },
        ],
        GLEAGUE: [
          {
            nbaPersonId: 2001, gp: 25, mpg: 26, pts: 12, reb: 5, ast: 3, stl: 1, blk: 0.4, tov: 2, fg3m: 1.2,
            fgPct: 0.48, fg3Pct: 0.36, ftPct: 0.76, fga: 12, fg3a: 5, fta: 4,
          },
        ],
      },
    };
    const scored = scoreArchive(scoreFixture, finalActuals);
    const nbaPts = scored.leagues.NBA.overall.model.pts;
    check('model scoring reports exact MAE RMSE and signed bias',
      nbaPts.available === true
        && nbaPts.n === 2
        && Math.abs(nbaPts.mae - 3) < 1e-12
        && Math.abs(nbaPts.rmse - Math.sqrt(10)) < 1e-12
        && Math.abs(nbaPts.bias - (-1)) < 1e-12);

    const repeatPts = scored.leagues.NBA.overall.paired.repeat.pts;
    check('repeat comparison uses the exact same paired player sample',
      repeatPts.n === 1
        && Math.abs(repeatPts.model.mae - 2) < 1e-12
        && Math.abs(repeatPts.baseline.mae - 1) < 1e-12);

    const avg3Pts = scored.leagues.NBA.overall.paired.avg3.pts;
    check('avg3 comparison uses the exact same paired player sample',
      avg3Pts.n === 2
        && Math.abs(avg3Pts.model.mae - 3) < 1e-12
        && Math.abs(avg3Pts.baseline.mae - 1.5) < 1e-12);

    check('coverage and unavailable baselines are separate from model error',
      scored.leagues.NBA.coverage.projected === 2
        && scored.leagues.NBA.coverage.matchedActuals === 2
        && scored.leagues.NBA.coverage.baselineAvailable.repeat === 1
        && scored.leagues.NBA.coverage.baselineAvailable.avg3 === 2);

    check('percentage eligibility uses actual attempt thresholds without removing other metrics',
      scored.leagues.NBA.overall.model.pts.n === 2
        && scored.leagues.NBA.overall.model.fgPct.n === 1
        && scored.leagues.NBA.overall.model.ftPct.n === 1
        && scored.leagues.NBA.overall.model.fg3Pct.available === false
        && scored.leagues.NBA.overall.model.fg3Pct.n === 0);

    check('NBA and G League scoring remain separate',
      scored.leagues.NBA.overall.model.pts.n === 2
        && scored.leagues.GLEAGUE.overall.model.pts.n === 1
        && !('combined' in scored.leagues));

    check('season mismatch fails closed',
      throws(() => scoreArchive(scoreFixture, { ...finalActuals, season: '2027-28' }), /season/i));

    const interimActuals = { ...finalActuals, status: 'interim', asOf: '2026-12-15' };
    check('interim actuals require explicit interim mode',
      throws(() => scoreArchive(scoreFixture, interimActuals), /interim/i));
    const interimScore = scoreArchive(scoreFixture, interimActuals, { interim: true });
    check('interim scoring omits GP accuracy and preserves its cutoff label',
      interimScore.actuals.status === 'interim'
        && interimScore.actuals.asOf === '2026-12-15'
        && !('gp' in interimScore.leagues.NBA.overall.model));

    const cohortsA = deriveCohorts(scoreRowA);
    const cohortsB = deriveCohorts(scoreRowB);
    check('cohorts are frozen from archived pre-outcome fields',
      cohortsA.includes('recent-history-veteran')
        && cohortsA.includes('same-team')
        && cohortsA.includes('age-23-and-under')
        && cohortsA.includes('prior-high-minutes')
        && cohortsB.includes('older-history-returner')
        && cohortsB.includes('new-team')
        && cohortsB.includes('age-33-and-over')
        && cohortsB.includes('prior-lower-minutes'));

    check('rookie and unsigned cohorts are explicit',
      deriveCohorts({ status: 'rookie', basis: 'rookie-cohort-fallback', age: 20, projection: { why: { minutes: { last: null } } } }).includes('rookie')
        && deriveCohorts({ status: 'unsigned', basis: 'multi-year-history', age: 28, projection: { why: { minutes: { last: 10 } } } }).includes('unsigned-at-forecast'));
  }

  const canonicalSnapshotPath = path.join('scripts', 'data', 'forecast-archive', '2026-27-preseason-2026-09-29-e718284.json');
  if (fs.existsSync(canonicalSnapshotPath)) {
    const releaseRef = 'e7182849d62cba46566f3ffafc4c1e620e5ef8ff';
    const gitBytes = (filePath) => execFileSync('git', ['show', `${releaseRef}:${filePath}`], {
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const snapshotBytes = fs.readFileSync(canonicalSnapshotPath);
    const canonical = JSON.parse(snapshotBytes);
    const releaseDataBytes = gitBytes('public/data.json');
    const releaseCardBytes = gitBytes('PROJECTION_2026_27.json');
    const releaseInputsBytes = gitBytes('scripts/data/projection/inputs.json');
    const releaseData = JSON.parse(releaseDataBytes.toString('utf8'));

    check('canonical snapshot pins the exact e718284 release and explicit publication date',
      canonical.sourceCommit === releaseRef
        && canonical.publishedAt === '2026-09-29'
        && canonical.publicationBasis === 'explicit'
        && canonical.forecastId === '2026-27-preseason-2026-09-29-e718284');

    check('canonical snapshot hashes exact release bytes',
      canonical.sources.publicData.sha256 === sha256(releaseDataBytes)
        && canonical.sources.projectionCard.sha256 === sha256(releaseCardBytes)
        && canonical.sources.projectionInputs.sha256 === sha256(releaseInputsBytes)
        && canonical.sources.liveRoster === null);

    let releaseMismatch = 0;
    let firstReleaseMismatch = '';
    for (const league of ['NBA', 'GLEAGUE']) {
      const archivedRows = canonical.leagues[league];
      const releasedRows = releaseData.leagues[league];
      const archivedByIdentity = new Map(archivedRows.map((row) => [row.identity, row]));
      if (archivedRows.length !== releasedRows.length) {
        releaseMismatch++;
        firstReleaseMismatch ||= `${league} row count ${archivedRows.length} vs ${releasedRows.length}`;
      }
      for (const player of releasedRows) {
        const identity = projectionIdentity(league, player);
        const row = archivedByIdentity.get(identity);
        if (!row) {
          releaseMismatch++;
          firstReleaseMismatch ||= `${identity} missing`;
          continue;
        }
        if (player.proj?.abstain) {
          if (!row.abstain || row.reason !== player.proj.reason || 'projection' in row) {
            releaseMismatch++;
            firstReleaseMismatch ||= `${identity} abstention differs`;
          }
        } else if (row.abstain || JSON.stringify(row.projection) !== JSON.stringify(player.proj)) {
          releaseMismatch++;
          firstReleaseMismatch ||= `${identity} projection differs`;
        }
      }
    }
    check('canonical snapshot exactly preserves every released projection or abstention',
      releaseMismatch === 0, firstReleaseMismatch);

    const releaseProjected = ['NBA', 'GLEAGUE'].reduce((sum, league) =>
      sum + releaseData.leagues[league].filter((p) => p.proj && !p.proj.abstain).length, 0);
    const releaseAbstained = ['NBA', 'GLEAGUE'].reduce((sum, league) =>
      sum + releaseData.leagues[league].filter((p) => p.proj?.abstain).length, 0);
    check('canonical archive coverage counts equal the released data',
      canonical.counts.projected === releaseProjected
        && canonical.counts.abstained === releaseAbstained
        && canonical.counts.byLeague.NBA.total === releaseData.leagues.NBA.length
        && canonical.counts.byLeague.GLEAGUE.total === releaseData.leagues.GLEAGUE.length);

    check('canonical identities are id-based rather than name-based',
      ['NBA', 'GLEAGUE'].every((league) => canonical.leagues[league].every((row) =>
        row.identity === `${league}:${row.nbaPersonId ?? row.playerId}`
          && row.identity !== `${league}:${row.name}`)));

    const manifest = JSON.parse(fs.readFileSync(path.join('scripts', 'data', 'forecast-archive', 'index.json'), 'utf8'));
    const manifestEntry = manifest.forecasts.find((x) => x.forecastId === canonical.forecastId);
    check('manifest hash pins the canonical snapshot bytes',
      manifestEntry?.sha256 === sha256(snapshotBytes)
        && manifestEntry?.sourceCommit === releaseRef);
  }


  check('forecast archive verifier module exists', !verifyImportError, verifyImportError?.message || '');
  if (!verifyImportError) {
    const { verifyArchiveDirectory, validateAppendOnlyChanges } = verifyMod;
    check('verifier interfaces are exported',
      typeof verifyArchiveDirectory === 'function'
        && typeof validateAppendOnlyChanges === 'function');

    if (typeof verifyArchiveDirectory === 'function') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-verify-'));
      try {
        const snapshotName = 'fixture.json';
        const verifierArchive = {
          ...baseArchive,
          publishedAt: '2026-09-29',
          publicationBasis: 'explicit',
          sourceCommit: 'a'.repeat(40),
          model: {
            id: 'PROJECTION_2026_27',
            contextVersion: 'context-1',
            timeframe: 'preseason-full-season',
            rostersAsOf: '2026-09-29',
            rosterSha256: 'b'.repeat(64),
          },
          sources: {
            publicData: { path: 'public/data.json', sha256: 'c'.repeat(64) },
            projectionCard: { path: 'PROJECTION_2026_27.json', sha256: 'd'.repeat(64) },
            projectionInputs: { path: 'scripts/data/projection/inputs.json', sha256: 'e'.repeat(64) },
            liveRoster: null,
          },
          counts: {
            byLeague: {
              NBA: { total: 1, projected: 1, abstained: 0 },
              GLEAGUE: { total: 1, projected: 0, abstained: 1 },
            },
            projected: 1,
            abstained: 1,
            baselineAvailable: {
              NBA: { repeat: 0, avg3: 0 },
              GLEAGUE: { repeat: 0 },
            },
          },
        };
        const snapshot = JSON.stringify(verifierArchive, null, 2) + '\n';
        fs.writeFileSync(path.join(dir, snapshotName), snapshot);
        const manifest = {
          schemaVersion: 1,
          forecasts: [{
            forecastId: 'fixture',
            season: '2026-27',
            type: 'preseason-full-season',
            publishedAt: '2026-09-29',
            sourceCommit: 'a'.repeat(40),
            path: snapshotName,
            sha256: crypto.createHash('sha256').update(snapshot).digest('hex'),
            byLeague: {
              NBA: { total: 1, projected: 1, abstained: 0 },
              GLEAGUE: { total: 1, projected: 0, abstained: 1 },
            },
            projected: 1,
            abstained: 1,
            baselineAvailable: {
              NBA: { repeat: 0, avg3: 0 },
              GLEAGUE: { repeat: 0 },
            },
          }],
        };
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');

        const verified = verifyArchiveDirectory({ archiveDir: dir });
        check('archive directory verifier accepts a valid manifest and snapshot',
          verified.forecasts === 1 && verified.projected === 1 && verified.abstained === 1);

        const missingProvenance = JSON.parse(JSON.stringify(verifierArchive));
        delete missingProvenance.sources.projectionInputs;
        const missingProvenanceBytes = JSON.stringify(missingProvenance, null, 2) + '\n';
        fs.writeFileSync(path.join(dir, snapshotName), missingProvenanceBytes);
        const missingProvenanceManifest = JSON.parse(JSON.stringify(manifest));
        missingProvenanceManifest.forecasts[0].sha256 = crypto.createHash('sha256').update(missingProvenanceBytes).digest('hex');
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(missingProvenanceManifest, null, 2) + '\n');
        check('archive source provenance metadata is required',
          throws(() => verifyArchiveDirectory({ archiveDir: dir }), /source|provenance|projectionInputs/i));

        fs.writeFileSync(path.join(dir, snapshotName), snapshot);
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');

        const badHash = JSON.parse(JSON.stringify(manifest));
        badHash.forecasts[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(badHash, null, 2) + '\n');
        check('manifest hash mismatch is rejected',
          throws(() => verifyArchiveDirectory({ archiveDir: dir }), /hash|sha256/i));

        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
        fs.unlinkSync(path.join(dir, snapshotName));
        check('manifest entry pointing to a missing snapshot is rejected',
          throws(() => verifyArchiveDirectory({ archiveDir: dir }), /missing|exist|snapshot/i));

        fs.writeFileSync(path.join(dir, snapshotName), snapshot);
        const duplicate = JSON.parse(JSON.stringify(manifest));
        duplicate.forecasts.push({ ...duplicate.forecasts[0] });
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(duplicate, null, 2) + '\n');
        check('duplicate manifest forecast ids are rejected',
          throws(() => verifyArchiveDirectory({ archiveDir: dir }), /duplicate/i));

        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
        const malformed = JSON.parse(JSON.stringify(verifierArchive));
        malformed.leagues.NBA[0].projection.accounting.fgm = 99;
        const malformedBytes = JSON.stringify(malformed, null, 2) + '\n';
        fs.writeFileSync(path.join(dir, snapshotName), malformedBytes);
        const malformedManifest = JSON.parse(JSON.stringify(manifest));
        malformedManifest.forecasts[0].sha256 = crypto.createHash('sha256').update(malformedBytes).digest('hex');
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(malformedManifest, null, 2) + '\n');
        check('malformed archived projection accounting is rejected',
          throws(() => verifyArchiveDirectory({ archiveDir: dir }), /fgm|fga|account/i));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    if (typeof validateAppendOnlyChanges === 'function') {
      check('append-only verifier allows a newly added snapshot',
        !throws(() => validateAppendOnlyChanges([
          'A\tscripts/data/forecast-archive/new.json',
          'M\tscripts/data/forecast-archive/index.json',
        ])));
      check('append-only verifier rejects modification of an existing snapshot',
        throws(() => validateAppendOnlyChanges([
          'M\tscripts/data/forecast-archive/old.json',
        ]), /append|immutable|modify|existing/i));
      check('append-only verifier rejects deletion of an existing snapshot',
        throws(() => validateAppendOnlyChanges([
          'D\tscripts/data/forecast-archive/old.json',
        ]), /append|immutable|delete|existing/i));
      check('append-only verifier rejects rename of an existing snapshot',
        throws(() => validateAppendOnlyChanges([
          'R100\tscripts/data/forecast-archive/old.json\tscripts/data/forecast-archive/new.json',
        ]), /append|immutable|rename|existing/i));
    }
  }

}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

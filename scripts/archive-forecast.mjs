import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare } from './lib/projection.mjs';
import {
  sha256,
  extractArchivedPlayer,
  validateArchive,
  nbaBaselines,
  gleagueBaseline,
} from './lib/forecast-archive.mjs';
import { verifyArchiveDirectory, validateForecastSnapshot } from './verify-forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ARCHIVE_DIR = path.join(ROOT, 'scripts/data/forecast-archive');

export function readGitFile(ref, filePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: ROOT,
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).trim() : String(err?.message || err);
    throw new Error(`git show could not read required artifact ${filePath} at ${ref}: ${detail}`);
  }
}

export function resolveGitCommit(ref) {
  try {
    const sha = execFileSync('git', ['rev-parse', `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const committedAt = execFileSync('git', ['show', '-s', '--format=%cI', sha], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha) || Number.isNaN(Date.parse(committedAt))) {
      throw new Error('resolved git provenance is invalid');
    }
    return { sha, committedAt };
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).trim() : String(err?.message || err);
    throw new Error(`Could not resolve git ref ${ref}: ${detail}`);
  }
}

const numericPid = (player) => {
  const pid = Number(player?.nbaPersonId);
  return Number.isFinite(pid) ? pid : null;
};

function baselineAvailability(leagues) {
  const counts = {
    NBA: { repeat: 0, avg3: 0 },
    GLEAGUE: { repeat: 0 },
  };
  for (const row of leagues.NBA) {
    if (row.baselines?.repeat) counts.NBA.repeat++;
    if (row.baselines?.avg3) counts.NBA.avg3++;
  }
  for (const row of leagues.GLEAGUE) {
    if (row.baselines?.repeat) counts.GLEAGUE.repeat++;
  }
  return counts;
}

export function buildArchive({
  data,
  card,
  rawData,
  rawCard,
  rawInputs,
  rosterBytes = null,
  sourceCommit,
  publishedAt,
  publicationBasis,
  forecastId,
}) {
  if (!forecastId) throw new Error('Forecast id is required.');
  if (!/^[0-9a-f]{40}$/.test(String(sourceCommit || ''))) throw new Error('A full source commit SHA is required.');
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error('A valid publication timestamp is required.');

  const meta = data?.projectionMeta;
  if (!meta?.season) throw new Error('Projection season is required and cannot be ambiguous.');
  if (!meta?.timeframe) throw new Error('Projection timeframe is required and cannot be ambiguous.');
  if (!meta?.id || !meta?.contextVersion || !meta?.rostersAsOf) {
    throw new Error('Projection model/context/roster metadata is incomplete.');
  }
  if (card?.id && card.id !== meta.id) {
    throw new Error(`Projection card id ${card.id} does not match published model id ${meta.id}.`);
  }

  const inputBytes = Buffer.isBuffer(rawInputs) ? rawInputs : Buffer.from(rawInputs);
  const inputData = JSON.parse(inputBytes.toString('utf8'));
  const rosterPayload = rosterBytes
    ? JSON.parse((Buffer.isBuffer(rosterBytes) ? rosterBytes : Buffer.from(rosterBytes)).toString('utf8'))
    : inputData.rosters2627;
  const rosterHash = sha256(JSON.stringify(rosterPayload));
  if (meta.rosterSha256 !== rosterHash) {
    throw new Error(`Projection roster hash mismatch: published ${meta.rosterSha256}, frozen inputs ${rosterHash}.`);
  }

  const D = prepare(inputData);
  const leagues = { NBA: [], GLEAGUE: [] };
  const nbaPlayers = data?.leagues?.NBA;
  const glPlayers = data?.leagues?.GLEAGUE;
  if (!Array.isArray(nbaPlayers) || !Array.isArray(glPlayers)) {
    throw new Error('Published data must contain NBA and G League player arrays.');
  }

  for (const player of nbaPlayers) {
    const row = extractArchivedPlayer('NBA', player);
    const pid = numericPid(player);
    row.baselines = pid == null
      ? { repeat: null, avg3: null, evidence: { seasons: [] } }
      : nbaBaselines(D, pid, meta.season);
    leagues.NBA.push(row);
  }

  const glGames = Number(card?.gleague?.games) || 50;
  for (const player of glPlayers) {
    const row = extractArchivedPlayer('GLEAGUE', player);
    const pid = numericPid(player);
    row.baselines = pid == null
      ? { repeat: null, evidence: { seasons: [] } }
      : gleagueBaseline(D, pid, meta.season, glGames);
    leagues.GLEAGUE.push(row);
  }

  const archive = {
    schemaVersion: 1,
    forecastId,
    season: meta.season,
    forecastType: meta.timeframe,
    publishedAt,
    publicationBasis,
    sourceCommit,
    model: {
      id: meta.id,
      contextVersion: meta.contextVersion,
      timeframe: meta.timeframe,
      rostersAsOf: meta.rostersAsOf,
      rosterSha256: meta.rosterSha256,
    },
    sources: {
      publicData: { path: 'public/data.json', sha256: sha256(rawData) },
      projectionCard: { path: 'PROJECTION_2026_27.json', sha256: sha256(rawCard) },
      projectionInputs: { path: 'scripts/data/projection/inputs.json', sha256: sha256(inputBytes) },
      liveRoster: rosterBytes ? {
        path: 'scripts/data/live/roster.json',
        sha256: sha256(rosterBytes),
      } : null,
    },
    leagues,
  };

  const coverage = validateArchive(archive);
  archive.counts = {
    byLeague: coverage.byLeague,
    projected: coverage.projected,
    abstained: coverage.abstained,
    baselineAvailable: baselineAvailability(leagues),
  };
  return archive;
}

function manifestEntry(archive, relativePath, snapshotBytes) {
  return {
    forecastId: archive.forecastId,
    season: archive.season,
    type: archive.forecastType,
    publishedAt: archive.publishedAt,
    sourceCommit: archive.sourceCommit,
    path: relativePath.replace(/\\/g, '/'),
    sha256: sha256(snapshotBytes),
    byLeague: archive.counts.byLeague,
    projected: archive.counts.projected,
    abstained: archive.counts.abstained,
    baselineAvailable: archive.counts.baselineAvailable,
  };
}

export function writeArchiveFiles(archive, { archiveDir = DEFAULT_ARCHIVE_DIR } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(archive?.forecastId || '')) || archive.forecastId.toLowerCase() === 'index') {
    throw new Error('Forecast ID must be a safe, non-reserved filename.');
  }
  validateForecastSnapshot(archive);
  fs.mkdirSync(archiveDir, { recursive: true });
  const lockPath = path.join(archiveDir, '.archive-write.lock');
  let lockFd;
  try { lockFd = fs.openSync(lockPath, 'wx'); } catch { throw new Error(`Forecast archive writer is locked: ${lockPath}`); }

  const snapshotName = `${archive.forecastId}.json`;
  const snapshotPath = path.join(archiveDir, snapshotName);
  const manifestPath = path.join(archiveDir, 'index.json');
  const nonce = `${process.pid}-${Date.now()}`;
  const snapshotTmp = `${snapshotPath}.tmp-${nonce}`;
  const manifestTmp = `${manifestPath}.tmp-${nonce}`;
  let installedSnapshot = false;
  let manifestCommitted = false;
  try {
    const existing = fs.readdirSync(archiveDir).filter((name) => name !== '.archive-write.lock');
    if (existing.length) verifyArchiveDirectory({ archiveDir });
    if (fs.existsSync(snapshotPath)) throw new Error(`Forecast archive ${archive.forecastId} already exists; snapshots are append-only.`);

    let manifest = { schemaVersion: 1, forecasts: [] };
    if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.forecasts.some((entry) => entry.forecastId === archive.forecastId)) {
      throw new Error(`Duplicate forecast id ${archive.forecastId} already exists in manifest.`);
    }

    const snapshotBytes = Buffer.from(JSON.stringify(archive, null, 2) + '\n');
    manifest.forecasts.push(manifestEntry(archive, snapshotName, snapshotBytes));
    manifest.forecasts.sort((a, b) =>
      String(a.publishedAt).localeCompare(String(b.publishedAt)) || String(a.forecastId).localeCompare(String(b.forecastId)));
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');

    fs.writeFileSync(snapshotTmp, snapshotBytes);
    fs.writeFileSync(manifestTmp, manifestBytes);
    fs.linkSync(snapshotTmp, snapshotPath);
    fs.unlinkSync(snapshotTmp);
    installedSnapshot = true;
    fs.renameSync(manifestTmp, manifestPath);
    manifestCommitted = true;
    return { snapshotPath, manifestPath };
  } finally {
    if (fs.existsSync(snapshotTmp)) fs.rmSync(snapshotTmp, { force: true });
    if (fs.existsSync(manifestTmp)) fs.rmSync(manifestTmp, { force: true });
    if (installedSnapshot && !manifestCommitted && fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath, { force: true });
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function optionalGitFile(ref, filePath) {
  try {
    return readGitFile(ref, filePath);
  } catch {
    return null;
  }
}

export function captureForecast({
  ref,
  forecastId,
  archiveDir = DEFAULT_ARCHIVE_DIR,
  dryRun = false,
  publishedAt = null,
  artifactPaths = {},
}) {
  if (!ref) throw new Error('Capture requires --ref.');
  if (!forecastId) throw new Error('Capture requires --id.');

  const paths = {
    data: artifactPaths.data || 'public/data.json',
    card: artifactPaths.card || 'PROJECTION_2026_27.json',
    inputs: artifactPaths.inputs || 'scripts/data/projection/inputs.json',
    roster: artifactPaths.roster || 'scripts/data/live/roster.json',
  };
  const provenance = resolveGitCommit(ref);
  const rawData = readGitFile(ref, paths.data);
  const rawCard = readGitFile(ref, paths.card);
  const rawInputs = readGitFile(ref, paths.inputs);
  const rosterBytes = optionalGitFile(ref, paths.roster);
  const data = JSON.parse(rawData.toString('utf8'));
  const card = JSON.parse(rawCard.toString('utf8'));

  if (!dryRun && !publishedAt) throw new Error('A new forecast capture requires explicit --published-at.');
  const archive = buildArchive({
    data,
    card,
    rawData,
    rawCard,
    rawInputs,
    rosterBytes,
    sourceCommit: provenance.sha,
    publishedAt: publishedAt || provenance.committedAt,
    publicationBasis: publishedAt ? 'explicit' : 'source-commit-time',
    forecastId,
  });

  if (dryRun) return { archive, written: false };
  return { archive, written: true, ...writeArchiveFiles(archive, { archiveDir }) };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--ref') args.ref = argv[++i];
    else if (token === '--id') args.forecastId = argv[++i];
    else if (token === '--published-at') args.publishedAt = argv[++i];
    else if (token === '--archive-dir') args.archiveDir = argv[++i];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = captureForecast(parseArgs(process.argv.slice(2)));
    if (result.written) {
      console.log(`forecast archive written: ${result.archive.forecastId}`);
      console.log(`  snapshot: ${result.snapshotPath}`);
      console.log(`  manifest: ${result.manifestPath}`);
    } else {
      console.log(`forecast archive dry-run ok: ${result.archive.forecastId}`);
      console.log(JSON.stringify(result.archive.counts));
    }
  } catch (err) {
    console.error(err?.stack || err);
    process.exit(1);
  }
}

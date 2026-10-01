import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256, validateArchive } from './lib/forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ARCHIVE_DIR = path.join(ROOT, 'scripts/data/forecast-archive');
const ARCHIVE_PREFIX = 'scripts/data/forecast-archive/';
const INDEX_PATH = `${ARCHIVE_PREFIX}index.json`;

const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function baselineAvailability(leagues) {
  const counts = {
    NBA: { repeat: 0, avg3: 0 },
    GLEAGUE: { repeat: 0 },
  };
  for (const row of leagues?.NBA || []) {
    if (row.baselines?.repeat) counts.NBA.repeat++;
    if (row.baselines?.avg3) counts.NBA.avg3++;
  }
  for (const row of leagues?.GLEAGUE || []) {
    if (row.baselines?.repeat) counts.GLEAGUE.repeat++;
  }
  return counts;
}

function safeSnapshotPath(archiveDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid forecast snapshot path: ${relativePath}`);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized === 'index.json' || normalized.startsWith('/')) {
    throw new Error(`Invalid forecast snapshot path: ${relativePath}`);
  }
  const resolvedDir = path.resolve(archiveDir);
  const resolved = path.resolve(archiveDir, relativePath);
  if (!(resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep))) {
    throw new Error(`Forecast snapshot escapes archive directory: ${relativePath}`);
  }
  if (fs.existsSync(resolved)) {
    const realDir = fs.realpathSync(archiveDir);
    const realResolved = fs.realpathSync(resolved);
    if (!(realResolved === realDir || realResolved.startsWith(realDir + path.sep))) {
      throw new Error(`Forecast snapshot escapes archive directory through a symlink: ${relativePath}`);
    }
  }
  return resolved;
}

function readManifest(archiveDir) {
  const manifestPath = path.join(archiveDir, 'index.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Forecast archive manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.forecasts)) {
    throw new Error('Forecast archive manifest schema is invalid.');
  }
  const ids = new Set(), paths = new Set();
  for (const entry of manifest.forecasts) {
    if (!entry?.forecastId || !entry?.path) throw new Error('Forecast archive manifest entry is incomplete.');
    if (ids.has(entry.forecastId)) throw new Error(`Duplicate forecast id in manifest: ${entry.forecastId}`);
    if (paths.has(entry.path)) throw new Error(`Duplicate forecast snapshot path in manifest: ${entry.path}`);
    ids.add(entry.forecastId);
    paths.add(entry.path);
  }
  return manifest;
}

export function validateForecastSnapshot(archive) {
  validateArchiveProvenance(archive);
  const summary = validateArchive(archive);
  validateSourceProvenance(archive, summary);
  return summary;
}

export function readVerifiedForecast({ archiveDir = DEFAULT_ARCHIVE_DIR, forecastId = null, snapshotPath = null } = {}) {
  const manifest = readManifest(archiveDir);
  const entry = snapshotPath
    ? manifest.forecasts?.find((item) => item.path === snapshotPath)
    : manifest.forecasts?.find((item) => item.forecastId === forecastId);
  if (!entry) throw new Error('Forecast archive entry was not found in the manifest.');
  const resolved = safeSnapshotPath(archiveDir, entry.path);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Forecast archive snapshot is not a regular file: ${entry.path}`);
  const bytes = fs.readFileSync(resolved);
  if (sha256(bytes) !== entry.sha256) throw new Error(`Forecast archive snapshot hash/SHA256 mismatch: ${entry.path}`);
  const archive = JSON.parse(bytes.toString('utf8'));
  const summary = validateForecastSnapshot(archive);
  validateManifestEntry(entry, archive, summary, bytes);
  return { archive, bytes, entry, path: resolved };
}


function requireSha256(value, label) {
  if (!/^[0-9a-f]{64}$/i.test(String(value || ''))) {
    throw new Error(`Forecast archive source provenance ${label} requires a full SHA256 hash.`);
  }
}

function validateArchiveProvenance(archive) {
  if (archive?.schemaVersion !== 1) throw new Error('Forecast archive snapshot schemaVersion must be 1.');
  if (!archive?.forecastId || !archive?.season || !archive?.forecastType) {
    throw new Error('Forecast archive snapshot is missing forecast identity metadata.');
  }
  if (!archive?.publishedAt || Number.isNaN(Date.parse(archive.publishedAt))) {
    throw new Error('Forecast archive snapshot requires a valid publication date.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(archive?.sourceCommit || ''))) {
    throw new Error('Forecast archive snapshot requires a full source commit SHA.');
  }
  if (!archive?.publicationBasis) throw new Error('Forecast archive snapshot requires publicationBasis provenance.');

  const model = archive?.model;
  if (!model?.id || !model?.contextVersion || !model?.timeframe || !model?.rostersAsOf) {
    throw new Error('Forecast archive model/context/roster provenance is incomplete.');
  }
  if (model.timeframe !== archive.forecastType) {
    throw new Error('Forecast archive model timeframe does not match forecast type.');
  }
  if (Number.isNaN(Date.parse(model.rostersAsOf))) {
    throw new Error('Forecast archive roster-as-of provenance is invalid.');
  }
  requireSha256(model.rosterSha256, 'model.rosterSha256');

  const sources = archive?.sources;
  for (const key of ['publicData', 'projectionCard', 'projectionInputs']) {
    const source = sources?.[key];
    if (!source?.path) throw new Error(`Forecast archive source provenance is missing ${key}.`);
    requireSha256(source.sha256, `sources.${key}.sha256`);
  }
  if (sources?.liveRoster != null) {
    if (!sources.liveRoster.path) throw new Error('Forecast archive live-roster source provenance is missing its path.');
    requireSha256(sources.liveRoster.sha256, 'sources.liveRoster.sha256');
  }
}

function validateSourceProvenance(archive, summary) {
  if (!/^[0-9a-f]{40}$/.test(String(archive.sourceCommit || ''))) {
    throw new Error('Forecast archive source provenance requires a full sourceCommit SHA.');
  }
  if (!archive.publishedAt || Number.isNaN(Date.parse(archive.publishedAt))) {
    throw new Error('Forecast archive source provenance requires a valid publication date.');
  }
  if (!['explicit', 'source-commit-time'].includes(archive.publicationBasis)) {
    throw new Error('Forecast archive source provenance requires a publicationBasis.');
  }
  const model = archive.model;
  for (const key of ['id', 'contextVersion', 'timeframe', 'rostersAsOf', 'rosterSha256']) {
    if (model?.[key] === null || model?.[key] === undefined || model?.[key] === '') {
      throw new Error(`Forecast archive model provenance is missing ${key}.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(String(model.rosterSha256))) {
    throw new Error('Forecast archive model provenance has an invalid rosterSha256.');
  }

  const sources = archive.sources;
  for (const key of ['publicData', 'projectionCard', 'projectionInputs']) {
    const source = sources?.[key];
    if (!source?.path || !/^[0-9a-f]{64}$/.test(String(source.sha256 || ''))) {
      throw new Error(`Forecast archive source provenance is missing or invalid: ${key}.`);
    }
  }
  if (sources?.liveRoster != null) {
    if (!sources.liveRoster.path || !/^[0-9a-f]{64}$/.test(String(sources.liveRoster.sha256 || ''))) {
      throw new Error('Forecast archive source provenance has invalid liveRoster metadata.');
    }
  }

  const expectedCounts = {
    byLeague: summary.byLeague,
    projected: summary.projected,
    abstained: summary.abstained,
    baselineAvailable: baselineAvailability(archive.leagues),
  };
  if (!archive.counts || !jsonEqual(archive.counts, expectedCounts)) {
    throw new Error('Forecast archive embedded coverage/provenance counts do not match its player records.');
  }
}

function validateManifestEntry(entry, archive, summary, bytes) {
  if (entry.forecastId !== archive.forecastId) throw new Error(`Manifest forecast id mismatch for ${entry.path}`);
  if (entry.season !== archive.season) throw new Error(`Manifest season mismatch for ${entry.forecastId}`);
  if (entry.type !== archive.forecastType) throw new Error(`Manifest forecast type mismatch for ${entry.forecastId}`);
  if (entry.publishedAt !== archive.publishedAt) throw new Error(`Manifest publication date mismatch for ${entry.forecastId}`);
  if (entry.sourceCommit !== archive.sourceCommit) throw new Error(`Manifest source commit mismatch for ${entry.forecastId}`);
  if (entry.sha256 !== sha256(bytes)) throw new Error(`Manifest SHA256/hash mismatch for ${entry.forecastId}`);
  if (entry.projected !== summary.projected || entry.abstained !== summary.abstained) {
    throw new Error(`Manifest coverage count mismatch for ${entry.forecastId}`);
  }
  if (!jsonEqual(entry.byLeague, summary.byLeague)) {
    throw new Error(`Manifest league coverage mismatch for ${entry.forecastId}`);
  }
  const baselines = baselineAvailability(archive.leagues);
  if (!jsonEqual(entry.baselineAvailable, baselines)) {
    throw new Error(`Manifest baseline availability mismatch for ${entry.forecastId}`);
  }
}

export function verifyArchiveDirectory({ archiveDir = DEFAULT_ARCHIVE_DIR } = {}) {
  let manifest;
  try {
    manifest = readManifest(archiveDir);
  } catch (err) {
    throw new Error(`Forecast archive manifest is not valid JSON: ${err.message}`);
  }

  const ids = new Set();
  const paths = new Set();
  let projected = 0;
  let abstained = 0;

  for (const entry of manifest.forecasts) {
    if (!entry?.forecastId) throw new Error('Forecast archive manifest entry is missing forecastId.');
    if (ids.has(entry.forecastId)) throw new Error(`Duplicate forecast id in manifest: ${entry.forecastId}`);
    ids.add(entry.forecastId);
    if (!entry.path) throw new Error(`Manifest entry ${entry.forecastId} is missing snapshot path.`);
    if (paths.has(entry.path)) throw new Error(`Duplicate forecast snapshot path in manifest: ${entry.path}`);
    paths.add(entry.path);

    const snapshotPath = safeSnapshotPath(archiveDir, entry.path);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Forecast archive snapshot is missing: ${entry.path}`);
    }
    const snapshotStat = fs.lstatSync(snapshotPath);
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) {
      throw new Error(`Forecast archive snapshot is not a regular file: ${entry.path}`);
    }
    const bytes = fs.readFileSync(snapshotPath);
    if (entry.sha256 !== sha256(bytes)) {
      throw new Error(`Forecast archive snapshot hash/SHA256 mismatch: ${entry.path}`);
    }

    let archive;
    try {
      archive = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      throw new Error(`Forecast archive snapshot is not valid JSON (${entry.path}): ${err.message}`);
    }
    validateArchiveProvenance(archive);
    const summary = validateArchive(archive);
    validateSourceProvenance(archive, summary);
    validateManifestEntry(entry, archive, summary, bytes);
    projected += summary.projected;
    abstained += summary.abstained;
  }

  const listed = new Set(manifest.forecasts.map((entry) => entry.path));
  const orphans = fs.readdirSync(archiveDir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json' && !listed.has(name));
  if (orphans.length) throw new Error(`Forecast archive contains unindexed snapshot(s): ${orphans.join(', ')}`);

  return { forecasts: manifest.forecasts.length, projected, abstained };
}

export function validateManifestExtension(previous, next) {
  if (!Array.isArray(previous?.forecasts) || !Array.isArray(next?.forecasts)) throw new Error('Malformed archive manifest.');
  const nextEntries = new Map(next.forecasts.map(entry => [entry.forecastId,entry]));
  for (const entry of previous.forecasts) {
    if (!nextEntries.has(entry.forecastId)) throw new Error(`Existing forecast removed from manifest: ${entry.forecastId}`);
    if (!isDeepStrictEqual(entry,nextEntries.get(entry.forecastId))) throw new Error(`Existing forecast manifest entry modified: ${entry.forecastId}`);
  }
  return true;
}

export function validateAppendOnlyChanges(changes) {
  const lines = Array.isArray(changes)
    ? changes
    : String(changes || '').split(/\r?\n/).filter(Boolean);

  for (const raw of lines) {
    if (!raw) continue;
    const cols = raw.split('\t');
    const status = cols[0];
    const code = status[0];
    const paths = cols.slice(1).filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    const relevant = paths.filter((p) => p.startsWith(ARCHIVE_PREFIX));
    if (!relevant.length) continue;

    if (relevant.every((p) => p === INDEX_PATH)) {
      if (!['A', 'M'].includes(code)) {
        throw new Error(`Forecast archive manifest change is not append-only: ${raw}`);
      }
      continue;
    }

    if (code === 'A' && relevant.every((p) => p !== INDEX_PATH && p.endsWith('.json'))) continue;

    const action = code === 'M' ? 'modify' : code === 'D' ? 'delete'
      : code === 'R' ? 'rename' : code === 'C' ? 'copy' : `change (${status})`;
    throw new Error(`Forecast archive snapshots are immutable/append-only; cannot ${action} an existing snapshot: ${raw}`);
  }
  return true;
}

function parseArgs(argv) {
  const args = { baseRef: null, archiveDir: DEFAULT_ARCHIVE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--base-ref') args.baseRef = argv[++i];
    else if (token === '--archive-dir') args.archiveDir = argv[++i];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

export function verifyForecastArchive({ baseRef = null, archiveDir = DEFAULT_ARCHIVE_DIR } = {}) {
  const summary = verifyArchiveDirectory({ archiveDir });
  if (baseRef) {
    let diff;
    try {
      diff = execFileSync('git', [
        'diff', '--name-status', `${baseRef}..HEAD`, '--', 'scripts/data/forecast-archive',
      ], { cwd: ROOT, encoding: 'utf8' });
    } catch (err) {
      throw new Error(`Unable to compare forecast archive with base ref ${baseRef}: ${err.stderr?.toString?.() || err.message}`);
    }
    validateAppendOnlyChanges(diff);
    const tracked = execFileSync('git',['ls-tree','--name-only',baseRef,'--',INDEX_PATH],{cwd:ROOT,encoding:'utf8'}).trim();
    if (tracked) {
      const previous = JSON.parse(execFileSync('git',['show',`${baseRef}:${INDEX_PATH}`],{cwd:ROOT,encoding:'utf8'}));
      const next = JSON.parse(fs.readFileSync(path.join(archiveDir,'index.json'),'utf8'));
      validateManifestExtension(previous,next);
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyForecastArchive(parseArgs(process.argv.slice(2)));
    console.log(`forecast archive verified: ${result.forecasts} snapshot(s), ${result.projected} projected, ${result.abstained} abstained`);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

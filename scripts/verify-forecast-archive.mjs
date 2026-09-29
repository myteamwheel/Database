import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  return resolved;
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
  const manifestPath = path.join(archiveDir, 'index.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Forecast archive manifest is missing: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Forecast archive manifest is not valid JSON: ${err.message}`);
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.forecasts)) {
    throw new Error('Forecast archive manifest schema is invalid.');
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
    const summary = validateArchive(archive);
    validateManifestEntry(entry, archive, summary, bytes);
    projected += summary.projected;
    abstained += summary.abstained;
  }

  return { forecasts: manifest.forecasts.length, projected, abstained };
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

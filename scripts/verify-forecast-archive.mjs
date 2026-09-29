import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256, validateArchive } from './lib/forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, 'scripts/data/forecast-archive');

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function verifyArchiveDirectory({ rootDir = DEFAULT_DIR } = {}) {
  const indexPath = path.join(rootDir, 'index.json');
  if (!fs.existsSync(indexPath)) throw new Error(`forecast archive manifest missing: ${indexPath}`);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (index.schemaVersion !== 1 || !Array.isArray(index.forecasts)) throw new Error('invalid forecast archive manifest schema');

  const ids = new Set();
  const files = new Set();
  const forecasts = [];
  for (const entry of index.forecasts) {
    if (!entry?.forecastId) throw new Error('manifest entry missing forecastId');
    if (ids.has(entry.forecastId)) throw new Error(`duplicate forecast id in manifest: ${entry.forecastId}`);
    ids.add(entry.forecastId);
    if (!entry.file) throw new Error(`${entry.forecastId}: manifest entry missing file`);
    if (files.has(entry.file)) throw new Error(`duplicate forecast file in manifest: ${entry.file}`);
    files.add(entry.file);

    const snapshotPath = path.join(rootDir, entry.file);
    if (!fs.existsSync(snapshotPath)) throw new Error(`${entry.forecastId}: snapshot file missing: ${entry.file}`);
    const bytes = fs.readFileSync(snapshotPath);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) throw new Error(`${entry.forecastId}: snapshot hash mismatch`);

    const archive = JSON.parse(bytes.toString('utf8'));
    if (archive.forecastId !== entry.forecastId) throw new Error(`${entry.forecastId}: snapshot id does not match manifest`);
    if (archive.season !== entry.season || archive.type !== entry.type || archive.publishedAt !== entry.publishedAt || archive.sourceCommit !== entry.sourceCommit) {
      throw new Error(`${entry.forecastId}: snapshot metadata does not match manifest`);
    }
    const summary = validateArchive(archive);
    const baselineAvailable = { repeat: 0, avg3: 0 };
    for (const player of archive.players) {
      if (player.baselines?.repeat) baselineAvailable.repeat++;
      if (player.baselines?.avg3) baselineAvailable.avg3++;
    }
    const expectedCounts = {
      byLeague: summary.byLeague,
      projected: summary.projected,
      abstained: summary.abstained,
      baselineAvailable,
    };
    if (!sameJson(entry.counts, expectedCounts)) throw new Error(`${entry.forecastId}: manifest count mismatch`);

    if (!archive.model?.id || !archive.sourceCommit || !archive.publishedAt) throw new Error(`${entry.forecastId}: incomplete forecast provenance`);
    if (!archive.sources || typeof archive.sources !== 'object') throw new Error(`${entry.forecastId}: source provenance missing`);
    forecasts.push(entry.forecastId);
  }

  const jsonFiles = fs.readdirSync(rootDir).filter(x => x.endsWith('.json') && x !== 'index.json').sort();
  const unindexed = jsonFiles.filter(x => !files.has(x));
  if (unindexed.length) throw new Error(`unindexed forecast snapshot(s): ${unindexed.join(', ')}`);
  return { snapshots: forecasts.length, forecasts };
}

export function validateArchiveDiff(statusRows) {
  for (const row of statusRows || []) {
    const status = String(row.status || '');
    const p = row.path || '';
    if (!p.startsWith('scripts/data/forecast-archive/')) continue;
    if (p === 'scripts/data/forecast-archive/index.json') continue;
    if (status === 'A') continue;
    throw new Error(`forecast archive is append-only: ${status} ${p}${row.newPath ? ` -> ${row.newPath}` : ''}`);
  }
}

export function parseNameStatus(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) return { status, path: parts[1], newPath: parts[2] };
    return { status, path: parts[1] };
  });
}

function verifyAppendOnly(baseRef, { cwd = ROOT } = {}) {
  const out = execFileSync('git', ['diff','--name-status',`${baseRef}..HEAD`,'--','scripts/data/forecast-archive'], { cwd, encoding:'utf8', maxBuffer:16*1024*1024 });
  const rows = parseNameStatus(out);
  validateArchiveDiff(rows);
  return rows.length;
}

function parseArgs(argv) {
  const out = {};
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if (arg==='--base-ref') out.baseRef=argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts=parseArgs(process.argv.slice(2));
  const result=verifyArchiveDirectory();
  const changed=opts.baseRef ? verifyAppendOnly(opts.baseRef) : null;
  console.log(`forecast archive ok · ${result.snapshots} snapshot(s)${changed===null?'':` · append-only diff ${changed} path(s)`}`);
}

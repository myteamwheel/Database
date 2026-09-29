import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildArchive, sha256, validateArchive } from './lib/forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(ROOT, 'scripts/data/forecast-archive');
const REQUIRED = ['public/data.json','PROJECTION_2026_27.json','scripts/data/projection/inputs.json'];
const OPTIONAL_ROSTER = 'scripts/data/live/roster.json';

export function readGitFile(ref, filePath, { optional = false, cwd = ROOT, run = execFileSync } = {}) {
  try { return run('git', ['show', `${ref}:${filePath}`], { cwd, maxBuffer: 256 * 1024 * 1024 }); }
  catch (error) { if (optional) return null; throw new Error(`cannot read ${filePath} at ${ref}: ${error.message}`); }
}

export function resolveGitCommit(ref, { cwd = ROOT } = {}) {
  const sha = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd, encoding:'utf8' }).trim();
  const committedAt = execFileSync('git', ['show','-s','--format=%cI',sha], { cwd, encoding:'utf8' }).trim();
  return { sha, committedAt };
}

const snapshotBytes = (archive) => Buffer.from(JSON.stringify(archive, null, 1) + '\n');

function manifestEntry(archive, bytes) {
  const summary = validateArchive(archive);
  const baseline = { repeat: 0, avg3: 0 };
  for (const p of archive.players) {
    if (p.baselines?.repeat) baseline.repeat++;
    if (p.baselines?.avg3) baseline.avg3++;
  }
  return {
    forecastId: archive.forecastId, season: archive.season, type: archive.type, publishedAt: archive.publishedAt,
    sourceCommit: archive.sourceCommit, file: `${archive.forecastId}.json`, sha256: sha256(bytes),
    counts: { byLeague: summary.byLeague, projected: summary.projected, abstained: summary.abstained, baselineAvailable: baseline },
  };
}

export function writeArchiveFiles(dir, archive) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${archive.forecastId}.json`);
  if (fs.existsSync(file)) throw new Error(`forecast archive already exists: ${archive.forecastId}`);
  const indexPath = path.join(dir, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { schemaVersion: 1, forecasts: [] };
  if (index.forecasts.some(x => x.forecastId === archive.forecastId)) throw new Error(`forecast id already exists in manifest: ${archive.forecastId}`);
  const bytes = snapshotBytes(archive);
  index.forecasts.push(manifestEntry(archive, bytes));
  index.forecasts.sort((a,b) => String(a.publishedAt).localeCompare(String(b.publishedAt)) || a.forecastId.localeCompare(b.forecastId));
  const tmpFile = `${file}.tmp-${process.pid}`, tmpIndex = `${indexPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, bytes);
  fs.writeFileSync(tmpIndex, JSON.stringify(index, null, 1) + '\n');
  fs.renameSync(tmpFile, file);
  fs.renameSync(tmpIndex, indexPath);
  return { file, indexPath, entry: index.forecasts.find(x => x.forecastId === archive.forecastId) };
}

export function captureForecast({ ref, forecastId, publishedAt, dryRun = false, outDir = DEFAULT_DIR, readRefFile = readGitFile, resolveRef = resolveGitCommit }) {
  if (!ref || !forecastId || !publishedAt) throw new Error('--ref, --id and --published-at are required');
  const resolved = resolveRef(ref);
  const raw = {};
  for (const p of REQUIRED) raw[p] = readRefFile(ref, p);
  raw[OPTIONAL_ROSTER] = readRefFile(ref, OPTIONAL_ROSTER, { optional: true });
  const data = JSON.parse(raw['public/data.json'].toString('utf8'));
  const card = JSON.parse(raw['PROJECTION_2026_27.json'].toString('utf8'));
  const inputs = JSON.parse(raw['scripts/data/projection/inputs.json'].toString('utf8'));
  const roster = raw[OPTIONAL_ROSTER] ? JSON.parse(raw[OPTIONAL_ROSTER].toString('utf8')) : null;
  const effectiveRoster = roster || inputs.rosters2627;
  const rosterHash = sha256(JSON.stringify(effectiveRoster));
  if (data.projectionMeta?.rosterSha256 && data.projectionMeta.rosterSha256 !== rosterHash) {
    throw new Error(`roster hash mismatch: release has ${data.projectionMeta.rosterSha256}, ref bytes imply ${rosterHash}`);
  }
  const sources = Object.fromEntries([...REQUIRED, OPTIONAL_ROSTER].map(p => [p, raw[p] ? { present:true, sha256:sha256(raw[p]) } : { present:false, sha256:null }]));
  const archive = buildArchive({ data, card, rawInputs: raw['scripts/data/projection/inputs.json'], roster, sourceCommit: resolved.sha,
    publishedAt, publicationBasis:'verified-release-date', forecastId, sources });
  archive.sourceCommitTime = resolved.committedAt;
  if (dryRun) return { archive, written: null };
  return { archive, written: writeArchiveFiles(outDir, archive) };
}

function args(argv) {
  const out = {};
  for (let i=0;i<argv.length;i++) {
    const a=argv[i];
    if (a==='--dry-run') out.dryRun=true;
    else if (a==='--ref') out.ref=argv[++i];
    else if (a==='--id') out.forecastId=argv[++i];
    else if (a==='--published-at') out.publishedAt=argv[++i];
    else if (a==='--out-dir') out.outDir=argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = captureForecast(args(process.argv.slice(2)));
  console.log(result.written ? `archived ${result.archive.forecastId} -> ${result.written.file}` : JSON.stringify(result.archive, null, 1));
}

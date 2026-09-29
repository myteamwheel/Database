import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreArchive } from './lib/forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ARCHIVE_DIR = path.join(ROOT, 'scripts/data/forecast-archive');

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSort(value[key])]));
}

export function resolveArchivePath(value, archiveDir = DEFAULT_ARCHIVE_DIR) {
  if (!value) throw new Error('Scoring requires --archive <path-or-id>.');
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;

  const manifestPath = path.join(archiveDir, 'index.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Forecast archive manifest not found at ${manifestPath}.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest?.forecasts?.find((item) => item.forecastId === value);
  if (!entry) throw new Error(`Forecast archive id ${value} was not found.`);
  const resolved = path.join(archiveDir, entry.path);
  if (!fs.existsSync(resolved)) throw new Error(`Forecast archive file for ${value} is missing: ${resolved}`);
  return resolved;
}

export function scoreForecastFile({ archive, actual, interim = false, out = null, archiveDir = DEFAULT_ARCHIVE_DIR }) {
  if (!actual) throw new Error('Scoring requires --actual <path>.');
  const archivePath = resolveArchivePath(archive, archiveDir);
  const actualPath = path.resolve(actual);
  if (!fs.existsSync(actualPath)) throw new Error(`Actual-results file not found: ${actualPath}`);

  const forecast = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const actuals = JSON.parse(fs.readFileSync(actualPath, 'utf8'));
  const report = deepSort(scoreArchive(forecast, actuals, { interim }));
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (out) {
    fs.writeFileSync(path.resolve(out), bytes);
    return { report, outputPath: path.resolve(out), bytes };
  }
  return { report, outputPath: null, bytes };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--archive') args.archive = argv[++i];
    else if (token === '--actual') args.actual = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--archive-dir') args.archiveDir = argv[++i];
    else if (token === '--interim') args.interim = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = scoreForecastFile(parseArgs(process.argv.slice(2)));
    if (!result.outputPath) process.stdout.write(result.bytes);
    else console.log(`forecast score report written: ${result.outputPath}`);
  } catch (err) {
    console.error(err?.stack || err);
    process.exit(1);
  }
}

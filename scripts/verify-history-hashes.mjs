// Prove the local history cache matches what provenance recorded. This is what makes it safe to
// treat raw history as a re-fetchable cache rather than tracked source: the hashes are in git
// even when the payload is not.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const provPath = path.join(HIST, 'provenance.json');
if (!fs.existsSync(provPath)) {
  console.log('No history cache present. Run: npm run fetch:history');
  process.exit(0);
}
const prov = JSON.parse(fs.readFileSync(provPath, 'utf8'));
const fileFor = (ds) => {
  const [season, kind] = [ds.dataset.split('/')[0], ds.dataset];
  if (kind.endsWith('starter_splits')) return path.join(HIST, season, 'starter_splits.json');
  return path.join(HIST, season, kind.includes('Playoffs') ? 'gamelog_playoffs.json' : 'gamelog.json');
};
let ok = 0, missing = 0, mismatch = 0;
for (const ds of prov.datasets) {
  const f = fileFor(ds);
  if (!fs.existsSync(f)) { missing++; continue; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  if (h === ds.sha256) ok++; else { mismatch++; console.log(`  MISMATCH ${ds.dataset}: recorded ${ds.sha256}, found ${h}`); }
}
console.log(`history cache: ${ok} verified · ${missing} missing · ${mismatch} mismatched (of ${prov.datasets.length})`);
if (mismatch) { console.error('Cache does not match recorded provenance.'); process.exit(1); }
if (missing) console.log('Missing files can be restored with: npm run fetch:history');

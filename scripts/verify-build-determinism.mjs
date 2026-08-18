// Verify that the committed-source browser build is byte-for-byte reproducible when its explicit
// provenance inputs are held constant. The check snapshots the current artifacts, builds twice,
// compares SHA-256 digests, and restores the caller's files so verification has no side effects.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'scripts/data/history/player_history_product.json',
  'public/history-games.json.gz',
  'public/data.json',
  'public/standalone.html',
];
const originals = new Map(targets.map((rel) => {
  const f = path.join(ROOT, rel);
  return [rel, fs.existsSync(f) ? fs.readFileSync(f) : null];
}));
const env = {
  ...process.env,
  BUILD_GENERATED_AT: process.env.BUILD_GENERATED_AT || '2000-01-01T00:00:00Z',
  BUILD_COMMIT: process.env.BUILD_COMMIT || 'determinism-check',
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(script) {
  execFileSync(process.execPath, [script], { cwd: ROOT, env, stdio: 'pipe' });
}
function buildAndHash() {
  run('scripts/build-history-summary.mjs');
  run('scripts/build-history-games.mjs');
  run('scripts/build-v3.mjs');
  run('scripts/build-artifact.mjs');
  return Object.fromEntries(targets.map((rel) => [rel, sha(fs.readFileSync(path.join(ROOT, rel)))]));
}
function restore() {
  for (const [rel, buf] of originals) {
    const f = path.join(ROOT, rel);
    if (buf === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, buf);
  }
}

try {
  const first = buildAndHash();
  const second = buildAndHash();
  const mismatches = targets.filter((rel) => first[rel] !== second[rel]);
  console.log(`determinism inputs: generatedAt=${env.BUILD_GENERATED_AT} buildCommit=${env.BUILD_COMMIT}`);
  for (const rel of targets) console.log(`${first[rel]}  ${rel}`);
  if (mismatches.length) {
    console.error(`NON-DETERMINISTIC: ${mismatches.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`DETERMINISTIC_OK · ${targets.length} artifacts identical across two complete builds`);
  }
} finally {
  restore();
}

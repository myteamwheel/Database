import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_BASELINE_REF,
  HISTORY_CACHE_REF,
  candidateStages,
  validateCandidatePlan,
  classifyWorkingTree,
  candidateBuildEnvironment,
} from './lib/candidate-verification.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    baselineRef: CANDIDATE_BASELINE_REF,
    archiveBaseRef: process.env.CANDIDATE_ARCHIVE_BASE_REF || null,
    report: 'candidate-verification.json',
    materialReport: 'candidate-material-changes.json',
    requireCleanGenerated: false,
    plan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline-ref') out.baselineRef = argv[++i];
    else if (a === '--archive-base-ref') out.archiveBaseRef = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--material-report') out.materialReport = argv[++i];
    else if (a === '--require-clean-generated') out.requireCleanGenerated = true;
    else if (a === '--plan') out.plan = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function run(command, args, { env = process.env, stdio = 'inherit', maxBuffer = 256 * 1024 * 1024 } = {}) {
  return spawnSync(command, args, { cwd: ROOT, env, stdio, maxBuffer });
}

function text(command, args) {
  const r = run(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${String(r.stderr || '').trim()}`);
  return String(r.stdout || '').trim();
}

function gitObjectExists(ref) {
  const r = run('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
  return r.status === 0;
}

function parseStatusPaths(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    // Porcelain v1: XY<space>path; rename/copy uses old -> new. Audit the destination path.
    const body = line.slice(3).trim();
    return body.includes(' -> ') ? body.split(' -> ').at(-1) : body;
  });
}

function restoreTrackedFile(file, backup) {
  if (backup === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, backup);
}

const args = parseArgs(process.argv.slice(2));
const previewArchiveRef = args.archiveBaseRef || '<explicit-archive-base-ref-required>';
const preview = candidateStages({ archiveBaseRef: previewArchiveRef, baselinePath: '<baseline-data.json>', materialReportPath: args.materialReport });
validateCandidatePlan(preview);
if (args.plan) {
  console.log(JSON.stringify({ baselineRef: args.baselineRef, archiveBaseRef: previewArchiveRef, stages: preview }, null, 2));
  process.exit(0);
}
if (!args.archiveBaseRef) throw new Error('--archive-base-ref is required for release verification');

const startedAt = new Date().toISOString();
const headBefore = text('git', ['rev-parse', 'HEAD']);
const committedArtifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
if (!gitObjectExists(args.baselineRef)) throw new Error(`published baseline ref is unavailable locally: ${args.baselineRef}`);
if (!gitObjectExists(HISTORY_CACHE_REF)) throw new Error(`immutable history cache ref is unavailable locally: ${HISTORY_CACHE_REF}`);
if (!gitObjectExists(args.archiveBaseRef)) throw new Error(`archive base ref is unavailable locally: ${args.archiveBaseRef}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-verification-'));
const baselinePath = path.join(temp, 'published-data.json');
const provenancePath = path.join(ROOT, 'scripts/data/history/provenance.json');
const provenanceBackup = fs.existsSync(provenancePath) ? fs.readFileSync(provenancePath) : null;
let fatalFailed = false;
const stageResults = [];
let materialSummary = null;
let workingTree = null;
let headAfter = null;
let overallOk = false;

try {
  const baseline = run('git', ['show', `${args.baselineRef}:public/data.json`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (baseline.status !== 0) throw new Error(`cannot read published baseline public/data.json from ${args.baselineRef}`);
  fs.writeFileSync(baselinePath, baseline.stdout);

  const stages = candidateStages({ archiveBaseRef: args.archiveBaseRef, baselinePath, materialReportPath: args.materialReport });
  validateCandidatePlan(stages);
  const reproducible = candidateBuildEnvironment(committedArtifact, process.env, {
    generatedAt: text('git', ['show', '-s', '--format=%cI', 'HEAD']),
    commit: headBefore,
  });
  const env = { ...process.env, ...reproducible };

  for (const stage of stages) {
    if (fatalFailed) {
      stageResults.push({ id: stage.id, category: stage.category, status: 'skipped-after-fatal', exitCode: null, durationMs: 0 });
      continue;
    }
    console.log(`\n==> ${stage.id} [${stage.category}]`);
    const t0 = Date.now();
    const result = run(stage.command, stage.args, { env });
    const ok = result.status === 0;
    stageResults.push({ id: stage.id, category: stage.category, status: ok ? 'passed' : 'failed', exitCode: result.status ?? 1, durationMs: Date.now() - t0 });
    if (!ok && stage.fatal) fatalFailed = true;
  }

  // The immutable history hydrate intentionally replaces a tracked provenance file in some trees.
  // Restore the caller's exact version before judging whether verification mutated source code.
  restoreTrackedFile(provenancePath, provenanceBackup);

  if (fs.existsSync(args.materialReport)) {
    try {
      const m = JSON.parse(fs.readFileSync(args.materialReport, 'utf8'));
      materialSummary = {
        material: m.material ?? m.summary?.materialChanges ?? null,
        explained: m.explained ?? m.summary?.explained ?? null,
        legacyTraceLimited: m.legacyTraceLimited ?? m.summary?.legacyTraceLimited ?? null,
        unexplained: m.unexplained ?? m.summary?.unexplained ?? null,
      };
    } catch (e) {
      materialSummary = { parseError: e.message };
    }
  }

  headAfter = text('git', ['rev-parse', 'HEAD']);
  const statusResult = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (statusResult.status !== 0) throw new Error(`git status failed: ${String(statusResult.stderr || '').trim()}`);
  const statusRaw = String(statusResult.stdout || '').replace(/\n$/, '');
  const statusPaths = parseStatusPaths(statusRaw);
  const reportRel = path.relative(ROOT, path.resolve(ROOT, args.report)).replaceAll('\\', '/');
  const materialRel = path.relative(ROOT, path.resolve(ROOT, args.materialReport)).replaceAll('\\', '/');
  workingTree = classifyWorkingTree(statusPaths, { reportPaths: [reportRel, materialRel] });

  const failedStages = stageResults.filter((s) => s.status === 'failed');
  const skippedStages = stageResults.filter((s) => s.status.startsWith('skipped'));
  const headStable = headBefore === headAfter;
  const sourceClean = workingTree.unexpected.length === 0;
  const generatedClean = workingTree.generated.length === 0;
  overallOk = failedStages.length === 0 && skippedStages.length === 0 && headStable && sourceClean
    && (!args.requireCleanGenerated || generatedClean);

  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    baselineRef: args.baselineRef,
    archiveBaseRef: args.archiveBaseRef,
    historyCacheRef: HISTORY_CACHE_REF,
    headBefore,
    headAfter,
    headStable,
    requireCleanGenerated: args.requireCleanGenerated,
    workingTree,
    materialSummary,
    stages: stageResults,
    summary: {
      passed: stageResults.filter((s) => s.status === 'passed').length,
      failed: failedStages.length,
      skipped: skippedStages.length,
      sourceClean,
      generatedClean,
      overallOk,
    },
  };
  fs.writeFileSync(path.resolve(ROOT, args.report), JSON.stringify(report, null, 2) + '\n');
  console.log(`\nCandidate verification: ${overallOk ? 'PASS' : 'FAIL'} · ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped`);
  if (workingTree.unexpected.length) console.error(`unexpected tracked/untracked changes: ${workingTree.unexpected.join(', ')}`);
  if (args.requireCleanGenerated && workingTree.generated.length) console.error(`generated artifacts differ from HEAD: ${workingTree.generated.join(', ')}`);
} finally {
  restoreTrackedFile(provenancePath, provenanceBackup);
  fs.rmSync(temp, { recursive: true, force: true });
}

process.exit(overallOk ? 0 : 1);

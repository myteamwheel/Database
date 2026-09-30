import assert from 'node:assert/strict';
import {
  CANDIDATE_BASELINE_REF,
  HISTORY_CACHE_REF,
  REQUIRED_CATEGORIES,
  candidateStages,
  validateCandidatePlan,
  classifyWorkingTree,
  candidateBuildEnvironment,
} from '../scripts/lib/candidate-verification.mjs';

const stages = candidateStages({
  archiveBaseRef: 'abc123',
  baselinePath: '/tmp/published-data.json',
  materialReportPath: '/tmp/material-report.json',
});
assert.equal(validateCandidatePlan(stages), true);
assert.match(CANDIDATE_BASELINE_REF, /^[0-9a-f]{40}$/);
assert.match(HISTORY_CACHE_REF, /^[0-9a-f]{40}$/);
assert.deepEqual(new Set(stages.map((x) => x.category)), new Set(REQUIRED_CATEGORIES));

const byId = Object.fromEntries(stages.map((x) => [x.id, x]));
assert.equal(byId['build-candidate'].fatal, true);
assert.deepEqual(byId['forecast-archive-immutability'].args.slice(-2), ['--base-ref', 'abc123']);
assert.ok(byId['material-change-release-report'].args.includes('/tmp/published-data.json'));
assert.ok(byId['material-change-release-report'].args.includes('/tmp/material-report.json'));
assert.equal(byId['browser-regression'].args[1], 'test:browser');
assert.ok(stages.some((x) => x.id === 'ui-data-contract'));
assert.ok(stages.some((x) => x.id === 'refresh-failure-tests'));
assert.ok(stages.some((x) => x.id === 'artifact-lossless'));
assert.ok(stages.some((x) => x.id === 'build-determinism'));
assert.ok(stages.some((x) => x.id === 'review-regressions'));

for (const stage of stages) {
  const flat = [stage.command, ...stage.args].join(' ');
  assert.doesNotMatch(flat, /\bnpm\s+run\s+(fetch|refresh|refresh:owner)\b/,
    `${stage.id} unexpectedly performs live ingestion`);
}

assert.throws(() => candidateStages({ archiveBaseRef: '', baselinePath: 'a', materialReportPath: 'b' }), /archive base ref/i);
assert.throws(() => validateCandidatePlan(stages.filter((x) => x.category !== 'browser')), /missing categories: browser/i);
assert.throws(() => validateCandidatePlan([...stages, stages[0]]), /duplicate candidate stage id/i);

assert.deepEqual(classifyWorkingTree([
  'public/data.json',
  'public/data-status.json',
  'candidate-verification.json',
  'scripts/lib/projection.mjs',
], { reportPaths: ['candidate-verification.json'] }), {
  generated: ['public/data.json', 'public/data-status.json'],
  unexpected: ['scripts/lib/projection.mjs'],
  ephemeral: ['candidate-verification.json'],
});

const committedBuild = {
  provenance: {
    generatedAt: '2026-09-27T12:00:00.000Z',
    buildCommit: '1'.repeat(40),
  },
};
assert.deepEqual(candidateBuildEnvironment(committedBuild, {}, {
  generatedAt: '2026-09-30T12:00:00.000Z',
  commit: '2'.repeat(40),
}), {
  BUILD_GENERATED_AT: committedBuild.provenance.generatedAt,
  BUILD_COMMIT: committedBuild.provenance.buildCommit,
}, 'candidate rebuilds must preserve committed artifact provenance instead of writing a self-referential HEAD');
assert.deepEqual(candidateBuildEnvironment(committedBuild, {
  BUILD_GENERATED_AT: '2026-09-29T10:30:00.000Z',
  BUILD_COMMIT: '3'.repeat(40),
}), {
  BUILD_GENERATED_AT: '2026-09-29T10:30:00.000Z',
  BUILD_COMMIT: '3'.repeat(40),
}, 'explicit release provenance overrides remain supported');
assert.equal(candidateBuildEnvironment({ provenance: {
  generatedAt: '2026-09-27T12:00:00.000Z', buildCommit: '869ab3c',
} }).BUILD_COMMIT, '869ab3c', 'existing published artifacts may carry Git short-SHA provenance');
assert.throws(() => candidateBuildEnvironment({}, {}, { generatedAt: 'invalid', commit: 'short' }), /timestamp/i);

console.log(`candidate verification plan tests passed: ${stages.length} stages across ${REQUIRED_CATEGORIES.length} required categories`);

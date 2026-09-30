export const CANDIDATE_BASELINE_REF = 'e7182849d62cba46566f3ffafc4c1e620e5ef8ff';
export const HISTORY_CACHE_REF = 'c17bc8d7cf2e41822a8bcf6fbf4b0b62bca095ee';

export const ALLOWED_GENERATED_PATHS = new Set([
  'scripts/data/history/player_history_product.json',
  'public/history-games.json.gz',
  'public/history-role-features.json.gz',
  'public/data.json',
  'public/data-status.json',
  'public/standalone.html',
]);

export const REQUIRED_CATEGORIES = [
  'history',
  'build',
  'accounting',
  'source-failure',
  'projection',
  'archive',
  'comparison',
  'tulip',
  'consistency',
  'artifact',
  'material-change',
  'syntax',
  'browser',
];

const npm = (id, category, script, extra = [], options = {}) => ({
  id,
  category,
  command: 'npm',
  args: ['run', script, ...(extra.length ? ['--', ...extra] : [])],
  ...options,
});

/**
 * Release-candidate verification plan. It intentionally performs no live ingestion: source-failure
 * behavior is tested against fixtures, while the candidate itself is built only from committed
 * snapshots plus the immutable historical cache pinned below.
 */
export function candidateStages({ archiveBaseRef, baselinePath, materialReportPath }) {
  if (!archiveBaseRef) throw new Error('candidate verification requires an explicit archive base ref');
  if (!baselinePath || !materialReportPath) throw new Error('candidate verification requires material-change paths');

  return [
    {
      id: 'hydrate-history', category: 'history', command: 'bash', fatal: true,
      args: ['-lc', `set -euo pipefail; git archive ${HISTORY_CACHE_REF} scripts/data/history/provenance.json scripts/data/history/2015-16 scripts/data/history/2016-17 scripts/data/history/2017-18 scripts/data/history/2018-19 scripts/data/history/2019-20 scripts/data/history/2020-21 scripts/data/history/2021-22 scripts/data/history/2022-23 scripts/data/history/2023-24 scripts/data/history/2024-25 | tar -x`],
    },
    npm('build-history', 'history', 'build:history', [], { fatal: true }),
    npm('audit-history-strict', 'history', 'audit:history', ['--strict']),
    npm('verify-history-strict', 'history', 'verify:history', ['--strict']),

    npm('build-candidate', 'build', 'build', [], { fatal: true }),

    npm('audit-data', 'accounting', 'audit'),
    npm('ui-data-contract', 'accounting', 'verify:ui-data-contract'),
    npm('review-regressions', 'accounting', 'test:review'),
    npm('projection-sensitivity', 'projection', 'test:projection-sensitivity'),
    npm('projection-context-evaluation', 'projection', 'evaluate:projection-context'),
    npm('projection-frozen-tests', 'projection', 'test:projections'),

    npm('forecast-archive-tests', 'archive', 'test:forecast-archive'),
    npm('forecast-archive-immutability', 'archive', 'verify:forecast-archive', ['--base-ref', archiveBaseRef]),

    npm('comparison-tests', 'comparison', 'test:comps'),

    npm('tulip-beta-tests', 'tulip', 'test:tulipbeta'),
    npm('tulip-beta-diagnostics', 'tulip', 'test:tulipbeta:diagnostics'),
    npm('projected-role-tests', 'tulip', 'test:tulipcapacity'),
    npm('tulip-metadata-verify', 'tulip', 'tulip:verify'),
    npm('tulip-backtest', 'tulip', 'tulip:backtest'),

    npm('refresh-failure-tests', 'source-failure', 'test:refresh'),
    npm('publication-contract-tests', 'source-failure', 'test:publication'),
    { id: 'evidence-claim-tests', category: 'source-failure', command: 'node', args: ['tests/evidence-claims.test.mjs'] },
    npm('owner-refresh-failure-tests', 'source-failure', 'test:owner-refresh'),
    npm('publication-verify', 'source-failure', 'verify:publication'),

    npm('preset-audit', 'consistency', 'audit:presets'),
    npm('cross-tab-audit', 'consistency', 'audit:cross-tabs'),
    npm('history-product-tests', 'consistency', 'test:history'),
    npm('starter-invariants', 'consistency', 'test:starter'),

    npm('artifact-lossless', 'artifact', 'verify:artifact'),
    npm('build-determinism', 'artifact', 'verify:determinism'),

    npm('material-change-unit-tests', 'material-change', 'test:material-changes'),
    npm('material-change-release-report', 'material-change', 'explain:material-changes', [
      '--before', baselinePath,
      '--after', 'public/data.json',
      '--out', materialReportPath,
    ]),

    {
      id: 'javascript-syntax', category: 'syntax', command: 'bash',
      args: ['-lc', 'set -euo pipefail; node --check app.js; node --check workspace.js; node --check history-lab.js; for f in scripts/*.mjs scripts/lib/*.mjs tests/*.mjs; do node --check "$f"; done'],
    },
    npm('browser-regression', 'browser', 'test:browser'),
  ];
}

export function validateCandidatePlan(stages) {
  if (!Array.isArray(stages) || !stages.length) throw new Error('candidate stage plan is empty');
  const ids = new Set();
  const categories = new Set();
  for (const stage of stages) {
    if (!stage?.id || !stage?.category || !stage?.command || !Array.isArray(stage.args)) {
      throw new Error('candidate stage is malformed');
    }
    if (ids.has(stage.id)) throw new Error(`duplicate candidate stage id: ${stage.id}`);
    ids.add(stage.id);
    categories.add(stage.category);
    const flat = [stage.command, ...stage.args].join(' ');
    if (/\bnpm\s+run\s+(fetch|refresh|refresh:owner)\b/.test(flat)) {
      throw new Error(`candidate verification must not ingest live sources: ${stage.id}`);
    }
  }
  const missingCategories = REQUIRED_CATEGORIES.filter((x) => !categories.has(x));
  if (missingCategories.length) throw new Error(`candidate plan missing categories: ${missingCategories.join(', ')}`);
  for (const id of [
    'build-candidate', 'ui-data-contract', 'review-regressions', 'refresh-failure-tests', 'projection-frozen-tests',
    'forecast-archive-immutability', 'artifact-lossless', 'build-determinism',
    'material-change-release-report', 'browser-regression',
  ]) {
    if (!ids.has(id)) throw new Error(`candidate plan missing required stage: ${id}`);
  }
  return true;
}

export function classifyWorkingTree(paths, { reportPaths = [] } = {}) {
  const reports = new Set(reportPaths.filter(Boolean));
  const generated = [], unexpected = [], ephemeral = [];
  for (const path of paths) {
    if (reports.has(path)) ephemeral.push(path);
    else if (ALLOWED_GENERATED_PATHS.has(path)) generated.push(path);
    else unexpected.push(path);
  }
  return { generated, unexpected, ephemeral };
}

export function candidateBuildEnvironment(committedArtifact, env = {}, fallback = {}) {
  const generatedAt = env.BUILD_GENERATED_AT || committedArtifact?.provenance?.generatedAt || fallback.generatedAt;
  const commit = env.BUILD_COMMIT || committedArtifact?.provenance?.buildCommit
    || committedArtifact?.provenance?.commit || fallback.commit;
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('candidate build requires a valid reproducible generation timestamp');
  }
  if (!commit || !/^[0-9a-f]{7,40}$/i.test(String(commit))) {
    throw new Error('candidate build requires a reproducible source commit');
  }
  return { BUILD_GENERATED_AT: generatedAt, BUILD_COMMIT: commit };
}

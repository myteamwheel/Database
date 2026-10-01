import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveEvidenceClaims, validateEvidenceClaims } from './evidence-claims.mjs';
import { verifyTransactionSnapshot } from './transactions.mjs';
import {modelDependencyClosure} from './model-dependencies.mjs';
export { deriveEvidenceClaims, validateEvidenceClaims } from './evidence-claims.mjs';

export const COVERAGE_STATES = Object.freeze(['complete','partial','fallback','unavailable']);
export const DEPENDENCY_AUDIT_FILES = Object.freeze(['scripts/lib/model-dependencies.mjs','scripts/model-code-dependencies.mjs']);
const COVERAGE_SET = new Set(COVERAGE_STATES);

export const MODEL_OUTPUTS = Object.freeze({
  performanceGrades: Object.freeze({
    label: 'Performance grades and custom metrics',
    codeFiles: ['scripts/lib/grades.mjs','scripts/lib/metrics.mjs','scripts/lib/sources.mjs','scripts/lib/roster.mjs','scripts/build-v3.mjs'],
    source: '2025-26 official NBA/G League stat snapshots with explicitly labeled Basketball-Reference second-source fields',
  }),
  projections: Object.freeze({
    label: '2026-27 player projections',
    codeFiles: ['scripts/lib/projection.mjs','scripts/lib/projection-context.mjs','scripts/lib/projection-validation.mjs','scripts/build-projections.mjs'],
    source: 'Frozen projection inputs/model card plus the published current-roster context',
  }),
  tulipEvidence: Object.freeze({
    label: 'TULIP role evidence',
    codeFiles: ['scripts/lib/tulip.mjs','scripts/lib/tulip-diagnostics.mjs','scripts/build-v3.mjs'],
    source: 'Published season/player history and current database rows; unavailable availability/transaction/lineup evidence stays unavailable',
  }),
  tulipBeta: Object.freeze({
    label: 'TULIP Beta recommended-minute allocator',
    codeFiles: ['scripts/lib/tulip-beta.mjs','scripts/lib/tulip-beta-diagnostics.mjs','scripts/build-v3.mjs'],
    source: '2025-26 player value/workload evidence grouped by the published 2026-27 roster snapshot',
  }),
  projectedRoleMpg: Object.freeze({
    label: 'Projected Role MPG',
    codeFiles: ['scripts/lib/tulip-capacity-v1.mjs','scripts/lib/tulip-capacity-build.mjs','scripts/build-v3.mjs'],
    source: 'Frozen historical offseason-move role model and its preserved/recomputed source cache, explicitly not a physical-capacity estimate',
  }),
  playerComparisons: Object.freeze({
    label: 'Historical player comparisons',
    codeFiles: ['scripts/lib/comparison-profiles.mjs','scripts/build-player-comps.mjs'],
    source: 'Same-league historical profiles, official combine measurements where present, and published player-season evidence',
  }),
  teamFit: Object.freeze({
    label: 'Skill profiles, similarity, archetypes and Team Fit',
    codeFiles: ['scripts/lib/analysis.mjs','scripts/lib/roster.mjs','scripts/lib/sources.mjs','scripts/build-v3.mjs'],
    source: 'Published same-league player rows and minutes-weighted roster need profiles',
  }),
  crossLeague: Object.freeze({
    label: 'G League/NBA readiness and translation models',
    codeFiles: ['scripts/lib/crossleague.mjs','scripts/build-crossleague.mjs'],
    source: 'Same-season dual-league player sample with explicitly reported sample thresholds and held-out limitations',
  }),
});
const MODEL_KEYS = Object.freeze(Object.keys(MODEL_OUTPUTS));


const REQUIRED_DOMAINS = [
  'officialStats',
  'rosterProjectionInputs',
  'transactions',
  'injuries',
  'news',
  'basketballReferenceSnapshot',
];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (p) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
const maxIso = (values) => values.filter(Boolean).sort().at(-1) || null;

function fileSha256(root, relativePath, { optional = false } = {}) {
  const full = path.join(root, relativePath);
  if (!fs.existsSync(full)) {
    if (optional) return null;
    throw new Error(`Model provenance code/input file is missing: ${relativePath}`);
  }
  return hash(fs.readFileSync(full));
}

function sourceManifestVersion(publicData) {
  const rows = Array.isArray(publicData?.provenance?.sources) ? publicData.provenance.sources : [];
  if (!rows.length) return null;
  const normalized = rows.map((row) => ({ file:String(row.file || ''), sha256:String(row.sha256 || '') }))
    .sort((a,b) => a.file.localeCompare(b.file));
  return hash(Buffer.from(JSON.stringify(normalized)));
}

function semanticModelVersion(key, publicData) {
  if (key === 'performanceGrades') {
    const embedded = publicData?.gradeModel?.version || null;
    const provenance = publicData?.provenance?.gradeModelVersion || null;
    if (embedded && provenance && embedded !== provenance) {
      throw new Error(`Grade model version mismatch: gradeModel=${embedded}, provenance=${provenance}.`);
    }
    return embedded || provenance;
  }
  if (key === 'projections') {
    const id = publicData?.projectionMeta?.id || null;
    const ctx = publicData?.projectionMeta?.contextVersion || null;
    return id && ctx ? `${id}+${ctx}` : id;
  }
  if (key === 'tulipEvidence') return publicData?.tulipMeta?.version || null;
  if (key === 'tulipBeta') return publicData?.tulipBetaMeta?.config?.version || null;
  if (key === 'projectedRoleMpg') return publicData?.tulipCapacityMeta?.version || null;
  if (key === 'playerComparisons') return publicData?.analysis?.playerCompsMeta?.version || null;
  return null;
}

function inputVersionFor(key, publicData, root, sourceManifestSha256) {
  const common = {
    season: publicData?.season || null,
    buildGeneratedAt: publicData?.generatedAt || null,
    sourceManifestSha256,
  };
  if (key === 'projections') return {
    ...common,
    modelCardSha256: fileSha256(root, 'PROJECTION_2026_27.json'),
    projectionInputsSha256: fileSha256(root, 'scripts/data/projection/inputs.json'),
    publishedInputsSha256: publicData?.projectionMeta?.inputsSha256 || null,
    rosterSha256: publicData?.projectionMeta?.rosterSha256 || null,
    rostersAsOf: publicData?.projectionMeta?.rostersAsOf || null,
  };
  if (key === 'tulipBeta') return {
    ...common,
    baselineSeason: publicData?.tulipBetaMeta?.baselineSeason || null,
    rostersAsOf: publicData?.tulipBetaMeta?.rostersAsOf || publicData?.projectionMeta?.rostersAsOf || null,
    rosterSha256: publicData?.projectionMeta?.rosterSha256 || null,
  };
  if (key === 'teamFit') return {
    ...common,
    rosterSha256: publicData?.projectionMeta?.rosterSha256 || null,
    rostersAsOf: publicData?.projectionMeta?.rostersAsOf || null,
  };
  if (key === 'projectedRoleMpg') return {
    ...common,
    cardSha256: publicData?.tulipCapacityMeta?.cardSha256 || null,
    frozenAt: publicData?.tulipCapacityMeta?.frozenAt || null,
    buildInputMode: publicData?.tulipCapacityMeta?.buildInputMode || null,
  };
  if (key === 'playerComparisons') return {
    ...common,
    nbaHistory: publicData?.analysis?.playerCompsMeta?.nbaHistory || null,
    gleagueHistory: publicData?.analysis?.playerCompsMeta?.gleagueHistory || null,
  };
  return common;
}

export function deriveModelProvenance({ root, publicData }) {
  if (!root || !publicData) throw new Error('Model provenance requires the repository root and public data.');
  const sourceManifestSha256 = sourceManifestVersion(publicData);
  const outputs = {};
  const closures=modelDependencyClosure(root,Object.fromEntries(MODEL_KEYS.map(key=>[key,MODEL_OUTPUTS[key].codeFiles])));
  for (const key of MODEL_KEYS) {
    const spec = MODEL_OUTPUTS[key];
    const codeFiles = closures[key].map((relativePath) => ({ path:relativePath, sha256:fileSha256(root, relativePath) }));
    const codeVersionSha256 = hash(Buffer.from(JSON.stringify(codeFiles.map((x) => [x.path,x.sha256]))));
    const semanticVersion = semanticModelVersion(key, publicData);
    outputs[key] = {
      label: spec.label,
      modelVersion: semanticVersion || `code-sha256:${codeVersionSha256}`,
      semanticVersion,
      codeVersionSha256,
      codeFiles,
      dependencyPolicy:'transitive-static-esm-v1',
      inputVersion: inputVersionFor(key, publicData, root, sourceManifestSha256),
      source: spec.source,
    };
  }
  return {
    schemaVersion: 1,
    buildCommit: publicData?.provenance?.buildCommit || null,
    sourceManifestSha256,
    dependencyAudit:{policy:'transitive-static-esm-v1',nodeMajor:process.versions.node.split('.')[0],codeFiles:DEPENDENCY_AUDIT_FILES.map(relativePath=>({path:relativePath,sha256:fileSha256(root,relativePath)}))},
    outputs,
  };
}

function validateModelProvenance(modelProvenance) {
  if (!modelProvenance || modelProvenance.schemaVersion !== 1) throw new Error('Publication model-provenance schema is invalid.');
  const audit=modelProvenance.dependencyAudit;
  if(audit?.policy!=='transitive-static-esm-v1'||!/^\d+$/.test(String(audit.nodeMajor))||Number(audit.nodeMajor)<20||!Array.isArray(audit.codeFiles)||audit.codeFiles.length!==DEPENDENCY_AUDIT_FILES.length||!DEPENDENCY_AUDIT_FILES.every(p=>audit.codeFiles.some(f=>f.path===p&&/^[0-9a-f]{64}$/.test(f.sha256))))throw new Error('Publication dependency audit provenance is incomplete.');
  if (modelProvenance.sourceManifestSha256 !== null
      && !/^[0-9a-f]{64}$/.test(String(modelProvenance.sourceManifestSha256))) {
    throw new Error('Publication model-provenance source-manifest version is invalid.');
  }
  const keys = Object.keys(modelProvenance.outputs || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...MODEL_KEYS].sort())) {
    throw new Error('Publication model-provenance output set is incomplete.');
  }
  for (const key of MODEL_KEYS) {
    const item = modelProvenance.outputs[key];
    if (!item?.label || !item?.modelVersion || !item?.source || !/^[0-9a-f]{64}$/.test(String(item.codeVersionSha256 || ''))) {
      throw new Error(`Publication model provenance is invalid for ${key}.`);
    }
    if (item.dependencyPolicy!=='transitive-static-esm-v1'||!Array.isArray(item.codeFiles) || new Set(item.codeFiles.map(f=>f.path)).size!==item.codeFiles.length || !MODEL_OUTPUTS[key].codeFiles.every(p=>item.codeFiles.some(f=>f.path===p))) {
      throw new Error(`Publication model provenance code files are incomplete for ${key}.`);
    }
    for (const file of item.codeFiles) {
      if (!file?.path || !/^[0-9a-f]{64}$/.test(String(file.sha256 || ''))) {
        throw new Error(`Publication model provenance code hash is invalid for ${key}.`);
      }
    }
    if (!item.inputVersion || typeof item.inputVersion !== 'object') {
      throw new Error(`Publication model provenance input version is missing for ${key}.`);
    }
  }
  return true;
}


function officialStatsDomain(root, publicData) {
  const dirs = ['official_nba','official_gleague_regular','official_gleague_showcase'];
  const manifests = dirs.map((dir) => ({
    dir,
    manifest: readJson(path.join(root, 'scripts/data', dir, '_refresh-manifest.json')),
  })).filter((x) => x.manifest);
  if (!manifests.length) {
    return {
      status: 'tracked-snapshot',
      checkedAt: null,
      fetchedAt: null,
      asOf: publicData?.season || null,
      manifests: 0,
      changeSummary: { added:0, removed:0, changed:0, retainedSources:0, unavailableSources:0 },
      limitation: 'Tracked official-stat files predate per-source refresh manifests; exact fetch time and row-level change history are unavailable.',
    };
  }
  const sources = manifests.flatMap(({dir, manifest}) => (manifest.sources || []).map((s) => ({...s, directory:dir})));
  const retained = sources.filter((s) => s.status === 'retained').length;
  const unavailable = sources.filter((s) => s.status === 'unavailable').length;
  const missingManifests = dirs.length - manifests.length;
  const incomplete = retained || unavailable || missingManifests || !sources.length;
  const sums = sources.reduce((acc, s) => {
    const d = s.changeSummary || {};
    acc.added += Number(d.added || 0);
    acc.removed += Number(d.removed || 0);
    acc.changed += Number(d.changed || 0);
    return acc;
  }, { added:0, removed:0, changed:0 });
  return {
    status: incomplete ? 'partial' : 'ok',
    checkedAt: maxIso(manifests.map((x) => x.manifest.checkedAt)),
    fetchedAt: maxIso(sources.map((s) => s.fetchedAt)),
    asOf: [...new Set(manifests.map((x) => x.manifest.season).filter(Boolean))].join(', ') || publicData?.season || null,
    manifests: manifests.length,
    missingManifests,
    sourceCount: sources.length,
    changeSummary: { ...sums, retainedSources: retained, unavailableSources: unavailable },
    limitation: incomplete
      ? 'Some league manifests or source data are missing, unavailable, or retained from an earlier snapshot. Timestamps show the most recent source, not freshness of every source.'
      : null,
  };
}

export function deriveSourceDomains({ root, publicData }) {
  const projection = readJson(path.join(root, 'scripts/data/projection/inputs.provenance.json'));
  const liveRoster = readJson(path.join(root, 'scripts/data/live/roster.json'));
  const liveRosterMatches = liveRoster?.fetchedAt &&
    String(liveRoster.fetchedAt).slice(0, 10) === publicData?.projectionMeta?.rostersAsOf;
  const bref = readJson(path.join(root, 'scripts/data/bref_build_v2.json'));
  const transactionFile = 'scripts/data/live/transactions.json';
  const transactionInput = readJson(path.join(root, transactionFile));
  const transactions = transactionInput ? verifyTransactionSnapshot(transactionInput) : null;
  if (transactions && (publicData?.transactionMeta?.sourceRawSha256 !== transactions.rawSha256 || publicData?.transactionMeta?.fetchedAt !== transactions.fetchedAt)) {
    throw new Error('Published transaction context is stale; rebuild before publication.');
  }
  return {
    officialStats: officialStatsDomain(root, publicData),
    rosterProjectionInputs: projection || liveRoster ? {
      status: liveRoster && !liveRosterMatches ? 'partial' : 'ok',
      checkedAt: liveRoster?.fetchedAt || projection?.fetchedAt || null,
      fetchedAt: liveRoster?.fetchedAt || projection?.fetchedAt || null,
      asOf: (liveRoster?.fetchedAt || projection?.fetchedAt || '').slice(0,10) || null,
      sha256: liveRoster ? fileSha256(root, 'scripts/data/live/roster.json') : projection?.sha256 || null,
      source: liveRoster?.source || 'frozen projection player index',
      projectionInputsSha256: projection?.sha256 || null,
      projectionInputsFetchedAt: projection?.fetchedAt || null,
      limitation: liveRoster && !liveRosterMatches
        ? 'The fetched roster does not match the roster date in the published projection; rebuild before publication.'
        : liveRoster ? 'Current roster context is newer than the frozen model-training inputs; training was not silently refitted.' : null,
    } : {
      status: 'unavailable', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'Projection/roster provenance file is unavailable.',
    },
    transactions: transactions ? {
      status:'tracked-snapshot', checkedAt:transactions.fetchedAt, fetchedAt:transactions.fetchedAt,
      asOf:transactions.summary.latestEventDate, source:transactions.source,
      sha256:fileSha256(root, transactionFile), ...transactions.summary,
      limitation:'Official transaction ledger through the stated event date. Draft-consideration events are not player signings. The current official roster index remains authoritative for roster membership; transaction text does not establish medical clearance or silently alter forecasts.',
    } : {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified transaction feed is configured. Roster snapshots are not presented as a transaction history.',
    },
    injuries: {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified injury/medical-status feed is configured. The model does not infer current clearance.',
    },
    news: {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified news ingestion is configured. Headlines do not silently alter forecasts.',
    },
    basketballReferenceSnapshot: bref ? {
      status:'snapshot',
      checkedAt: bref.generatedAt || bref.fetchedAt || bref.provenance?.generatedAt || null,
      fetchedAt: bref.generatedAt || bref.fetchedAt || bref.provenance?.generatedAt || null,
      asOf: publicData?.season || null,
      limitation:'Static second-source snapshot; it is not refreshed by the official-stats reload.',
    } : {
      status:'unavailable', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'Basketball-Reference snapshot metadata is unavailable.',
    },
  };
}

export function coverageStateForSource(domain) {
  const raw = domain?.status;
  if (raw === 'ok') return 'complete';
  if (raw === 'partial' || raw === 'retained' || raw === 'tracked-snapshot') return 'partial';
  if (raw === 'snapshot') return 'fallback';
  if (raw === 'unavailable' || raw === 'not-configured') return 'unavailable';
  throw new Error(`Unknown source-domain status for coverage classification: ${raw || 'missing'}.`);
}

function countStates(states) {
  const counts = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0]));
  for (const state of states) {
    if (!COVERAGE_SET.has(state)) throw new Error(`Invalid coverage state: ${state}`);
    counts[state]++;
  }
  return counts;
}

function aggregateState(counts, total) {
  if (!total || counts.unavailable === total) return 'unavailable';
  if (counts.partial > 0 || counts.unavailable > 0) return 'partial';
  if (counts.fallback === total) return 'fallback';
  if (counts.fallback > 0) return 'partial';
  return 'complete';
}

function seasonDataState(row) {
  if (row?.appeared === true && Number(row?.gp) > 0 && Number.isFinite(Number(row?.minutes)) && Number(row?.minutes) >= 0) return 'complete';
  if (row?.currentRoster === true || row?.appeared === false) return 'partial';
  return 'unavailable';
}

function projectionState(row) {
  const projection = row?.proj;
  if (!projection || projection.abstain) return 'unavailable';
  const basis = String(projection.basis || '');
  if (/fallback/i.test(basis) || projection?.why?.fallback || projection?.why?.rookie) return 'fallback';
  return 'complete';
}

function summarizePlayerCoverage(rows, classifier) {
  const states = rows.map(classifier);
  const counts = countStates(states);
  return { state: aggregateState(counts, rows.length), counts };
}

function combineCoverageStates(states) {
  const counts = countStates(states);
  return aggregateState(counts, states.length);
}

export function deriveCoverageStates({ publicData, sourceDomains }) {
  if (!sourceDomains || REQUIRED_DOMAINS.some((key) => !sourceDomains[key])) {
    throw new Error('Coverage derivation requires every publication source domain.');
  }
  const sources = Object.fromEntries(REQUIRED_DOMAINS.map((key) => [key, {
    state: coverageStateForSource(sourceDomains[key]),
    rawStatus: sourceDomains[key].status,
  }]));
  const leagues = {};
  for (const league of ['NBA','GLEAGUE']) {
    const rows = Array.isArray(publicData?.leagues?.[league]) ? publicData.leagues[league] : [];
    const seasonData = summarizePlayerCoverage(rows, seasonDataState);
    const projections = summarizePlayerCoverage(rows, projectionState);
    leagues[league] = {
      state: combineCoverageStates([seasonData.state, projections.state]),
      rows: rows.length,
      seasonData,
      projections,
    };
  }
  return {
    schemaVersion: 1,
    allowedStates: [...COVERAGE_STATES],
    sourceDomains: sources,
    leagues,
  };
}

function validateCoverageStates(coverage, sourceDomains = null) {
  if (!coverage || coverage.schemaVersion !== 1) throw new Error('Publication coverage-state schema is invalid.');
  if (JSON.stringify(coverage.allowedStates) !== JSON.stringify(COVERAGE_STATES)) {
    throw new Error('Publication coverage-state vocabulary is invalid.');
  }
  for (const key of REQUIRED_DOMAINS) {
    const entry = coverage.sourceDomains?.[key];
    if (!entry || !COVERAGE_SET.has(entry.state) || !entry.rawStatus) {
      throw new Error(`Publication source coverage is invalid for ${key}.`);
    }
    if (sourceDomains && (entry.rawStatus !== sourceDomains[key]?.status
        || entry.state !== coverageStateForSource(sourceDomains[key]))) {
      throw new Error(`Publication source coverage does not match raw status for ${key}.`);
    }
  }
  for (const league of ['NBA','GLEAGUE']) {
    const entry = coverage.leagues?.[league];
    if (!entry || !COVERAGE_SET.has(entry.state) || !Number.isInteger(entry.rows) || entry.rows < 0) {
      throw new Error(`Publication league coverage is invalid for ${league}.`);
    }
    for (const key of ['seasonData','projections']) {
      const detail = entry[key];
      if (!detail || !COVERAGE_SET.has(detail.state)) throw new Error(`Publication ${league} ${key} coverage is invalid.`);
      const total = COVERAGE_STATES.reduce((sum, state) => {
        const value = detail.counts?.[state];
        if (!Number.isInteger(value) || value < 0) throw new Error(`Publication ${league} ${key} coverage count is invalid.`);
        return sum + value;
      }, 0);
      if (total !== entry.rows) throw new Error(`Publication ${league} ${key} coverage counts do not match row count.`);
    }
  }
  return true;
}

export function validatePublicationStatus(status, { publicData = null, publicDataBytes = null, root = null } = {}) {
  if (!status || status.schemaVersion !== 1 || !status.publicationId || !status.season || !status.publishedAt) {
    throw new Error('Publication status schema is invalid.');
  }
  if (Number.isNaN(Date.parse(status.publishedAt))) throw new Error('Publication timestamp is invalid.');
  if (!/^[0-9a-f]{64}$/.test(String(status.dataSha256 || ''))) throw new Error('Publication data SHA256/hash is invalid.');
  if (!status.sourceDomains || REQUIRED_DOMAINS.some((key) => !status.sourceDomains[key])) {
    throw new Error('Publication source-domain status is incomplete.');
  }
  validateCoverageStates(status.coverage, status.sourceDomains);
  validateModelProvenance(status.modelProvenance);
  validateEvidenceClaims(status.evidenceClaims, status.modelProvenance);
  if (publicData && status.season !== publicData.season) throw new Error('Publication season does not match public data season.');
  if (publicData) {
    const expectedCoverage = deriveCoverageStates({ publicData, sourceDomains: status.sourceDomains });
    if (JSON.stringify(status.coverage) !== JSON.stringify(expectedCoverage)) {
      throw new Error('Publication coverage states are stale relative to public data/source domains.');
    }
    const expectedEvidenceClaims = deriveEvidenceClaims({ publicData, modelProvenance: status.modelProvenance });
    if (JSON.stringify(status.evidenceClaims) !== JSON.stringify(expectedEvidenceClaims)) {
      throw new Error('Publication evidence claims are stale relative to public data/model provenance.');
    }
  }
  if (publicData && root) {
    const expectedModelProvenance = deriveModelProvenance({ root, publicData });
    if (JSON.stringify(status.modelProvenance) !== JSON.stringify(expectedModelProvenance)) {
      throw new Error('Publication model provenance is stale relative to implementation/input files.');
    }
  }
  if (publicDataBytes && status.dataSha256 !== hash(publicDataBytes)) throw new Error('Publication data hash/SHA256 does not match public data.');
  return true;
}

export function buildPublicationStatus({ publicData, publicDataBytes, sourceDomains, modelProvenance, previousStatus = null, publishedAt }) {
  if (!publicData || !publicDataBytes || !sourceDomains || !modelProvenance) throw new Error('Publication requires public data bytes, source domains and model provenance.');
  const dataSha256 = hash(publicDataBytes);
  const publicationId = `${publicData.season}-${String(publishedAt).replace(/[^0-9]/g,'').slice(0,14)}-${dataSha256.slice(0,12)}`;
  const officialChanges = sourceDomains.officialStats?.changeSummary || { added:0,removed:0,changed:0,retainedSources:0,unavailableSources:0 };
  const evidenceClaims = deriveEvidenceClaims({ publicData, modelProvenance });
  const status = {
    schemaVersion: 1,
    publicationId,
    season: publicData.season,
    publishedAt,
    buildGeneratedAt: publicData.generatedAt || null,
    dataSha256,
    previousSuccessfulPublication: previousStatus?.publicationId && previousStatus.publicationId !== publicationId ? {
      publicationId: previousStatus.publicationId,
      publishedAt: previousStatus.publishedAt,
      dataSha256: previousStatus.dataSha256,
    } : (previousStatus?.publicationId === publicationId ? previousStatus.previousSuccessfulPublication || null : null),
    sourceDomains,
    coverage: deriveCoverageStates({ publicData, sourceDomains }),
    modelProvenance,
    evidenceClaims,
    changes: { officialStats: officialChanges },
    forecastAdjustmentPolicy: {
      transactions:'not-applied-unless-verified-structured-input',
      injuries:'not-applied-unless-verified-structured-input',
      news:'not-applied-unless-verified-structured-input',
      note:'Unconfigured or ambiguous external information does not silently rewrite forecasts.',
    },
  };
  validatePublicationStatus(status, { publicData, publicDataBytes });
  return status;
}

export function writePublicationStatus({ outputPath, status }) {
  validatePublicationStatus(status);
  fs.mkdirSync(path.dirname(outputPath), { recursive:true });
  const temp = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(status, null, 2) + '\n');
    fs.renameSync(temp, outputPath);
  } finally {
    fs.rmSync(temp, { force:true });
  }
  return outputPath;
}

export const EVIDENCE_STATUSES = Object.freeze([
  'measured',
  'measured-limited',
  'descriptive',
  'experimental',
  'not-established',
  'unavailable',
]);
const EVIDENCE_SET = new Set(EVIDENCE_STATUSES);

const OUTPUT_KEYS = Object.freeze([
  'performanceGrades',
  'projections',
  'tulipEvidence',
  'tulipBeta',
  'projectedRoleMpg',
  'playerComparisons',
  'teamFit',
  'crossLeague',
]);

const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const cloneOrNull = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

function modelVersion(modelProvenance, key) {
  const version = modelProvenance?.outputs?.[key]?.modelVersion;
  if (!version) throw new Error(`Evidence claims require model provenance for ${key}.`);
  return version;
}

function projectionEvidence(publicData) {
  const bt = publicData?.projectionMeta?.backtest?.nba || null;
  const reconciliation = publicData?.projectionMeta?.contextReconciliation || null;
  return {
    legacyBacktest: bt ? {
      evidenceStatus: 'measured-limited',
      season: bt.season || null,
      n: finiteOrNull(bt.n),
      mae: cloneOrNull(bt.mae),
      gainVsBaselines: cloneOrNull(bt.gain),
      appliesToFullShippedModel: false,
      boundary: 'Legacy veteran projection backtest; it predates the complete current context stack and does not validate rookie, returner, injury/availability or all context behavior.',
    } : {
      evidenceStatus: 'unavailable',
      season: null,
      n: null,
      mae: null,
      gainVsBaselines: null,
      appliesToFullShippedModel: false,
      boundary: 'No legacy backtest payload is published.',
    },
    minuteReconciliation: reconciliation ? {
      evidenceStatus: 'measured-limited',
      n: finiteOrNull(reconciliation.n),
      teams: finiteOrNull(reconciliation.teams),
      maeDelta: cloneOrNull(reconciliation.mae?.delta),
      appliesToFullShippedModel: false,
      boundary: reconciliation.limitations || 'Minute-layer check only; rates, injuries and availability are outside this evaluation.',
    } : {
      evidenceStatus: 'unavailable',
      n: null,
      teams: null,
      maeDelta: null,
      appliesToFullShippedModel: false,
      boundary: 'No context-reconciliation evaluation is published.',
    },
  };
}

export function deriveEvidenceClaims({ publicData, modelProvenance }) {
  if (!publicData || !modelProvenance) throw new Error('Evidence claims require public data and model provenance.');
  const projections = projectionEvidence(publicData);
  const outputs = {
    performanceGrades: {
      modelVersion: modelVersion(modelProvenance, 'performanceGrades'),
      evidenceStatus: 'descriptive',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      boundary: 'Within-league descriptive performance grades are not forecasts and carry no predictive-accuracy claim.',
    },
    projections: {
      modelVersion: modelVersion(modelProvenance, 'projections'),
      evidenceStatus: 'not-established',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      evidence: projections,
      boundary: publicData?.projectionMeta?.contextValidation
        || 'Overall predictive accuracy is not established for the exact shipped projection/context stack.',
    },
    tulipEvidence: {
      modelVersion: modelVersion(modelProvenance, 'tulipEvidence'),
      evidenceStatus: 'experimental',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      boundary: 'Observational role-expansion evidence and robustness diagnostics are not predictive validation or causal identification.',
    },
    tulipBeta: {
      modelVersion: modelVersion(modelProvenance, 'tulipBeta'),
      evidenceStatus: 'experimental',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      evidence: cloneOrNull(publicData?.tulipBetaMeta?.validation),
      boundary: publicData?.tulipBetaMeta?.notValidated
        || 'Recommended-minute direction and magnitude are experimental and are not validated as win-optimal prescriptions.',
    },
    projectedRoleMpg: {
      modelVersion: modelVersion(modelProvenance, 'projectedRoleMpg'),
      evidenceStatus: publicData?.tulipCapacityMeta?.benchmarks ? 'measured-limited' : 'unavailable',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      evidence: publicData?.tulipCapacityMeta?.benchmarks ? {
        evidenceGrade: cloneOrNull(publicData?.tulipCapacityMeta?.evidenceGrade),
        benchmarks: cloneOrNull(publicData?.tulipCapacityMeta?.benchmarks),
      } : null,
      boundary: 'This is a frozen role/workload projection with its own limited evidence; it is not physical capacity and its evidence does not validate TULIP Beta or the 2026-27 stat projection.',
    },
    playerComparisons: {
      modelVersion: modelVersion(modelProvenance, 'playerComparisons'),
      evidenceStatus: 'descriptive',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      boundary: 'Comparison similarity/blend fit is heuristic descriptive matching, not a calibrated probability or future-career prediction.',
    },
    teamFit: {
      modelVersion: modelVersion(modelProvenance, 'teamFit'),
      evidenceStatus: 'descriptive',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      boundary: 'Team Fit describes how a player profile addresses current roster needs; it is not a forecast of team wins or player performance.',
    },
    crossLeague: {
      modelVersion: modelVersion(modelProvenance, 'crossLeague'),
      evidenceStatus: publicData?.analysis?.crossLeague?.readiness?.leaveOneOutAuc != null ? 'measured-limited' : 'descriptive',
      predictiveAccuracyClaim: { supported: false, evaluationModelVersion: null, chronologicalAsOf: false, fullShippedModel: false },
      evidence: {
        readinessTrainingSize: finiteOrNull(publicData?.analysis?.crossLeague?.readiness?.trainingSize),
        readinessLeaveOneOutAuc: finiteOrNull(publicData?.analysis?.crossLeague?.readiness?.leaveOneOutAuc),
        translationCrossoverSample: finiteOrNull(publicData?.analysis?.crossLeague?.per36?.sampleSize
          ?? publicData?.analysis?.translation?.crossoverSample),
      },
      boundary: 'Readiness/translation evidence comes from selected same-season dual-league samples; it does not establish NBA-career probability or general out-of-sample career accuracy.',
    },
  };
  return {
    schemaVersion: 1,
    policy: 'Predictive accuracy may be labeled supported only when a chronological as-of evaluation names the exact shipped model version and evaluates the full shipped model scope.',
    outputs,
  };
}

export function validateEvidenceClaims(claims, modelProvenance) {
  if (!claims || claims.schemaVersion !== 1 || !claims.policy) throw new Error('Publication evidence-claims schema is invalid.');
  const keys = Object.keys(claims.outputs || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...OUTPUT_KEYS].sort())) {
    throw new Error('Publication evidence-claims output set is incomplete.');
  }
  for (const key of OUTPUT_KEYS) {
    const item = claims.outputs[key];
    const expectedVersion = modelVersion(modelProvenance, key);
    if (!item || item.modelVersion !== expectedVersion || !EVIDENCE_SET.has(item.evidenceStatus) || !item.boundary) {
      throw new Error(`Publication evidence claim is invalid for ${key}.`);
    }
    const accuracy = item.predictiveAccuracyClaim;
    if (!accuracy || typeof accuracy.supported !== 'boolean') {
      throw new Error(`Publication predictive-accuracy claim is invalid for ${key}.`);
    }
    if (accuracy.supported) {
      if (item.evidenceStatus !== 'measured'
          || accuracy.evaluationModelVersion !== item.modelVersion
          || accuracy.chronologicalAsOf !== true
          || accuracy.fullShippedModel !== true) {
        throw new Error(`Predictive accuracy claim for ${key} lacks evidence for the exact shipped model.`);
      }
    }
  }
  return true;
}

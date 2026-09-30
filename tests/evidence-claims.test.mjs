import assert from 'node:assert/strict';
import { deriveEvidenceClaims, validateEvidenceClaims } from '../scripts/lib/evidence-claims.mjs';

const modelProvenance = { outputs: Object.fromEntries([
  'performanceGrades','projections','tulipEvidence','tulipBeta','projectedRoleMpg','playerComparisons','teamFit','crossLeague'
].map((key) => [key,{ modelVersion:`v:${key}` }])) };
const publicData = {
  projectionMeta: {
    contextValidation:'Legacy veteran backtest does not validate context-1; minute reconciliation is a layer-only check.',
    backtest:{ nba:{ season:'2025-26', n:476, mae:{ pts:{model:2.5113,repeat:2.9128} }, gain:{pts:{vsRepeat:{gain:0.4015}}} } },
    contextReconciliation:{ n:459, teams:29, mae:{delta:{mpg:0.0618,pts:-0.0241,reb:0.0047,ast:0.0096}}, limitations:'Minute-only; rates, injuries and availability held fixed.' },
  },
  tulipBetaMeta:{ notValidated:'Direction and magnitude are not validated win prescriptions.', validation:{status:'PARTIAL_LEDGER_ONLY'} },
  tulipCapacityMeta:{ evidenceGrade:'limited', benchmarks:{mae:4.2} },
  analysis:{ crossLeague:{ readiness:{trainingSize:85,leaveOneOutAuc:0.64}, per36:{sampleSize:30} } },
};
const claims=deriveEvidenceClaims({publicData,modelProvenance});
assert.equal(validateEvidenceClaims(claims,modelProvenance),true);
assert.equal(claims.outputs.projections.evidenceStatus,'not-established');
assert.equal(claims.outputs.projections.predictiveAccuracyClaim.supported,false);
assert.equal(claims.outputs.projections.evidence.legacyBacktest.appliesToFullShippedModel,false);
assert.equal(claims.outputs.projections.evidence.minuteReconciliation.appliesToFullShippedModel,false);
assert.equal(claims.outputs.tulipBeta.evidenceStatus,'experimental');
assert.equal(claims.outputs.projectedRoleMpg.evidenceStatus,'measured-limited');
assert.equal(claims.outputs.crossLeague.evidenceStatus,'measured-limited');

const badVersion=structuredClone(claims);
badVersion.outputs.projections.modelVersion='other';
assert.throws(()=>validateEvidenceClaims(badVersion,modelProvenance),/evidence claim/i);

const unsupported=structuredClone(claims);
Object.assign(unsupported.outputs.projections,{evidenceStatus:'measured'});
Object.assign(unsupported.outputs.projections.predictiveAccuracyClaim,{
  supported:true,evaluationModelVersion:'legacy-model',chronologicalAsOf:true,fullShippedModel:true,
});
assert.throws(()=>validateEvidenceClaims(unsupported,modelProvenance),/exact shipped model/i);

const futureValid=structuredClone(claims);
Object.assign(futureValid.outputs.projections,{evidenceStatus:'measured'});
Object.assign(futureValid.outputs.projections.predictiveAccuracyClaim,{
  supported:true,evaluationModelVersion:'v:projections',chronologicalAsOf:true,fullShippedModel:true,
});
assert.equal(validateEvidenceClaims(futureValid,modelProvenance),true);

console.log('evidence-claims tests passed: shipped-model version binding, limited-evidence separation, unsupported accuracy rejection');

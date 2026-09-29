import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

let mod=null, importError=null;
try { mod=await import('../scripts/lib/tulip-beta-diagnostics.mjs'); }
catch(err){ importError=err; }

let pass=0, fail=0;
const t=(name,fn)=>{try{fn();console.log(`  PASS  ${name}`);pass++;}catch(e){console.log(`  FAIL  ${name} — ${e.message}`);fail++;}};

console.log('TULIP Beta feasibility/validation diagnostics');

t('diagnostics module exists',()=>assert.ifError(importError));

if(!importError){
  const { distributionSummary, teamAllocationDiagnostics, validationStatus }=mod;

  const mk=(id,delta,team='AAA',extra={})=>({
    playerId:String(id),name:`P${id}`,league:'NBA',currentRoster:true,currentTeam:team,
    positionFamily:extra.positionFamily||'Wing',
    tulipBeta: extra.abstain
      ? {abstain:true,status:'BETA',reason:extra.reason||'insufficient_minutes'}
      : {abstain:false,status:'BETA',tulip:delta,currentMpg:20,recommendedMpg:20+delta,
          confidence:extra.confidence||'MEDIUM',extrapolated:!!extra.extrapolated,
          valueGapSd:delta/5,supportedCeiling:24,evidenceTier:'B',evidenceFactor:0.85,
          rosterBalanceFactor:1}
  });

  const rows=[mk(1,10),mk(2,7),mk(3,5),mk(4,3),mk(5,-10),mk(6,-7),mk(7,-5),mk(8,-3),
    mk(9,0),mk(10,0,'AAA',{abstain:true,reason:'no_appearance',positionFamily:'Big'})];

  t('distribution summary reports +/-3/5/7/10 counts exactly',()=>{
    const d=distributionSummary(rows);
    assert.deepStrictEqual(d.thresholds['3'],{positive:4,negative:4,absolute:8});
    assert.deepStrictEqual(d.thresholds['5'],{positive:3,negative:3,absolute:6});
    assert.deepStrictEqual(d.thresholds['7'],{positive:2,negative:2,absolute:4});
    assert.deepStrictEqual(d.thresholds['10'],{positive:1,negative:1,absolute:2});
    assert.strictEqual(d.scored,9);
    assert.strictEqual(d.abstained,1);
  });

  t('team diagnostics distinguish bounded ledger from playable rotation',()=>{
    const d=teamAllocationDiagnostics(rows,'AAA');
    assert.strictEqual(d.currentRosterPlayers,10);
    assert.strictEqual(d.scoredPlayers,9);
    assert.strictEqual(d.abstainedPlayers,1);
    assert.strictEqual(d.abstentionReasons.no_appearance,1);
    assert.ok(Math.abs(d.ledger.net)<1e-9);
    assert.ok(d.feasibility.ledgerConserved);
    assert.ok(d.feasibility.individualBounds);
    assert.strictEqual(d.feasibility.availabilityVerified,false);
    assert.strictEqual(d.feasibility.positionConstraintsEnforced,false);
    assert.strictEqual(d.feasibility.fullPlayable240Rotation,false);
    assert.strictEqual(d.feasibility.status,'PARTIAL_LEDGER_ONLY');
    assert.ok(d.positionCoverage.roster.Big===1);
    assert.ok(!d.positionCoverage.scored.Big);
  });

  t('validation status freezes negative causal result without borrowing capacity validation',()=>{
    const v=validationStatus();
    assert.strictEqual(v.devQuasiExperiment.reducedFormPtsPerSd,-0.127);
    assert.deepStrictEqual(v.devQuasiExperiment.andersonRubin95,[-1.756,1.021]);
    assert.strictEqual(v.exactMagnitudeValidated,false);
    assert.strictEqual(v.ordinalDirectionValidatedAsWinPrescription,false);
    assert.strictEqual(v.projectedRoleMpgBacktestValidatesAllocator,false);
    assert.strictEqual(v.allocatorHistoricalReplay.status,'NOT_RUN');
    assert.ok(v.chronologicalHoldouts.every(x=>x.status==='UNSPENT_IN_THIS_SECTION'));
  });
}

console.log(`\n${fail===0?'ALL PASS':fail+' FAILURE(S)'} · ${pass} passed`);
process.exit(fail===0?0:1);

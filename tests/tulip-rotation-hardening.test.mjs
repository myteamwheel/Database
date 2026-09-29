import assert from 'node:assert/strict';
import {
  BETA_CONFIG,
  tulipValueSignals,
  tulipBetaForTeam,
  positionTokens,
  positionsCompatible,
  marginalAllocationPriority,
  tulipDistribution,
} from '../scripts/lib/tulip-beta.mjs';

let pass=0, fail=0;
const t=(name,fn)=>{try{fn();console.log(`  PASS  ${name}`);pass++;}catch(e){console.log(`  FAIL  ${name} — ${e.message}`);fail++;}};

const mk=(id,{bpm=0,mpg=20,position='F',minutes=1200,tier='A',frontier=40,available}={})=>({
  playerId:String(id), name:`P${id}`, appeared:true, bpm, mpg, minutes, position,
  history:[['2025-26','Regular Season',[],60,Math.max(mpg,30)]],
  tulip:{
    frontier:[{mpg:frontier,abstain:false}],
    card:{evidenceTier:{tier},projection:{counterfactualSupport:{status:'OK'}}},
    roleScaleResponse:{response:'SUPPORTED'},
  },
  ...(available===undefined?{}:{tulipAvailability:{verified:true,available}}),
});

console.log('TULIP rotation hardening');

t('1 value evaluation is separate from minute recommendation',()=>{
  const roster=[mk(1,{bpm:5}),mk(2,{bpm:2}),mk(3,{bpm:0}),mk(4,{bpm:-2}),mk(5,{bpm:-4})];
  const s=tulipValueSignals(roster,{leagueBpm:0,leagueGapSd:2});
  assert.equal(s.size,5);
  for(const v of s.values()){
    assert.ok(Number.isFinite(v.valueGapSd));
    assert.equal('recommendedMpg' in v,false);
    assert.equal('tulip' in v,false);
  }
});

t('2 position tokenization preserves hybrid substitution evidence',()=>{
  assert.deepEqual(positionTokens({position:'G-F'}),['G','F']);
  assert.deepEqual(positionTokens({positionFamily:'F-C'}),['F','C']);
  assert.equal(positionsCompatible({position:'G'},{position:'C'}),false);
  assert.equal(positionsCompatible({position:'F-C'},{position:'C'}),true);
  assert.equal(positionsCompatible({position:null},{position:'C'}),null);
});

t('3 explicit verified unavailability is honored; missing availability is not guessed',()=>{
  const roster=[mk(1,{bpm:6,available:false}),mk(2,{bpm:3}),mk(3,{bpm:0}),mk(4,{bpm:-2}),mk(5,{bpm:-4}),mk(6,{bpm:-5})];
  const s=tulipValueSignals(roster,{leagueBpm:0,leagueGapSd:2});
  assert.equal(s.has('1'),false);
  assert.equal(s.has('2'),true);
});

t('4 coarse positions can block an otherwise desired center-from-guard transfer',()=>{
  const roster=[
    mk(1,{bpm:10,mpg:8,position:'C'}),
    mk(2,{bpm:-2,mpg:24,position:'G'}),
    mk(3,{bpm:-2,mpg:24,position:'G'}),
    mk(4,{bpm:-2,mpg:24,position:'G'}),
    mk(5,{bpm:-2,mpg:24,position:'G'}),
  ];
  const out=tulipBetaForTeam(roster,{leagueBpm:0,leagueGapSd:1});
  const star=out.get('1');
  assert.equal(star.tulip,0);
  assert.ok(star.unfilledDesiredMpg>0);
  assert.equal(star.positionLimited,true);
  assert.equal([...out.values()].reduce((s,x)=>s+x.tulip,0),0);
});

t('5 a compatible hybrid donor can fund a center gain while incompatible guards cannot be named as sources',()=>{
  const roster=[
    mk(11,{bpm:10,mpg:8,position:'C'}),
    mk(12,{bpm:-4,mpg:24,position:'F-C'}),
    mk(13,{bpm:-2,mpg:24,position:'G'}),
    mk(14,{bpm:-2,mpg:24,position:'G'}),
    mk(15,{bpm:-2,mpg:24,position:'G'}),
  ];
  const out=tulipBetaForTeam(roster,{leagueBpm:0,leagueGapSd:1});
  assert.ok(out.get('11').tulip>0);
  assert.ok(out.get('12').tulip<0);
  assert.equal(out.get('13').tulip,0);
  assert.equal(out.get('14').tulip,0);
  assert.equal(out.get('15').tulip,0);
  assert.ok(Math.abs([...out.values()].reduce((s,x)=>s+x.tulip,0))<1e-9);
});

t('6 marginal allocation priority diminishes as more minutes move',()=>{
  const p0=marginalAllocationPriority(2,0);
  const p3=marginalAllocationPriority(2,3);
  const p8=marginalAllocationPriority(2,8);
  assert.ok(p0>p3&&p3>p8&&p8>0);
});

t('7 moved rows disclose the diminishing-return factor and allocation basis',()=>{
  const roster=[
    mk(21,{bpm:9,mpg:8,position:'F'}),
    mk(22,{bpm:3,mpg:10,position:'F'}),
    mk(23,{bpm:-3,mpg:24,position:'F'}),
    mk(24,{bpm:-3,mpg:24,position:'F'}),
    mk(25,{bpm:-3,mpg:24,position:'F'}),
  ];
  const out=tulipBetaForTeam(roster,{leagueBpm:0,leagueGapSd:1});
  const moved=[...out.values()].filter(x=>Math.abs(x.tulip)>0);
  assert.ok(moved.length>=2);
  assert.ok(moved.every(x=>x.allocationBasis==='position-aware-diminishing-v3'));
  assert.ok(moved.every(x=>x.diminishingFactorFinal>0&&x.diminishingFactorFinal<=1));
  assert.ok(moved.some(x=>x.diminishingFactorFinal<1));
});

t('8 distribution diagnostics report +/-3/5/7/10 magnitudes without quotas',()=>{
  const rows=[
    {tulip:10.2},{tulip:7.1},{tulip:5.0},{tulip:3.1},{tulip:2.9},
    {tulip:-10.0},{tulip:-7.2},{tulip:-4.9},{tulip:-3.0},{tulip:0},
  ];
  const d=tulipDistribution(rows);
  assert.deepEqual(d.absoluteAtLeast,{3:8,5:5,7:4,10:2});
  assert.deepEqual(d.positiveAtLeast,{3:4,5:3,7:2,10:1});
  assert.deepEqual(d.negativeAtLeast,{3:4,5:2,7:2,10:1});
  assert.equal(d.quotaApplied,false);
});

t('9 version and metadata explicitly identify the new heuristic layer',()=>{
  assert.match(BETA_CONFIG.version,/v3/);
  assert.ok(BETA_CONFIG.diminishingScaleMpg>0);
  assert.equal(BETA_CONFIG.positionGuard,'coarse-roster-family-overlap');
});

console.log(`\n${fail===0?'ALL PASS':`${fail} FAILURE(S)`} · ${pass} passed`);
process.exit(fail===0?0:1);

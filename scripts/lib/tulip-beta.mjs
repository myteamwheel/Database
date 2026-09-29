// TULIP BETA — experimental, zero-sum minute-reallocation estimate.
//
// The model is deliberately split into TWO layers:
//   A. PLAYER EVALUATION: reliability-shrunk value versus the current team's allocated-minute average.
//   B. MINUTE ALLOCATION: a heuristic recommendation that applies workload evidence, coarse position
//      substitution, diminishing marginal priority and a zero-sum roster ledger.
//
// EPISTEMIC STATUS: historical causal testing did NOT establish that the exact minute deltas maximize
// wins. The allocator is decision support, not a validated coaching prescription.

export const BETA_CONFIG = {
  version: 'tulip-beta-position-diminishing-v3',
  evaluationVersion: 'team-relative-value-v1',
  allocationVersion: 'position-aware-diminishing-v3',
  shrinkMinutes: 400,
  minMinutes: 200,
  minMpg: 0.5,
  minutesPerSd: 10.0,
  floorMpg: 0,
  ceilingHardCap: 40.0,
  allocationStepMpg: 0.1,
  // Transparent heuristic: each additional 5 MPG already moved reduces marginal priority.
  // This is a stabilizer, not a fitted causal coefficient.
  diminishingScaleMpg: 5.0,
  positionGuard: 'coarse-roster-family-overlap',
  availabilityInput: 'explicit-verified-only',
};

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const round1 = (v) => Math.round((Number(v) + Number.EPSILON) * 10) / 10;
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const round3 = (v) => Math.round((Number(v) + Number.EPSILON) * 1000) / 1000;

const POSITION_MAP = { PG:'G', SG:'G', G:'G', SF:'F', PF:'F', F:'F', C:'C' };

export function positionTokens(p) {
  const raw = p?.positionFamily ?? p?.position;
  if (!raw) return [];
  const pieces = String(raw).toUpperCase().split(/[-/,s]+/).map((x) => POSITION_MAP[x] || null).filter(Boolean);
  const order = ['G','F','C'];
  return [...new Set(pieces)].sort((a,b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * true  -> known compatible position families overlap
 * false -> known position families do not overlap
 * null  -> one or both positions are unavailable, so compatibility is unknown rather than guessed
 */
export function positionsCompatible(a,b) {
  const A=positionTokens(a), B=positionTokens(b);
  if (!A.length || !B.length) return null;
  return A.some((x) => B.includes(x));
}

function availabilityState(p) {
  const a=p?.tulipAvailability;
  if (a?.verified === true && a.available === false) return 'verified-unavailable';
  if (a?.verified === true && a.available === true) return 'verified-available';
  return 'unverified';
}

function eligiblePlayer(p) {
  return p?.appeared
    && fin(p.bpm)
    && fin(p.mpg)
    && (p.minutes || 0) >= BETA_CONFIG.minMinutes
    && Number(p.mpg) >= BETA_CONFIG.minMpg
    && availabilityState(p) !== 'verified-unavailable';
}

/**
 * Layer A only: evaluate each eligible player's reliability-shrunk value relative to the
 * minute-weighted team average. This function intentionally emits NO recommended minutes.
 */
export function tulipValueSignals(roster,{leagueBpm,leagueGapSd}) {
  if (!fin(leagueBpm) || !fin(leagueGapSd) || Number(leagueGapSd) <= 0) {
    throw new Error('TULIP requires a finite league mean and positive gap standard deviation');
  }
  const elig=(roster || []).filter(eligiblePlayer);
  if (elig.length < 5) return new Map();

  const shrunk=new Map();
  for(const p of elig){
    const m=Number(p.minutes)||0;
    shrunk.set(String(p.playerId),(m*Number(p.bpm)+BETA_CONFIG.shrinkMinutes*Number(leagueBpm))/(m+BETA_CONFIG.shrinkMinutes));
  }
  const totMin=elig.reduce((a,p)=>a+Number(p.mpg),0);
  const teamAvg=elig.reduce((a,p)=>a+shrunk.get(String(p.playerId))*Number(p.mpg),0)/totMin;
  return new Map(elig.map((p)=>{
    const playerId=String(p.playerId);
    const sh=shrunk.get(playerId);
    const gap=sh-teamAvg;
    return [playerId,{
      playerId,
      evaluationVersion:BETA_CONFIG.evaluationVersion,
      shrunkBpm:sh,
      teamAverageShrunkBpm:teamAvg,
      valueGap:gap,
      valueGapSd:gap/Number(leagueGapSd),
      currentMpg:Number(p.mpg),
      availability:availabilityState(p),
      positionTokens:positionTokens(p),
      positionEvidence:positionTokens(p).length ? 'roster-listed' : 'unavailable',
    }];
  }));
}

/** Career-high and sustained workload from compact history (index 4 = MPG, index 3 = GP). */
function workloadHistory(p) {
  const rows=Array.isArray(p.history)?p.history:Object.values(p.history||{});
  let careerHigh=0,sustained=0;
  for(const r of rows){
    if(!Array.isArray(r)||r[1]!=='Regular Season') continue;
    const gp=Number(r[3]),mpg=Number(r[4]);
    if(!fin(gp)||!fin(mpg)||gp<20) continue;
    if(mpg>careerHigh) careerHigh=mpg;
    if(gp>=40&&mpg>sustained) sustained=mpg;
  }
  return {careerHigh,sustained};
}

function supportedFrontierMpg(p) {
  const f=(p.tulip&&p.tulip.frontier)||[];
  let best=0;
  for(const pt of f) if(!pt.abstain&&fin(pt.mpg)&&pt.mpg>best) best=pt.mpg;
  return best;
}

function evidenceFactor(p) {
  const card=p.tulip&&p.tulip.card;
  const tier=card&&card.evidenceTier&&card.evidenceTier.tier;
  let f=tier==='A'?1:tier==='B'?0.85:tier==='C'?0.6:0.45;
  const rsr=p.tulip&&p.tulip.roleScaleResponse;
  if(rsr&&/INSUFFICIENT/i.test(rsr.response||'')) f=Math.min(f,0.8);
  const cs=card&&card.projection&&card.projection.counterfactualSupport;
  if(cs&&cs.status&&cs.status!=='OK') f=Math.min(f,0.7);
  return f;
}

function confidenceOf(p,finalDelta,ceiling) {
  const mins=Number(p.minutes)||0;
  const tier=p.tulip&&p.tulip.card&&p.tulip.card.evidenceTier&&p.tulip.card.evidenceTier.tier;
  const inSupport=(Number(p.mpg)+finalDelta)<=ceiling+0.05;
  if(mins>=800&&(tier==='A'||tier==='B')&&inSupport) return 'HIGH';
  if(mins>=300&&(tier==='A'||tier==='B'||tier==='C')&&inSupport) return 'MEDIUM';
  return 'LOW';
}

/** Marginal transfer priority. Strength is absolute team-relative signal in SD units. */
export function marginalAllocationPriority(strength,movedMpg,scale=BETA_CONFIG.diminishingScaleMpg) {
  if(!fin(strength)||Number(strength)<0||!fin(movedMpg)||Number(movedMpg)<0||!fin(scale)||Number(scale)<=0) {
    throw new Error(`Marginal allocation priority requires non-negative strength/moved minutes and positive scale (strength=${strength}, moved=${movedMpg}, scale=${scale})`);
  }
  return Number(strength)/(1+Number(movedMpg)/Number(scale));
}

function positionMatch(a,b) {
  const c=positionsCompatible(a.p,b.p);
  // Unknown position evidence must not be silently treated as "known compatible". It is allowed so
  // the existing product does not fabricate a hard restriction from missing data, but the output
  // records that the transfer used unknown compatibility.
  return c===false?false:true;
}

function allocateLedger(rows) {
  const pos=rows.filter((r)=>r.desired>0).map((r)=>({...r,remaining:r.desired,moved:0,partners:new Set(),unknownPartner:false}));
  const neg=rows.filter((r)=>r.desired<0).map((r)=>({...r,remaining:-r.desired,moved:0,partners:new Set(),unknownPartner:false}));
  const byId=new Map(rows.map((r)=>[String(r.p.playerId),{delta:0,partners:new Set(),unknownPartner:false}]));
  const step=BETA_CONFIG.allocationStepMpg;
  let iterations=0;

  while(true){
    let best=null;
    for(const g of pos){
      if(g.remaining<step-1e-9) continue;
      for(const d of neg){
        if(d.remaining<step-1e-9) continue;
        if(!positionMatch(g,d)) continue;
        const compatibility=positionsCompatible(g.p,d.p);
        const gp=marginalAllocationPriority(Math.abs(g.gapSd),g.moved);
        const dp=marginalAllocationPriority(Math.abs(d.gapSd),d.moved);
        const score=gp+dp;
        const key=`${String(g.p.playerId)}|${String(d.p.playerId)}`;
        if(!best||score>best.score+1e-12||(Math.abs(score-best.score)<=1e-12&&key<best.key)) {
          best={g,d,score,key,compatibility};
        }
      }
    }
    if(!best) break;
    best.g.remaining-=step; best.d.remaining-=step;
    best.g.moved+=step; best.d.moved+=step;
    best.g.partners.add(String(best.d.p.playerId));
    best.d.partners.add(String(best.g.p.playerId));
    if(best.compatibility===null){best.g.unknownPartner=true;best.d.unknownPartner=true;}
    const go=byId.get(String(best.g.p.playerId)), dn=byId.get(String(best.d.p.playerId));
    go.delta+=step; dn.delta-=step;
    go.partners.add(String(best.d.p.playerId)); dn.partners.add(String(best.g.p.playerId));
    if(best.compatibility===null){go.unknownPartner=true;dn.unknownPartner=true;}
    iterations++;
    if(iterations>20000) throw new Error('TULIP allocation exceeded iteration safety bound');
  }

  const remainingOpposite=(row,sign)=>{
    const others=sign>0?neg:pos;
    return others.some((x)=>x.remaining>=step-1e-9);
  };
  const hasCompatibleRemaining=(row,sign)=>{
    const others=sign>0?neg:pos;
    return others.some((x)=>x.remaining>=step-1e-9&&positionMatch(sign>0?row:x,sign>0?x:row));
  };

  for(const g of pos){
    const o=byId.get(String(g.p.playerId));
    o.positionLimited=g.remaining>=step-1e-9&&remainingOpposite(g,1)&&!hasCompatibleRemaining(g,1);
  }
  for(const d of neg){
    const o=byId.get(String(d.p.playerId));
    o.positionLimited=d.remaining>=step-1e-9&&remainingOpposite(d,-1)&&!hasCompatibleRemaining(d,-1);
  }
  return {byId,iterations};
}

export function tulipDistribution(rows) {
  const vals=(rows||[]).map((x)=>Number(x?.tulip)).filter(Number.isFinite);
  const thresholds=[3,5,7,10];
  const absoluteAtLeast={},positiveAtLeast={},negativeAtLeast={};
  for(const n of thresholds){
    absoluteAtLeast[n]=vals.filter((v)=>Math.abs(v)>=n-1e-9).length;
    positiveAtLeast[n]=vals.filter((v)=>v>=n-1e-9).length;
    negativeAtLeast[n]=vals.filter((v)=>v<=-n+1e-9).length;
  }
  return {players:vals.length,absoluteAtLeast,positiveAtLeast,negativeAtLeast,quotaApplied:false};
}

/**
 * Layer B: transform pure player-value signals into a workload recommendation.
 * Every moved 0.1 MPG is funded by an opposite-direction team-mate.
 */
export function tulipBetaForTeam(roster,{leagueBpm,leagueGapSd}) {
  const signals=tulipValueSignals(roster,{leagueBpm,leagueGapSd});
  if(!signals.size) return new Map();
  const byId=new Map((roster||[]).map((p)=>[String(p.playerId),p]));
  const rows=[];

  for(const [id,sig] of signals){
    const p=byId.get(id);
    const rawSignalDelta=sig.valueGapSd*BETA_CONFIG.minutesPerSd;
    let desired=rawSignalDelta;
    const wh=workloadHistory(p);
    const ceiling=Math.min(BETA_CONFIG.ceilingHardCap,
      Math.max(Number(p.mpg),wh.careerHigh,wh.sustained,supportedFrontierMpg(p)));
    const headUp=Math.max(0,BETA_CONFIG.ceilingHardCap-Number(p.mpg));
    const headDown=Math.max(0,Number(p.mpg)-BETA_CONFIG.floorMpg);

    let evF=1,extrapolationFactor=1,supportedGain=0;
    if(desired>0){
      extrapolationFactor=evidenceFactor(p);
      supportedGain=Math.min(desired,Math.max(0,ceiling-Number(p.mpg)));
      const supportedAdjusted=supportedGain+(desired-supportedGain)*extrapolationFactor;
      evF=desired? supportedAdjusted/desired:1;
      desired=Math.min(supportedAdjusted,headUp);
    }else{
      desired=Math.max(desired,-headDown);
    }
    rows.push({p,...sig,rawSignalDelta,desired,ceiling,evF,extrapolationFactor,supportedGain});
  }

  const allocation=allocateLedger(rows);
  const out=new Map();
  for(const r of rows){
    const a=allocation.byId.get(String(r.p.playerId))||{delta:0,partners:new Set(),unknownPartner:false,positionLimited:false};
    const final=round1(a.delta||0);
    const currentMpg=round1(Number(r.p.mpg));
    const rec=round1(currentMpg+final);
    const desired=round1(r.desired);
    const unfilled=round1(Math.max(0,Math.abs(r.desired)-Math.abs(final)));
    const rosterBalanceFactor=Math.abs(r.desired)>1e-9?Math.min(1,Math.abs(final/r.desired)):0;
    const positionKnown=positionTokens(r.p).length>0;
    const factor=marginalAllocationPriority(1,Math.abs(final),BETA_CONFIG.diminishingScaleMpg);

    out.set(String(r.p.playerId),{
      tulip:final,
      currentMpg,
      recommendedMpg:rec,

      // Layer A: player evaluation, independent of the recommendation.
      evaluation:{
        version:r.evaluationVersion,
        shrunkBpm:round2(r.shrunkBpm),
        teamAverageShrunkBpm:round2(r.teamAverageShrunkBpm),
        valueGap:round2(r.valueGap),
        valueGapSd:round2(r.valueGapSd),
      },
      valueGap:round2(r.valueGap),
      valueGapSd:round2(r.valueGapSd),
      shrunkBpm:round2(r.shrunkBpm),

      // Layer B trace.
      rawSignalDelta:round1(r.rawSignalDelta),
      constrainedDelta:desired,
      requestedDelta:desired,
      rosterBalanceFactor:round3(rosterBalanceFactor),
      supportedCeiling:round1(r.ceiling),
      evidenceTier:(r.p.tulip&&r.p.tulip.card&&r.p.tulip.card.evidenceTier&&r.p.tulip.card.evidenceTier.tier)||null,
      evidenceFactor:round2(r.evF),
      extrapolationFactor:r.extrapolationFactor,
      supportedGain:round1(r.supportedGain),
      extrapolated:rec>r.ceiling+0.05,
      confidence:confidenceOf(r.p,final,r.ceiling),

      allocationBasis:BETA_CONFIG.allocationVersion,
      allocationStepMpg:BETA_CONFIG.allocationStepMpg,
      diminishingScaleMpg:BETA_CONFIG.diminishingScaleMpg,
      diminishingFactorFinal:round3(factor),
      unfilledDesiredMpg:unfilled,
      positionFamily:positionTokens(r.p).join('-')||null,
      positionEvidence:positionKnown?'roster-listed':'unavailable',
      positionLimited:!!a.positionLimited,
      compatiblePartnerIds:[...a.partners].sort(),
      usedUnknownPositionCompatibility:!!a.unknownPartner,
      availability:r.availability,
      allocationIterations:allocation.iterations,

      version:BETA_CONFIG.version,
      interpretation:'Experimental two-layer recommendation: player evaluation is separate from a position-aware, diminishing-return, zero-sum allocation heuristic. It is not validated as win-maximizing.',
      abstain:false,
      status:'BETA',
    });
  }
  return out;
}

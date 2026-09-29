const finite=(v)=>v!==null&&v!==undefined&&Number.isFinite(Number(v));
const round=(v,d=3)=>Math.round(Number(v)*10**d)/10**d;

export const TULIP_BETA_VALIDATION = Object.freeze({
  source: 'TULIP_RESEARCH_STATUS.md',
  devQuasiExperiment: {
    seasons: '2015-16..2023-24',
    reducedFormPtsPerSd: -0.127,
    andersonRubin95: [-1.756, 1.021],
    interpretation: 'Frozen DEV quasi-experiment did not establish a positive win effect for BPM/box-score-based routing.'
  },
  exactMagnitudeValidated: false,
  ordinalDirectionValidatedAsWinPrescription: false,
  projectedRoleMpgBacktestValidatesAllocator: false,
  allocatorHistoricalReplay: {
    status: 'NOT_RUN',
    reason: 'This section does not spend the pre-registered chronological TULIP holdouts or relabel the separate Projected Role MPG backtest as allocator validation.'
  },
  chronologicalHoldouts: [
    {season:'2024-25',status:'UNSPENT_IN_THIS_SECTION'},
    {season:'2025-26',status:'UNSPENT_IN_THIS_SECTION'}
  ]
});

export function validationStatus(){
  return JSON.parse(JSON.stringify(TULIP_BETA_VALIDATION));
}

function scoredRows(rows){
  return (rows||[]).filter((p)=>p?.tulipBeta&&!p.tulipBeta.abstain&&finite(p.tulipBeta.tulip));
}

export function distributionSummary(rows, thresholds=[3,5,7,10]){
  const scored=scoredRows(rows);
  const abstained=(rows||[]).filter((p)=>p?.tulipBeta?.abstain).length;
  const out={};
  for(const threshold of thresholds){
    const t=Number(threshold);
    const positive=scored.filter((p)=>Number(p.tulipBeta.tulip)>=t).length;
    const negative=scored.filter((p)=>Number(p.tulipBeta.tulip)<=-t).length;
    out[String(t)]={positive,negative,absolute:positive+negative};
  }
  const support={HIGH:0,MEDIUM:0,LOW:0,UNKNOWN:0};
  let extrapolated=0;
  for(const p of scored){
    const s=p.tulipBeta.confidence;
    if(Object.prototype.hasOwnProperty.call(support,s)) support[s]++;
    else support.UNKNOWN++;
    if(p.tulipBeta.extrapolated) extrapolated++;
  }
  return {scored:scored.length,abstained,thresholds:out,support,extrapolated};
}

function countBy(rows,key){
  const out={};
  for(const p of rows){
    const v=p?.[key];
    if(v===null||v===undefined||v==='') continue;
    out[String(v)]=(out[String(v)]||0)+1;
  }
  return out;
}

export function teamAllocationDiagnostics(rows,team){
  const roster=(rows||[]).filter((p)=>p?.league==='NBA'&&p.currentRoster&&p.currentTeam===team);
  const scored=scoredRows(roster);
  const abstained=roster.filter((p)=>p?.tulipBeta?.abstain);
  const reasons={};
  for(const p of abstained){
    const reason=p.tulipBeta.reason||'unspecified';
    reasons[reason]=(reasons[reason]||0)+1;
  }
  const current=scored.reduce((s,p)=>s+Number(p.tulipBeta.currentMpg),0);
  const recommended=scored.reduce((s,p)=>s+Number(p.tulipBeta.recommendedMpg),0);
  const gained=scored.filter((p)=>Number(p.tulipBeta.tulip)>0).reduce((s,p)=>s+Number(p.tulipBeta.tulip),0);
  const surrendered=scored.filter((p)=>Number(p.tulipBeta.tulip)<0).reduce((s,p)=>s-Number(p.tulipBeta.tulip),0);
  const net=recommended-current;
  const ledgerConserved=Math.abs(gained-surrendered)<=0.11&&Math.abs(net)<=0.11;
  const individualBounds=scored.every((p)=>{
    const x=Number(p.tulipBeta.recommendedMpg);
    return Number.isFinite(x)&&x>=-0.11&&x<=40.11;
  });
  return {
    team,
    currentRosterPlayers:roster.length,
    scoredPlayers:scored.length,
    abstainedPlayers:abstained.length,
    abstentionReasons:reasons,
    ledger:{
      currentScoredMpg:round(current,1),
      recommendedScoredMpg:round(recommended,1),
      gainedMpg:round(gained,1),
      surrenderedMpg:round(surrendered,1),
      net:round(net,1)
    },
    positionCoverage:{
      roster:countBy(roster,'positionFamily'),
      scored:countBy(scored,'positionFamily')
    },
    distribution:distributionSummary(roster),
    feasibility:{
      status:'PARTIAL_LEDGER_ONLY',
      ledgerConserved,
      individualBounds,
      availabilityVerified:false,
      positionConstraintsEnforced:false,
      fullPlayable240Rotation:false,
      eligiblePoolOnly:true,
      note:'TULIP Beta conserves the scored eligible-player workload ledger and enforces 0-40 MPG bounds. It does not verify simultaneous availability, enforce positional/lineup constraints, or construct a complete playable 240-minute rotation.'
    }
  };
}

export function playerDriverTrace(c){
  if(!c||c.abstain) return null;
  const delta=Number(c.tulip);
  return {
    valueSignal:{
      direction:delta>0?'increase':delta<0?'decrease':'no-change',
      teamRelativeGapSd:finite(c.valueGapSd)?Number(c.valueGapSd):null
    },
    workload:{
      currentMpg:finite(c.currentMpg)?Number(c.currentMpg):null,
      recommendedMpg:finite(c.recommendedMpg)?Number(c.recommendedMpg):null,
      supportedCeiling:finite(c.supportedCeiling)?Number(c.supportedCeiling):null,
      extrapolated:c.extrapolated===true
    },
    evidence:{
      tier:c.evidenceTier??null,
      factor:finite(c.evidenceFactor)?Number(c.evidenceFactor):null,
      support:c.confidence??null
    },
    ledger:{
      rosterBalanceFactor:finite(c.rosterBalanceFactor)?Number(c.rosterBalanceFactor):null
    },
    feasibility:{
      availabilityVerified:false,
      positionConstraintsEnforced:false,
      fullPlayable240Rotation:false
    }
  };
}

import { evaluateMinuteReconciliation } from '../scripts/lib/projection-context.mjs';

let pass=0, fail=0;
const check=(name,ok,detail='')=>{if(ok){pass++;console.log(`  ok   ${name}`);}else{fail++;console.log(`  FAIL ${name}${detail?' :: '+detail:''}`);}};

const rows=Array.from({length:8},(_,i)=>({
  team:'AAA',
  rosterSize:10,
  playerId:String(i+1),
  mpg:25,
  share:1,
  pr:{baseMin:900},
  line:{mpg:25,pts:20,reb:5,ast:4},
  actual:{mpg:30,pts:24,reb:6,ast:4.8},
}));
const before=JSON.stringify(rows);
const out=evaluateMinuteReconciliation(rows,{budget:240});

check('held-out reconciliation reports the scored sample',out.n===8&&out.teams===1);
check('held-out reconciliation conserves the team budget',
  out.teamBudgetCoverage.exact===1&&out.teamBudgetCoverage.teams===1);
check('held-out reconciliation does not mutate its input rows',JSON.stringify(rows)===before);
check('symmetric under-allocation moves all eight players from 25 to 30 MPG',
  Math.abs(out.mae.legacy.mpg-5)<1e-9&&Math.abs(out.mae.reconciled.mpg)<1e-9);
check('minute-only reconciliation rescales rate stats without inventing new rates',
  Math.abs(out.mae.reconciled.pts)<1e-9&&Math.abs(out.mae.reconciled.reb)<1e-9&&Math.abs(out.mae.reconciled.ast)<1e-9);
check('report exposes paired MAE deltas',
  Math.abs(out.mae.delta.mpg+5)<1e-9&&Math.abs(out.mae.delta.pts+4)<1e-9);
check('opening roster coverage is reported separately from scored history eligibility',
  out.openingRosterCoverage.modeledPlayers===8&&out.openingRosterCoverage.rosterPlayers===10
    &&out.openingRosterCoverage.completeTeams===0);
check('report limits its interpretation to the history-eligible minute layer',
  /history-eligible/i.test(out.population)&&/rookie|returner/i.test(out.limitations));

console.log(`\n${fail?'FAILED':'ALL PASS'} · ${pass} passed${fail?`, ${fail} failed`:''}`);
process.exit(fail?1:0);

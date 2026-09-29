import { evaluateMinuteReconciliation } from '../scripts/lib/projection-context.mjs';

let pass=0, fail=0;
const check=(name,ok,detail='')=>{if(ok){pass++;console.log(`  ok   ${name}`);}else{fail++;console.log(`  FAIL ${name}${detail?' :: '+detail:''}`);}};

const scored=Array.from({length:8},(_,i)=>({
  team:'AAA',
  playerId:String(i+1),
  score:true,
  mpg:25,
  share:1,
  pr:{baseMin:900},
  line:{mpg:25,pts:20,reb:5,ast:4},
  actual:{mpg:27.5,pts:22,reb:5.5,ast:4.4},
}));
const proxies=[
  {team:'AAA',playerId:'rookie-proxy',score:false,mpg:10,share:1,pr:{baseMin:0},proxyType:'rookie'},
  {team:'AAA',playerId:'returner-proxy',score:false,mpg:10,share:1,pr:{baseMin:300},proxyType:'older-history-returner'},
];
const rows=[...scored,...proxies];
const before=JSON.stringify(rows);
const out=evaluateMinuteReconciliation(rows,{budget:240});

check('held-out reconciliation scores only eligible veteran rows',out.n===8&&out.teams===1);
check('held-out reconciliation uses all opening-roster rows in the budget',
  out.openingRosterCoverage.modeledPlayers===10
    &&out.openingRosterCoverage.scoredPlayers===8
    &&out.openingRosterCoverage.proxyPlayers===2
    &&out.openingRosterCoverage.completeTeams===1);
check('held-out reconciliation conserves the complete team budget',
  out.teamBudgetCoverage.exact===1&&out.teamBudgetCoverage.teams===1);
check('held-out reconciliation does not mutate its input rows',JSON.stringify(rows)===before);
check('reserved proxy minutes prevent veterans from being forced to consume all 240',
  out.mae.reconciled.mpg>0&&out.mae.reconciled.mpg<out.mae.legacy.mpg,
  `legacy ${out.mae.legacy.mpg} reconciled ${out.mae.reconciled.mpg}`);
check('minute-only reconciliation rescales rate stats without inventing new rates',
  out.mae.reconciled.pts<out.mae.legacy.pts
    &&out.mae.reconciled.reb<out.mae.legacy.reb
    &&out.mae.reconciled.ast<out.mae.legacy.ast);
check('report exposes paired MAE deltas',
  out.mae.delta.mpg<0&&out.mae.delta.pts<0);
check('proxy rows never enter the scored sample',
  out.n===scored.length && out.openingRosterCoverage.proxyPlayers===proxies.length);
check('report limits its interpretation to the history-eligible minute layer',
  /history-eligible/i.test(out.population)&&/rookie|returner/i.test(out.limitations));

console.log(`\n${fail?'FAILED':'ALL PASS'} · ${pass} passed${fail?`, ${fail} failed`:''}`);
process.exit(fail?1:0);

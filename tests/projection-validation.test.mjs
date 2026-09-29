import { validateProjectionAccounting } from '../scripts/lib/projection-validation.mjs';

let pass=0, fail=0;
const check=(name,ok,detail='')=>{ if(ok){pass++;console.log(`  ok   ${name}`);}else{fail++;console.log(`  FAIL ${name}${detail?' :: '+detail:''}`);} };
const throws=(fn,re)=>{try{fn();return false;}catch(e){return re?re.test(String(e.message||e)):true;}};

const make = (ftValue=1) => {
  const gp=70, fgm=8, fg3m=2, fga=16, fg3a=6, ftm=4, fta=5, oreb=1.2, dreb=5.3;
  const pts=2*(fgm-fg3m)+3*fg3m+ftm*ftValue;
  const reb=oreb+dreb;
  return {
    gp, mpg:32, pts, reb, oreb, dreb, ast:5, stl:1, blk:.5, tov:2.4,
    fgm,fga,fg3m,fg3a,ftm,fta,
    fgPct:fgm/fga, fg3Pct:fg3m/fg3a, ftPct:ftm/fta,
    ts:pts/(2*(fga+0.44*fta)),
    accounting:{
      gp, mpg:32, pts, reb, oreb, dreb, ast:5, stl:1, blk:.5, tov:2.4,
      fgm,fga,fg3m,fg3a,ftm,fta,ftValue,
      totals:{
        pts:pts*gp,reb:reb*gp,oreb:oreb*gp,dreb:dreb*gp,ast:5*gp,stl:1*gp,blk:.5*gp,tov:2.4*gp,
        fgm:fgm*gp,fga:fga*gp,fg3m:fg3m*gp,fg3a:fg3a*gp,ftm:ftm*gp,fta:fta*gp
      }
    }
  };
};

check('valid NBA projection accounting passes', validateProjectionAccounting(make(1), {league:'NBA',scheduledGames:82}) === true);
check('valid G League nonstandard free throw value passes', validateProjectionAccounting(make(1.67), {league:'GLEAGUE',scheduledGames:50}) === true);
check('makes cannot exceed attempts', throws(()=>validateProjectionAccounting({...make(),accounting:{...make().accounting,fgm:17}}, {league:'NBA',scheduledGames:82}), /fgm|fga/i));
check('3PM cannot exceed FGM', throws(()=>validateProjectionAccounting({...make(),accounting:{...make().accounting,fg3m:9}}, {league:'NBA',scheduledGames:82}), /3pm|fg3m|fgm/i));
check('rebounds must reconcile', throws(()=>validateProjectionAccounting({...make(),accounting:{...make().accounting,reb:99}}, {league:'NBA',scheduledGames:82}), /reb/i));
check('points respect stored free throw value', throws(()=>validateProjectionAccounting({...make(1.67),accounting:{...make(1.67).accounting,pts:10}}, {league:'GLEAGUE',scheduledGames:50}), /pts|points/i));
check('field goal percentage derives from accounting', throws(()=>validateProjectionAccounting({...make(),fgPct:.9}, {league:'NBA',scheduledGames:82}), /fg.*percent|fgPct/i));
check('three point percentage derives from accounting', throws(()=>validateProjectionAccounting({...make(),fg3Pct:.9}, {league:'NBA',scheduledGames:82}), /3.*percent|fg3Pct/i));
check('free throw percentage derives from accounting', throws(()=>validateProjectionAccounting({...make(),ftPct:.9}, {league:'NBA',scheduledGames:82}), /free.*percent|ftPct/i));
check('true shooting derives from attempts and points', throws(()=>validateProjectionAccounting({...make(),ts:.9}, {league:'NBA',scheduledGames:82}), /true shooting|ts/i));
const badTotal=make(); badTotal.accounting={...badTotal.accounting,totals:{...badTotal.accounting.totals,pts:1}};
check('totals must equal per-game accounting times GP', throws(()=>validateProjectionAccounting(badTotal,{league:'NBA',scheduledGames:82}), /total.*pts|pts.*total/i));
check('GP cannot exceed league schedule', throws(()=>validateProjectionAccounting({...make(),gp:83,accounting:{...make().accounting,gp:83}}, {league:'NBA',scheduledGames:82}), /gp|games/i));
check('MPG cannot exceed league bound', throws(()=>validateProjectionAccounting({...make(),mpg:49,accounting:{...make().accounting,mpg:49}}, {league:'NBA',scheduledGames:82}), /mpg|minutes/i));

console.log(`\n${fail?'FAILED':'ALL PASS'} · ${pass} passed${fail?`, ${fail} failed`:''}`);
process.exit(fail?1:0);

// Independent oracle: imports no production accounting, formatting or model helpers.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const data=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url),'utf8'));
const close=(a,b,t,label)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t,`${label}: ${a} != ${b}`);
const rates={pts:'pts',reb:'reb',oreb:'oreb',dreb:'dreb',ast:'ast',stl:'stl',blk:'blk',tov:'tov',pf:'pf',fg:'fgm',fga:'fga',fg3:'fg3m',fg3a:'fg3a',ft:'ftm',fta:'fta'};
const projectionRates=['pts','reb','oreb','dreb','ast','stl','blk','tov','fga','fgm','fg3a','fg3m','fta','ftm'];
function audit(payload){
  let actuals=0,projections=0;
  for(const [league,rows]of Object.entries(payload.leagues))for(const p of rows){
    const label=`${league}/${p.name}`;
    if(p.appeared){
      actuals++;
      assert.ok(p.gp>0&&p.minutes>0,`${label}: positive measured exposure`);
      close(p.gp,p.stats.off_gp,0,`${label}: games`);
      close(p.minutes,p.stats.off_min,.000501,`${label}: total minutes`);
      close(p.mpg,p.minutes/p.gp,.050501,`${label}: MPG`);
      for(const [field,total]of Object.entries(rates))close(p[field],p.stats[`off_${total}`]/p.gp,.000501,`${label}: ${field}/GP`);
      close(p.stats.off_reb,p.stats.off_oreb+p.stats.off_dreb,0,`${label}: rebound totals`);
      close(p.stats.off_fg2m,p.stats.off_fgm-p.stats.off_fg3m,0,`${label}: two-point makes`);
      close(p.stats.off_fg2a,p.stats.off_fga-p.stats.off_fg3a,0,`${label}: two-point attempts`);
      for(const [field,makes,attempts]of [['fgPct','fgm','fga'],['fg3Pct','fg3m','fg3a'],['ftPct','ftm','fta']]){
        if(p.stats[`off_${attempts}`]>0)close(p[field],p.stats[`off_${makes}`]/p.stats[`off_${attempts}`],.000501,`${label}: pooled ${field}`);
      }
      if(p.stats.off_fga>0)close(p.efg,(p.stats.off_fgm+.5*p.stats.off_fg3m)/p.stats.off_fga,.000051,`${label}: actual eFG`);
      const actualTsDen=2*(p.stats.off_fga+.44*p.stats.off_fta);
      if(actualTsDen>0)close(p.ts,p.stats.off_pts/actualTsDen,.000051,`${label}: actual true shooting`);
      if(league==='NBA')close(p.stats.off_pts,2*p.stats.off_fgm+p.stats.off_fg3m+p.stats.off_ftm,0,`${label}: NBA point totals`);
      else {
        const freeThrowPoints=p.stats.off_pts-2*p.stats.off_fgm-p.stats.off_fg3m;
        assert.ok(freeThrowPoints>=p.stats.off_ftm&&freeThrowPoints<=3*p.stats.off_ftm,`${label}: G League weighted FT points`);
      }
      for(const key of ['pts','reb','oreb','dreb','ast','stl','blk','tov','pf','fg3'])close(p.per36[key],p.stats[`off_${rates[key]}`]*36/p.minutes,.050501,`${label}: ${key}/36`);
    }
    if(!p.proj||p.proj.abstain)continue;
    projections++;
    const q=p.proj,a=q.accounting;
    assert.ok(a&&a.totals,`${label}: complete accounting`);
    close(a.pts,2*a.fgm+a.fg3m+a.ftm*a.ftValue,1e-6,`${label}: forecast points`);
    close(a.reb,a.oreb+a.dreb,1e-6,`${label}: forecast rebounds`);
    assert.ok(a.fgm<=a.fga&&a.fg3m<=a.fg3a&&a.ftm<=a.fta,`${label}: makes/attempts`);
    assert.ok(a.fgm-a.fg3m<=a.fga-a.fg3a,`${label}: two-point attempts`);
    assert.ok(a.ftValue>=1&&a.ftValue<=3&&(league!=='NBA'||a.ftValue===1),`${label}: league scoring`);
    close(q.gp,a.gp,.050001,`${label}: rounded expected games`);
    assert.ok(q.gp>=0&&q.gp<=(league==='NBA'?82:50),`${label}: schedule`);
    close(q.mpg,a.mpg,.050001,`${label}: headline minutes`);
    for(const key of projectionRates){close(q[key],a[key],.050001,`${label}: headline ${key}`);close(a.totals[key],a[key]*a.gp,1e-5,`${label}: total ${key}`);}
    for(const [field,makes,attempts]of [['fgPct','fgm','fga'],['fg3Pct','fg3m','fg3a'],['ftPct','ftm','fta']])if(a[attempts]>0)close(q[field],a[makes]/a[attempts],.001001,`${label}: forecast ${field}`);else assert.equal(q[field],null);
    if(a.fga+.44*a.fta>0)close(q.ts,a.pts/(2*(a.fga+.44*a.fta)),.001001,`${label}: forecast true shooting`);
  }
  for(const [team,budget]of Object.entries(payload.projectionMeta.teamBudgets)){
    const roster=payload.leagues.NBA.filter(p=>p.currentTeam===team);
    const modeled=roster.filter(p=>p.proj&&!p.proj.abstain);
    close(roster.length,budget.rosterPlayers,0,`${team}: roster count`);
    close(modeled.length,budget.projectedPlayers,0,`${team}: modeled count`);
    close(roster.length-modeled.length,budget.unprojectedRosterPlayers,0,`${team}: missing count`);
    const minutes=modeled.reduce((sum,p)=>sum+p.proj.accounting.mpg*p.proj.accounting.gp/82,0);
    close(minutes,budget.allocated,1e-6,`${team}: precise effective minutes`);
    assert.ok(minutes+budget.unmodeledReserve<=240.000001,`${team}: total roster minute budget`);
    const totals=Object.fromEntries(projectionRates.map(k=>[k,modeled.reduce((sum,p)=>sum+p.proj.accounting.totals[k],0)]));
    close(totals.pts,2*totals.fgm+totals.fg3m+totals.ftm,1e-5,`${team}: pooled point totals`);
    close(totals.reb,totals.oreb+totals.dreb,1e-5,`${team}: pooled rebound totals`);
  }
  return {actuals,projections};
}
console.log('Independent arithmetic oracle:',audit(data));
for(const mutate of [p=>p.pts+=1,p=>p.stats.off_reb+=1,p=>p.proj.accounting.totals.pts+=10,p=>p.proj.accounting.ftValue=2]){
  const altered=structuredClone(data);mutate(altered.leagues.NBA.find(p=>p.appeared&&p.proj&&!p.proj.abstain));
  assert.throws(()=>audit(altered),'Deliberately corrupted player must fail');
}
const altered=structuredClone(data);Object.values(altered.projectionMeta.teamBudgets)[0].allocated+=1;
assert.throws(()=>audit(altered),'Deliberately corrupted team ledger must fail');
console.log('Five corruption controls rejected; independent player and roster accounting passed');

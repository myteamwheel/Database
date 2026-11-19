import assert from 'node:assert/strict';
import fs from 'node:fs';
import {distributeMinutes, planRoster, rotationFeatures, teamGames} from '../scripts/lib/gleague-rotation.mjs';
const read=path=>JSON.parse(fs.readFileSync(new URL('../'+path,import.meta.url)));
const model=read('scripts/data/gleague-rotation/model.json');
const {leagues,gLeagueRotationMeta:meta,gLeagueTracker,gLeagueSeasonProgress:progress}=read('public/data.json');
assert.equal(meta.version,model.version);
assert.equal(meta.completedThrough,progress.completedThrough);
assert.equal(meta.rosterAsOf,gLeagueTracker.asOf);
assert.ok(model.validation.start>model.trainThrough&&model.validation.playerGames>4000);
assert.ok(model.validation.mae<model.validation.repeatMpgMae);
const ids=['1','2','3','4','5','6','7'];
assert.equal(planRoster([],ids,model),null);
const capped=distributeMinutes(ids.map((id,i)=>({id,target:i===0?200:4})));
assert.equal(capped.get('1'),40);
assert.equal([...capped.values()].reduce((a,v)=>a+Math.round(v*10),0),2400);
assert.equal(distributeMinutes(ids.slice(0,5).map(id=>({id,target:30}))),null);
assert.equal(rotationFeatures([{lines:new Map()}],'new'),null);
assert.throws(()=>teamGames({resultSets:[{headers:[],rowSet:[]}]},meta.completedThrough),/schema/);
let feasible=0,scores=0;
for(const team of gLeagueTracker.teams){
  const rows=leagues.GLEAGUE.filter(p=>p.currentGLeagueRosterTeam===team.team);
  assert.equal(rows.length,team.listed);
  const planned=rows.filter(p=>!p.tulipRotation.abstain);
  if(!planned.length){assert.ok(rows.every(p=>['no_team_games','insufficient_roster_capacity'].includes(p.tulipRotation.reason)));continue;}
  feasible++;
  assert.equal(planned.length,rows.length);
  assert.equal(planned.reduce((a,p)=>a+Math.round(10*p.tulipRotation.recommendedMpg),0),2400);
  for(const p of planned){
    const t=p.tulipRotation,a=p.gLeagueSeasonActual.phases[meta.phase];
    assert.equal(t.phase,meta.phase);
    assert.ok(t.recommendedMpg>=0&&t.recommendedMpg<=40);
    assert.equal(t.currentMpg,a.perGame?.mpg??null);
    assert.equal(t.tulip,a.gp?Math.round(10*(t.recommendedMpg-a.perGame.mpg))/10||0:null);
    if(t.tulip!=null)scores++;
  }
}
assert.equal(feasible,meta.teams);assert.equal(scores,meta.scores);
assert.ok(leagues.GLEAGUE.filter(p=>!p.currentGLeagueRosterTeam).every(p=>p.tulipRotation.reason==='no_gleague_roster'&&p.tulipRotation.tulip==null));
console.log(feasible+' G League teams with 240-minute rotations and '+scores+' phase-specific scores verified.');

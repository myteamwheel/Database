import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildStints} from '../scripts/lib/roster.mjs';
import {DATA_DIR} from '../scripts/lib/sources.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stint-identity-'));
try{
  const file=path.join(dir,'rows.json');
  const fixture=[
    {PLAYER_ID:1,TEAM_ID:1610612762,QUERIED_TEAM_ID:1610612762,TEAM_ABBREVIATION:'UTA',TEAM_COUNT:1,GP:3,MIN:72,PTS:67},
    {PLAYER_ID:2,TEAM_ID:1610612763,QUERIED_TEAM_ID:1610612763,TEAM_ABBREVIATION:'MEM',TEAM_COUNT:1,GP:40,MIN:1000,PTS:700},
    {PLAYER_ID:1,TEAM_ID:1610612762,QUERIED_TEAM_ID:1610612763,TEAM_ABBREVIATION:'UTA',TEAM_COUNT:1,GP:45,MIN:1382,PTS:864},
  ];
  for(const rows of [fixture,[...fixture].reverse()]){
    fs.writeFileSync(file,JSON.stringify(rows));
    const stints=buildStints([{file:path.relative(DATA_DIR,file),label:'regular'}]).get(1);
    assert.deepEqual(stints.map(s=>[s.team,s.teamId,s.gp]),[['MEM',1610612763,45],['UTA',1610612762,3]]);
    assert.equal(stints.reduce((sum,s)=>sum+s.gp,0),48);
  }
  fs.writeFileSync(file,JSON.stringify([...fixture,{...fixture[1],TEAM_ABBREVIATION:'WRONG'}]));
  assert.throws(()=>buildStints([{file:path.relative(DATA_DIR,file),label:'regular'}]),/Conflicting/);
  fs.writeFileSync(file,JSON.stringify([fixture[2]]));
  assert.throws(()=>buildStints([{file:path.relative(DATA_DIR,file),label:'regular'}]),/Unresolved/);
  fs.writeFileSync(file,JSON.stringify([fixture[0],fixture[0]]));
  assert.throws(()=>buildStints([{file:path.relative(DATA_DIR,file),label:'regular'}]),/Duplicate/);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
// Independent reconstruction from the query-scoped raw sources: do not call
// buildStints or its abbreviation helper when auditing the published payload.
const published=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url)));
let checked=0;
for(const [league,files] of [['NBA',[['stints_nba.json','regular']]],['GLEAGUE',[['stints_gleague_regular.json','regular'],['stints_gleague_showcase.json','showcase']]]]) {
  const phases=files.map(([file,label])=>({label,rows:JSON.parse(fs.readFileSync(path.join(DATA_DIR,file)))}));
  const canonical=new Map(), expected=new Map();
  for(const {rows} of phases) for(const r of rows) if(r.TEAM_ID===r.QUERIED_TEAM_ID) {
    const prior=canonical.get(r.QUERIED_TEAM_ID);
    assert.ok(!prior||prior===r.TEAM_ABBREVIATION,'Conflicting verified query-team identity');
    canonical.set(r.QUERIED_TEAM_ID,r.TEAM_ABBREVIATION);
  }
  for(const {rows,label} of phases) {
    const seen=new Set();
    for(const r of rows) {
      const key=`${r.PLAYER_ID}:${r.QUERIED_TEAM_ID}`;
      assert.ok(!seen.has(key),'Duplicate player/query within one competition phase'); seen.add(key);
      assert.ok(canonical.has(r.QUERIED_TEAM_ID),'Unresolved queried team');
      if(!expected.has(String(r.PLAYER_ID))) expected.set(String(r.PLAYER_ID),new Map());
      const teams=expected.get(String(r.PLAYER_ID));
      if(!teams.has(r.QUERIED_TEAM_ID)) teams.set(r.QUERIED_TEAM_ID,{totals:{},halves:{}});
      const x=teams.get(r.QUERIED_TEAM_ID); x.halves[label]=r.GP;
      for(const field of ['GP','MIN','PTS','REB','OREB','DREB','AST','STL','BLK','TOV','PF','FGM','FGA','FG3M','FG3A','FTM','FTA','PLUS_MINUS']) x.totals[field]=(x.totals[field]||0)+(r[field]||0);
    }
  }
  const round=(v,n)=>Math.round(v*10**n)/10**n || 0; // JSON canonicalizes negative zero.
  for(const p of published.leagues[league]) {
    const teams=expected.get(String(p.playerId)); if(!teams)continue;
    assert.equal(p.teams.length,teams.size,`${league}/${p.name}: every queried stint retained`);
    for(const s of p.teams) {
      const x=teams.get(s.teamId); assert.ok(x,`${p.name}: unexpected team ID`);
      assert.equal(s.team,canonical.get(s.teamId)); assert.deepEqual(s.halves,x.halves);
      const t=x.totals; assert.equal(s.gp,t.GP); assert.equal(s.min,round(t.MIN,1));
      for(const [display,raw] of [['mpg','MIN'],['pts','PTS'],['reb','REB'],['ast','AST'],['stl','STL'],['blk','BLK'],['plusMinus','PLUS_MINUS']]) assert.equal(s[display],t.GP?round(t[raw]/t.GP,1):null,`${p.name}/${s.team}/${display}`);
      for(const [display,makes,attempts] of [['fgPct','FGM','FGA'],['fg3Pct','FG3M','FG3A'],['ftPct','FTM','FTA']]) assert.equal(s[display],t[attempts]?round(t[makes]/t[attempts],3):null);
      assert.equal(s.plusMinusTotal,t.PLUS_MINUS); checked++;
      for(const [key,raw]of Object.entries({pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fg3:'FG3M',fga:'FGA',fg3a:'FG3A',fta:'FTA',pf:'PF'}))assert.equal(s.per36[key],t.MIN>0?round(t[raw]*36/t.MIN,1):null,`${p.name}/${s.team}: precise scoped ${key}`);
    }
  }
}
console.log(`Independent source audit passed: ${checked} published NBA/G League team stints, identities, phase games, exposure, rates and shooting percentages`);
console.log('Stint identity passed: traded current-team labels cannot corrupt historical query teams; row-order independence and conflicting identity rejection');

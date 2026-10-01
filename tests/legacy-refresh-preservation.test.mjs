import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {officialRows,writeAtomicJson} from '../scripts/lib/official-table.mjs';
const table={resultSets:[{headers:['PLAYER_ID','TEAM_ID','GP'],rowSet:[[1,10,2]]}]};
assert.deepEqual(officialRows(table),[{PLAYER_ID:1,TEAM_ID:10,GP:2}]);
assert.deepEqual(officialRows({resultSets:[{headers:['PLAYER_ID'],rowSet:[]}]}),[]);
for(const bad of [null,{}, {resultSets:[{headers:['PLAYER_ID','PLAYER_ID'],rowSet:[]}]},{resultSets:[{headers:['PLAYER_ID'],rowSet:[[1,2]]}]},{resultSets:[{headers:['PLAYER_ID'],rowSet:[[false]]}]},{resultSets:[{headers:['TEAM_ID'],rowSet:[]}]}]) assert.throws(()=>officialRows(bad));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-refresh-'));
try {
  const atomic=path.join(root,'atomic.json');writeAtomicJson(atomic,{old:true});
  const circular={};circular.self=circular;
  assert.throws(()=>writeAtomicJson(atomic,circular));assert.deepEqual(JSON.parse(fs.readFileSync(atomic)),{old:true});
  writeAtomicJson(atomic,table);
  assert.throws(()=>writeAtomicJson(atomic,{resultSets:[{headers:['PLAYER_ID'],rowSet:[]}]}),/empty replacement/);
  assert.deepEqual(JSON.parse(fs.readFileSync(atomic)),table);
  writeAtomicJson(atomic,[{PLAYER_ID:1}]);assert.throws(()=>writeAtomicJson(atomic,[]),/empty replacement/);
  for(const script of ['fetch-stints.mjs','fetch-splits.mjs'])for(const failure of ['offline','malformed']) {
    const sandbox=path.join(root,script+failure);fs.mkdirSync(path.join(sandbox,'scripts/lib'),{recursive:true});
    fs.copyFileSync(new URL(`../scripts/${script}`,import.meta.url),path.join(sandbox,'scripts',script));
    fs.copyFileSync(new URL('../scripts/lib/official-table.mjs',import.meta.url),path.join(sandbox,'scripts/lib/official-table.mjs'));
    fs.mkdirSync(path.join(sandbox,'scripts/data/official_nba'),{recursive:true});
    fs.writeFileSync(path.join(sandbox,'scripts/data/official_nba/base_totals.json'),JSON.stringify({resultSets:[{headers:['TEAM_ID'],rowSet:[[10],[20]]}]}));
    fs.mkdirSync(path.join(sandbox,'scripts/data/splits_nba'),{recursive:true});
    const target=path.join(sandbox,'scripts/data',script==='fetch-stints.mjs'?'stints_nba.json':'splits_nba/home.json');
    fs.writeFileSync(target,'{"previous":"verified"}');
    const mock=path.join(sandbox,'mock.mjs');
    fs.writeFileSync(mock,`globalThis.setTimeout=(f)=>{queueMicrotask(f);return 0;};globalThis.clearTimeout=()=>{};globalThis.fetch=async url=>{${script==='fetch-stints.mjs'?`if(new URL(url).searchParams.get('TeamID')==='10')return {ok:true,json:async()=>(${JSON.stringify(table)})};`:''}${failure==='offline'?"throw new Error('offline fixture');":"return {ok:true,json:async()=>({resultSets:[{headers:['PLAYER_ID'],rowSet:[[false]]}]})};"}};`);
    const run=spawnSync(process.execPath,['--import',mock,path.join(sandbox,'scripts',script)],{encoding:'utf8',timeout:10000});
    assert.notEqual(run.status,0,`${script}/${failure} must fail`);
    assert.match(run.stderr,/previous cache retained/);
    assert.equal(fs.readFileSync(target,'utf8'),'{"previous":"verified"}',`${script}/${failure} preserves exact old cache`);
    assert.ok(!fs.existsSync(path.join(sandbox,'scripts/data/provenance_splits.json')),'Failure must not stamp a fresh successful provenance');
  }
} finally {fs.rmSync(root,{recursive:true,force:true});}
console.log('Legacy refresh guards passed: malformed identity/schema rejection; real empty tables; atomic serialization; offline/malformed stint and split failures preserve cached bytes');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runOwnerRefresh, ownerRefreshStages } from '../scripts/lib/owner-refresh.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-refresh-'));
try{
  fs.mkdirSync(path.join(root,'scripts/data/refresh-runs'),{recursive:true});
  const calls=[];
  const runner=async(stage)=>{
    calls.push(stage.id);
    return {code:0,stdout:`${stage.id} ok`,stderr:''};
  };
  const result=await runOwnerRefresh({
    root,
    season:'2025-26',
    now:()=> '2026-09-29T23:30:00Z',
    runStage:runner,
  });
  assert.equal(result.state,'verified-ready-to-publish');
  assert.deepEqual(calls, ownerRefreshStages({season:'2025-26'}).map(x=>x.id));
  assert.equal(calls.at(-1),'verify');
  assert.ok(calls.includes('fetch-live-roster'));
  assert.ok(calls.indexOf('fetch-live-roster') < calls.indexOf('build'));
  assert.equal(calls.includes('fetch-projection-inputs'),false,'routine refresh must preserve frozen model inputs');
  assert.ok(!calls.some(x=>/git|push|commit/i.test(x)));
  const saved=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/refresh-runs/latest.json'),'utf8'));
  assert.equal(saved.state,'verified-ready-to-publish');
  assert.equal(saved.stages.every(x=>x.status==='ok'),true);

  const failRoot=fs.mkdtempSync(path.join(os.tmpdir(),'owner-refresh-fail-'));
  try{
    fs.mkdirSync(path.join(failRoot,'scripts/data/refresh-runs'),{recursive:true});
    fs.mkdirSync(path.join(failRoot,'public'),{recursive:true});
    fs.writeFileSync(path.join(failRoot,'public/data.json'),'original data');
    fs.writeFileSync(path.join(failRoot,'public/standalone.html'),'original artifact');
    const failedCalls=[];
    const fail=await runOwnerRefresh({
      root:failRoot,
      season:'2025-26',
      now:()=> '2026-09-29T23:31:00Z',
      runStage:async(stage)=>{
        failedCalls.push(stage.id);
        if(stage.id==='build') for(const file of ['data.json','data-status.json','standalone.html']) {
          fs.writeFileSync(path.join(failRoot,'public',file),'unverified candidate');
        }
        return stage.id==='verify' ? {code:1,stdout:'',stderr:'verification failed'} : {code:0,stdout:'ok',stderr:''};
      },
    });
    assert.equal(fail.state,'failed');
    assert.match(fail.failure.reason,/verification failed|verify/i);
    assert.equal(failedCalls.includes('publish-status'),false);
    const failSaved=JSON.parse(fs.readFileSync(path.join(failRoot,'scripts/data/refresh-runs/latest.json'),'utf8'));
    assert.equal(failSaved.state,'failed');
    assert.equal(fs.readFileSync(path.join(failRoot,'public/data.json'),'utf8'),'original data');
    assert.equal(fs.readFileSync(path.join(failRoot,'public/standalone.html'),'utf8'),'original artifact');
    assert.equal(fs.existsSync(path.join(failRoot,'public/data-status.json')),false);
  } finally { fs.rmSync(failRoot,{recursive:true,force:true}); }

  const unsupported=[];
  await assert.rejects(runOwnerRefresh({
    root,
    season:'2026-27',
    runStage:async(stage)=>{unsupported.push(stage.id); return {code:0,stdout:'',stderr:''};},
  }),/builder|supported|2025-26/i);
  assert.equal(unsupported.length,0);

  console.log('owner refresh tests passed: ordered stages, no git push, fail-before-publication, run record, unsupported-season guard');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

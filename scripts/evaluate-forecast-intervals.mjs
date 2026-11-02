import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateChronologicalIntervals} from './lib/interval-calibration.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'database-interval-eval-'));
try{
  const run=(mode,name)=>{
    const out=path.join(dir,`${name}.json`);
    execFileSync(process.execPath,['scripts/fit-projections.mjs',...(mode?['dev']:[])],{
      cwd:root,env:{...process.env,PROJ_EVAL_ROWS:out},stdio:['ignore','pipe','inherit'],maxBuffer:16*1024*1024});
    return JSON.parse(fs.readFileSync(out,'utf8'));
  };
  const calibration=run(true,'calibration');
  const test=run(false,'test');
  const report=evaluateChronologicalIntervals(calibration,test);
  const output=process.argv[2]||path.join(root,'docs/FORECAST_INTERVAL_EVALUATION.json');
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(`Wrote chronological interval evaluation: ${report.stats.pts.cohorts.all.n} tested veterans, points coverage ${report.stats.pts.cohorts.all.coverage} against nominal ${report.nominalCoverage}.`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}

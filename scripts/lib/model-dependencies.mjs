import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function modelDependencyClosure(root,groups) {
  const run=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('../model-code-dependencies.mjs',import.meta.url)),root,JSON.stringify(groups)],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  if(run.status!==0)throw new Error(`Model dependency audit failed: ${run.stderr||run.error?.message||run.status}`);
  return JSON.parse(run.stdout);
}

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const read = name => fs.readFileSync(new URL(`../.github/workflows/${name}`,import.meta.url),'utf8');
const deploy=read('deploy-pages.yml'), rebuild=read('rebuild-generated.yml');
const paths=source=>source.split('    paths:')[1].split('  workflow_dispatch:')[0];
assert.deepEqual([...paths(deploy).matchAll(/- '([^']+)'/g)].map(m=>m[1]),['public/**','.github/workflows/deploy-pages.yml']);
for(const source of ['scripts/**','app.js','workspace.js','history-lab.js','history-lab.html','index.html','styles.css','package.json','package-lock.json','PROJECTION_2026_27.json']) assert.ok(paths(rebuild).includes(`'${source}'`),`${source} must rebuild before deployment`);
assert.ok(!paths(rebuild).includes("'public/**'"),'Generated artifacts must not recurse into rebuild');
assert.ok(rebuild.indexOf('npm run build')<rebuild.indexOf('git push origin'),'Build before publishing');
assert.ok(rebuild.indexOf('node scripts/verify-artifact.mjs')<rebuild.indexOf('git push origin'),'Verify artifacts before publishing');
assert.ok(rebuild.indexOf('git push origin')<rebuild.indexOf('gh workflow run deploy-pages.yml'),'Dispatch deploy only after successful artifact push');
assert.ok(rebuild.includes('for attempt in 1 2 3'),'Bounded retry for advancement during upload');
assert.ok(rebuild.includes('if [ "$pushed" != true ]'),'Exhausted retries must fail before deploy');
assert.ok(!/git push[^\n]*(?:--force|\s-f\b)/.test(rebuild),'Never force away concurrent evidence');
const retryBlock=rebuild.match(/          pushed=false[\s\S]*?\n\n          # Pushes/)[0].split('\n\n          # Pushes')[0];
for(const failures of [1,3]){
  const stub=`push_count=0\ngit() {\n case "$1" in\n fetch|rebase) echo "$1" ;;\n push) push_count=$((push_count + 1)); echo "push:$push_count"; if [ "$push_count" -le ${failures} ]; then return 1; fi ;;\n *) return 99 ;;\n esac\n}\n`;
  const result=spawnSync('bash',['-euo','pipefail'],{input:stub+retryBlock+'\necho DEPLOY_READY\n',encoding:'utf8',env:{...process.env,GITHUB_REF_NAME:'v3-official-data'}});
  assert.equal(result.status,failures===1?0:1,'Production retry block preserves shell failure semantics');
  assert.equal((result.stdout.match(/push:/g)||[]).length,failures===1?2:3);
  assert.equal(result.stdout.includes('DEPLOY_READY'),failures===1,'Never dispatch after exhausted push attempts');
  assert.equal((result.stdout.match(/fetch\n/g)||[]).length,failures===1?2:3,'Every retry refetches competing updates');
}
assert.ok(deploy.includes('npm run verify:publication'),'Reject stale or mismatched publication');
assert.ok(deploy.includes('cancel-in-progress: false'),'Do not cancel active Pages deployments');
console.log('Deployment routing passed: source/card edits rebuild first; no output rebuild recursion; exact publication gate retained; final artifact deploy explicitly dispatched');

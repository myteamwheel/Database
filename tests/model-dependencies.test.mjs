import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {modelDependencyClosure} from '../scripts/lib/model-dependencies.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-deps-'));
const outside=fs.mkdtempSync(path.join(os.tmpdir(),'model-deps-outside-'));
try {
  const write=(name,source)=>{const full=path.join(root,name);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,source);};
  write('a.mjs',`import fs from 'node:fs';
    import { x }
      from './b.mjs';
    export * from './c.mjs';
    // import x from './fake.mjs';
    const text="import y from './not-a-module.mjs';";
    throw new Error('PARSER MUST NEVER EXECUTE THIS');`);
  write('b.mjs',`export {z as x} from './nested/d.mjs';`);
  write('c.mjs',`export const c=1;`);
  write('nested/d.mjs',`import '../a.mjs';export const z=1;`);
  assert.deepEqual(modelDependencyClosure(root,{one:['a.mjs'],two:['c.mjs']}),{one:['a.mjs','b.mjs','c.mjs','nested/d.mjs'],two:['c.mjs']});
  write('dynamic.mjs',`const unused=()=>import /* hidden separator */ ('./c.mjs');`);
  assert.throws(()=>modelDependencyClosure(root,{one:['dynamic.mjs']}),/Dynamic/);
  write('bare.mjs',`import 'unpinned-package';`);
  assert.throws(()=>modelDependencyClosure(root,{one:['bare.mjs']}),/Unpinned/);
  write('syntax.mjs',`export const = 1;`);
  assert.throws(()=>modelDependencyClosure(root,{one:['syntax.mjs']}),/audit failed/);
  write('escape.mjs',`import '../outside.mjs';`);
  assert.throws(()=>modelDependencyClosure(root,{one:['escape.mjs']}),/escapes/);
  fs.writeFileSync(path.join(outside,'anything.mjs'),'export const x=1;');
  fs.symlinkSync(outside,path.join(root,'outside'));
  write('link.mjs',`import './outside/anything.mjs';`);
  assert.throws(()=>modelDependencyClosure(root,{one:['link.mjs']}),/escapes/);
} finally {fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
console.log('Native dependency parser passed: transitive imports/reexports/cycles, no evaluation, no fake comment/string imports, dynamic/bare/malformed/escaping dependencies fail closed');

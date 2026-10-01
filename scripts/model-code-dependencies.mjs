// Compile for dependency discovery only. Never link, instantiate or evaluate.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {isBuiltin} from 'node:module';

const root=fs.realpathSync(process.argv[2]), groups=JSON.parse(process.argv[3]);
const inside=file=>{const relative=path.relative(root,file);return relative!==''&&relative.split(path.sep)[0]!=='..'&&!path.isAbsolute(relative);};
const parsed=new Map();
function dependencies(relative) {
  const requested=path.resolve(root,relative);
  if(!inside(requested))throw new Error(`Model dependency escapes repository: ${relative}`);
  const full=fs.realpathSync(requested);
  if(!inside(full))throw new Error(`Model dependency escapes repository: ${relative}`);
  if(parsed.has(relative))return parsed.get(relative);
  const source=fs.readFileSync(full,'utf8');
  // Dynamic module loading has no statically enumerable closure. Current model
  // code does not use it; reject it instead of silently emitting partial hashes.
  if(/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/.test(source))throw new Error(`Dynamic model dependency requires an explicit audited policy: ${relative}`);
  const module=new vm.SourceTextModule(source,{identifier:full});
  const requests=module.moduleRequests?.map(r=>r.specifier)||module.dependencySpecifiers;
  const locals=[];
  for(const spec of requests) {
    if(isBuiltin(spec))continue;
    if(!spec.startsWith('.'))throw new Error(`Unpinned nonlocal model dependency: ${relative} -> ${spec}`);
    const target=path.resolve(path.dirname(full),spec);
    if(!inside(target))throw new Error(`Model dependency escapes repository: ${spec}`);
    locals.push(path.relative(root,target).split(path.sep).join('/'));
  }
  parsed.set(relative,locals);return locals;
}
const result={};
for(const [key,entries] of Object.entries(groups)) {
  const seen=new Set();
  const visit=file=>{if(seen.has(file))return;seen.add(file);for(const dep of dependencies(file))visit(dep);};
  for(const entry of entries)visit(entry);
  result[key]=[...seen].sort();
}
process.stdout.write(JSON.stringify(result));

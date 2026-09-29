import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreArchive } from './lib/forecast-archive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out={interim:false};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--archive') out.archive=argv[++i];
    else if(a==='--actual') out.actual=argv[++i];
    else if(a==='--interim') out.interim=true;
    else if(a==='--out') out.out=argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if(!out.archive||!out.actual) throw new Error('--archive and --actual are required');
  return out;
}

function archivePath(value){
  if(fs.existsSync(value)) return value;
  const underRoot=path.resolve(ROOT,value);
  if(fs.existsSync(underRoot)) return underRoot;
  const byId=path.join(ROOT,'scripts/data/forecast-archive',value.endsWith('.json')?value:`${value}.json`);
  if(fs.existsSync(byId)) return byId;
  throw new Error(`forecast archive not found: ${value}`);
}

export function runScoreCli(opts){
  const archive=JSON.parse(fs.readFileSync(archivePath(opts.archive),'utf8'));
  const actual=JSON.parse(fs.readFileSync(path.resolve(opts.actual),'utf8'));
  const report=scoreArchive(archive,actual,{interim:opts.interim});
  const output=JSON.stringify(report,null,1)+'\n';
  if(opts.out) fs.writeFileSync(path.resolve(opts.out),output);
  return output;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.stdout.write(runScoreCli(parseArgs(process.argv.slice(2))));
}

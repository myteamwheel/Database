import fs from 'node:fs';
import path from 'node:path';
import { buildMaterialChangeReport, validateMaterialChangeReport } from './lib/material-change-explanations.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--before') out.before = argv[++i];
    else if (arg === '--after') out.after = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!out.before || !out.after) throw new Error('--before and --after are required');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const before = JSON.parse(fs.readFileSync(args.before, 'utf8'));
const after = JSON.parse(fs.readFileSync(args.after, 'utf8'));
const report = buildMaterialChangeReport(before, after);
validateMaterialChangeReport(report);
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.summary));

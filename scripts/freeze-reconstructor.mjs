// Freeze and version the deterministic reconstructor.
//
// A rule version must be frozen BEFORE it is evaluated on untouched validation games, otherwise
// "held out" means nothing. This records the rule-file content hash alongside the metrics that
// version achieved, so a later change can be attributed to a specific rule set rather than to
// accumulated undocumented edits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG = path.join(ROOT, 'scripts/data/history/reconstructor_versions.json');
const label = process.argv[2] || 'unlabelled';
const RULE_FILES = ['scripts/lib/lineup.mjs', 'scripts/lib/rotation.mjs'];

const hashes = {};
for (const f of RULE_FILES) {
  hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').slice(0, 16);
}
const run = (cmd) => { try { return execSync(cmd, { cwd: ROOT }).toString(); } catch (e) { return String(e.stdout || e.message); } };
const dev = run('node scripts/eval-lineup.mjs --set=development');
const parse = (out, re) => { const m = re.exec(out); return m ? m[1] : null; };
const metrics = {
  developmentSet: {
    games: parse(dev, /· (\d+) games/),
    openingFive: parse(dev, /opening five\s+([\d.]+%)/),
    q2Open: parse(dev, /Q2 opening lineup\s+([\d.]+%)/),
    q3Open: parse(dev, /Q3 opening lineup\s+([\d.]+%)/),
    stintCount: parse(dev, /stint count exact\s+([\d.]+%)/),
    firstEntryMean: parse(dev, /first entry\s+mean ([\d.]+)m/),
    totalMinMean: parse(dev, /total minutes mean ([\d.]+)m/),
  },
};
const reg = fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, 'utf8')) : { versions: [] };
reg.versions.push({
  label, frozenAt: new Date().toISOString(), ruleHashes: hashes, metrics,
  note: 'Development metrics only. Validation must be run ONCE against this frozen version.',
});
fs.writeFileSync(REG, JSON.stringify(reg, null, 1));
console.log(`FROZEN as "${label}"`);
console.log(JSON.stringify({ ruleHashes: hashes, metrics }, null, 1));
console.log(`\nversions recorded: ${reg.versions.length} -> scripts/data/history/reconstructor_versions.json`);

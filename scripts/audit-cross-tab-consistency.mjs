import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCrossTabConsistency } from './lib/cross-tab-consistency.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=JSON.parse(fs.readFileSync(path.join(ROOT,'public/data.json'),'utf8'));
const report=auditCrossTabConsistency(data);
if(report.warnings.length) console.warn(report.warnings.join('\n'));
if(report.errors.length){
  console.error(report.errors.join('\n'));
  process.exit(1);
}
console.log(`cross-tab consistency verified · NBA ${report.summary.nbaPlayers} · G League ${report.summary.gleaguePlayers} · NBA Team Fit ${report.summary.nbaTeamFitTeams} teams · roster-only ${report.summary.rosterOnlyPlayers} · dual-league ${report.summary.dualLeaguePeople}`);

import fs from 'node:fs';
import assert from 'node:assert/strict';

let auditMod = null;
let importError = null;
try {
  auditMod = await import('../scripts/lib/cross-tab-consistency.mjs');
} catch (err) {
  importError = err;
}

assert.equal(importError, null, `cross-tab consistency module missing: ${importError?.message || ''}`);
assert.equal(typeof auditMod.auditCrossTabConsistency, 'function');

const data = JSON.parse(fs.readFileSync(new URL('../public/data.json', import.meta.url), 'utf8'));
const report = auditMod.auditCrossTabConsistency(data);

assert.deepEqual(report.errors, [], report.errors.join('\n'));
assert.ok(report.summary.nbaPlayers > 0);
assert.ok(report.summary.gleaguePlayers > 0);
assert.ok(report.summary.nbaTeamFitTeams >= 29, `team-fit teams: ${report.summary.nbaTeamFitTeams}`);
assert.ok(report.summary.currentRosterMeasuredProfiles > 0);
assert.ok(report.summary.rosterOnlyPlayers > 0);
assert.ok(report.summary.dualLeaguePeople > 0);

for (const row of report.teamFitTeams) {
  assert.equal(row.publishedMeasuredProfiles, row.expectedMeasuredProfiles,
    `${row.team}: Team Fit roster basis does not match current-roster measured profiles`);
}
for (const row of report.currentRosterProjectionTeams) {
  assert.equal(row.projectionTeam, row.currentTeam,
    `${row.name}: projection team must match current roster team`);
}

console.log(`cross-tab consistency passed · NBA ${report.summary.nbaPlayers} · G League ${report.summary.gleaguePlayers} · Team Fit ${report.summary.nbaTeamFitTeams} teams · dual-league ${report.summary.dualLeaguePeople}`);

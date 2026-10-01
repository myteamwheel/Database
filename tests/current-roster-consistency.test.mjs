import fs from 'node:fs';
import assert from 'node:assert/strict';
import { verifyLiveRosterSnapshot } from '../scripts/lib/live-roster.mjs';

const roster = verifyLiveRosterSnapshot(JSON.parse(fs.readFileSync('scripts/data/live/roster.json', 'utf8')));
const data = JSON.parse(fs.readFileSync('public/data.json', 'utf8'));
const id = roster.headers.indexOf('PERSON_ID');
const team = roster.headers.indexOf('TEAM_ABBREVIATION');
const expected = new Map(roster.rows.map(row => [Number(row[id]), row[team]]));
const nba = new Map(data.leagues.NBA.map(player => [Number(player.nbaPersonId), player]));
assert.equal(data.projectionMeta.rostersAsOf, roster.fetchedAt.slice(0, 10));

for (const [personId, currentTeam] of expected) {
  const player = nba.get(personId);
  assert.ok(player, `current roster player ${personId} is absent from the database`);
  assert.equal(player.currentTeam, currentTeam, `${player.name} current team`);
  assert.equal(player.currentRoster, true, `${player.name} current roster flag`);
  assert.equal(player.proj?.team, currentTeam, `${player.name} projection team`);
  if (!player.appeared) {
    assert.equal(player.rosterOnly, true, `${player.name} has no invented 2025-26 appearance`);
    assert.equal(player.grade, null, `${player.name} has no invented 2025-26 grade`);
  }
}
for (const [personId, player] of nba) {
  if (expected.has(personId)) continue;
  assert.equal(player.currentTeam, null, `${player.name} retained a team after leaving the roster`);
  assert.equal(player.currentRoster, false, `${player.name} retained a roster flag`);
}
for (const player of data.leagues.GLEAGUE) {
  const expectedTeam = expected.get(Number(player.nbaPersonId)) || null;
  assert.equal(player.currentNbaTeam, expectedTeam, `${player.name} dual-league NBA affiliation`);
}
console.log(`current roster consistency passed: ${expected.size} official players, ${nba.size} NBA database records`);

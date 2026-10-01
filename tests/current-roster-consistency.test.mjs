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

// Verify every returning veteran's dated evidence against raw season tables, independently
// of projectionHistory and the builder's explanation helpers.
const inputs = JSON.parse(fs.readFileSync('scripts/data/projection/inputs.json', 'utf8'));
const decode = t => t.rows.map(row => Object.fromEntries(t.headers.map((h,i) => [h,row[i]])));
let returners = 0;
for (const league of ['NBA','GLEAGUE']) {
  const histories = new Map();
  for (const [season,tables] of Object.entries(inputs[league === 'NBA' ? 'nba' : 'gleague'])) {
    if (season >= '2026-27') continue;
    for (const row of decode(tables.base)) {
      if (!(row.MIN > 0 && row.GP > 0)) continue;
      const id = Number(row.PLAYER_ID);
      if (!histories.has(id)) histories.set(id, []);
      histories.get(id).push({season,gp:row.GP,min:Math.round(row.MIN)});
    }
  }
  for (const player of data.leagues[league]) {
    const history = (histories.get(Number(player.nbaPersonId)) || []).sort((a,b)=>b.season.localeCompare(a.season));
    // G League's current line also includes Showcase Cup; those appearances are not gaps.
    if (player.appeared || !history.length || history[0].season === '2025-26') continue;
    returners++;
    assert.ok(player.proj && !player.proj.abstain, `${player.name}: historical evidence should be usable`);
    const recent = history.filter(r=>r.season >= '2023-24');
    const used = recent.length ? recent : history.slice(0,3);
    const published = player.proj.why.seasons;
    assert.deepEqual(published.map(({season,gp,min})=>({season,gp,min})),used,`${player.name}: dated source evidence`);
    assert.equal(player.appeared,false,`${player.name}: no invented last-season appearance`);
    assert.equal(player.gp,0,`${player.name}: last-season appearance count`);
    assert.equal(player.grade,null,`${player.name}: no grade from older stats`);
    assert.equal(player.proj.availability.injuryStatus,'not-verified',`${player.name}: medical status`);
    if (recent.length) {
      assert.equal(player.proj.why.minutes.last,null,`${player.name}: no invented last-season MPG`);
      assert.equal(player.proj.why.games.lastShare,0,`${player.name}: true latest-season nonappearance`);
    } else {
      const fallback=player.proj.why.fallback;
      assert.equal(fallback.lastObservedSeason,history[0].season,`${player.name}: last active season`);
      assert.equal(fallback.blankSeasonGapCount,2026-Number(history[0].season.slice(0,4))-1,`${player.name}: calendar gaps`);
      assert.ok(['low','very-low'].includes(fallback.support),`${player.name}: historical support`);
      assert.equal(fallback.returnToPlayPredicted,false,`${player.name}: no return-to-play claim`);
      assert.ok(!fallback.note.includes('NBA'),`${player.name}: league-neutral fallback wording`);
    }
  }
}
assert.ok(returners>0,'returner cohort must be covered');
console.log(`Independent dated returner evidence passed: ${returners} NBA/G League veterans`);

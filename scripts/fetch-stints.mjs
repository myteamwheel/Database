// Per-team stint lines + the Showcase half of G League tracking.
//
// leaguedashplayerstats with TeamID=0 returns ONE aggregate row per player, so a player who
// changed teams shows full-season production beside a single team abbreviation. Querying each
// TeamID separately returns that player's line *for that team*, which is what team filtering
// and team history actually need.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(url, { headers: H, signal: c.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) { console.log(`    give up ${label}: ${e.message}`); return null; }
      await wait(2000 * i);
    }
  }
}

const dash = (leagueId, seasonType, teamId) =>
  'https://stats.nba.com/stats/leaguedashplayerstats?' + new URLSearchParams({
    College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
    DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: '0',
    LeagueID: leagueId, Location: '', MeasureType: 'Base', Month: '0', OpponentTeamID: '0',
    Outcome: '', PORound: '0', PaceAdjust: 'N', PerMode: 'Totals', Period: '0',
    PlayerExperience: '', PlayerPosition: '', PlusMinus: 'N', Rank: 'N', Season: '2025-26',
    SeasonSegment: '', SeasonType: seasonType, ShotClockRange: '', StarterBench: '',
    TeamID: String(teamId), TwoWay: '0', VsConference: '', VsDivision: '', Weight: '',
  }).toString();

const ptDash = (leagueId, seasonType, type) =>
  'https://stats.nba.com/stats/leaguedashptstats?' + new URLSearchParams({
    College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
    DraftPick: '', DraftYear: '', GameScope: '', Height: '', LastNGames: '0',
    LeagueID: leagueId, Location: '', Month: '0', OpponentTeamID: '0', Outcome: '',
    PORound: '0', PerMode: 'Totals', PlayerExperience: '', PlayerOrTeam: 'Player',
    PlayerPosition: '', PtMeasureType: type, Season: '2025-26', SeasonSegment: '',
    SeasonType: seasonType, StarterBench: '', TeamID: '0', VsConference: '',
    VsDivision: '', Weight: '',
  }).toString();

function rows(j) {
  if (!j) return [];
  const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  if (!rs || !rs.rowSet) return [];
  return rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]])));
}

/** Team ids present in a league's aggregate table. */
function teamIdsFrom(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data', dir, 'base_totals.json'), 'utf8'));
  const rs = j.resultSets[0];
  const idx = rs.headers.indexOf('TEAM_ID');
  return [...new Set(rs.rowSet.map((r) => r[idx]))].filter((x) => x);
}

const JOBS = [
  { league: '00', seasonType: 'Regular Season', dir: 'official_nba', out: 'stints_nba' },
  { league: '20', seasonType: 'Regular Season', dir: 'official_gleague_regular', out: 'stints_gleague_regular' },
  { league: '20', seasonType: 'Showcase', dir: 'official_gleague_regular', out: 'stints_gleague_showcase' },
];

for (const job of JOBS) {
  const teams = teamIdsFrom(job.dir);
  console.log(`${job.out}: ${teams.length} teams`);
  const all = [];
  for (const tid of teams) {
    const r = rows(await get(dash(job.league, job.seasonType, tid), `${job.out} team ${tid}`));
    // TEAM_ABBREVIATION on these rows is the player's CURRENT team, not the team queried, so
    // both of a traded player's stints come back labelled with wherever he ended up. The
    // queried id is the only reliable stint identity.
    for (const row of r) row.QUERIED_TEAM_ID = tid;
    all.push(...r);
    await wait(700);
  }
  fs.writeFileSync(path.join(ROOT, 'scripts/data', `${job.out}.json`), JSON.stringify(all));
  console.log(`  ${all.length} stint rows -> scripts/data/${job.out}.json`);
}

// Showcase half of the two tracking measures the G League actually serves.
fs.mkdirSync(path.join(ROOT, 'scripts/data/official_gleague_showcase'), { recursive: true });
for (const [name, type] of [['pt_catchshoot', 'CatchShoot'], ['pt_pullup', 'PullUpShot']]) {
  const j = await get(ptDash('20', 'Showcase', type), `showcase ${name}`);
  const n = rows(j).length;
  if (j) fs.writeFileSync(path.join(ROOT, 'scripts/data/official_gleague_showcase', `${name}.json`), JSON.stringify(j));
  console.log(`showcase ${name}: ${n} rows`);
  await wait(900);
}

// Regular-season tracking in Totals form so the two halves can be summed rather than averaged.
for (const [name, type] of [['pt_catchshoot_totals', 'CatchShoot'], ['pt_pullup_totals', 'PullUpShot']]) {
  const j = await get(ptDash('20', 'Regular Season', type), `regular ${name}`);
  const n = rows(j).length;
  if (j) fs.writeFileSync(path.join(ROOT, 'scripts/data/official_gleague_regular', `${name}.json`), JSON.stringify(j));
  console.log(`regular ${name}: ${n} rows`);
  await wait(900);
}
for (const [name, type] of [['pt_catchshoot_totals', 'CatchShoot'], ['pt_pullup_totals', 'PullUpShot']]) {
  const j = await get(ptDash('20', 'Showcase', type), `showcase ${name}`);
  if (j) fs.writeFileSync(path.join(ROOT, 'scripts/data/official_gleague_showcase', `${name}.json`), JSON.stringify(j));
  await wait(900);
}
console.log('done');

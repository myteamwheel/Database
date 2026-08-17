// Situational splits + season rosters.
//
// The league dashboard query already carries Location, Outcome, StarterBench and SeasonSegment
// parameters; they were simply left blank, so the database only ever held one season aggregate.
// These pull the same Base+Advanced measures per split, and the roster endpoint adds players who
// were on a roster but never appeared.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data');
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
const rows = (j) => {
  if (!j) return [];
  const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  return rs && rs.rowSet ? rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]]))) : [];
};

const dash = (leagueId, seasonType, measure, extra) =>
  'https://stats.nba.com/stats/leaguedashplayerstats?' + new URLSearchParams({
    College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
    DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: '0',
    LeagueID: leagueId, Location: '', MeasureType: measure, Month: '0', OpponentTeamID: '0',
    Outcome: '', PORound: '0', PaceAdjust: 'N', PerMode: 'Totals', Period: '0',
    PlayerExperience: '', PlayerPosition: '', PlusMinus: 'N', Rank: 'N', Season: '2025-26',
    SeasonSegment: '', SeasonType: seasonType, ShotClockRange: '', StarterBench: '', TeamID: '0',
    TwoWay: '0', VsConference: '', VsDivision: '', Weight: '', ...extra,
  }).toString();

const clutch = (leagueId, seasonType) =>
  'https://stats.nba.com/stats/leaguedashplayerclutch?' + new URLSearchParams({
    AheadBehind: 'Ahead or Behind', ClutchTime: 'Last 5 Minutes', College: '', Conference: '',
    Country: '', DateFrom: '', DateTo: '', Division: '', DraftPick: '', DraftYear: '',
    GameScope: '', GameSegment: '', Height: '', LastNGames: '0', LeagueID: leagueId, Location: '',
    MeasureType: 'Base', Month: '0', OpponentTeamID: '0', Outcome: '', PORound: '0',
    PaceAdjust: 'N', PerMode: 'Totals', Period: '0', PlayerExperience: '', PlayerPosition: '',
    PlusMinus: 'N', PointDiff: '5', Rank: 'N', Season: '2025-26', SeasonSegment: '',
    SeasonType: seasonType, ShotClockRange: '', StarterBench: '', TeamID: '0', TwoWay: '0',
    VsConference: '', VsDivision: '', Weight: '',
  }).toString();

/** Splits worth having: each is a real analytical dimension, not a slice of a slice. */
const SPLITS = [
  ['home', { Location: 'Home' }],
  ['road', { Location: 'Road' }],
  ['wins', { Outcome: 'W' }],
  ['losses', { Outcome: 'L' }],
  ['starter', { StarterBench: 'Starters' }],
  ['bench', { StarterBench: 'Bench' }],
  ['preallstar', { SeasonSegment: 'Pre All-Star' }],
  ['postallstar', { SeasonSegment: 'Post All-Star' }],
];

const LEAGUES = [
  { id: '00', seasonType: 'Regular Season', dir: 'splits_nba' },
  { id: '20', seasonType: 'Regular Season', dir: 'splits_gleague_regular' },
  { id: '20', seasonType: 'Showcase', dir: 'splits_gleague_showcase' },
];

const provenance = [];
for (const lg of LEAGUES) {
  const dir = path.join(OUT, lg.dir);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`${lg.dir}:`);
  for (const [name, extra] of SPLITS) {
    const j = await get(dash(lg.id, lg.seasonType, 'Base', extra), `${lg.dir}/${name}`);
    const r = rows(j);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(j));
    console.log(`  ${name.padEnd(12)} ${r.length} rows`);
    provenance.push({ dataset: `${lg.dir}/${name}`, rows: r.length, fetchedAt: new Date().toISOString() });
    await wait(900);
  }
  // Month is season-relative on this API (1 = the season's opening month). Absent months are
  // skipped rather than written empty, so the set differs by league.
  for (let m = 1; m <= 12; m++) {
    const mj = await get(dash(lg.id, lg.seasonType, 'Base', { Month: String(m) }), `${lg.dir}/month${m}`);
    const mr = rows(mj);
    if (mr.length) {
      fs.writeFileSync(path.join(dir, `month${m}.json`), JSON.stringify(mj));
      console.log(`  ${('month' + m).padEnd(12)} ${mr.length} rows`);
      provenance.push({ dataset: `${lg.dir}/month${m}`, rows: mr.length, fetchedAt: new Date().toISOString() });
    }
    await wait(800);
  }

  const cj = await get(clutch(lg.id, lg.seasonType), `${lg.dir}/clutch`);
  const cr = rows(cj);
  fs.writeFileSync(path.join(dir, 'clutch.json'), JSON.stringify(cj));
  console.log(`  ${'clutch'.padEnd(12)} ${cr.length} rows`);
  provenance.push({ dataset: `${lg.dir}/clutch`, rows: cr.length, fetchedAt: new Date().toISOString() });
  await wait(900);
}

// Season rosters, for players who were rostered but never appeared.
for (const [leagueId, dirName, sourceDir] of [
  ['00', 'rosters_nba', 'official_nba'],
  ['20', 'rosters_gleague', 'official_gleague_regular'],
]) {
  const base = JSON.parse(fs.readFileSync(path.join(OUT, sourceDir, 'base_totals.json'), 'utf8'));
  const idx = base.resultSets[0].headers.indexOf('TEAM_ID');
  const teams = [...new Set(base.resultSets[0].rowSet.map((r) => r[idx]))].filter(Boolean);
  const all = [];
  for (const tid of teams) {
    const j = await get('https://stats.nba.com/stats/commonteamroster?' + new URLSearchParams({
      LeagueID: leagueId, Season: '2025-26', TeamID: String(tid),
    }), `${dirName} ${tid}`);
    all.push(...rows(j));
    await wait(600);
  }
  fs.writeFileSync(path.join(OUT, `${dirName}.json`), JSON.stringify(all));
  console.log(`${dirName}: ${all.length} roster entries across ${teams.length} teams`);
  provenance.push({ dataset: dirName, rows: all.length, fetchedAt: new Date().toISOString() });
}

fs.writeFileSync(path.join(OUT, 'provenance_splits.json'), JSON.stringify(provenance, null, 1));
console.log('done');

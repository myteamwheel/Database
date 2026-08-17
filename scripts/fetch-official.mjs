// Generic stats.nba.com puller. Usage: node fetch-official.mjs <LeagueID> <outDir>
// outDir is resolved relative to the repository root, so this works from any checkout.
//   LeagueID 00 = NBA, 20 = NBA G League
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEAGUE_ID = process.argv[2];
const SEASON_TYPE = process.argv[4] || 'Regular Season';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[3] || 'scripts/data/official');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-site',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.log(`   attempt ${i}/${tries} failed (${label}): ${e.message}`);
      if (i === tries) return null;
      await wait(2500 * i);
    }
  }
}

const base = (extra) => new URLSearchParams({
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '',
  LastNGames: '0', LeagueID: LEAGUE_ID, Location: '', Month: '0', OpponentTeamID: '0',
  Outcome: '', PORound: '0', PaceAdjust: 'N', Period: '0', PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', Season: '2025-26', SeasonSegment: '',
  SeasonType: SEASON_TYPE, ShotClockRange: '', StarterBench: '', TeamID: '0',
  TwoWay: '0', VsConference: '', VsDivision: '', Weight: '', ...extra,
}).toString();

const dash = (measure, perMode) =>
  'https://stats.nba.com/stats/leaguedashplayerstats?' + base({ MeasureType: measure, PerMode: perMode });

const ptDash = (type) =>
  'https://stats.nba.com/stats/leaguedashptstats?' + new URLSearchParams({
    College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
    DraftPick: '', DraftYear: '', GameScope: '', Height: '', LastNGames: '0',
    LeagueID: LEAGUE_ID, Location: '', Month: '0', OpponentTeamID: '0', Outcome: '',
    PORound: '0', PerMode: 'PerGame', PlayerExperience: '', PlayerOrTeam: 'Player',
    PlayerPosition: '', PtMeasureType: type, Season: '2025-26', SeasonSegment: '',
    SeasonType: SEASON_TYPE, StarterBench: '', TeamID: '0', VsConference: '',
    VsDivision: '', Weight: '',
  }).toString();

const jobs = [
  ['base_pergame', dash('Base', 'PerGame')],
  ['base_totals', dash('Base', 'Totals')],
  ['base_per36', dash('Base', 'Per36')],
  ['base_per100', dash('Base', 'Per100Possessions')],
  ['advanced', dash('Advanced', 'PerGame')],
  ['misc', dash('Misc', 'PerGame')],
  ['scoring', dash('Scoring', 'PerGame')],
  ['usage', dash('Usage', 'PerGame')],
  ['defense', dash('Defense', 'PerGame')],
  ['fourfactors', dash('Four Factors', 'PerGame')],
  ['bios', 'https://stats.nba.com/stats/leaguedashplayerbiostats?' + base({ PerMode: 'PerGame' })],
  ['playerindex', 'https://stats.nba.com/stats/playerindex?' + new URLSearchParams({
    College: '', Country: '', DraftPick: '', DraftRound: '', DraftYear: '', Height: '',
    Historical: '1', LeagueID: LEAGUE_ID, Season: '2025-26', SeasonType: 'Regular Season',
    TeamID: '0', Weight: '',
  }).toString()],
  ['hustle', 'https://stats.nba.com/stats/leaguehustlestatsplayer?' + new URLSearchParams({
    College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
    DraftPick: '', DraftYear: '', Height: '', LeagueID: LEAGUE_ID, Location: '', Month: '0',
    OpponentTeamID: '0', Outcome: '', PORound: '0', PerMode: 'PerGame', PlayerExperience: '',
    PlayerPosition: '', Season: '2025-26', SeasonSegment: '', SeasonType: SEASON_TYPE,
    TeamID: '0', VsConference: '', VsDivision: '', Weight: '',
  }).toString()],
  ['pt_drives', ptDash('Drives')],
  ['pt_defense', ptDash('Defense')],
  ['pt_passing', ptDash('Passing')],
  ['pt_rebounding', ptDash('Rebounding')],
  ['pt_touches', ptDash('Possessions')],
  ['pt_catchshoot', ptDash('CatchShoot')],
  ['pt_pullup', ptDash('PullUpShot')],
  ['pt_efficiency', ptDash('Efficiency')],
];

const report = [];
for (const [name, url] of jobs) {
  process.stdout.write(`  ${name} ... `);
  const j = await get(url, name);
  if (!j) { console.log('FAILED'); report.push([name, 'FAILED', 0]); await wait(1200); continue; }
  const rs = (j.resultSets && (Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets)) || j.resultSet;
  const rows = rs && rs.rowSet ? rs.rowSet.length : 0;
  fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(j));
  console.log(`rows=${rows} cols=${rs && rs.headers ? rs.headers.length : 0}`);
  report.push([name, 'ok', rows]);
  await wait(1200);
}
console.log('\n=== SUMMARY (league ' + LEAGUE_ID + ') ===');
report.forEach((r) => console.log('  ' + r[0].padEnd(16) + r[1].padEnd(8) + 'rows=' + r[2]));

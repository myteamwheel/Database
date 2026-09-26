// Inputs for the 2026-27 stat projection (scripts/lib/projection.mjs).
//
// Everything here is PLAYER-level data from stats.nba.com, saved compactly under
// scripts/data/projection/ so the fit and the build run offline (CI cannot reach stats.nba.com).
//   - league-wide season totals for EVERY player, NBA 2009-10..2025-26 and G League 2014-15..2025-26.
//     League-wide (not just current players) so aging and year-to-year change are not estimated
//     only from survivors.
//   - advanced totals (usage, pace, possessions) for the same seasons.
//   - each NBA season's opening-fortnight team, so the backtest can use the roster a projection
//     would actually have known before the season (not the post-trade-deadline team).
//   - games and minutes as a starter, and after the All-Star break (the role a season ended in).
//   - the all-time player index (position, height, weight, draft slot).
//   - 2026-27 rosters as currently published, including 2026 draftees.
//
// Team win/loss and plus-minus columns are dropped at fetch time: the projection does not use team
// outcomes, and the TULIP research holdout seasons stay untouched.
//
// Usage: node scripts/fetch-projection-inputs.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/projection');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
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
      if (i === tries) throw new Error(`giving up on ${label}`);
      await wait(3000 * i);
    }
  }
}

const dashParams = (league, season, extra) => new URLSearchParams({
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '',
  LastNGames: '0', LeagueID: league, Location: '', Month: '0', OpponentTeamID: '0',
  Outcome: '', PORound: '0', PaceAdjust: 'N', Period: '0', PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', Season: season, SeasonSegment: '',
  SeasonType: 'Regular Season', ShotClockRange: '', StarterBench: '', TeamID: '0',
  TwoWay: '0', VsConference: '', VsDivision: '', Weight: '', ...extra,
}).toString();
const dash = (league, season, extra) =>
  'https://stats.nba.com/stats/leaguedashplayerstats?' + dashParams(league, season, extra);

// Columns kept. W, L, W_PCT, PLUS_MINUS and fantasy/rank columns are deliberately not stored.
const KEEP_BASE = ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ID', 'TEAM_ABBREVIATION', 'AGE', 'GP', 'MIN',
  'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA', 'OREB', 'DREB', 'REB', 'AST', 'TOV', 'STL', 'BLK',
  'BLKA', 'PF', 'PFD', 'PTS', 'DD2', 'TD3'];
const KEEP_ADV = ['PLAYER_ID', 'USG_PCT', 'PACE', 'POSS', 'TS_PCT', 'AST_PCT', 'OREB_PCT', 'DREB_PCT', 'PIE'];
const KEEP_OPEN = ['PLAYER_ID', 'TEAM_ID', 'TEAM_ABBREVIATION', 'GP', 'MIN'];
const KEEP_ROLE = ['PLAYER_ID', 'GP', 'MIN'];

function table(json, keep) {
  const rs = json.resultSets?.[0] || json.resultSet;
  const idx = keep.map((k) => rs.headers.indexOf(k));
  const missing = keep.filter((k, i) => idx[i] < 0);
  if (missing.length) throw new Error('missing columns ' + missing.join(','));
  return { headers: keep, rows: rs.rowSet.map((r) => idx.map((i) => r[i])) };
}

const season = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const NBA_SEASONS = Array.from({ length: 17 }, (_, i) => season(2009 + i));   // 2009-10 .. 2025-26
const GL_SEASONS = Array.from({ length: 12 }, (_, i) => season(2014 + i));    // 2014-15 .. 2025-26
// Opening night of each NBA regular season. The fortnight after it gives the team each player
// started the season with.
const OPENING = {
  '2009-10': '10/27/2009', '2010-11': '10/26/2010', '2011-12': '12/25/2011', '2012-13': '10/30/2012',
  '2013-14': '10/29/2013', '2014-15': '10/28/2014', '2015-16': '10/27/2015', '2016-17': '10/25/2016',
  '2017-18': '10/17/2017', '2018-19': '10/16/2018', '2019-20': '10/22/2019', '2020-21': '12/22/2020',
  '2021-22': '10/19/2021', '2022-23': '10/18/2022', '2023-24': '10/24/2023', '2024-25': '10/22/2024',
  '2025-26': '10/21/2025',
};
const plusDays = (mdy, n) => {
  const [m, d, y] = mdy.split('/').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCMonth() + 1).padStart(2, '0')}/${String(t.getUTCDate()).padStart(2, '0')}/${t.getUTCFullYear()}`;
};

const out = { fetchedAt: new Date().toISOString(), source: 'stats.nba.com', nba: {}, gleague: {}, nbaOpening: {},
  nbaStarters: {}, nbaPostAllStar: {} };
let n = 0;
const step = async (label, url, keep) => {
  const j = await get(url, label);
  n++;
  await wait(900);
  return table(j, keep);
};

for (const s of NBA_SEASONS) {
  const base = await step(`NBA ${s} totals`, dash('00', s, { MeasureType: 'Base', PerMode: 'Totals' }), KEEP_BASE);
  const adv = await step(`NBA ${s} advanced`, dash('00', s, { MeasureType: 'Advanced', PerMode: 'Totals' }), KEEP_ADV);
  const from = OPENING[s];
  const open = await step(`NBA ${s} opening`, dash('00', s, { MeasureType: 'Base', PerMode: 'Totals',
    DateFrom: from, DateTo: plusDays(from, 13) }), KEEP_OPEN);
  // Role signals: games (and minutes) as a starter, and the role a player ended the season in.
  const starters = await step(`NBA ${s} as starter`, dash('00', s, { MeasureType: 'Base', PerMode: 'Totals',
    StarterBench: 'Starters' }), KEEP_ROLE);
  const post = await step(`NBA ${s} after All-Star`, dash('00', s, { MeasureType: 'Base', PerMode: 'Totals',
    SeasonSegment: 'Post All-Star' }), KEEP_ROLE);
  out.nba[s] = { base, adv };
  out.nbaOpening[s] = open;
  out.nbaStarters[s] = starters;
  out.nbaPostAllStar[s] = post;
  console.log(`NBA ${s}: ${base.rows.length} players, ${open.rows.length} in opening fortnight`);
}
for (const s of GL_SEASONS) {
  const base = await step(`G League ${s} totals`, dash('20', s, { MeasureType: 'Base', PerMode: 'Totals' }), KEEP_BASE);
  const adv = await step(`G League ${s} advanced`, dash('20', s, { MeasureType: 'Advanced', PerMode: 'Totals' }), KEEP_ADV);
  out.gleague[s] = { base, adv };
  console.log(`G League ${s}: ${base.rows.length} players`);
}

const piParams = (league, s, historical) => new URLSearchParams({
  College: '', Country: '', DraftPick: '', DraftRound: '', DraftYear: '', Height: '',
  Historical: historical ? '1' : '0', LeagueID: league, Season: s, SeasonType: 'Regular Season',
  TeamID: '0', Weight: '',
}).toString();
const PI_KEEP = ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'TEAM_ID', 'TEAM_ABBREVIATION',
  'POSITION', 'HEIGHT', 'WEIGHT', 'COUNTRY', 'DRAFT_YEAR', 'DRAFT_ROUND', 'DRAFT_NUMBER', 'ROSTER_STATUS',
  'FROM_YEAR', 'TO_YEAR'];
out.playerIndex = await step('NBA player index (all time)',
  'https://stats.nba.com/stats/playerindex?' + piParams('00', '2025-26', true), PI_KEEP);
out.rosters2627 = await step('NBA 2026-27 rosters',
  'https://stats.nba.com/stats/playerindex?' + piParams('00', '2026-27', false), PI_KEEP);
console.log(`player index ${out.playerIndex.rows.length}, 2026-27 roster rows ${out.rosters2627.rows.length}`);

const file = path.join(OUT, 'inputs.json');
fs.writeFileSync(file, JSON.stringify(out));
const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(OUT, 'inputs.provenance.json'), JSON.stringify({
  file: 'scripts/data/projection/inputs.json', sha256: sha, requests: n, fetchedAt: out.fetchedAt,
  nbaSeasons: NBA_SEASONS, gleagueSeasons: GL_SEASONS,
  note: 'Player-level stats.nba.com dashboards. W/L/W_PCT/PLUS_MINUS columns are not stored.',
}, null, 2) + '\n');
console.log(`wrote ${file} (${(fs.statSync(file).size / 1e6).toFixed(2)} MB) sha256 ${sha.slice(0, 16)} after ${n} requests`);

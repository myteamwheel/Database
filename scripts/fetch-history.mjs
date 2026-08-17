// Historical NBA ingestion — real data, shared infrastructure, not a TULIP-private store.
//
// leaguegamelog gives one row per player per game with date, teams, minutes and box score.
// It does NOT carry a starter flag, so `started` is recorded as null here and must come from a
// separate source; it is never inferred from minutes.
//
// Provenance is written for every season: endpoint, parameters, row count, fetch timestamp and a
// content hash, so a later change can be traced to a source revision rather than to this code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/history');
fs.mkdirSync(OUT, { recursive: true });

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
      const t = setTimeout(() => c.abort(), 90000);
      const r = await fetch(url, { headers: H, signal: c.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) { console.log(`  give up ${label}: ${e.message}`); return null; }
      await wait(3000 * i);
    }
  }
}

const SEASONS = process.argv[2]
  ? process.argv[2].split(',')
  : ['2015-16', '2016-17', '2017-18', '2018-19', '2019-20',
     '2020-21', '2021-22', '2022-23', '2023-24', '2024-25'];

const gameLogUrl = (season, seasonType) => 'https://stats.nba.com/stats/leaguegamelog?' +
  new URLSearchParams({ Counter: '0', DateFrom: '', DateTo: '', Direction: 'ASC', LeagueID: '00',
    PlayerOrTeam: 'P', Season: season, SeasonType: seasonType, Sorter: 'DATE' });

/** Season-level starter/bench splits: the only starts information reachable without per-game boxscores. */
const starterUrl = (season, starterBench) => 'https://stats.nba.com/stats/leaguedashplayerstats?' +
  new URLSearchParams({ College: '', Conference: '', Country: '', DateFrom: '', DateTo: '',
    Division: '', DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '',
    LastNGames: '0', LeagueID: '00', Location: '', MeasureType: 'Base', Month: '0',
    OpponentTeamID: '0', Outcome: '', PORound: '0', PaceAdjust: 'N', PerMode: 'Totals',
    Period: '0', PlayerExperience: '', PlayerPosition: '', PlusMinus: 'N', Rank: 'N',
    Season: season, SeasonSegment: '', SeasonType: 'Regular Season', ShotClockRange: '',
    StarterBench: starterBench, TeamID: '0', TwoWay: '0', VsConference: '', VsDivision: '', Weight: '' });

const rows = (j) => {
  if (!j) return [];
  const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  return rs && rs.rowSet ? rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]]))) : [];
};

const provenance = [];
const record = (dataset, url, n, file) => {
  const buf = fs.readFileSync(file);
  provenance.push({
    dataset, endpoint: url.split('?')[0], parameters: url.split('?')[1],
    rows: n, bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    fetchedAt: new Date().toISOString(),
    source: 'stats.nba.com',
  });
};

for (const season of SEASONS) {
  console.log(`\n=== ${season} ===`);
  const seasonDir = path.join(OUT, season);
  fs.mkdirSync(seasonDir, { recursive: true });

  for (const st of ['Regular Season', 'Playoffs']) {
    const url = gameLogUrl(season, st);
    const j = await get(url, `${season} ${st} game log`);
    const r = rows(j);
    if (!r.length) { console.log(`  ${st.padEnd(15)} 0 rows`); await wait(1500); continue; }
    // Normalised, shared shape. `started` is null on purpose: this endpoint does not report it.
    const norm = r.map((x) => ({
      season, seasonType: st,
      gameId: x.GAME_ID, gameDate: x.GAME_DATE, playerId: x.PLAYER_ID, playerName: x.PLAYER_NAME,
      teamId: x.TEAM_ID, team: x.TEAM_ABBREVIATION, matchup: x.MATCHUP, wl: x.WL,
      isHome: typeof x.MATCHUP === 'string' ? !x.MATCHUP.includes('@') : null,
      opponent: typeof x.MATCHUP === 'string' ? x.MATCHUP.split(/ @ | vs\. /)[1] || null : null,
      started: null,
      min: x.MIN, pts: x.PTS, reb: x.REB, oreb: x.OREB, dreb: x.DREB, ast: x.AST,
      stl: x.STL, blk: x.BLK, tov: x.TOV, pf: x.PF,
      fgm: x.FGM, fga: x.FGA, fg3m: x.FG3M, fg3a: x.FG3A, ftm: x.FTM, fta: x.FTA,
      plusMinus: x.PLUS_MINUS,
    }));
    const file = path.join(seasonDir, st === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
    fs.writeFileSync(file, JSON.stringify(norm));
    record(`${season}/${st}/gamelog`, url, norm.length, file);
    const dates = norm.map((x) => x.gameDate).filter(Boolean).sort();
    console.log(`  ${st.padEnd(15)} ${String(norm.length).padStart(6)} rows · ` +
      `${new Set(norm.map((x) => x.playerId)).size} players · ${dates[0]} to ${dates[dates.length - 1]}`);
    await wait(1600);
  }

  // Season starter/bench totals. Not per game, so it supports a season starter SHARE only —
  // enough for context matching, not enough for Tier A shock detection.
  const splits = {};
  for (const [key, label] of [['starters', 'Starters'], ['bench', 'Bench']]) {
    const url = starterUrl(season, label);
    const r = rows(await get(url, `${season} ${label}`));
    splits[key] = r.map((x) => ({ playerId: x.PLAYER_ID, gp: x.GP, min: x.MIN, pts: x.PTS }));
    await wait(1400);
  }
  const sf = path.join(seasonDir, 'starter_splits.json');
  fs.writeFileSync(sf, JSON.stringify(splits));
  record(`${season}/starter_splits`, starterUrl(season, 'Starters'),
    splits.starters.length + splits.bench.length, sf);
  console.log(`  starter splits  ${splits.starters.length} starters / ${splits.bench.length} bench rows`);
}

fs.writeFileSync(path.join(OUT, 'provenance.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  seasons: SEASONS,
  notes: {
    started: 'leaguegamelog does not report a starter flag, so per-game `started` is null. Season-level starter/bench splits are stored separately and support a season starter SHARE only.',
    availability: 'NOT ACQUIRED. No injury/inactive feed with reliable pre-tipoff timing was ingested, so knownBeforeTipoff cannot be established and Tier A remains unreachable.',
    transactions: 'NOT ACQUIRED.',
  },
  datasets: provenance,
}, null, 1));
console.log(`\nwrote ${provenance.length} datasets · provenance at scripts/data/history/provenance.json`);

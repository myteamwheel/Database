// Fetch official NBA Draft Combine anthropometrics (2000-present) for player comps.
// Local refresh helper: stats.nba.com is unreliable from GitHub-hosted CI, so this is intentionally
// not part of the default CI build. Missing combine data never blocks a build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/combine_anthro.json');
const START = 2000;
const END = Number(process.env.COMBINE_END_YEAR || new Date().getUTCFullYear());
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json, text/plain, */*', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

async function get(year) {
  const url = 'https://stats.nba.com/stats/draftcombineplayeranthro?' + new URLSearchParams({
    LeagueID: '00', SeasonYear: String(year),
  });
  let last;
  for (let i = 1; i <= 4; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      console.log(`combine ${year}: attempt ${i}/4 failed: ${e.message}`);
      await wait(2000 * i);
    }
  }
  console.warn(`combine ${year}: skipped after failures (${last?.message || last})`);
  return null;
}
function rows(json) {
  const rs = json?.resultSets?.[0] || json?.resultSet;
  if (!rs?.headers || !rs?.rowSet) return [];
  return rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]])));
}

const byPlayer = new Map();
let seasonsFetched = 0;
for (let year = START; year <= END; year++) {
  const json = await get(year);
  if (!json) continue;
  seasonsFetched++;
  for (const x of rows(json)) {
    const pid = Number(x.PLAYER_ID);
    if (!pid) continue;
    const row = {
      season: year, playerId: pid, name: x.PLAYER_NAME || [x.FIRST_NAME, x.LAST_NAME].filter(Boolean).join(' '),
      heightNoShoesInches: fin(x.HEIGHT_WO_SHOES) ? Number(x.HEIGHT_WO_SHOES) : null,
      weight: fin(x.WEIGHT) ? Number(x.WEIGHT) : null,
      wingspanInches: fin(x.WINGSPAN) ? Number(x.WINGSPAN) : null,
      standingReachInches: fin(x.STANDING_REACH) ? Number(x.STANDING_REACH) : null,
      handLength: fin(x.HAND_LENGTH) ? Number(x.HAND_LENGTH) : null,
      handWidth: fin(x.HAND_WIDTH) ? Number(x.HAND_WIDTH) : null,
      bodyFatPct: fin(x.BODY_FAT_PCT) ? Number(x.BODY_FAT_PCT) : null,
    };
    // One player may attend twice; latest measurement wins.
    const old = byPlayer.get(pid);
    if (!old || year >= old.season) byPlayer.set(pid, row);
  }
  await wait(900);
}
const out = {
  source: 'stats.nba.com draftcombineplayeranthro',
  fetchedAt: new Date().toISOString(),
  yearsRequested: [START, END], seasonsFetched, rows: [...byPlayer.values()],
  caveat: 'Combine-only measurements. Players who did not attend have no wingspan/reach value; those values must remain missing.',
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`combine anthro: wrote ${out.rows.length} unique players from ${seasonsFetched} seasons to ${OUT}`);

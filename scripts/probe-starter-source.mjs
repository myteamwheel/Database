// Phase 2 source evaluation for historical per-game starter status. Reproducible: re-run this
// before trusting any starter ingest.
//
// FINDING. stats.nba.com box scores report START_POSITION (v2) / position (v3) for FIVE players
// per team from 2017-18 onward, but for 2015-16 and 2016-17 the field is populated for bench
// players too — sampled team-games showed 8, 9 and 11 "starters". boxscoretraditionalv3 has the
// SAME defect on those seasons, so it is the underlying data, not the endpoint version.
//
// Consequence: per-game starter status is trustworthy for 2017-18..2024-25 only. For 2015-16 and
// 2016-17 `started` must stay null. It is NOT inferred from minutes, and the five highest-minute
// players are NOT assumed to be the starters — that is precisely the heuristic this project
// forbids, and the 2015-16 example shows why it would be wrong (Aron Baynes carried a start
// position on 10:51).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(url, { headers: H, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 2) return { __err: e.message }; await wait(2000); }
  }
}
const v2 = (g) => 'https://stats.nba.com/stats/boxscoretraditionalv2?' + new URLSearchParams({
  GameID: g, StartPeriod: '0', EndPeriod: '10', StartRange: '0', EndRange: '28800', RangeType: '0' });

/** Seasons whose per-game starter field is trustworthy. Derived by this probe, not assumed. */
export const STARTER_RELIABLE_SEASONS = ['2017-18', '2018-19', '2019-20', '2020-21',
  '2021-22', '2022-23', '2023-24', '2024-25'];
export const STARTER_UNRELIABLE_SEASONS = ['2015-16', '2016-17'];

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasons = JSON.parse(fs.readFileSync(path.join(HIST, 'provenance.json'), 'utf8')).seasons;
  const perSeason = Number(process.argv[2] || 3);
  console.log('season    team-games sampled   with != 5 starters   verdict');
  for (const s of seasons) {
    const rows = JSON.parse(fs.readFileSync(path.join(HIST, s, 'gamelog.json'), 'utf8'));
    const ids = [...new Set(rows.map((r) => r.gameId))];
    const step = Math.max(1, Math.floor(ids.length / perSeason));
    const pick = Array.from({ length: perSeason }, (_, k) => ids[Math.min(ids.length - 1, k * step)]);
    let bad = 0, checked = 0;
    for (const g of pick) {
      const r = await get(v2(g));
      const ps = r.resultSets?.find((x) => x.name === 'PlayerStats');
      if (!ps) { await wait(1200); continue; }
      const i = Object.fromEntries(ps.headers.map((h, k) => [h, k]));
      const byTeam = {};
      ps.rowSet.forEach((x) => {
        if (String(x[i.START_POSITION] || '').trim() !== '') {
          const t = x[i.TEAM_ABBREVIATION]; byTeam[t] = (byTeam[t] || 0) + 1;
        }
      });
      Object.values(byTeam).forEach((n) => { checked++; if (n !== 5) bad++; });
      await wait(1300);
    }
    console.log(`${s}  ${String(checked).padStart(18)}   ${String(bad).padStart(17)}   ` +
      `${bad === 0 ? 'RELIABLE' : 'UNRELIABLE - keep started=null'}`);
  }
}

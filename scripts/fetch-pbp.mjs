// Resumable play-by-play crawl for the games that carry opportunity episodes.
//
// Needed to separate ASSIGNED workload (what rotation pattern says the team intended to give him)
// from REALIZED opener minutes (what he logged after foul trouble, blowouts and overtime). Final
// minutes conflate the two, and that conflation is the last major flaw in Model A.
//
// Coverage was verified season by season before writing this: playbyplayv3 returns usable
// substitution events for every season 2015-16 through 2024-25 (36-67 substitutions per game).
// Games are deduplicated first — 8,582 episodes reference only 2,729 distinct games, because one
// absence game supplies an episode for each team-mate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/data/history/pbp');
const STATE = path.join(ROOT, 'scripts/data/history/pbp_state.json');
fs.mkdirSync(CACHE, { recursive: true });

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (g) => `https://stats.nba.com/stats/playbyplayv3?GameID=${g}&StartPeriod=1&EndPeriod=10`;

const needed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { failed: {} };
const todo = needed.filter((g) => !fs.existsSync(path.join(CACHE, `${g}.json`)));
console.log(`${needed.length} games needed · ${needed.length - todo.length} cached · ${todo.length} to fetch`);

let done = 0, failed = 0;
for (const g of todo) {
  let got = null, lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(url(g), { headers: H, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const acts = j.game?.actions || [];
      if (!acts.length) throw new Error('no actions');
      // Store what the assigned-workload proxy needs. subType is EMPTY on substitution events, so
      // direction comes from `description`, formatted "SUB: {incoming} FOR {outgoing}", with
      // personId/playerName identifying the OUTGOING player. An earlier version of this crawler
      // dropped description and playerName as redundant, which made entries unrecoverable — the
      // cache has to carry them.
      got = {
        gameId: g,
        actions: acts
          .filter((a) => /substitution/i.test(a.actionType || '') || a.actionType === 'period')
          .map((a) => ({ n: a.actionNumber, p: a.period, clock: a.clock, type: a.actionType,
            sub: a.subType, personId: a.personId, teamId: a.teamId,
            playerName: a.playerName, description: a.description })),
        periods: Math.max(...acts.map((a) => a.period || 1)),
      };
      break;
    } catch (e) { lastErr = e.message; await wait(1500 * (i + 1)); }
  }
  if (got) {
    fs.writeFileSync(path.join(CACHE, `${g}.json`), JSON.stringify(got));
    delete state.failed[g];
    done++;
  } else {
    // Recorded explicitly, never silently dropped.
    state.failed[g] = lastErr;
    failed++;
  }
  if ((done + failed) % 50 === 0) {
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`  ${done + failed}/${todo.length} · ok ${done} · failed ${failed}`);
  }
  await wait(1250);
}
fs.writeFileSync(STATE, JSON.stringify(state));
console.log(`\ncomplete · fetched ${done} · failed ${failed}`);
if (failed) console.log(`failed game ids recorded in ${path.relative(ROOT, STATE)}`);

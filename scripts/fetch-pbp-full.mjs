// FULL play-by-play acquisition for the possession-level TULIP branch.
//
// WHY A NEW CACHE. scripts/data/history/pbp/ keeps ONLY substitution + period actions (verified: a
// full game there holds 49 of 512 actions). That is enough to reconstruct lineups and nothing else —
// no scores, no possession-ending events — so it cannot support RAPM. This writes a richer corpus to
// pbp_full/ and leaves the old cache untouched, because existing scripts read it.
//
// Stored gzipped: ~512 actions/game over ~11.5k games is large raw, small compressed, and this crawl
// must never need repeating.
//
// DEV SEASONS ONLY. Holdout play-by-play is deliberately not queued.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/data/history/pbp_full');
const STATE = path.join(ROOT, 'scripts/data/history/pbp_full_state.json');
fs.mkdirSync(CACHE, { recursive: true });

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const url = (g) => `https://stats.nba.com/stats/playbyplayv3?GameID=${g}&StartPeriod=1&EndPeriod=10`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const SPACING_MS = Number(process.env.SPACING_MS || 150);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const MAX_TRIES = Number(process.env.MAX_TRIES || 4);

const queue = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const gzPath = (g) => path.join(CACHE, `${g}.json.gz`);
const cached = (g) => { try { return fs.statSync(gzPath(g)).size > 200; } catch { return false; } };
const todo = queue.filter((g) => !cached(g));

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { status: {}, failures: {} };
state.status = state.status || {}; state.failures = state.failures || {};
function saveState() {
  const tmp = `${STATE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE);       // atomic checkpoint
}
console.log(`queue ${queue.length} · already cached ${queue.length - todo.length} · to fetch ${todo.length}`);
console.log(`concurrency=${CONCURRENCY} spacing=${SPACING_MS}ms timeout=${TIMEOUT_MS}ms maxTries=${MAX_TRIES}`);

// Keep every field a possession/lineup model needs; drop coordinates, video flags and duplicated
// name/tricode fields that would triple the corpus for no analytic value.
const slim = (a) => ({
  n: a.actionNumber, p: a.period, clock: a.clock, type: a.actionType, sub: a.subType,
  pid: a.personId, tid: a.teamId, name: a.playerName, desc: a.description,
  hs: a.scoreHome, as: a.scoreAway, res: a.shotResult, fg: a.isFieldGoal, sv: a.shotValue,
});

let ok = 0, failed = 0, done = 0, cursor = 0;
async function handle(g) {
  let lastErr = null;
  for (let i = 0; i < MAX_TRIES; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url(g), { headers: H, signal: c.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const acts = j.game?.actions || [];
      if (!acts.length) throw new Error('no actions');
      const payload = { gameId: g, n: acts.length, periods: Math.max(...acts.map((a) => a.period || 1)),
        actions: acts.map(slim) };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
      const tmp = `${gzPath(g)}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, gzPath(g));      // atomic: a killed process never leaves a truncated game
      state.status[g] = 'OK';
      delete state.failures[g];
      ok++;
      return;
    } catch (e) {
      clearTimeout(t);
      lastErr = /abort/i.test(e.message) ? 'TIMEOUT' : e.message;
      await wait(1200 * (i + 1));        // backoff; transient failures are retried, never dropped
    }
  }
  state.status[g] = 'FAILED';
  state.failures[g] = lastErr;
  failed++;
}
async function worker() {
  while (cursor < todo.length) {
    const g = todo[cursor++];
    await handle(g);
    done++;
    if (done % 200 === 0) {
      saveState();
      const pct = (100 * ok / Math.max(1, done)).toFixed(1);
      console.log(`  ${done}/${todo.length} · ok ${ok} (${pct}%) · failed ${failed} · cached total ${queue.filter(cached).length}`);
    }
    await wait(SPACING_MS);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { saveState(); console.log('\ncheckpointed on ' + sig); process.exit(143); });

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
saveState();
const haveNow = queue.filter(cached).length;
console.log(`\ncomplete · ok ${ok} · failed ${failed}`);
console.log(`coverage: ${haveNow}/${queue.length} (${(100 * haveNow / queue.length).toFixed(2)}%)`);
if (failed) console.log(`failures recorded in pbp_full_state.json: ${Object.keys(state.failures).length} games`);

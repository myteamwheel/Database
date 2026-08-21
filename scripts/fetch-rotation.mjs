// GameRotation crawl — exact player stints, with PER-GAME acceptance.
//
// WHY THIS REPLACES PBP RECONSTRUCTION. Rebuilding stints from playbyplayv3 substitution text
// required inferring quarter-start lineups, closing stints at period boundaries and parsing
// direction out of "SUB: {in} FOR {out}" descriptions. After three rounds of fixes it still carried
// 3.00 minutes of mean error against the box score. GameRotation supplies IN_TIME_REAL and
// OUT_TIME_REAL directly and lands at 0.20-0.28 minutes with zero players off by more than one.
//
// WHY EVERY GAME IS VALIDATED ANYWAY. The endpoint sometimes returns PARTIAL data — one team, or a
// truncated set of stints — which produces silently wrong minutes rather than an obvious failure. A
// sampled season showed 6.75 mean error traceable to one such game while its neighbours were exact.
// So each game is checked against box-score minutes before being accepted, and rejected games are
// recorded rather than quietly used.
//
// Times are tenths of a second: (OUT_TIME_REAL - IN_TIME_REAL) / 600 gives minutes.
//
// ACQUISITION RESILIENCE (2026-08-20). The overnight run spanned 8.8 hours of which 5.7 were dead
// time with no process running at all. Nothing detected that. Acquisition mechanics now come from
// lib/acquire.mjs: a deadline spanning headers AND body, a wall-clock stall guard independent of the
// abort path, a heartbeat for an external supervisor, and an atomically-written manifest that records
// a game as in-flight BEFORE the request so a death mid-request is always recoverable.
// The scientific layer below — sample, validation rules, acceptance thresholds — is UNCHANGED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest, Heartbeat, AttemptLog, timedFetch, withStallGuard, writeAtomic, sleep, DONE } from './lib/acquire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const CACHE = path.join(HIST, 'rotation');
const STATE = path.join(HIST, 'rotation_state.json');
const BEAT = path.join(HIST, 'rotation_heartbeat.json');
const ATTEMPTS = path.join(HIST, 'rotation_attempts.jsonl');
fs.mkdirSync(CACHE, { recursive: true });

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};

// ACQUISITION POLICY. Every attempt records the policy version that produced it, so a result can
// never be silently attributed to settings it was not gathered under. The production values are NOT
// yet chosen — they must come from the measured latency distribution, not from guesswork.
const POLICY = process.env.POLICY || 'unset';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const SPACING_MS = Number(process.env.SPACING_MS || 4000);
// The stall guard must sit clear of a legitimately slow request or it will manufacture false stalls.
const STALL_MS = Number(process.env.STALL_MS || TIMEOUT_MS * 2 + 15000);
const ATTEMPTS_PER_PASS = Number(process.env.ATTEMPTS || 1);
const LIMIT = Number(process.env.LIMIT || 0);

const url = (g) => `https://stats.nba.com/stats/gamerotation?GameID=${g}&LeagueID=00&RotationType=`;
const TOL = 1.0;          // per-player minute tolerance
const MAX_BAD_SHARE = 0.1; // reject a game if more than 10% of players disagree

const needed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Box-score minutes for validation.
const box = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (r.min > 0) box.set(`${r.gameId}|${r.playerId}`, r.min);
  }
}

// STATUS TAXONOMY. A game's fate is NOT decided during acquisition. Failures mean "did not return
// under these conditions", not "does not exist" — a distinction this project has got wrong
// repeatedly. WORKER_STALL and INTERRUPTED are acquisition-infrastructure events and carry even less
// evidential weight than a timeout: they say something about our process, nothing about the data.
// REJECTED_BY_VALIDATION is assigned separately by validate-rotation.mjs, never here.
// UNAVAILABLE_AFTER_ALL_SOURCES is assigned by a deliberate decision step, never by this crawler.
const runId = `${Date.now().toString(36)}-${process.pid}`;
const man = new Manifest(STATE, { policy: POLICY, runId });
const beat = new Heartbeat(BEAT, runId);
const log = new AttemptLog(ATTEMPTS);

const reclaimed = man.sweepStale();
if (reclaimed.length) console.log(`reclaimed ${reclaimed.length} game(s) left in-flight by a dead run -> INTERRUPTED (retry-eligible)`);

/** A truncated cache file from a crash would otherwise count as "already cached" forever. */
function cachedAndValid(g) {
  const f = path.join(CACHE, `${g}.json`);
  if (!fs.existsSync(f)) return false;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j.stints) && j.stints.length > 0; }
  catch { fs.unlinkSync(f); return false; }   // corrupt -> refetch
}

let todo = needed.filter((g) => !cachedAndValid(g));
if (LIMIT) todo = todo.slice(0, LIMIT);
console.log(`${needed.length} games needed · ${needed.length - todo.length} cached · ${todo.length} to fetch`);
console.log(`policy=${POLICY} timeout=${TIMEOUT_MS}ms concurrency=${CONCURRENCY} spacing=${SPACING_MS}ms stallGuard=${STALL_MS}ms run=${runId}`);

let ok = 0, failed = 0, stalled = 0;
let cursor = 0;
async function worker(wid) {
  while (cursor < todo.length) {
    const g = todo[cursor++];
    await handle(g, wid);
    beat.set(wid, null, 'spacing');
    await sleep(SPACING_MS);
  }
  beat.set(wid, null, 'done');
}

async function handle(g, wid) {
  let stints = null, outcome = null;
  for (let i = 0; i < ATTEMPTS_PER_PASS; i++) {
    beat.set(wid, g, 'requesting');
    man.begin(g, wid);                       // durable in-flight record BEFORE the network call
    const res = await withStallGuard(timedFetch(url(g), { headers: H, timeoutMs: TIMEOUT_MS }), STALL_MS);
    if (res.__stalled) {
      log.write({ ts: new Date().toISOString(), game: g, worker: wid, policy: POLICY, ms: STALL_MS, outcome: 'WORKER_STALL', status: null, bytes: 0 });
      man.complete(g, 'WORKER_STALL', 'stall_guard_fired');
      stalled++;
      return;                                // retry-eligible; never counted as unavailable
    }
    log.write({ ts: new Date().toISOString(), game: g, worker: wid, policy: POLICY, ms: res.ms, outcome: res.outcome, status: res.status, bytes: res.bytes });
    outcome = res.outcome;
    if (!res.ok) continue;
    const out = [];
    for (const rs of res.json.resultSets || []) {
      const ix = Object.fromEntries(rs.headers.map((h, k) => [h, k]));
      for (const row of rs.rowSet) {
        out.push({ teamId: row[ix.TEAM_ID], personId: row[ix.PERSON_ID],
          inT: row[ix.IN_TIME_REAL], outT: row[ix.OUT_TIME_REAL],
          ptDiff: row[ix.PT_DIFF], usg: row[ix.USG_PCT] });
      }
    }
    if (!out.length) { outcome = 'EMPTY_RESPONSE'; continue; }
    stints = out;
    break;
  }

  if (!stints) {
    const prior = man.status[g];
    man.complete(g, prior === 'FAILED_PASS1' ? 'FAILED_PASS2' : 'FAILED_PASS1', outcome || 'no_response');
    failed++;
  } else {
    // ACCEPTANCE: reconstructed minutes must agree with the box score, and both teams must appear.
    const mins = new Map();
    for (const s of stints) mins.set(s.personId, (mins.get(s.personId) || 0) + (s.outT - s.inT) / 600);
    let checked = 0, bad = 0, worst = 0;
    for (const [pid, m] of mins) {
      const bm = box.get(`${g}|${pid}`);
      if (bm === undefined) continue;
      checked++;
      const d = Math.abs(m - bm);
      if (d > TOL) bad++;
      if (d > worst) worst = d;
    }
    // ALWAYS cache the raw response, atomically. Acceptance is decided by validate-rotation.mjs, so
    // tightening the gate later never costs another crawl.
    beat.set(wid, g, 'writing');
    writeAtomic(path.join(CACHE, `${g}.json`), JSON.stringify({ gameId: g, stints, policy: POLICY }));
    man.complete(g, man.attempts[g] ? 'RECOVERED_PASS2' : 'SUCCESS', `checked=${checked} bad=${bad} worst=${worst.toFixed(2)}`);
    ok++;
  }

  // Progress ALWAYS reports successes over COMPLETED ATTEMPTS, never over the total queue. A
  // success count alone implies a rate against a denominator that has not been reached yet.
  const completed = ok + failed + stalled;
  if (completed % 25 === 0 || completed === todo.length) {
    console.log(`  ${ok} ok / ${completed} completed (${(100 * ok / completed).toFixed(1)}%) · stalled ${stalled} · ${todo.length - completed} of ${todo.length} not yet attempted`);
  }
}

// A signal must not leave games marked in-flight. Flush and exit cleanly instead.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`\n${sig} received — flushing manifest; in-flight games stay retry-eligible.`);
    man.flush(); beat.clear(); process.exit(143);
  });
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(`w${i}`)));
man.flush(); beat.clear();
console.log(`\npass complete · cached this pass ${ok} · no response ${failed} · worker stalls ${stalled}`);
console.log('status tally: ' + JSON.stringify(man.tally()));
console.log('Failures are NOT unavailable — rerun this script to retry them in a delayed pass.');

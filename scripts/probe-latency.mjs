// MEASUREMENT ONLY. Never writes the rotation cache, never mutates rotation_state.json.
//
// Its whole purpose is to observe the endpoint's real latency distribution UNCENSORED, so the
// production timeout can be derived from evidence rather than picked. The previous 45s ceiling was
// never checked against the tail it was meant to clear, and a later change to 40s was made without
// any measurement at all — which is backwards if slow-but-valid responses are the suspected problem.
//
// The diagnostic timeout is deliberately generous. A request that takes 90s here is DATA, not a
// failure; censoring it would reproduce exactly the blind spot being investigated.
//
// env: CONCURRENCY, TIMEOUT_MS, SPACING_MS, LABEL   argv[2]: queue json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptLog, timedFetch, withStallGuard, sleep } from './lib/acquire.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/history/latency_probe.jsonl');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const url = (g) => `https://stats.nba.com/stats/gamerotation?GameID=${g}&LeagueID=00&RotationType=`;

const LABEL = process.env.LABEL || 'probe';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);   // generous: measurement, not policy
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const SPACING_MS = Number(process.env.SPACING_MS || 4000);
const STALL_MS = Number(process.env.STALL_MS || TIMEOUT_MS + 30000);

const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));  // [{game, cls}] or [game]
const q = items.map((x) => (typeof x === 'string' ? { game: x, cls: 'unknown' } : x));
const log = new AttemptLog(OUT);
console.log(`probe ${LABEL} · n=${q.length} · concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms spacing=${SPACING_MS}ms`);

const recs = [];
let cursor = 0;
async function worker(wid) {
  while (cursor < q.length) {
    const { game, cls } = q[cursor++];
    const res = await withStallGuard(timedFetch(url(game), { headers: H, timeoutMs: TIMEOUT_MS }), STALL_MS);
    const rec = res.__stalled
      ? { ts: new Date().toISOString(), label: LABEL, game, cls, worker: wid, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, ms: STALL_MS, outcome: 'WORKER_STALL', status: null, bytes: 0, rows: 0 }
      : { ts: new Date().toISOString(), label: LABEL, game, cls, worker: wid, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, ms: res.ms, outcome: res.outcome, status: res.status, bytes: res.bytes,
          rows: res.ok ? (res.json.resultSets || []).reduce((a, r) => a + (r.rowSet?.length || 0), 0) : 0 };
    // An HTTP 200 carrying zero rows is a distinct outcome from a transport failure and must not be
    // pooled with it — one is the server answering "nothing", the other is not reaching the server.
    if (rec.outcome === 'OK' && rec.rows === 0) rec.outcome = 'EMPTY_200';
    log.write(rec); recs.push(rec);
    process.stdout.write(`  ${String(recs.length).padStart(3)}/${q.length} ${game} ${cls.padEnd(8)} ${String(rec.ms + 'ms').padStart(8)} ${rec.outcome}\n`);
    await sleep(SPACING_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(`w${i}`)));

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN;
function report(title, sel) {
  const s = recs.filter(sel);
  if (!s.length) { console.log(`\n${title}: n=0`); return; }
  const ms = s.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${title}  n=${s.length}`);
  console.log(`  p50 ${pct(ms, .5)}  p90 ${pct(ms, .9)}  p95 ${pct(ms, .95)}  p99 ${pct(ms, .99)}  max ${ms[ms.length - 1]}`);
}
console.log(`\n===== ${LABEL} =====`);
const tally = {};
for (const r of recs) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
console.log('outcomes:', JSON.stringify(tally), ` (denominator = ${recs.length} completed attempts)`);
report('SUCCESSFUL responses only (this is what a timeout must clear)', (r) => r.outcome === 'OK');
report('non-success outcomes', (r) => r.outcome !== 'OK');
for (const c of [...new Set(recs.map((r) => r.cls))]) {
  const s = recs.filter((r) => r.cls === c);
  console.log(`  class ${c}: ${s.filter((r) => r.outcome === 'OK').length}/${s.length} ok`);
}

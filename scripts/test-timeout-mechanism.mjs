// CONTROLLED DIAGNOSTIC: does the request timeout mechanism actually fire?
//
// The 5.7-hour gap on 2026-08-20 was NOT a request hang — pass 1 exited normally and no process was
// running. But that investigation surfaced a latent unbounded-hang path in fetch-rotation.mjs:
//
//     const r = await fetch(url, { signal: c.signal }); clearTimeout(t);   // <-- timer dies here
//     const j = await r.json();                                            // <-- unbounded
//
// clearTimeout runs when HEADERS arrive. A server that sends headers and then stalls the body leaves
// r.json() awaiting with no timer and no live abort signal. This test proves the behaviour instead of
// assuming it, using a LOCAL server so the result is deterministic and does not depend on stats.nba.com.
//
// Three scenarios, each run against both the old pattern and the fixed one:
//   A no-headers    server accepts the socket and never responds at all
//   B stalled-body  server sends 200 + headers + partial JSON, then never finishes
//   C normal        server responds promptly (control: the timer must NOT fire spuriously)
import http from 'node:http';

const T = 3000;                       // deliberately short so the test is fast
const open = [];                      // keep stalled sockets referenced so GC cannot mask the bug

const server = http.createServer((req, res) => {
  if (req.url === '/no-headers') { open.push(res); return; }              // never writes anything
  if (req.url === '/stalled-body') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    res.write('{"resultSets":[');    // valid prefix, never terminated
    open.push(res); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ resultSets: [{ headers: ['A'], rowSet: [[1]] }] }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** The CURRENT pattern: clearTimeout immediately after headers. */
async function oldPattern(path) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), T);
  const r = await fetch(base + path, { signal: c.signal }); clearTimeout(t);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

/** FIXED: one deadline covering headers AND body; cleared only in finally, after the body resolves. */
async function fixedPattern(path) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), T);
  try {
    const r = await fetch(base + path, { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();          // still covered by the same signal
  } finally { clearTimeout(t); }
}

// A hang is indistinguishable from "very slow" without an outer bound, so race every case against a
// wall-clock ceiling well above T. Anything that hits the ceiling never aborted.
const CEILING = T * 3;
async function probe(label, fn, path) {
  const t0 = Date.now();
  let verdict;
  try {
    await Promise.race([
      fn(path),
      new Promise((_, rej) => setTimeout(() => rej(new Error('__CEILING__')), CEILING)),
    ]);
    verdict = 'resolved';
  } catch (e) {
    verdict = e.message === '__CEILING__' ? 'HUNG PAST CEILING (no abort)'
      : /abort/i.test(e.message) ? 'aborted' : 'error: ' + e.message;
  }
  const ms = Date.now() - t0;
  const flag = verdict.startsWith('HUNG') ? '  <-- UNBOUNDED' : '';
  console.log(`  ${label.padEnd(30)} ${String(ms + 'ms').padStart(7)}  ${verdict}${flag}`);
  return { verdict, ms };
}

console.log(`request timeout = ${T}ms · outer ceiling = ${CEILING}ms\n`);
console.log('CURRENT pattern (clearTimeout after headers):');
const a1 = await probe('A no-headers', oldPattern, '/no-headers');
const b1 = await probe('B stalled-body', oldPattern, '/stalled-body');
const c1 = await probe('C normal', oldPattern, '/normal');
console.log('\nFIXED pattern (deadline spans body, cleared in finally):');
const a2 = await probe('A no-headers', fixedPattern, '/no-headers');
const b2 = await probe('B stalled-body', fixedPattern, '/stalled-body');
const c2 = await probe('C normal', fixedPattern, '/normal');

console.log('\nCONCLUSION');
console.log(`  AbortController itself works: ${a1.verdict === 'aborted' ? 'YES — pre-header aborts fire' : 'NO'}`);
console.log(`  Current code hangs on stalled body: ${b1.verdict.startsWith('HUNG') ? 'YES — confirmed defect' : 'no'}`);
console.log(`  Fix bounds the stalled body: ${b2.verdict === 'aborted' ? 'YES' : 'NO'}`);
console.log(`  Fix does not break normal responses: ${c2.verdict === 'resolved' ? 'YES' : 'NO'}`);
server.close(); process.exit(0);

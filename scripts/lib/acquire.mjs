// Crash- and stall-resilient acquisition primitives.
//
// WHY THIS EXISTS. The overnight run of 2026-08-20 spanned 8.8 hours but only 2.9 hours of it was
// work: pass 1 finished normally at 07:13:35Z and then NOTHING RAN for 5.7 hours because the
// orchestrating shell had already been killed. The machine was awake the whole time (caffeinate held
// an assertion continuously; pmset logs no sleep). No request hung. The defect was that orchestration
// was not durable, and that nothing noticed the absence.
//
// So the protections here are deliberately INDEPENDENT of each other:
//   1. request deadline   — spans headers AND body (the old code cleared its timer once headers
//                           arrived, leaving r.json() unbounded; proven in test-timeout-mechanism.mjs)
//   2. worker stall guard — a wall-clock race that does not rely on the abort path firing at all
//   3. heartbeat + supervisor — an external process that notices a dead or frozen crawl and restarts
//                           it from the manifest
//
// None of these decide whether data EXISTS. A watchdog kill is an acquisition-side event and is
// always retry-eligible; only a separate, deliberate step may ever mark a game unavailable.
import fs from 'node:fs';
import path from 'node:path';

/** Atomic replace. A crash mid-write must never leave a half-written manifest or cache file. */
export function writeAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);          // rename is atomic within a filesystem
}

/** Append-only attempt log. Survives any crash and yields the latency distribution for free. */
export class AttemptLog {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); }
  write(rec) { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); }
  read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

// Acquisition statuses. NONE of these are terminal — terminality is a scientific judgement made
// elsewhere, after every source has been tried under a VALIDATED policy.
export const RETRY_ELIGIBLE = new Set([
  'FAILED_PASS1', 'FAILED_PASS2', 'WORKER_STALL', 'INTERRUPTED', 'HTTP_ERROR', 'EMPTY_RESPONSE',
]);
export const DONE = new Set(['SUCCESS', 'RECOVERED_PASS2']);

export class Manifest {
  constructor(file, { policy, runId }) {
    this.file = file; this.policy = policy; this.runId = runId;
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    this.status = s.status || {};
    this.attempts = s.attempts || {};
    this.policyOf = s.policyOf || {};     // acquisition-policy version of the LAST attempt per game
    this.outcome = s.outcome || {};       // fine-grained outcome class of the last attempt
    this.inflight = s.inflight || {};     // gameId -> {runId, pid, worker, startedAt}
    this.dirty = false;
  }

  /**
   * A game left IN FLIGHT by a process that no longer exists must never stay that way — that is how a
   * crawl silently loses games forever. Anything belonging to a different run is reclaimed as
   * INTERRUPTED, which is retry-eligible.
   */
  sweepStale() {
    const reclaimed = [];
    for (const [g, rec] of Object.entries(this.inflight)) {
      if (rec.runId === this.runId) continue;
      this.status[g] = 'INTERRUPTED';
      this.outcome[g] = 'process_died_in_flight';
      delete this.inflight[g];
      reclaimed.push(g);
    }
    if (reclaimed.length) { this.dirty = true; this.flush(); }
    return reclaimed;
  }

  /** Written BEFORE the network call, so a death mid-request is always visible afterwards. */
  begin(g, worker) {
    this.inflight[g] = { runId: this.runId, pid: process.pid, worker, startedAt: Date.now() };
    this.policyOf[g] = this.policy;
    this.dirty = true;
    this.flush();
  }

  /** Written after the call resolves, one atomic replace, no batching window to lose. */
  complete(g, status, outcome) {
    delete this.inflight[g];
    this.status[g] = status;
    this.outcome[g] = outcome;
    this.policyOf[g] = this.policy;
    if (!DONE.has(status)) this.attempts[g] = (this.attempts[g] || 0) + 1;
    this.dirty = true;
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    writeAtomic(this.file, JSON.stringify({
      status: this.status, attempts: this.attempts, policyOf: this.policyOf,
      outcome: this.outcome, inflight: this.inflight,
    }));
    this.dirty = false;
  }

  tally() {
    const t = {};
    for (const v of Object.values(this.status)) t[v] = (t[v] || 0) + 1;
    return t;
  }
}

/** Small file an external supervisor polls. Cheap enough to rewrite on every state change. */
export class Heartbeat {
  constructor(file, runId) {
    this.file = file; this.runId = runId; this.workers = {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  set(worker, game, phase) {
    this.workers[worker] = { game, phase, ts: Date.now() };
    writeAtomic(this.file, JSON.stringify({
      runId: this.runId, pid: process.pid, ts: Date.now(), workers: this.workers,
    }));
  }
  clear() { try { fs.unlinkSync(this.file); } catch { /* already gone */ } }
}

/**
 * One request with a deadline that covers the ENTIRE exchange.
 *
 * The previous implementation cleared its timer as soon as headers arrived, so a server that sent
 * headers and then stalled the body produced an unbounded await. test-timeout-mechanism.mjs
 * reproduces that against a local stalling server: 'HUNG PAST CEILING (no abort)'. Here the signal
 * stays live until the body has been consumed and the timer is cleared only in finally.
 *
 * @returns {{ok:boolean, outcome:string, ms:number, status:number|null, json:any, bytes:number}}
 */
export async function timedFetch(url, { headers, timeoutMs }) {
  const t0 = Date.now();
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: c.signal });
    if (!r.ok) return { ok: false, outcome: `HTTP_${r.status}`, ms: Date.now() - t0, status: r.status, json: null, bytes: 0 };
    const text = await r.text();                       // still covered by the same signal
    let json = null;
    try { json = JSON.parse(text); }
    catch { return { ok: false, outcome: 'PARSE_ERROR', ms: Date.now() - t0, status: r.status, json: null, bytes: text.length }; }
    return { ok: true, outcome: 'OK', ms: Date.now() - t0, status: r.status, json, bytes: text.length };
  } catch (e) {
    const outcome = /abort/i.test(e.message) ? 'REQUEST_TIMEOUT'
      : /fetch failed|ECONN|ENOTFOUND|socket/i.test(e.message) ? 'NETWORK_ERROR' : 'ERROR:' + e.message;
    return { ok: false, outcome, ms: Date.now() - t0, status: null, json: null, bytes: 0 };
  } finally { clearTimeout(timer); }
}

/**
 * Wall-clock stall guard, INDEPENDENT of the abort path.
 *
 * If timedFetch's own deadline somehow fails to fire, this still returns control to the worker. The
 * abandoned request is left to be collected; losing a socket is strictly better than losing a worker
 * for six hours. The result is WORKER_STALL, which is retry-eligible and is NEVER evidence that the
 * game's data does not exist.
 */
export async function withStallGuard(promise, stallMs, onStall) {
  let timer;
  const guard = new Promise((res) => {
    timer = setTimeout(() => { try { onStall?.(); } catch { /* best effort */ } res({ __stalled: true }); }, stallMs);
  });
  try { return await Promise.race([promise, guard]); }
  finally { clearTimeout(timer); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

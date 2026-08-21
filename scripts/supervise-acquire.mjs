// External supervisor for a long acquisition crawl.
//
// WHY. On 2026-08-20 the crawl's orchestrating shell was killed, pass 2 never started, and 5.7 hours
// passed with no process running and nothing noticing. An in-process watchdog cannot fix that — the
// whole process tree was gone. This supervisor is a separate process that (a) restarts the child if
// it dies with work still outstanding, and (b) SIGKILLs and restarts it if the heartbeat goes stale,
// which covers a freeze that the child's own guards somehow failed to break.
//
// It makes no scientific decisions. It never marks a game unavailable. Restarts are safe because the
// crawler resumes idempotently from the manifest and reclaims any in-flight game as INTERRUPTED.
//
// Run detached so it outlives the shell that launched it:
//   nohup node scripts/supervise-acquire.mjs <queue.json> > sup.log 2>&1 &
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const BEAT = path.join(HIST, 'rotation_heartbeat.json');
const CACHE = path.join(HIST, 'rotation');

const queueFile = process.argv[2];
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const STALE_MS = Number(process.env.STALE_MS || 240000);   // no heartbeat this long => frozen
const POLL_MS = Number(process.env.POLL_MS || 15000);
const MAX_RESTARTS = Number(process.env.MAX_RESTARTS || 20);

const stamp = () => new Date().toISOString();
const remaining = () => queue.filter((g) => {
  const f = path.join(CACHE, `${g}.json`);
  if (!fs.existsSync(f)) return true;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return !(Array.isArray(j.stints) && j.stints.length); }
  catch { return true; }
}).length;

let restarts = 0, child = null, stop = false;

function launch() {
  try { fs.unlinkSync(BEAT); } catch { /* fine */ }
  child = spawn(process.execPath, [path.join(ROOT, 'scripts/fetch-rotation.mjs'), queueFile], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log(`${stamp()} supervisor: launched child pid=${child.pid} (restart ${restarts}) · ${remaining()} game(s) outstanding`);
  child.on('exit', (code, sig) => {
    const left = remaining();
    console.log(`${stamp()} supervisor: child exited code=${code} signal=${sig} · ${left} outstanding`);
    child = null;
    if (stop) return;
    // A clean exit with nothing left is the finish line. Anything else with work remaining is a
    // failure to make progress, and the crawl resumes from the manifest.
    if (left === 0) { console.log(`${stamp()} supervisor: queue complete`); process.exit(0); }
    if (restarts >= MAX_RESTARTS) { console.log(`${stamp()} supervisor: restart budget exhausted, stopping`); process.exit(1); }
    restarts++;
    setTimeout(launch, 5000);
  });
}

setInterval(() => {
  if (!child) return;
  let age = null;
  try { age = Date.now() - JSON.parse(fs.readFileSync(BEAT, 'utf8')).ts; } catch { return; }
  if (age > STALE_MS) {
    // SIGKILL, not SIGTERM: the point of this branch is that the child is not responding to its own
    // guards, so asking it politely is not a reliable option.
    console.log(`${stamp()} supervisor: heartbeat stale by ${(age / 1000).toFixed(0)}s — SIGKILL pid=${child.pid}`);
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}, POLL_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stop = true; if (child) try { process.kill(child.pid, 'SIGTERM'); } catch {} process.exit(143); });
}

console.log(`${stamp()} supervisor: queue=${queueFile} n=${queue.length} staleAfter=${STALE_MS}ms maxRestarts=${MAX_RESTARTS}`);
launch();

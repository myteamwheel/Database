// Categorize WHY PBP reconstruction disagrees with GameRotation, rather than reporting one
// aggregate minute error.
//
// "Mean error 3.00 minutes" says nothing about what to fix. "61% of errors come from period-opening
// lineups" is actionable. Every validated GameRotation game is ground truth for the exact stint
// boundaries, so each disagreement can be attributed to a specific failure mode and the dominant
// one fixed first.
//
// This is deliberately deterministic and auditable. Reconstruction is an accounting problem; using
// a model here would bury the very bugs that need to be visible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stints } from './lib/rotation.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const rotDir = path.join(HIST, 'rotation'), pbpDir = path.join(HIST, 'pbp');
const TENTHS = 600;   // per minute
const PERIOD = 12 * TENTHS, OT = 5 * TENTHS;

const started = new Map(), seasonOf = new Map(), rosterName = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()) {
  const gl = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(gl)) for (const r of JSON.parse(fs.readFileSync(gl, 'utf8'))) { seasonOf.set(r.gameId, s); rosterName.set(`${r.gameId}|${r.playerId}`, r.playerName); }
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) if (r.started === true) started.set(`${r.gameId}|${r.playerId}`, true);
  }
}

/** Which period does a game-clock offset fall in, and is it a period boundary? */
const periodOf = (t) => (t < 4 * PERIOD ? Math.floor(t / PERIOD) + 1 : 5 + Math.floor((t - 4 * PERIOD) / OT));
const isBoundary = (t) => {
  const p = periodOf(t);
  const start = p <= 4 ? (p - 1) * PERIOD : 4 * PERIOD + (p - 5) * OT;
  return Math.abs(t - start) < 30;   // within 3s of a period start
};

/** Attribute one player's stint disagreement to a failure mode. */
function classify(truth, recon) {
  if (!recon.length && truth.length) return 'no_stints_reconstructed';
  if (recon.length && !truth.length) return 'phantom_stints';
  const dT = truth.reduce((a, s) => a + (s.outT - s.inT), 0);
  const dR = recon.reduce((a, s) => a + (s.end - s.start) * 10, 0);   // recon in seconds -> tenths
  if (Math.abs(dT - dR) < 0.5 * TENTHS) return 'match';

  // Which boundaries are involved in the missing or extra time?
  const truthStarts = truth.map((s) => s.inT), reconStarts = recon.map((s) => s.start * 10);
  const missedOpen = truthStarts.filter((t) => isBoundary(t) && !reconStarts.some((r) => Math.abs(r - t) < 60));
  if (missedOpen.length) {
    const p = periodOf(missedOpen[0]);
    if (p === 2) return 'missed_Q2_opening_lineup';
    if (p === 3) return 'missed_Q3_opening_lineup';
    if (p >= 5) return 'missed_OT_opening_lineup';
    if (p === 4) return 'missed_Q4_opening_lineup';
    return 'missed_period_opening_lineup';
  }
  if (recon.length !== truth.length) return dR > dT ? 'extra_or_merged_stints' : 'missing_stints';
  return dR > dT ? 'stint_extends_too_long' : 'stint_ends_too_early';
}

const rotFiles = fs.existsSync(rotDir) ? fs.readdirSync(rotDir).filter((f) => f.endsWith('.json')) : [];
if (!rotFiles.length) { console.log('no GameRotation ground truth cached yet'); process.exit(0); }

const counts = new Map(), bySeason = new Map();
let players = 0, matched = 0, gamesUsed = 0;
for (const fn of rotFiles) {
  const gid = fn.replace('.json', '');
  const pbpFile = path.join(pbpDir, `${gid}.json`);
  if (!fs.existsSync(pbpFile)) continue;      // need both sources for the same game
  gamesUsed++;
  const rot = JSON.parse(fs.readFileSync(path.join(rotDir, fn), 'utf8'));
  const pbp = JSON.parse(fs.readFileSync(pbpFile, 'utf8'));
  const byPlayer = new Map();
  for (const s of rot.stints) {
    if (!byPlayer.has(s.personId)) byPlayer.set(s.personId, []);
    byPlayer.get(s.personId).push(s);
  }
  for (const [pid, truth] of byPlayer) {
    const nm = rosterName.get(`${gid}|${pid}`) || (pbp.actions.find((a) => String(a.personId) === String(pid)) || {}).playerName;
    const recon = stints(pbp, String(pid), started.has(`${gid}|${pid}`), nm);
    const c = classify(truth.sort((a, b) => a.inT - b.inT), recon);
    players++;
    if (c === 'match') matched++;
    counts.set(c, (counts.get(c) || 0) + 1);
    const s = seasonOf.get(gid) || '?';
    if (!bySeason.has(s)) bySeason.set(s, new Map());
    bySeason.get(s).set(c, (bySeason.get(s).get(c) || 0) + 1);
  }
}
console.log(`RECONSTRUCTION ERROR CATEGORIES — ${gamesUsed} games with BOTH sources, ${players} player-games\n`);
console.log(`exact match: ${matched}/${players} (${(100 * matched / players).toFixed(1)}%)\n`);
console.log('failure mode                      count    share of errors');
const errs = players - matched;
for (const [c, n] of [...counts.entries()].filter(([c]) => c !== 'match').sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(32)} ${String(n).padStart(5)}    ${(100 * n / errs).toFixed(1)}%`);
}
console.log('\nFix the dominant mode first, rerun, and the distribution should shift.');

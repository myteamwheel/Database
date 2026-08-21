// Are GameRotation-UNAVAILABLE games harder for our deterministic PBP reconstructor?
//
// Feed cleanliness (parseable records, present IDs) does NOT measure reconstruction difficulty.
// What has actually cost us is lineup state: period-opening lineups, carrying state across
// boundaries, simultaneous substitution ordering. This measures that directly, using official
// box-score minutes as the reference — available for BOTH groups, unlike stint timing.
//
// WHAT THIS CAN AND CANNOT ESTABLISH. Materially worse reconstruction among unavailable games is
// evidence that Tier A is selected toward easier games. Similar difficulty is reassuring but is NOT
// proof: two different stint reconstructions can produce nearly identical total minutes, and where
// GameRotation is missing the true stint timing is unobserved by definition.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stints } from './lib/rotation.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const rotDir = path.join(HIST, 'rotation'), pbpDir = path.join(HIST, 'pbp');
const haveRot = new Set(fs.existsSync(rotDir) ? fs.readdirSync(rotDir).map((f) => f.replace('.json', '')) : []);

const box = new Map(), started = new Map(), seasonOf = new Map(), rosterName = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    seasonOf.set(r.gameId, s);
    rosterName.set(`${r.gameId}|${r.playerId}`, r.playerName);
    if (r.min > 0) box.set(`${r.gameId}|${r.playerId}`, r.min);
  }
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) if (r.started === true) started.set(`${r.gameId}|${r.playerId}`, true);
  }
}

/** Reconstruct one game with the current deterministic rules and score the difficulty. */
function difficulty(rec) {
  const g = rec.gameId;
  const ids = [...new Set(rec.actions.filter((a) => a.personId).map((a) => String(a.personId)))];
  const errs = [];
  let unresolved = 0;
  for (const pid of ids) {
    const bm = box.get(`${g}|${Number(pid)}`);
    if (bm === undefined) continue;
    const nm = rosterName.get(`${g}|${Number(pid)}`) || (rec.actions.find((a) => String(a.personId) === pid) || {}).playerName;
    const st = stints(rec, pid, started.has(`${g}|${Number(pid)}`), nm);
    if (!st.length) { unresolved++; continue; }
    errs.push(Math.abs(st.reduce((a, s) => a + (s.end - s.start), 0) / 60 - bm));
  }
  if (!errs.length) return null;
  errs.sort((a, b) => a - b);
  return {
    season: seasonOf.get(g) || '?',
    available: haveRot.has(g) ? 1 : 0,
    players: errs.length,
    meanErr: errs.reduce((a, b) => a + b, 0) / errs.length,
    maxErr: errs[errs.length - 1],
    pctOver1: 100 * errs.filter((e) => e > 1).length / errs.length,
    unresolvedPlayers: unresolved,
  };
}

const rows = [];
for (const fn of (fs.existsSync(pbpDir) ? fs.readdirSync(pbpDir).filter((f) => f.endsWith('.json')) : [])) {
  const d = difficulty(JSON.parse(fs.readFileSync(path.join(pbpDir, fn), 'utf8')));
  if (d) rows.push(d);
}
const A = rows.filter((r) => r.available), U = rows.filter((r) => !r.available);
console.log(`RECONSTRUCTION DIFFICULTY — rotation available (${A.length} games) vs unavailable (${U.length})\n`);
if (!A.length || !U.length) {
  console.log('Insufficient overlap between the rotation and PBP caches to compare yet.');
  process.exit(0);
}
const m = (arr, k) => arr.reduce((a, x) => a + x[k], 0) / arr.length;
console.log('metric                     available   unavailable   diff');
for (const k of ['meanErr', 'maxErr', 'pctOver1', 'unresolvedPlayers']) {
  console.log(`${k.padEnd(25)} ${m(A, k).toFixed(2).padStart(9)} ${m(U, k).toFixed(2).padStart(13)} ${(m(A, k) - m(U, k)).toFixed(2).padStart(7)}`);
}
// Within season, because pooled comparison can measure era rather than difficulty.
console.log('\nwithin season (cells with >=5 games in both groups):');
console.log('season      nA   nU   meanErr A   meanErr U');
for (const s of [...new Set(rows.map((r) => r.season))].sort()) {
  const a = A.filter((r) => r.season === s), u = U.filter((r) => r.season === s);
  if (a.length < 5 || u.length < 5) continue;
  console.log(`${s.padEnd(11)} ${String(a.length).padStart(3)}  ${String(u.length).padStart(3)}   ${m(a, 'meanErr').toFixed(2).padStart(9)}   ${m(u, 'meanErr').toFixed(2).padStart(9)}`);
}
console.log('\nWorse error among UNAVAILABLE games would indicate Tier A is selected toward easier');
console.log('games. Similar error is reassuring but not proof: total minutes can match while stint');
console.log('timing differs, and timing is unobserved exactly where GameRotation is missing.');

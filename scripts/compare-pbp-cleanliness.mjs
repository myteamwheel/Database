// THE HIDDEN SELECTION RISK.
//
// If GameRotation exists disproportionately for games whose play-by-play is unusually clean, then
// Tier A is the EASY subset. A deterministic PBP reconstructor developed and audited on Tier A
// would score beautifully and still fail on Tier B — the messier games where GameRotation is
// missing and the fallback is actually needed. Held-out Tier A accuracy would be falsely
// reassuring.
//
// This compares the PBP feed itself between games where GameRotation is available and where it is
// not. Feed quality matters far more here than home/away or month.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const rotDir = path.join(HIST, 'rotation'), pbpDir = path.join(HIST, 'pbp');
const haveRot = new Set(fs.existsSync(rotDir) ? fs.readdirSync(rotDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : []);
const pbpFiles = fs.existsSync(pbpDir) ? fs.readdirSync(pbpDir).filter((f) => f.endsWith('.json')) : [];

/** Observable cleanliness of one game's play-by-play. */
function cleanliness(rec) {
  const subs = (rec.actions || []).filter((a) => /substitution/i.test(a.type || ''));
  const parseable = subs.filter((a) => /SUB:\s*.+\s+FOR\s+/i.test(String(a.description || ''))).length;
  const noPerson = subs.filter((a) => !a.personId).length;
  const noDesc = subs.filter((a) => !a.description).length;
  // Simultaneous substitutions share a timestamp; more of them means harder reconstruction.
  const byClock = new Map();
  for (const a of subs) {
    const k = `${a.p}|${a.clock}`;
    byClock.set(k, (byClock.get(k) || 0) + 1);
  }
  const simultaneous = [...byClock.values()].filter((n) => n > 1).length;
  const maxAtOnce = byClock.size ? Math.max(...byClock.values()) : 0;
  const periodEvents = (rec.actions || []).filter((a) => a.type === 'period').length;
  return {
    subs: subs.length,
    parseablePct: subs.length ? 100 * parseable / subs.length : null,
    missingPersonId: noPerson,
    missingDescription: noDesc,
    simultaneousClusters: simultaneous,
    maxSubsAtOneClock: maxAtOnce,
    periodEvents,
    periods: rec.periods || 0,
  };
}

const groups = { available: [], unavailable: [] };
for (const fn of pbpFiles) {
  const gid = fn.replace('.json', '');
  const rec = JSON.parse(fs.readFileSync(path.join(pbpDir, fn), 'utf8'));
  groups[haveRot.has(gid) ? 'available' : 'unavailable'].push(cleanliness(rec));
}
const n = (k) => groups[k].length;
console.log(`PBP CLEANLINESS — GameRotation available (${n('available')}) vs unavailable (${n('unavailable')})\n`);
if (!n('available') || !n('unavailable')) {
  console.log('Not enough overlap yet between the PBP cache and the rotation cache to compare.');
  console.log('Rerun once both crawls cover a common set of games.');
  process.exit(0);
}
const stat = (arr, k) => {
  const v = arr.map((x) => x[k]).filter((x) => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  return { m, sd, n: v.length };
};
console.log('metric                    available    unavailable   std.diff');
for (const k of ['subs', 'parseablePct', 'missingPersonId', 'missingDescription',
  'simultaneousClusters', 'maxSubsAtOneClock', 'periodEvents']) {
  const a = stat(groups.available, k), u = stat(groups.unavailable, k);
  if (!a || !u) continue;
  // Standardized difference: scale-free, so metrics with different units stay comparable.
  const pooled = Math.sqrt((a.sd ** 2 + u.sd ** 2) / 2) || 1;
  const d = (a.m - u.m) / pooled;
  console.log(`${k.padEnd(24)} ${a.m.toFixed(2).padStart(9)} ${u.m.toFixed(2).padStart(14)} ${d.toFixed(3).padStart(10)}${Math.abs(d) > 0.5 ? '  <- large' : Math.abs(d) > 0.2 ? '  <- moderate' : ''}`);
}
console.log('\nWHAT THIS DOES AND DOES NOT SHOW.');
console.log('These metrics test raw substitution-event CLEANLINESS: are records parseable, are IDs');
console.log('and descriptions present. They do NOT test RECONSTRUCTION DIFFICULTY, which is what has');
console.log('actually cost us — period-opening lineups, lineup state across boundaries, simultaneous');
console.log('substitution ordering, and players appearing on court with no explicit sub event. A game');
console.log('can have 100% clean substitution records and still be hard to reconstruct.');
console.log('');
console.log('So similar cleanliness is NOT evidence that Tier A is representative. And note the');
console.log('unavoidable limit: where GameRotation is missing, true stint timing is unobserved, so no');
console.log('diagnostic can prove the two groups are equally hard. Worse reconstruction error among');
console.log('unavailable games would be evidence of selection; similar error is reassuring but not');
console.log('proof. The strongest available evidence remains freezing deterministic rules developed on');
console.log('part of Tier A and auditing them on untouched Tier A seasons and team-seasons.');

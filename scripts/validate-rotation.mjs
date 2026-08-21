// Conservation battery for GameRotation stints.
//
// GameRotation is NEAR-EXACT WHEN COMPLETE — 0.20-0.28 minutes mean error against the box score,
// which is roughly 12-17 seconds and largely box-score rounding. It is not literally exact, and it
// is not uniformly complete: some games return PARTIAL stint sets that produce believable-looking
// but wrong minutes. Partial responses are more dangerous than missing ones, because missing data
// announces itself and corrupted data does not.
//
// So acceptance is not "average error looks fine". A game must conserve the quantities basketball
// guarantees: five players on the floor at all times, 240 team player-minutes per regulation game
// plus 25 per overtime, every box-score player represented, and no impossible stints.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const CACHE = path.join(HIST, 'rotation');
const TENTHS_PER_MIN = 600;
const REG_TENTHS = 48 * TENTHS_PER_MIN;
const OT_TENTHS = 5 * TENTHS_PER_MIN;

const box = new Map(), started = new Map(), seasonOf = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    seasonOf.set(r.gameId, s);
    if (r.min > 0) box.set(`${r.gameId}|${r.playerId}`, r.min);
  }
  // Starter flags do NOT live in the game log — every `started` there is null. They live in the
  // separate starter crawl. Reading them from the game log made the opening-five check compare
  // against an empty set, so it rejected every game for a fault of its own.
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) {
      if (r.started === true) started.set(`${r.gameId}|${r.playerId}`, true);
    }
  }
}

/** Every check a complete rotation record must satisfy. Any failure rejects the game. */
export function validateGame(rec) {
  const g = rec.gameId, fails = [];
  const stints = rec.stints || [];
  if (!stints.length) return { ok: false, fails: ['no stints'] };

  // 1. Structural validity of each stint.
  if (stints.some((s) => !(s.outT > s.inT))) fails.push('stint with OUT <= IN');

  // 2. Both teams present.
  const teams = [...new Set(stints.map((s) => s.teamId))];
  if (teams.length !== 2) fails.push(`expected 2 teams, got ${teams.length}`);

  // 3. No self-overlap: one player cannot be on the floor twice at once.
  const byPlayer = new Map();
  for (const s of stints) {
    if (!byPlayer.has(s.personId)) byPlayer.set(s.personId, []);
    byPlayer.get(s.personId).push(s);
  }
  for (const [, list] of byPlayer) {
    const sorted = [...list].sort((a, b) => a.inT - b.inT);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].inT < sorted[i - 1].outT) { fails.push('overlapping stints for one player'); break; }
  }

  // 4. Game length inferred from the latest stint end, then team minutes must conserve:
  //    240 player-minutes per regulation game, +25 per overtime period.
  const gameEnd = Math.max(...stints.map((s) => s.outT));
  const otPeriods = gameEnd > REG_TENTHS ? Math.round((gameEnd - REG_TENTHS) / OT_TENTHS) : 0;
  const expectedPerTeam = (48 + 5 * otPeriods) * 5;   // player-minutes
  for (const t of teams) {
    const tm = stints.filter((s) => s.teamId === t).reduce((a, s) => a + (s.outT - s.inT) / TENTHS_PER_MIN, 0);
    if (Math.abs(tm - expectedPerTeam) > 1.5) fails.push(`team ${t} has ${tm.toFixed(1)} player-minutes, expected ${expectedPerTeam}`);
  }

  // 5. Five on the floor at every moment. Swept as an event line rather than sampled, so a gap of
  //    any length is caught.
  for (const t of teams) {
    const ev = [];
    for (const s of stints.filter((x) => x.teamId === t)) { ev.push([s.inT, 1]); ev.push([s.outT, -1]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let on = 0, badSpan = 0, prev = 0;
    for (const [t2, d] of ev) {
      if (t2 > prev && on !== 5 && prev < gameEnd) badSpan += t2 - prev;
      on += d; prev = t2;
    }
    // A little slack absorbs simultaneous substitutions recorded a tenth apart.
    if (badSpan > 30) fails.push(`team ${t} not at 5 players for ${(badSpan / TENTHS_PER_MIN).toFixed(2)} min`);
  }

  // 6. Every box-score player present, and minutes agree tightly for ALL of them.
  const mins = new Map();
  for (const s of stints) mins.set(s.personId, (mins.get(s.personId) || 0) + (s.outT - s.inT) / TENTHS_PER_MIN);
  let missing = 0, worst = 0;
  for (const [k, bm] of box) {
    if (!k.startsWith(g + '|')) continue;
    const pid = Number(k.split('|')[1]);
    const rm = mins.get(pid);
    if (rm === undefined) { missing++; continue; }
    worst = Math.max(worst, Math.abs(rm - bm));
  }
  if (missing) fails.push(`${missing} box-score players absent from rotation`);
  if (worst > 1.0) fails.push(`worst per-player minute gap ${worst.toFixed(2)}`);

  // 7. Opening five must match the official starters — but only where starter data actually exists
  // for this game. Absent starter data is a gap in OUR records, not a defect in the rotation feed,
  // and must not be scored as one.
  const haveStarters = [...started.keys()].some((k) => k.startsWith(g + '|'));
  for (const t of (haveStarters ? teams : [])) {
    const opens = stints.filter((s) => s.teamId === t && s.inT === 0).map((s) => s.personId);
    if (opens.length !== 5) { fails.push(`team ${t} opens with ${opens.length} players`); continue; }
    const mismatched = opens.filter((p) => !started.has(`${g}|${p}`)).length;
    if (mismatched) fails.push(`team ${t} opening five disagrees with official starters (${mismatched})`);
  }

  return { ok: fails.length === 0, fails, worst: +worst.toFixed(2), otPeriods };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')) : [];
  const bySeason = new Map(), reasons = new Map();
  const accepted = [];
  for (const fn of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(CACHE, fn), 'utf8'));
    const v = validateGame(rec);
    const s = seasonOf.get(rec.gameId) || '?';
    const b = bySeason.get(s) || { ok: 0, bad: 0 };
    if (v.ok) { b.ok++; accepted.push(rec.gameId); } else {
      b.bad++;
      for (const f of v.fails) {
        const key = f.replace(/\d+(\.\d+)?/g, 'N').replace(/team \d+/, 'team');
        reasons.set(key, (reasons.get(key) || 0) + 1);
      }
    }
    bySeason.set(s, b);
  }
  console.log('ROTATION CONSERVATION BATTERY');
  console.log(`games cached: ${files.length}\n`);
  console.log('season     accepted  rejected  accept%');
  for (const [s, b] of [...bySeason.entries()].sort()) {
    console.log(`${s.padEnd(10)} ${String(b.ok).padStart(8)} ${String(b.bad).padStart(9)}  ${(100 * b.ok / (b.ok + b.bad)).toFixed(1)}%`);
  }
  console.log('\nrejection reasons:');
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${r}`);
  fs.writeFileSync(path.join(HIST, 'rotation_accepted.json'), JSON.stringify(accepted));
  console.log(`\naccepted game ids -> scripts/data/history/rotation_accepted.json (${accepted.length})`);
}

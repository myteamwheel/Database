// PHASE 0, stage 3 — CORRECTED empirical-support measurement. Still outcome-blind.
//
// The stage-2 support figure was invalid: it compared ONE game's minutes to a prior average, so it
// measured ordinary game-to-game minute variance, not shock-induced reallocation. A player's minutes
// swing several MPG night to night for reasons having nothing to do with a teammate's absence.
//
// The dose TULIP needs is the SYSTEMATIC shift: mean minutes when teammate a is OUT minus mean when
// a is IN, for the same (team-season, absent player, teammate) cell, with enough games on both sides
// that the mean is not itself noise. A variance decomposition below quantifies how much of the
// per-game shift was signal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')))
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: String(r.teamId), min: r.min ?? 0 });
}
const teamGames = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!teamGames.has(k)) teamGames.set(k, new Map());
  teamGames.get(k).set(r.gameId, r.gameDate);
}
for (const [k, m] of teamGames) teamGames.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));
const minOf = new Map();
for (const r of rows) minOf.set(`${r.gameId}|${r.playerId}`, r.min);
const rosterOf = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!rosterOf.has(k)) rosterOf.set(k, new Set());
  rosterOf.get(k).add(r.playerId);
}

const MIN_SIDE = 3;      // >=3 games with a OUT and >=3 with a IN before a cell is measurable
const cells = [];        // systematic shift per (team-season, absent a, teammate p)
const perGameShift = []; // for the variance decomposition
for (const [tk, games] of teamGames) {
  const [season, teamId] = tk.split('|');
  const roster = [...(rosterOf.get(tk) || [])];
  // absent players worth studying: rotation regulars with both in- and out-games
  for (const a of roster) {
    const inG = [], outG = [];
    for (const g of games) {
      const m = minOf.get(`${g}|${a}`);
      if (m === undefined || m <= 0) outG.push(g); else inG.push(g);
    }
    if (inG.length < MIN_SIDE || outG.length < MIN_SIDE) continue;
    const aMpg = inG.reduce((x, g) => x + (minOf.get(`${g}|${a}`) ?? 0), 0) / inG.length;
    if (aMpg < 15) continue;                       // rotation player only
    for (const p of roster) {
      if (p === a) continue;
      const mi = inG.map((g) => minOf.get(`${g}|${p}`) ?? 0).filter((v, i) => minOf.get(`${inG[i]}|${p}`) !== undefined);
      const mo = outG.map((g) => minOf.get(`${g}|${p}`) ?? 0).filter((v, i) => minOf.get(`${outG[i]}|${p}`) !== undefined);
      if (mi.length < MIN_SIDE || mo.length < MIN_SIDE) continue;
      const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
      const sd = (arr, m) => Math.sqrt(arr.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, arr.length - 1));
      const mIn = avg(mi), mOut = avg(mo);
      const shift = mOut - mIn;
      const seShift = Math.sqrt(sd(mi, mIn) ** 2 / mi.length + sd(mo, mOut) ** 2 / mo.length);
      cells.push({ season, teamId, a, p, nIn: mi.length, nOut: mo.length, mIn, mOut, shift, seShift, aMpg });
      for (const v of mo) perGameShift.push(Math.abs(v - mIn));
    }
  }
}
console.log('================ PHASE 0, STAGE 3 — CORRECTED SUPPORT ================\n');
console.log(`measurable (team-season, absent, teammate) cells with >=${MIN_SIDE} games each side: ${cells.length}`);
console.log(`distinct absent rotation players: ${new Set(cells.map((c) => c.a)).size}`);
console.log(`distinct team-seasons: ${new Set(cells.map((c) => c.season + '|' + c.teamId)).size}\n`);

const abs = cells.map((c) => Math.abs(c.shift)).sort((a, b) => a - b);
const qq = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
console.log('--- SYSTEMATIC reallocation |mean(out) - mean(in)| per teammate ---');
console.log(`  p50 ${qq(0.5).toFixed(2)}  p75 ${qq(0.75).toFixed(2)}  p90 ${qq(0.90).toFixed(2)}  p95 ${qq(0.95).toFixed(2)}  p99 ${qq(0.99).toFixed(2)}  max ${abs[abs.length - 1].toFixed(1)}`);
for (const t of [1, 2, 3, 5, 8]) {
  const k = abs.filter((x) => x >= t).length;
  console.log(`  |systematic shift| >= ${t} MPG : ${(100 * k / abs.length).toFixed(1)}%  (n=${k})`);
}

console.log('\n--- how much of that is REAL vs sampling noise? ---');
const sig = cells.filter((c) => Math.abs(c.shift) > 1.96 * c.seShift);
console.log(`  cells whose shift exceeds its own 95% sampling error: ${sig.length} of ${cells.length} (${(100 * sig.length / cells.length).toFixed(1)}%)`);
const sigAbs = sig.map((c) => Math.abs(c.shift)).sort((a, b) => a - b);
const sq = (p) => sigAbs[Math.min(sigAbs.length - 1, Math.floor(p * sigAbs.length))];
console.log(`  among those: p50 ${sq(0.5).toFixed(2)}  p90 ${sq(0.90).toFixed(2)}  p95 ${sq(0.95).toFixed(2)}  max ${sigAbs[sigAbs.length - 1].toFixed(1)}`);
for (const t of [1, 2, 3, 5, 8]) {
  const k = sigAbs.filter((x) => x >= t).length;
  console.log(`    statistically distinguishable |shift| >= ${t} MPG : ${k}`);
}

console.log('\n--- variance decomposition (why the stage-2 number was wrong) ---');
const pg = perGameShift.sort((a, b) => a - b);
console.log(`  per-game |min - prior mean| p50 ${pg[Math.floor(pg.length / 2)].toFixed(2)}   <- dominated by ordinary game-to-game variance`);
console.log(`  systematic |mean(out) - mean(in)| p50 ${qq(0.5).toFixed(2)}   <- the actual shock-induced dose`);
console.log(`  ratio: per-game dispersion overstates the true dose by ~${(pg[Math.floor(pg.length / 2)] / qq(0.5)).toFixed(1)}x at the median`);

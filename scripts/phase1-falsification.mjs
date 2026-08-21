// PHASE 1 — FALSIFICATION TESTS for Design A. DEV SEASONS ONLY.
//
// This script deliberately does NOT compute the structural coefficient (instrument -> margin in
// SHOCK games). It runs only the tests that could reveal violations of the identifying assumptions.
// Those tests are NECESSARY, NOT SUFFICIENT: passing them means we failed to reject important
// violations, never that injury shocks are exogenous.
//
// Tests:
//   T1 PRE-TREND       instrument vs team margin in games BEFORE the shock            -> expect null
//   T2 OUTCOME PLACEBO same instrument in games where the "absent" player PLAYED       -> expect null
//   T3 OPPONENT BALANCE instrument vs opponent pre-game strength                       -> expect null
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];

// ---- team margins (DEV only) ----
const margin = new Map(), teamDate = new Map();
for (const s of DEV) {
  const f = path.join(HIST, 'teamlogs', `${s}.json`);
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    margin.set(`${r.gameId}|${r.teamId}`, r.plusMinus);
    teamDate.set(`${r.gameId}|${r.teamId}`, r.gameDate);
  }
}
// ---- player rows ----
const rows = [];
for (const s of DEV) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')))
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: String(r.teamId),
      min: r.min ?? 0, pts: r.pts, fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, oreb: r.oreb, dreb: r.dreb, ast: r.ast, stl: r.stl, blk: r.blk, pf: r.pf, tov: r.tov });
}
const gsF = (r) => r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm) + 0.7 * r.oreb + 0.3 * r.dreb + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
const tg = new Map(), minOf = new Map(), rowAt = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!tg.has(k)) tg.set(k, new Map());
  tg.get(k).set(r.gameId, r.gameDate);
  minOf.set(`${r.gameId}|${r.playerId}`, r.min);
  rowAt.set(`${r.gameId}|${r.playerId}`, r);
}
for (const [k, m] of tg) tg.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));

/** Build the frozen-weight instrument for one (team-season, focal player, target game). */
function instrumentFor(season, teamId, focal, gameId) {
  const games = tg.get(`${season}|${teamId}`) || [];
  const i = games.indexOf(gameId);
  if (i < 10) return null;
  const prior = games.slice(0, i);
  const outG = [], inG = [];
  for (const g of prior) { const m = minOf.get(`${g}|${focal}`); if (m === undefined || m <= 0) outG.push(g); else inG.push(g); }
  if (outG.length < 1 || inG.length < 3) return null;
  const present = rows.filter((r) => r.gameId === gameId && r.teamId === teamId && r.min > 0 && r.playerId !== focal);
  if (present.length < 3) return null;
  const val = (p) => { let m = 0, g = 0;
    for (const gid of prior) { const rr = rowAt.get(`${gid}|${p}`); if (!rr || rr.min <= 0) continue; m += rr.min; g += gsF(rr); }
    return m < 60 ? null : 36 * g / m; };
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const w = [];
  for (const p of present) {
    const v = val(p.playerId); if (v === null) continue;
    const mo = outG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
    const mi = inG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
    w.push({ w: avg(mo) - avg(mi), v, priorMin: avg(mi) });
  }
  if (w.length < 3) return null;
  const tot = w.reduce((a, x) => a + x.priorMin, 0);
  const vbar = w.reduce((a, x) => a + x.v * x.priorMin, 0) / Math.max(1e-9, tot);
  return w.reduce((a, x) => a + Math.max(0, x.w) * (x.v - vbar), 0);
}

/** Within-team-season FE regression with cluster-robust SE at team-season. */
function reg(sample) {
  const grp = new Map();
  for (const s of sample) { const k = `${s.season}|${s.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(s); }
  const X = [], Y = [], C = [];
  for (const [k, arr] of grp) {
    if (arr.length < 2) continue;
    const mx = arr.reduce((a, b) => a + b.z, 0) / arr.length, my = arr.reduce((a, b) => a + b.y, 0) / arr.length;
    for (const b of arr) { X.push(b.z - mx); Y.push(b.y - my); C.push(k); }
  }
  const n = X.length;
  if (n < 50) return null;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += X[i] * X[i]; sxy += X[i] * Y[i]; }
  const beta = sxy / sxx;
  const byC = new Map();
  for (let i = 0; i < n; i++) { const e = Y[i] - beta * X[i]; byC.set(C[i], (byC.get(C[i]) || 0) + X[i] * e); }
  let meat = 0; for (const v of byC.values()) meat += v * v;
  const G = byC.size, se = Math.sqrt(meat / (sxx * sxx) * (G / Math.max(1, G - 1)));
  // scale: effect per 1 SD of instrument, in points of margin
  const sdz = Math.sqrt(sxx / n);
  return { beta, se, t: beta / se, n, G, perSD: beta * sdz, perSDse: se * sdz };
}
const fmt = (r, label) => r
  ? `  ${label.padEnd(34)} n=${String(r.n).padStart(5)} clusters=${String(r.G).padStart(4)}  per-SD ${(r.perSD >= 0 ? '+' : '') + r.perSD.toFixed(3)} pts  se ${r.perSDse.toFixed(3)}  t ${r.t.toFixed(2)}  ${Math.abs(r.t) > 1.96 ? '<-- REJECTS NULL' : 'null not rejected'}`
  : `  ${label.padEnd(34)} insufficient n`;

const built = JSON.parse(fs.readFileSync('/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad/built.json', 'utf8'))
  .filter((b) => DEV.includes(b.season));
console.log('=========== PHASE 1 — FALSIFICATION TESTS (DEV ONLY) ===========');
console.log('The structural coefficient is NOT computed in this script.\n');
console.log(`DEV shocks available: ${built.length}\n`);

// ---- T1 PRE-TREND ----
console.log('--- T1 PRE-TREND: instrument vs team margin BEFORE the shock (expect null) ---');
for (const K of [3, 5]) {
  const sample = [];
  for (const b of built) {
    const games = tg.get(`${b.season}|${b.teamId}`) || [];
    const i = games.indexOf(b.gameId);
    if (i < K) continue;
    const prior = games.slice(i - K, i).map((g) => margin.get(`${g}|${b.teamId}`)).filter((v) => v !== undefined);
    if (prior.length < K) continue;
    sample.push({ season: b.season, teamId: b.teamId, z: b.predFlow, y: prior.reduce((x, y) => x + y, 0) / prior.length });
  }
  console.log(fmt(reg(sample), `prior ${K}-game mean margin`));
}

// ---- T3 OPPONENT BALANCE (pre-game opponent strength) ----
console.log('\n--- T3 OPPONENT BALANCE: instrument vs opponent pre-game strength (expect null) ---');
{
  // opponent = the other team in the same gameId; strength = their mean margin in prior 10 games
  const oppOf = new Map();
  for (const [k] of margin) { const [g, t] = k.split('|'); if (!oppOf.has(g)) oppOf.set(g, []); oppOf.get(g).push(t); }
  const sample = [];
  for (const b of built) {
    const pair = oppOf.get(b.gameId) || [];
    const opp = pair.find((t) => t !== String(b.teamId));
    if (!opp) continue;
    const ogames = tg.get(`${b.season}|${opp}`) || [];
    const oi = ogames.indexOf(b.gameId);
    if (oi < 10) continue;
    const pr = ogames.slice(oi - 10, oi).map((g) => margin.get(`${g}|${opp}`)).filter((v) => v !== undefined);
    if (pr.length < 8) continue;
    sample.push({ season: b.season, teamId: b.teamId, z: b.predFlow, y: pr.reduce((x, y) => x + y, 0) / pr.length });
  }
  console.log(fmt(reg(sample), 'opponent prior-10 mean margin'));
}

// ---- T2 OUTCOME PLACEBO ----
console.log('\n--- T2 OUTCOME PLACEBO: same instrument in games where the player PLAYED (expect null) ---');
{
  const cells = new Map();
  for (const b of built) cells.set(`${b.season}|${b.teamId}|${b.playerId}`, b);
  // Cap PER CELL, not globally: an early global break would truncate the placebo to whichever
  // team-seasons happened to iterate first, which is a biased subset rather than a placebo.
  const PER_CELL = 6;
  const sample = [];
  for (const [k] of cells) {
    const [season, teamId, focal] = k.split('|');
    const games = tg.get(`${season}|${teamId}`) || [];
    const eligible = [];
    for (let i = 10; i < games.length; i++) {
      const g = games[i];
      const m = minOf.get(`${g}|${focal}`);
      if (m === undefined || m <= 0) continue;          // placebo = games he PLAYED
      if (margin.get(`${g}|${teamId}`) === undefined) continue;
      eligible.push(g);
    }
    // deterministic spread across the season rather than the first few games
    const step = Math.max(1, Math.floor(eligible.length / PER_CELL));
    for (let j = 0; j < eligible.length && sample.length < 100000; j += step) {
      const g = eligible[j];
      const z = instrumentFor(season, teamId, focal, g);
      if (z === null) continue;
      sample.push({ season, teamId, z, y: margin.get(`${g}|${teamId}`) });
    }
  }
  console.log(fmt(reg(sample), 'placebo (player present) margin'));
}
console.log('\nInterpretation rule: these tests can REVEAL violations. They cannot prove exogeneity.');

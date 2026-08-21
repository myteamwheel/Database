// PHASE 3 — bounded value-prior challenge. DEV ONLY. Holdout untouched.
// Stage A: build V0/V1/V2/V3, audit usability, and measure first-stage relevance under the FROZEN
// Design A. No structural coefficient is computed in this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];

const teamMargin = new Map();
for (const s of DEV) { const f = path.join(HIST, 'teamlogs', `${s}.json`);
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) teamMargin.set(`${r.gameId}|${r.teamId}`, r.plusMinus); }

const rows = [];
for (const s of DEV) { const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')))
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: String(r.teamId),
      min: r.min ?? 0, pm: r.plusMinus ?? null,
      pts: r.pts, fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, oreb: r.oreb, dreb: r.dreb, ast: r.ast, stl: r.stl, blk: r.blk, pf: r.pf, tov: r.tov }); }
const gsF = (r) => r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm) + 0.7 * r.oreb + 0.3 * r.dreb + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
const tg = new Map(), rowAt = new Map(), minOf = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!tg.has(k)) tg.set(k, new Map());
  tg.get(k).set(r.gameId, r.gameDate);
  rowAt.set(`${r.gameId}|${r.playerId}`, r); minOf.set(`${r.gameId}|${r.playerId}`, r.min);
}
for (const [k, m] of tg) tg.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));

const K_SHRINK = 400;   // minutes of prior-mean shrinkage, fixed here, not tuned
/** All four priors for one player, from games strictly before `prior` cutoff. */
function priors(playerId, priorGames, teamId) {
  let m = 0, g = 0, pmSum = 0, pmMin = 0;
  for (const gid of priorGames) {
    const r = rowAt.get(`${gid}|${playerId}`);
    if (!r || r.min <= 0) continue;
    m += r.min; g += gsF(r);
    if (r.pm !== null) { pmSum += r.pm; pmMin += r.min; }
  }
  const out = { minutes: m };
  out.V0 = m >= 60 ? (36 * g / m) * (m / (m + K_SHRINK)) : null;
  out.V1 = pmMin >= 60 ? (36 * pmSum / pmMin) * (pmMin / (pmMin + K_SHRINK)) : null;
  // V2 WOWY: team margin with vs without, prior games only
  const withG = [], withoutG = [];
  for (const gid of priorGames) {
    const mm = minOf.get(`${gid}|${playerId}`);
    const tm = teamMargin.get(`${gid}|${teamId}`);
    if (tm === undefined) continue;
    if (mm === undefined || mm <= 0) withoutG.push(tm); else withG.push(tm);
  }
  if (withG.length >= 5 && withoutG.length >= 3) {
    const a = withG.reduce((x, y) => x + y, 0) / withG.length;
    const b = withoutG.reduce((x, y) => x + y, 0) / withoutG.length;
    const nEff = Math.min(withG.length, withoutG.length);
    out.V2 = (a - b) * (nEff / (nEff + 10));
  } else out.V2 = null;
  return out;
}

// standardise within season for blending
console.log('======= PHASE 3A — VALUE-PRIOR AUDIT (DEV only, outcome-blind first stage) =======\n');
console.log('RAPM: INFEASIBLE within this bounded challenge — 10.5% PBP coverage of DEV games;');
console.log('full coverage needs ~9,760 fetches plus the lineup-reconstruction pipeline. Recorded, not attempted.\n');

const shocks = JSON.parse(fs.readFileSync(`${S}/built.json`, 'utf8')).filter((b) => DEV.includes(b.season));
// Rebuild the instrument per prior, reusing the FROZEN Design A construction.
function instrumentsFor(kind) {
  const out = [];
  let missing = 0;
  for (const sh of shocks) {
    const games = tg.get(`${sh.season}|${sh.teamId}`) || [];
    const i = games.indexOf(sh.gameId);
    if (i < 10) continue;
    const prior = games.slice(0, i);
    const outG = [], inG = [];
    for (const g of prior) { const m = minOf.get(`${g}|${sh.playerId}`); if (m === undefined || m <= 0) outG.push(g); else inG.push(g); }
    if (outG.length < 1 || inG.length < 3) continue;
    const present = rows.filter((r) => r.gameId === sh.gameId && r.teamId === sh.teamId && r.min > 0 && r.playerId !== sh.playerId);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const w = [];
    for (const p of present) {
      const pv = priors(p.playerId, prior, sh.teamId);
      const v = pv[kind];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const mo = outG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
      const mi = inG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
      w.push({ w: avg(mo) - avg(mi), v, priorMin: avg(mi), realized: p.min });
    }
    if (w.length < 3) { missing++; continue; }
    const totMin = w.reduce((a, x) => a + x.priorMin, 0);
    const vbar = w.reduce((a, x) => a + x.v * x.priorMin, 0) / Math.max(1e-9, totMin);
    out.push({ ...sh,
      predFlow: w.reduce((a, x) => a + Math.max(0, x.w) * (x.v - vbar), 0),
      realizedFlow: w.reduce((a, x) => a + (x.realized - x.priorMin) * (x.v - vbar), 0) });
  }
  return { out, missing };
}
function firstStage(sample) {
  const grp = new Map();
  for (const b of sample) { const k = `${b.season}|${b.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(b); }
  const X = [], Y = [], C = [];
  for (const [k, arr] of grp) { if (arr.length < 2) continue;
    const mx = arr.reduce((a, b) => a + b.predFlow, 0) / arr.length, my = arr.reduce((a, b) => a + b.realizedFlow, 0) / arr.length;
    for (const b of arr) { X.push(b.predFlow - mx); Y.push(b.realizedFlow - my); C.push(k); } }
  const n = X.length; if (n < 50) return null;
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += X[i] * X[i]; sxy += X[i] * Y[i]; }
  const beta = sxy / sxx;
  const by = new Map(); for (let i = 0; i < n; i++) by.set(C[i], (by.get(C[i]) || 0) + X[i] * (Y[i] - beta * X[i]));
  let s2 = 0; for (const v of by.values()) s2 += v * v;
  const G = by.size, se = Math.sqrt(s2 / (sxx * sxx) * (G / (G - 1)));
  return { beta, F: (beta / se) ** 2, n, G };
}
const results = {};
for (const kind of ['V0', 'V1', 'V2']) {
  const { out, missing } = instrumentsFor(kind);
  const fs1 = firstStage(out);
  results[kind] = out;
  console.log(`--- ${kind} ---`);
  console.log(`  shocks with usable instrument: ${out.length} (dropped for missing prior: ${missing})`);
  console.log(`  first stage (frozen Design A): ${fs1 ? `beta ${fs1.beta.toFixed(3)}  cluster-F ${fs1.F.toFixed(1)}  n=${fs1.n} clusters=${fs1.G}` : 'insufficient'}`);
  fs.writeFileSync(`${S}/prior_${kind}.json`, JSON.stringify(out));
}
// correlation between priors, on the instrument they induce
const byKey = (arr) => new Map(arr.map((b) => [`${b.gameId}|${b.teamId}|${b.playerId}`, b.predFlow]));
const m0 = byKey(results.V0), m1 = byKey(results.V1), m2 = byKey(results.V2);
function corr(a, b) {
  const keys = [...a.keys()].filter((k) => b.has(k));
  const xa = keys.map((k) => a.get(k)), xb = keys.map((k) => b.get(k));
  const ma = xa.reduce((x, y) => x + y, 0) / xa.length, mb = xb.reduce((x, y) => x + y, 0) / xb.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < keys.length; i++) { n += (xa[i] - ma) * (xb[i] - mb); da += (xa[i] - ma) ** 2; db += (xb[i] - mb) ** 2; }
  return { r: n / Math.sqrt(da * db), n: keys.length };
}
console.log('\n--- do the priors carry DIFFERENT information? (instrument correlation) ---');
const c01 = corr(m0, m1), c02 = corr(m0, m2), c12 = corr(m1, m2);
console.log(`  V0 vs V1: r ${c01.r.toFixed(3)} (n=${c01.n})`);
console.log(`  V0 vs V2: r ${c02.r.toFixed(3)} (n=${c02.n})`);
console.log(`  V1 vs V2: r ${c12.r.toFixed(3)} (n=${c12.n})`);

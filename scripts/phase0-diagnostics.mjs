// PHASE 0, stage 5 — chronological split declared, DEV-ONLY support, and every genuinely
// outcome-blind diagnostic. Still reads no margin, win/loss, net rating or plus-minus.
//
// SPLIT (declared here, frozen before any support rule is chosen):
//   DEVELOPMENT  2015-16 .. 2023-24   (9 seasons)  — all model/support/clamp selection happens here
//   HOLDOUT      2024-25, 2025-26     (2 seasons)  — never inspected for selection of anything
//
// DISCLOSURE: stage 3 computed the support distribution POOLED over all 11 seasons, which included
// holdout EXPOSURE data (minutes), though never holdout outcomes. That pooled number is discarded
// and is used for nothing. The support rule below is computed from DEVELOPMENT SEASONS ONLY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];
const HOLD = ['2024-25','2025-26'];
const built = JSON.parse(fs.readFileSync(`${S}/built.json`, 'utf8'));
const devBuilt = built.filter((b) => DEV.includes(b.season));

console.log('============ PHASE 0, STAGE 5 — SPLIT + OUTCOME-BLIND DIAGNOSTICS ============\n');
console.log(`DEVELOPMENT: ${DEV.join(', ')}`);
console.log(`HOLDOUT (untouched for selection): ${HOLD.join(', ')}`);
console.log(`usable shocks — development ${devBuilt.length} · holdout ${built.length - devBuilt.length}\n`);

// ---------- DEV-ONLY systematic support ----------
const rows = [];
for (const s of DEV) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')))
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: String(r.teamId), min: r.min ?? 0 });
}
const tg = new Map(), minOf = new Map(), roster = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!tg.has(k)) tg.set(k, new Map());
  tg.get(k).set(r.gameId, r.gameDate);
  minOf.set(`${r.gameId}|${r.playerId}`, r.min);
  if (!roster.has(k)) roster.set(k, new Set());
  roster.get(k).add(r.playerId);
}
for (const [k, m] of tg) tg.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));
const cells = [];
for (const [k, games] of tg) {
  const rs = [...(roster.get(k) || [])];
  for (const a of rs) {
    const inG = [], outG = [];
    for (const g of games) { const m = minOf.get(`${g}|${a}`); if (m === undefined || m <= 0) outG.push(g); else inG.push(g); }
    if (inG.length < 3 || outG.length < 3) continue;
    if (inG.reduce((x, g) => x + (minOf.get(`${g}|${a}`) ?? 0), 0) / inG.length < 15) continue;
    for (const p of rs) {
      if (p === a) continue;
      const mi = inG.map((g) => minOf.get(`${g}|${p}`)).filter((v) => v !== undefined);
      const mo = outG.map((g) => minOf.get(`${g}|${p}`)).filter((v) => v !== undefined);
      if (mi.length < 3 || mo.length < 3) continue;
      const avg = (x) => x.reduce((a2, b2) => a2 + b2, 0) / x.length;
      const sdv = (x, m) => Math.sqrt(x.reduce((a2, b2) => a2 + (b2 - m) ** 2, 0) / Math.max(1, x.length - 1));
      const mIn = avg(mi), mOut = avg(mo);
      cells.push({ shift: mOut - mIn, se: Math.sqrt(sdv(mi, mIn) ** 2 / mi.length + sdv(mo, mOut) ** 2 / mo.length) });
    }
  }
}
const abs = cells.map((c) => Math.abs(c.shift)).sort((a, b) => a - b);
const sig = cells.filter((c) => Math.abs(c.shift) > 1.96 * c.se);
const qq = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
console.log('--- DEVELOPMENT-ONLY systematic reallocation support ---');
console.log(`  cells ${cells.length} · distinguishable from own sampling error ${sig.length} (${(100 * sig.length / cells.length).toFixed(1)}%)`);
console.log(`  |shift| p50 ${qq(abs, .5).toFixed(2)}  p75 ${qq(abs, .75).toFixed(2)}  p90 ${qq(abs, .90).toFixed(2)}  p95 ${qq(abs, .95).toFixed(2)}`);
console.log('  distinguishable cells by magnitude:');
const sigAbs = sig.map((c) => Math.abs(c.shift)).sort((a, b) => a - b);
for (const t of [1, 2, 3, 5, 8, 11]) console.log(`    >=${String(t).padStart(2)} MPG : ${sigAbs.filter((x) => x >= t).length}`);
console.log('  NOTE: this is OBSERVED EXPOSURE density, not causal support. The causally usable region');
console.log('  is set after identification diagnostics, by a pre-specified precision rule — not by p95.');

// ---------- first stage with intended FE + clustering ----------
function fsStats(sample, label) {
  if (sample.length < 40) { console.log(`  ${label.padEnd(26)} n=${sample.length} — too few`); return null; }
  // demean within team-season (the intended FE)
  const grp = new Map();
  for (const b of sample) { const k = `${b.season}|${b.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(b); }
  const xs = [], ys = [], cl = [];
  for (const [k, arr] of grp) {
    if (arr.length < 2) continue;
    const mx = arr.reduce((a, b) => a + b.predFlow, 0) / arr.length;
    const my = arr.reduce((a, b) => a + b.realizedFlow, 0) / arr.length;
    for (const b of arr) { xs.push(b.predFlow - mx); ys.push(b.realizedFlow - my); cl.push(k); }
  }
  const n = xs.length;
  if (n < 40) { console.log(`  ${label.padEnd(26)} n=${n} after FE — too few`); return null; }
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const beta = sxy / sxx;
  // cluster-robust variance at team-season
  const byC = new Map();
  for (let i = 0; i < n; i++) { const e = ys[i] - beta * xs[i]; byC.set(cl[i], (byC.get(cl[i]) || 0) + xs[i] * e); }
  let meat = 0; for (const v of byC.values()) meat += v * v;
  const G = byC.size;
  const varB = meat / (sxx * sxx) * (G / Math.max(1, G - 1));
  const seB = Math.sqrt(varB), Feff = (beta / seB) ** 2;
  console.log(`  ${label.padEnd(26)} n=${String(n).padStart(5)} clusters=${String(G).padStart(4)} beta ${beta.toFixed(3)} se ${seB.toFixed(3)} cluster-F ${Feff.toFixed(1)}`);
  return { beta, seB, Feff, n, G };
}
console.log('\n--- FIRST STAGE with team-season FE, cluster-robust at team-season (DEV ONLY) ---');
const full = fsStats(devBuilt, 'ALL usable shocks');
console.log('\n--- by shock class (never pooled) ---');
for (const c of ['C3_INJURY', 'C1_ADMIN', 'C2_PERSONAL', 'C4_TEAM_REST', 'C5_OTHER']) fsStats(devBuilt.filter((b) => b.cls === c), c);

// ---------- leave-one-out sensitivity ----------
console.log('\n--- LEAVE-ONE-OUT sensitivity of the first stage (DEV) ---');
function loo(keyFn, label) {
  const keys = [...new Set(devBuilt.map(keyFn))];
  const betas = [];
  for (const k of keys) {
    const sub = devBuilt.filter((b) => keyFn(b) !== k);
    if (sub.length < 100) continue;
    const grp = new Map();
    for (const b of sub) { const g = `${b.season}|${b.teamId}`; if (!grp.has(g)) grp.set(g, []); grp.get(g).push(b); }
    let sxx = 0, sxy = 0;
    for (const [, arr] of grp) {
      if (arr.length < 2) continue;
      const mx = arr.reduce((a, b) => a + b.predFlow, 0) / arr.length, my = arr.reduce((a, b) => a + b.realizedFlow, 0) / arr.length;
      for (const b of arr) { const x = b.predFlow - mx; sxx += x * x; sxy += x * (b.realizedFlow - my); }
    }
    betas.push(sxy / sxx);
  }
  betas.sort((a, b) => a - b);
  console.log(`  drop-one ${label.padEnd(14)} k=${betas.length}  beta min ${betas[0].toFixed(3)}  median ${betas[Math.floor(betas.length / 2)].toFixed(3)}  max ${betas[betas.length - 1].toFixed(3)}`);
}
loo((b) => b.teamId, 'team');
loo((b) => b.playerId, 'absent player');
loo((b) => `${b.season}|${b.teamId}`, 'team-season');
loo((b) => b.season, 'season');

// ---------- balance on predetermined covariates ----------
console.log('\n--- BALANCE: does the instrument predict PREDETERMINED variables it should not? ---');
console.log('  (all covariates fixed before tip-off; no game outcome involved)');
function balance(name, get) {
  const sub = devBuilt.filter((b) => Number.isFinite(get(b)));
  const mx = sub.reduce((a, b) => a + b.predFlow, 0) / sub.length;
  const my = sub.reduce((a, b) => a + get(b), 0) / sub.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const b of sub) { sxy += (b.predFlow - mx) * (get(b) - my); sxx += (b.predFlow - mx) ** 2; syy += (get(b) - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy);
  console.log(`  ${name.padEnd(30)} corr with instrument ${r >= 0 ? '+' : ''}${r.toFixed(3)}  ${Math.abs(r) > 0.10 ? '<-- CHECK' : ''}`);
}
balance('absent player prior MPG', (b) => b.priorMpg);
balance('game index within season', (b) => b.gameIdx);
balance('n teammates valued', (b) => b.nTeammates);
balance('total routed minutes (totW)', (b) => b.totW);

// PHASE 3B — identical frozen Design A applied to each declared prior. DEV only.
// Falsification battery + conditioned structural + AR CI + leave-one-out + sensitivity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];
const margin = new Map();
for (const s of DEV) { const f = path.join(HIST, 'teamlogs', `${s}.json`);
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) margin.set(`${r.gameId}|${r.teamId}`, r.plusMinus); }
const tgMap = new Map();
for (const s of DEV) { const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const k = `${s}|${r.teamId}`; if (!tgMap.has(k)) tgMap.set(k, new Map()); tgMap.get(k).set(r.gameId, String(r.gameDate)); } }
for (const [k, m] of tgMap) tgMap.set(k, [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([g]) => g));

const CTRL = ['priorMpg', 'gameIdx', 'nTeammates', 'totW'];
function partial(sample, fields) {
  const grp = new Map();
  for (const b of sample) { const k = `${b.season}|${b.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(b); }
  const res = {}; for (const f of fields) res[f] = []; const keys = [], Xc = [];
  for (const [k, arr] of grp) { if (arr.length < 2) continue;
    const m = (fn) => arr.reduce((a, x) => a + fn(x), 0) / arr.length;
    const mc = CTRL.map((c) => m((x) => x[c] ?? 0)), mf = fields.map((f) => m((x) => x[f]));
    for (const b of arr) { keys.push(k); Xc.push(CTRL.map((c, i) => (b[c] ?? 0) - mc[i])); fields.forEach((f, i) => res[f].push(b[f] - mf[i])); } }
  const p = CTRL.length, n = Xc.length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) for (let c = 0; c < p; c++) XtX[a][c] += Xc[i][a] * Xc[i][c];
  const solve = (rhs) => { const A = XtX.map((r, i) => [...r, rhs[i]]);
    for (let c = 0; c < p; c++) { let pv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
      [A[c], A[pv]] = [A[pv], A[c]]; if (Math.abs(A[c][c]) < 1e-12) A[c][c] = 1e-12;
      for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k2 = c; k2 <= p; k2++) A[r][k2] -= f * A[c][k2]; } }
    return A.map((r, i) => r[p] / A[i][i]); };
  for (const f of fields) { const rhs = new Array(p).fill(0);
    for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) rhs[a] += Xc[i][a] * res[f][i];
    const w = solve(rhs);
    for (let i = 0; i < n; i++) res[f][i] -= Xc[i].reduce((a, x, j) => a + w[j] * x, 0); }
  return { ...res, keys };
}
const sdOf = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
function analyse(sample, label) {
  const P = partial(sample, ['predFlow', 'realizedFlow', 'y']);
  const Z = P.predFlow, X = P.realizedFlow, Y = P.y, K = P.keys, n = Z.length;
  let zz = 0, zx = 0, zy = 0;
  for (let i = 0; i < n; i++) { zz += Z[i] * Z[i]; zx += Z[i] * X[i]; zy += Z[i] * Y[i]; }
  const bRF = zy / zz, bFS = zx / zz, bIV = zy / zx;
  const cv = (num) => { const by = new Map(); for (let i = 0; i < n; i++) by.set(K[i], (by.get(K[i]) || 0) + num[i]);
    let s2 = 0; for (const v of by.values()) s2 += v * v; return { s2, G: by.size }; };
  const rfN = []; for (let i = 0; i < n; i++) rfN.push(Z[i] * (Y[i] - bRF * Z[i]));
  const v1 = cv(rfN), seRF = Math.sqrt(v1.s2 / (zz * zz) * (v1.G / (v1.G - 1)));
  const fsN = []; for (let i = 0; i < n; i++) fsN.push(Z[i] * (X[i] - bFS * Z[i]));
  const v2 = cv(fsN), seFS = Math.sqrt(v2.s2 / (zz * zz) * (v2.G / (v2.G - 1)));
  const sdZ = sdOf(Z), sdX = sdOf(X);
  // AR CI
  const arRej = (b0) => { let zyn = 0; for (let i = 0; i < n; i++) zyn += Z[i] * (Y[i] - b0 * X[i]);
    const bb = zyn / zz; const num = []; for (let i = 0; i < n; i++) num.push(Z[i] * ((Y[i] - b0 * X[i]) - bb * Z[i]));
    const v = cv(num); return Math.abs(bb / Math.sqrt(v.s2 / (zz * zz) * (v.G / (v.G - 1)))) > 1.96; };
  const span = Math.max(Math.abs(bIV) * 12, Math.abs(bRF / bFS) * 12, 1e-6);
  let lo = null, hi = null;
  for (let k = 0; k <= 800; k++) { const b0 = bIV - span + 2 * span * k / 800; if (!arRej(b0)) { if (lo === null) lo = b0; hi = b0; } }
  console.log(`\n===== ${label} =====`);
  console.log(`  n=${n} clusters=${v1.G}`);
  console.log(`  first stage : beta ${bFS.toFixed(3)}  cluster-F ${((bFS / seFS) ** 2).toFixed(1)}`);
  console.log(`  reduced form: ${(bRF * sdZ >= 0 ? '+' : '') + (bRF * sdZ).toFixed(3)} pts/SD  se ${(seRF * sdZ).toFixed(3)}  t ${(bRF / seRF).toFixed(2)}`);
  console.log(`  IV          : ${(bIV * sdX >= 0 ? '+' : '') + (bIV * sdX).toFixed(3)} pts per SD of realized reallocation`);
  console.log(`  AR 95% CI   : ${lo === null ? 'EMPTY' : `[${(lo * sdX).toFixed(3)}, ${(hi * sdX).toFixed(3)}]`}`
    + `  ${lo !== null && (lo * sdX) * (hi * sdX) > 0 ? (lo * sdX > 0 ? '<-- POSITIVE, excludes zero' : '<-- negative, excludes zero') : '<-- includes zero'}`);
  return { bRF, seRF, sdZ, perSD: bRF * sdZ, sePerSD: seRF * sdZ, F: (bFS / seFS) ** 2 };
}
// falsification for a given prior
function falsify(sample, label) {
  const pre = [];
  for (const b of sample) {
    const games = tgMap.get(`${b.season}|${b.teamId}`) || [];
    const i = games.indexOf(b.gameId); if (i < 3) continue;
    const pr = games.slice(i - 3, i).map((g) => margin.get(`${g}|${b.teamId}`)).filter((v) => v !== undefined);
    if (pr.length < 3) continue;
    pre.push({ ...b, y: pr.reduce((x, y) => x + y, 0) / pr.length });
  }
  const P = partial(pre, ['predFlow', 'y']);
  const Z = P.predFlow, Y = P.y, K = P.keys, n = Z.length;
  let zz = 0, zy = 0; for (let i = 0; i < n; i++) { zz += Z[i] * Z[i]; zy += Z[i] * Y[i]; }
  const b = zy / zz;
  const by = new Map(); for (let i = 0; i < n; i++) by.set(K[i], (by.get(K[i]) || 0) + Z[i] * (Y[i] - b * Z[i]));
  let s2 = 0; for (const v of by.values()) s2 += v * v;
  const G = by.size, se = Math.sqrt(s2 / (zz * zz) * (G / (G - 1)));
  console.log(`  pre-trend (prior-3 margin): ${(b * sdOf(Z) >= 0 ? '+' : '') + (b * sdOf(Z)).toFixed(3)} pts/SD  t ${(b / se).toFixed(2)}  ${Math.abs(b / se) > 1.96 ? '<-- REJECTS' : 'ok'}`);
}
console.log('======= PHASE 3B — FROZEN DESIGN A UNDER EACH DECLARED PRIOR (DEV) =======');
const out = {};
for (const kind of ['V0', 'V1', 'V2']) {
  const raw = JSON.parse(fs.readFileSync(`${S}/prior_${kind}.json`, 'utf8'))
    .map((b) => ({ ...b, y: margin.get(`${b.gameId}|${b.teamId}`) })).filter((b) => b.y !== undefined);
  out[kind] = analyse(raw, `${kind}${kind === 'V0' ? '  (FROZEN BENCHMARK)' : ''}`);
  falsify(raw, kind);
}
// V3 = predeclared 50/50 blend of standardised V0 and V1 instruments
{
  const a = JSON.parse(fs.readFileSync(`${S}/prior_V0.json`, 'utf8'));
  const b = new Map(JSON.parse(fs.readFileSync(`${S}/prior_V1.json`, 'utf8')).map((x) => [`${x.gameId}|${x.teamId}|${x.playerId}`, x]));
  // Standardise EACH prior's instrument by ITS OWN SD before the 50/50 blend. The earlier version
  // divided both by V0's SD and contained a stray term, producing NaN.
  const arr1 = [...b.values()];
  const sa0 = sdOf(a.map((x) => x.predFlow)), sf0 = sdOf(a.map((x) => x.realizedFlow));
  const sa1 = sdOf(arr1.map((x) => x.predFlow)), sf1 = sdOf(arr1.map((x) => x.realizedFlow));
  const bl = [];
  for (const x of a) {
    const y = b.get(`${x.gameId}|${x.teamId}|${x.playerId}`); if (!y) continue;
    const m = margin.get(`${x.gameId}|${x.teamId}`); if (m === undefined) continue;
    bl.push({ ...x,
      predFlow: 0.5 * (x.predFlow / sa0) + 0.5 * (y.predFlow / sa1),
      realizedFlow: 0.5 * (x.realizedFlow / sf0) + 0.5 * (y.realizedFlow / sf1), y: m });
  }
  out.V3 = analyse(bl, 'V3  (predeclared 50/50 blend V0+V1)');
  falsify(bl, 'V3');
}
console.log('\n======= COMPARISON vs FROZEN BENCHMARK V0 =======');
console.log('  prior   reduced form pts/SD        t      first-stage F');
for (const k of ['V0', 'V1', 'V2', 'V3']) {
  const r = out[k]; if (!r) continue;
  console.log(`  ${k}      ${(r.perSD >= 0 ? '+' : '') + r.perSD.toFixed(3)} (se ${r.sePerSD.toFixed(3)})   ${(r.bRF / r.seRF).toFixed(2)}      ${r.F.toFixed(1)}`);
}

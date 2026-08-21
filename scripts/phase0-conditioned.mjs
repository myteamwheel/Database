// PHASE 0, stage 6 — does the instrument survive conditioning on the covariates it failed balance on?
// Outcome-blind. If residualising the instrument on those predetermined controls destroys its
// variation or its first stage, Design A is not usable as specified.
import fs from 'node:fs';
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];
const b0 = JSON.parse(fs.readFileSync(`${S}/built.json`, 'utf8')).filter((b) => DEV.includes(b.season));
const CTRL = ['priorMpg', 'gameIdx', 'nTeammates', 'totW'];

// within team-season FE + linear controls, by Frisch-Waugh
function residualise(sample, target, controls) {
  const grp = new Map();
  for (const b of sample) { const k = `${b.season}|${b.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(b); }
  const X = [], Y = [], keys = [];
  for (const [k, arr] of grp) {
    if (arr.length < 2) continue;
    const m = (f) => arr.reduce((a, x) => a + f(x), 0) / arr.length;
    const my = m((x) => x[target]);
    const mc = controls.map((c) => m((x) => x[c] ?? 0));
    for (const b of arr) { Y.push(b[target] - my); X.push(controls.map((c, i) => (b[c] ?? 0) - mc[i])); keys.push(k); }
  }
  // OLS of Y on X
  const p = controls.length, n = Y.length;
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { for (let c = 0; c < p; c++) A[a][c] += X[i][a] * X[i][c]; A[a][p] += X[i][a] * Y[i]; }
  for (let c = 0; c < p; c++) {
    let pv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) A[c][c] = 1e-12;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k2 = c; k2 <= p; k2++) A[r][k2] -= f * A[c][k2]; }
  }
  const w = A.map((r, i) => r[p] / A[i][i]);
  const res = Y.map((y, i) => y - X[i].reduce((a, x, j) => a + w[j] * x, 0));
  const sd = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n);
  const sdRaw = Math.sqrt(Y.reduce((a, y) => a + y * y, 0) / n);
  return { res, keys, retained: sd / sdRaw };
}
const zi = residualise(b0, 'predFlow', CTRL);
const zy = residualise(b0, 'realizedFlow', CTRL);
console.log('======= PHASE 0, STAGE 6 — INSTRUMENT AFTER CONDITIONING (DEV, outcome-blind) =======\n');
console.log(`instrument SD retained after FE + balance controls: ${(100 * zi.retained).toFixed(1)}%`);
console.log(`exposure   SD retained: ${(100 * zy.retained).toFixed(1)}%\n`);
let sxx = 0, sxy = 0;
for (let i = 0; i < zi.res.length; i++) { sxx += zi.res[i] ** 2; sxy += zi.res[i] * zy.res[i]; }
const beta = sxy / sxx;
const byC = new Map();
for (let i = 0; i < zi.res.length; i++) { const e = zy.res[i] - beta * zi.res[i]; byC.set(zi.keys[i], (byC.get(zi.keys[i]) || 0) + zi.res[i] * e); }
let meat = 0; for (const v of byC.values()) meat += v * v;
const G = byC.size, se = Math.sqrt(meat / (sxx * sxx) * (G / (G - 1)));
console.log('--- CONDITIONED FIRST STAGE (team-season FE + priorMpg, gameIdx, nTeammates, totW) ---');
console.log(`  n=${zi.res.length} clusters=${G}  beta ${beta.toFixed(3)}  se ${se.toFixed(3)}  cluster-F ${((beta / se) ** 2).toFixed(1)}`);
console.log('\n--- residual balance recheck ---');
for (const c of CTRL) {
  const zc = residualise(b0, c, CTRL.filter((x) => x !== c));
  let s = 0, a1 = 0, a2 = 0;
  const n = Math.min(zi.res.length, zc.res.length);
  for (let i = 0; i < n; i++) { s += zi.res[i] * zc.res[i]; a1 += zi.res[i] ** 2; a2 += zc.res[i] ** 2; }
  console.log(`  ${c.padEnd(14)} residual corr ${(s / Math.sqrt(a1 * a2)).toFixed(3)}`);
}

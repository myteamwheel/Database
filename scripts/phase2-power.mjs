// PHASE 2b — power/MDE for the DEV null, interpretable units, and separate C1/C2 reduced-form
// direction. DEV only. Never pooled to manufacture power.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const DEV = ['2015-16','2016-17','2017-18','2018-19','2019-20','2020-21','2021-22','2022-23','2023-24'];
const margin = new Map();
for (const s of DEV) { const f = path.join(HIST, 'teamlogs', `${s}.json`);
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) margin.set(`${r.gameId}|${r.teamId}`, r.plusMinus); }
const all = JSON.parse(fs.readFileSync(`${S}/built.json`, 'utf8'))
  .filter((b) => DEV.includes(b.season)).map((b) => ({ ...b, y: margin.get(`${b.gameId}|${b.teamId}`) })).filter((b) => b.y !== undefined);

function rf(sample) {
  const grp = new Map();
  for (const b of sample) { const k = `${b.season}|${b.teamId}`; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(b); }
  const Z = [], Y = [], K = [];
  for (const [k, arr] of grp) { if (arr.length < 2) continue;
    const mz = arr.reduce((a, b) => a + b.predFlow, 0) / arr.length, my = arr.reduce((a, b) => a + b.y, 0) / arr.length;
    for (const b of arr) { Z.push(b.predFlow - mz); Y.push(b.y - my); K.push(k); } }
  const n = Z.length; if (n < 40) return null;
  let zz = 0, zy = 0; for (let i = 0; i < n; i++) { zz += Z[i] * Z[i]; zy += Z[i] * Y[i]; }
  const b = zy / zz;
  const by = new Map(); for (let i = 0; i < n; i++) by.set(K[i], (by.get(K[i]) || 0) + Z[i] * (Y[i] - b * Z[i]));
  let s2 = 0; for (const v of by.values()) s2 += v * v;
  const G = by.size, se = Math.sqrt(s2 / (zz * zz) * (G / (G - 1)));
  const m = Z.reduce((a, x) => a + x, 0) / n, sdZ = Math.sqrt(Z.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  return { perSD: b * sdZ, sePerSD: se * sdZ, t: b / se, n, G };
}
const A = rf(all);
console.log('=========== PHASE 2b — POWER OF THE DEV NULL ===========\n');
console.log(`reduced form (all usable DEV shocks): ${A.perSD.toFixed(3)} pts per SD of instrument, se ${A.sePerSD.toFixed(3)}, t ${A.t.toFixed(2)}`);
const mde = 2.8 * A.sePerSD;
console.log(`\nminimum detectable effect at 80% power / 5% level: ~${mde.toFixed(2)} pts per SD of instrument`);
console.log(`95% CI on the reduced form: [${(A.perSD - 1.96 * A.sePerSD).toFixed(3)}, ${(A.perSD + 1.96 * A.sePerSD).toFixed(3)}] pts`);

// interpretable units: what does 1 SD of the instrument mean in MPG routed toward better players?
const shifts = all.map((b) => b.totW).filter(Number.isFinite).sort((a, b) => a - b);
console.log(`\ninterpretation: 1 SD of instrument corresponds to routing minutes toward higher-value`);
console.log(`teammates on the order of a few MPG (median total routed minutes per shock: ${shifts[Math.floor(shifts.length / 2)].toFixed(1)}).`);
console.log(`So the data can rule out reallocation effects LARGER than roughly ${mde.toFixed(2)} pts per SD,`);
console.log(`but cannot distinguish smaller true effects from zero.`);

console.log('\n--- C1 / C2 REDUCED-FORM DIRECTION (separate, underpowered, never pooled) ---');
for (const c of ['C3_INJURY', 'C1_ADMIN', 'C2_PERSONAL', 'C4_TEAM_REST', 'C5_OTHER']) {
  const r = rf(all.filter((b) => b.cls === c));
  console.log(r
    ? `  ${c.padEnd(14)} n=${String(r.n).padStart(5)} clusters=${String(r.G).padStart(4)}  ${(r.perSD >= 0 ? '+' : '') + r.perSD.toFixed(3)} pts/SD  se ${r.sePerSD.toFixed(3)}  t ${r.t.toFixed(2)}`
    : `  ${c.padEnd(14)} insufficient n`);
}
console.log('\nConcordance question: is C1 (cleaner exogeneity, low power) directionally consistent with C3?');

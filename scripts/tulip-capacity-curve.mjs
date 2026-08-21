// TULIP CAPACITY CURVE — Model A and Model B combined, WITHOUT collapsing to one number.
//
//   Model A  P(sustain >= w)          will the role persist at this workload
//   Model B  P(effective | w)         given he plays it, does production hold
//   joint    P(sustain AND effective) the portable question TULIP actually asks
//
// The two are kept visible because they fail differently and a single scalar hides which one is
// binding. A player can be 90% likely to hold 30 MPG and 40% likely to remain effective there; that
// is a completely different recommendation from the reverse, and one number cannot say so.
//
// "Effective" means holding the player's OWN pre-event GameScore/36 — delta = 0, not a fitted
// threshold. Support is reported at every workload because the curve must abstain where the data
// thins rather than extrapolating confidently.
//
// NOTE ON COMPOSITION. Model B is estimated conditional on the role being received (>=3 usable
// follow-up games), so multiplying is coherent: A supplies P(persist), B supplies P(effective |
// persist). It is NOT a causal claim about raising a player's minutes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';
import { gameScore } from './lib/minutes-response.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5, MIN_FOLLOW = 3, MIN_FOLLOW_MIN = 8;
const PRE = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg'];

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
attachStarterFlags(rows, HIST);

const per36 = (v, m) => (m > 0 ? 36 * v / m : null);
const A_DATA = [], B_DATA = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  // Model A sample: sustained latent workload over ALL follow-ups
  let num = 0, den = 0, w2 = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w2 * (e.outcomeRows[i].min ?? 0); den += w2; w2 *= 1 - ALPHA; }
  if (den > 0) {
    A_DATA.push({ ...e.pre, baselineMpg: e.baselineMpg,
      openerMin: e.openerRow.min ?? e.baselineMpg,
      startedOpener: e.openerRow.started === true ? 1 : 0,
      promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
      y: num / den, pid: String(e.playerId) });
  }
  // Model B sample: conditional on the role actually being received
  const fr = e.outcomeRows.filter((r) => (r.min ?? 0) >= MIN_FOLLOW_MIN);
  if (fr.length < MIN_FOLLOW) continue;
  const m = fr.reduce((a, r) => a + r.min, 0);
  if (m <= 0) continue;
  // WORKLOAD INPUT = the OPENER's minutes, observed BEFORE the outcome window.
  //
  // Using realized follow-up minutes here leaked the outcome back into the predictor: players who
  // ended up playing more had been playing better, which made P(effective|w) RISE with w (53% ->
  // 71%). That is reverse causality, not capacity, and it also breaks the rule that no follow-up
  // information may enter the right-hand side. The opener is the last workload signal that precedes
  // the window the outcome is measured over.
  B_DATA.push({ ...e.pre, baselineMpg: e.baselineMpg, w: e.openerRow.min ?? e.baselineMpg,
    realizedW: m / fr.length,
    y: per36(fr.reduce((a, r) => a + (gameScore(r) ?? 0), 0), m), pid: String(e.playerId) });
}
const A_FE = [...PRE, 'openerMin', 'startedOpener', 'promotedToStart'];
const B_FE = [...PRE, 'w'];
const RIDGE = 1e-6;
function fit(train, FE) {
  const m = FE.length + 1;
  const M = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) M[a][b] += v[a] * v[b]; M[a][m] += v[a] * d.y; }
  }
  for (let a = 1; a < m; a++) M[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) {
    let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
    [M[c], M[pv]] = [M[pv], M[c]];
    if (Math.abs(M[c][c]) < 1e-10) M[c][c] = 1e-10;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
    }
  }
  const wts = M.map((r, i) => r[m] / M[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
const fA = fit(A_DATA, A_FE), residA = A_DATA.map((d) => d.y - fA(d)).sort((a, b) => a - b);
const fB = fit(B_DATA, B_FE), residB = B_DATA.map((d) => d.y - fB(d)).sort((a, b) => a - b);
const pGE = (pred, resid, T) => resid.reduce((c, r) => c + (pred + r >= T ? 1 : 0), 0) / resid.length;

/** Local support: how many historical episodes resemble this query at this workload. */
const support = (q, w) => A_DATA.filter((d) =>
  Math.abs(d.baselineMpg - q.baselineMpg) <= 3 && Math.abs(d.openerMin - w) <= 3).length;

function curve(q, label) {
  console.log(`\n${label}`);
  console.log(`  baseline ${q.baselineMpg} MPG · pre GS/36 ${q.preGsPer36.toFixed(1)} · pre TS ${(100 * q.preTs).toFixed(1)}%`);
  console.log('   w    P(sustain>=w)   P(effective|w)   joint    support');
  for (const w of [22, 24, 26, 28, 30, 32]) {
    const qa = { ...q, openerMin: w };
    const ps = pGE(fA(qa), residA, w);
    const pe = pGE(fB({ ...q, w }), residB, q.preGsPer36);   // holds his own prior rate
    const n = support(q, w);
    const sup = n >= 500 ? 'High' : n >= 200 ? 'Moderate' : n >= 60 ? 'Low' : 'ABSTAIN';
    console.log(`  ${String(w).padStart(2)}      ${(100 * ps).toFixed(0).padStart(3)}%           ${(100 * pe).toFixed(0).padStart(3)}%        ${(100 * ps * pe).toFixed(0).padStart(3)}%     ${String(n).padStart(4)} ${sup}`);
  }
}

const mean = (k) => A_DATA.reduce((a, d) => a + (d[k] ?? 0), 0) / A_DATA.length;
const base = Object.fromEntries(PRE.map((k) => [k, mean(k)]));
console.log('MODEL A sample', A_DATA.length, '· MODEL B sample', B_DATA.length);

curve({ ...base, baselineMpg: 18, preGsPer36: 14.5, preTs: 0.56, preStartRate: 0.1 },
  'UNDERUSED BENCH PLAYER — 18 MPG baseline, above-average rate, rarely starts');
curve({ ...base, baselineMpg: 26, preGsPer36: 13.0, preTs: 0.55, preStartRate: 0.8 },
  'ESTABLISHED STARTER — 26 MPG baseline, average rate');
curve({ ...base, baselineMpg: 12, preGsPer36: 10.0, preTs: 0.52, preStartRate: 0.0 },
  'DEEP BENCH — 12 MPG baseline, below-average rate (expect abstention at high w)');

console.log('\nREADING THIS: the two columns answer different questions and the joint is their product.');
console.log('Where support says ABSTAIN the curve is extrapolating and should not be quoted.');
console.log('P(effective|w) is nearly flat in w because Model B found effectiveness essentially');
console.log('workload-invariant in this range — capacity is limited by ROLE PERSISTENCE, not by');
console.log('per-minute decay. That is a finding, not a modelling shortcut.');

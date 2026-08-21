// MODEL B — does per-minute EFFECTIVENESS survive a bigger role?
//
// Model A answers "will the workload persist". That is only half of TULIP Capacity. A player who
// holds 32 MPG but produces at a replacement rate once he gets there has not demonstrated capacity;
// he has demonstrated availability. Model B estimates the other half: conditional on absorbing a
// larger workload, what happens to production PER MINUTE.
//
// WHY NOT THE WITHIN-PLAYER SEASON COMPARISON in minutes-response.mjs. That pools season-over-season
// minute changes, which are assigned by coaches who see things a box score does not, so a player
// whose minutes rose may simply have been improving. Here the opportunity comes from a TEAMMATE's
// absence, which is exogenous to this player's own form.
//
// TIMING, to avoid the failure that killed TULIP v1. Minutes and production inside one game are
// simultaneous — a player who is scoring stays on the floor — so regressing them against each other
// recovers reverse causality. The episode structure separates them:
//     treatment = workload change measured on the OPENER
//     outcome   = per-minute production on the SUBSEQUENT games
//
// REGRESSION TO THE MEAN is the main non-causal threat: a player observed at an unusually high
// pre-shock rate will decline whatever his minutes do. Pre-shock production is therefore a control,
// so the minute coefficient is identified off variation at a GIVEN prior rate.
//
// MEDIATORS ARE EXCLUDED. Nothing measured after the shock (started, usage, follow-up minutes)
// enters the right-hand side except the treatment itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { gameScore } from './lib/minutes-response.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const MIN_FOLLOW = Number(process.env.MIN_FOLLOW || 3);
const MIN_FOLLOW_MIN = Number(process.env.MIN_FOLLOW_MIN || 8);

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
const ts = (r) => (r.fga + 0.44 * r.fta > 0 ? r.pts / (2 * (r.fga + 0.44 * r.fta)) : null);

const data = [];
let censored = 0;
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  const fr = e.outcomeRows.filter((r) => (r.min ?? 0) >= MIN_FOLLOW_MIN);
  if (fr.length < MIN_FOLLOW) { censored++; continue; }
  const mins = fr.reduce((a, r) => a + r.min, 0);
  if (mins <= 0) { censored++; continue; }
  const gs = fr.reduce((a, r) => a + (gameScore(r) ?? 0), 0);
  const followGsPer36 = 36 * gs / mins;
  const tsVals = fr.map(ts).filter((v) => v !== null);
  const followTs = tsVals.length ? tsVals.reduce((a, b) => a + b, 0) / tsVals.length : null;
  const sustainedMpg = mins / fr.length;
  // TREATMENT measured on the opener, never on the follow-up games that produce the outcome.
  const openerGain = (e.openerRow.min ?? e.baselineMpg) - e.baselineMpg;
  data.push({
    ...e.pre, baselineMpg: e.baselineMpg,
    openerGain, sustainedGain: sustainedMpg - e.baselineMpg, sustainedMpg,
    y: followGsPer36, yTs: followTs,
    pid: String(e.playerId), season: e.season, nFollow: fr.length,
  });
}
console.log(`MODEL B — effectiveness response`);
console.log(`episodes ${data.length} · players ${new Set(data.map((d) => d.pid)).size} · censored for <${MIN_FOLLOW} usable follow-ups ${censored}`);
console.log(`mean follow-up GameScore/36 ${(data.reduce((a, d) => a + d.y, 0) / data.length).toFixed(2)}`);

const CTRL = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg'];

function ols(train, FE, ykey) {
  const m = FE.length + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * (d[ykey] ?? 0); }
  }
  for (let c = 0; c < m; c++) {
    let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-8) A[c][c] = 1e-8;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[m] / A[i][i]);
}

/** Player-clustered bootstrap on the treatment coefficient. */
function coefCI(FE, ykey, treat, B = 1500) {
  const sample = data.filter((d) => Number.isFinite(d[ykey]));
  const idx = FE.indexOf(treat) + 1;
  const point = ols(sample, FE, ykey)[idx];
  const byP = new Map();
  for (const d of sample) { if (!byP.has(d.pid)) byP.set(d.pid, []); byP.get(d.pid).push(d); }
  const groups = [...byP.values()];
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let b = 0; b < B; b++) {
    const tr = [];
    for (let i = 0; i < groups.length; i++) tr.push(...groups[Math.floor(rnd() * groups.length)]);
    boot.push(ols(tr, FE, ykey)[idx]);
  }
  boot.sort((a, b) => a - b);
  return { point, lo: boot[Math.floor(0.025 * B)], hi: boot[Math.floor(0.975 * B)], n: sample.length };
}

console.log('\n===== TREATMENT COEFFICIENT: production per minute vs workload increase =====');
for (const treat of ['openerGain', 'sustainedGain']) {
  const r = coefCI([...CTRL, treat], 'y', treat);
  const flag = (r.lo > 0 || r.hi < 0) ? 'excludes 0' : 'includes 0';
  console.log(`  GameScore/36 on ${treat.padEnd(14)} ${r.point >= 0 ? '+' : ''}${r.point.toFixed(4)} per +1 MPG  95% CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}]  ${flag}  n=${r.n}`);
}
{
  const r = coefCI([...CTRL, 'openerGain'], 'yTs', 'openerGain');
  const flag = (r.lo > 0 || r.hi < 0) ? 'excludes 0' : 'includes 0';
  console.log(`  TS%          on openerGain    ${r.point >= 0 ? '+' : ''}${(100 * r.point).toFixed(4)} pp per +1 MPG  95% CI [${(100 * r.lo).toFixed(4)}, ${(100 * r.hi).toFixed(4)}]  ${flag}  n=${r.n}`);
}

// Shape, without imposing linearity: residualise the outcome on the controls, then read the mean
// residual by band of workload increase. A linear slope near zero could still hide a cliff.
console.log('\n===== SHAPE: residual GameScore/36 by size of opener workload increase =====');
{
  const w = ols(data, CTRL, 'y');
  const resid = data.map((d) => ({ pid: d.pid, g: d.openerGain, r: d.y - (w[0] + CTRL.reduce((s, k, i) => s + w[i + 1] * (d[k] ?? 0), 0)) }));
  const bands = [[-99, 0], [0, 4], [4, 8], [8, 12], [12, 16], [16, 99]];
  console.log('  gain band     n     mean residual GS/36');
  for (const [lo, hi] of bands) {
    const s = resid.filter((x) => x.g >= lo && x.g < hi);
    if (s.length < 40) { console.log(`  ${String(lo).padStart(3)}..${String(hi).padEnd(3)}  ${String(s.length).padStart(5)}   (too few)`); continue; }
    const m = s.reduce((a, x) => a + x.r, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, x) => a + (x.r - m) ** 2, 0) / s.length) / Math.sqrt(new Set(s.map((x) => x.pid)).size);
    console.log(`  ${String(lo).padStart(3)}..${String(hi).padEnd(3)}  ${String(s.length).padStart(5)}   ${m >= 0 ? '+' : ''}${m.toFixed(3)}  +/- ${(1.96 * sd).toFixed(3)}`);
  }
}

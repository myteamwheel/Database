// THE DECISIVE COMPARISON: does rotation-derived ASSIGNED workload beat realized openerMin at
// predicting sustained latent workload?
//
// openerMin is what the player actually logged in the opener. It is partly an OUTCOME — blowouts,
// foul trouble and a hot hand all move it — so using it as the treatment conflates "the team opened
// a role" with "the game let him keep it". Assigned Workload reads the coach's intent from the early
// rotation structure instead, before in-game feedback can act.
//
// Three feature sets are fitted on IDENTICAL rows with an IDENTICAL estimator and IDENTICAL splits,
// so any difference is attributable to the features and nothing else:
//   A  baseline + openerMin                  (current production Model A)
//   B  baseline + assigned (NO openerMin)    (does intent alone beat realized minutes?)
//   C  baseline + openerMin + assigned       (does intent add anything on top?)
//
// Two validation regimes, because grouped-by-player alone cannot detect drift across eras:
//   grouped 5-fold by player   (never split a player across train/test: ~700 players, many episodes)
//   chronological holdout      (train on earlier seasons, test on the latest — the real use case)
//
// SOURCE PRECEDENCE for the rotation features, recorded per row, never blended silently:
//   GAMEROTATION  exact stint times from the endpoint
//   PBP_RECON     deterministic reconstruction, admitted ONLY where official starters exist for the
//                 team-game. On untouched validation that stratum reconstructs first entry to 0.11
//                 min and first-half minutes to 0.14 min; without starters the same rules give 7.94
//                 and 4.45, so the flag is an admission criterion, not a nicety.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { assignedFeatures } from './lib/assigned.mjs';
import { reconstructTeam } from './lib/lineup.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
const BASE = ['preGsPer36', 'preForm5', 'preTs', 'preFgaPer36', 'preAstPer36', 'preTovPer36',
  'preRebPer36', 'preStartRate', 'baselineMpg'];
const ASSIGNED = ['a_started', 'a_firstIn', 'a_firstStint', 'a_q1Min', 'a_firstHalfMin', 'a_stintsH1', 'a_firstHalfShare'];
// In C the official flag already carries "did he start", so the rotation copy is dropped: keeping
// both made the design singular (MAE 7.28, R2 -1.02 — a numerical blow-up, not a finding).
const ASSIGNED_NEW = ASSIGNED.filter((k) => k !== 'a_started');
const SETS = {
  A_openerMin: [...BASE, 'openerMin', 'startedOpener', 'promotedToStart'],
  B_assigned: [...BASE, ...ASSIGNED],
  C_both: [...BASE, 'openerMin', 'startedOpener', 'promotedToStart', ...ASSIGNED_NEW],
};

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
}
// gamelog ships `started: null` everywhere, which silently made startedOpener/promotedToStart
// constant zero. Populate them from the official source before episodes are built, so the
// assignment signal A is credited with is the one it actually has.
{
  const cov = attachStarterFlags(rows, HIST);
  console.log(`starter flags attached: ${cov.set} rows covered, ${cov.unknown} unknown (${(100 * cov.coverage).toFixed(1)}% coverage)`);
}

// roster + official starter flags, needed both to admit a game and to seed reconstruction
const roster = new Map(), hasOfficial = new Set();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const gf = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(gf)) for (const r of JSON.parse(fs.readFileSync(gf, 'utf8'))) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!roster.has(k)) roster.set(k, []);
    roster.get(k).push({ playerId: r.playerId, playerName: r.playerName, started: false });
  }
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) {
      if (r.started !== true) continue;
      const k = `${r.gameId}|${r.teamId}`;
      hasOfficial.add(k);
      const p = (roster.get(k) || []).find((x) => x.playerId === r.playerId);
      if (p) p.started = true;
    }
  }
}

const rotCache = new Set(fs.readdirSync(path.join(HIST, 'rotation')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
const pbpCache = new Set(fs.readdirSync(path.join(HIST, 'pbp')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
const reconMemo = new Map();

/** Early-rotation features for one player in one game, with explicit source precedence. */
function rotationFeatures(gameId, teamId, playerId) {
  if (rotCache.has(gameId)) {
    const j = JSON.parse(fs.readFileSync(path.join(HIST, 'rotation', `${gameId}.json`), 'utf8'));
    const f = assignedFeatures(j.stints, playerId);
    if (f) return { f, src: 'GAMEROTATION' };
  }
  const key = `${gameId}|${teamId}`;
  if (!pbpCache.has(gameId) || !hasOfficial.has(key)) return null;   // admission criterion
  let byPlayer = reconMemo.get(key);
  if (byPlayer === undefined) {
    try {
      const pbp = JSON.parse(fs.readFileSync(path.join(HIST, 'pbp', `${gameId}.json`), 'utf8'));
      byPlayer = reconstructTeam(pbp, teamId, roster.get(key) || []).byPlayer;
    } catch { byPlayer = null; }
    reconMemo.set(key, byPlayer);
  }
  if (!byPlayer) return null;
  const ss = byPlayer.get(Number(playerId)) || byPlayer.get(String(playerId));
  if (!ss || !ss.length) return null;
  // reconstructTeam yields seconds; assignedFeatures expects tenths of a second
  const stints = ss.map((s) => ({ personId: playerId, inT: Math.round(s.start * 10), outT: Math.round(s.end * 10), ptDiff: 0 }));
  const f = assignedFeatures(stints, playerId);
  return f ? { f, src: 'PBP_RECON' } : null;
}

function latentWorkload(outcomeRows) {
  if (!outcomeRows.length) return null;
  let num = 0, den = 0, w = 1;
  for (let i = outcomeRows.length - 1; i >= 0; i--) { num += w * (outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  return den > 0 ? num / den : null;
}

const data = [];
const srcTally = {};
let noRot = 0;
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36) || !Number.isFinite(e.pre?.preForm5)) continue;
  const sustained = latentWorkload(e.outcomeRows);
  if (!Number.isFinite(sustained)) continue;
  const g = String(e.openerRow.gameId), tid = e.openerRow.teamId;
  const got = rotationFeatures(g, tid, e.playerId);
  if (!got) { noRot++; continue; }
  srcTally[got.src] = (srcTally[got.src] || 0) + 1;
  data.push({
    ...e.pre, baselineMpg: e.baselineMpg,
    openerMin: e.openerRow.min ?? e.baselineMpg,
    startedOpener: e.openerRow.started === true ? 1 : 0,
    promotedToStart: (e.openerRow.started === true && (e.pre.preStartRate ?? 0) < 0.5) ? 1 : 0,
    a_started: got.f.startedOpener, a_firstIn: got.f.firstInMin, a_firstStint: got.f.firstStintMin,
    a_q1Min: got.f.q1Min, a_firstHalfMin: got.f.firstHalfMin, a_stintsH1: got.f.stintsFirstHalf,
    a_firstHalfShare: got.f.firstHalfShare,
    y: sustained, pid: String(e.playerId), season: e.season, src: got.src,
  });
}
console.log(`episodes WITH rotation features: ${data.length} · players ${new Set(data.map((d) => d.pid)).size}`);
console.log(`  sources: ${JSON.stringify(srcTally)} · episodes dropped for no rotation source: ${noRot}`);
if (data.length < 150) { console.log('\nSAMPLE TOO SMALL for an honest held-out comparison — waiting for more games.'); process.exit(0); }

const RIDGE = Number(process.env.RIDGE || 1e-6);
function ols(train, FE) {
  const m = FE.length + 1;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) {
    const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; }
  }
  // Ridge on the slopes only (never the intercept): guards the solve against the early-rotation
  // features, which are correlated with one another by construction.
  const scale = train.length * RIDGE;
  for (let a = 1; a < m; a++) A[a][a] += scale;
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
  const w = A.map((r, i) => r[m] / A[i][i]);
  return (d) => w[0] + FE.reduce((s, k, i) => s + w[i + 1] * (d[k] ?? 0), 0);
}

function score(oof) {
  const mae = oof.reduce((a, o) => a + Math.abs(o.pred - o.actual), 0) / oof.length;
  const my = oof.reduce((a, o) => a + o.actual, 0) / oof.length;
  let ssr = 0, sst = 0;
  for (const o of oof) { ssr += (o.actual - o.pred) ** 2; sst += (o.actual - my) ** 2; }
  let crps = 0;
  for (const o of oof) {
    let s2 = 0;
    for (const r of o.resid) s2 += Math.abs(o.pred + r - o.actual);
    let s3 = 0;
    for (let i = 0; i < o.resid.length; i += 7) for (let j = 0; j < o.resid.length; j += 7) s3 += Math.abs(o.resid[i] - o.resid[j]);
    const k = Math.ceil(o.resid.length / 7);
    crps += s2 / o.resid.length - 0.5 * s3 / (k * k);
  }
  const cov = (lvl) => {
    let hit = 0;
    for (const o of oof) {
      const lo = o.resid[Math.floor((0.5 - lvl / 2) * o.resid.length)], hi = o.resid[Math.min(o.resid.length - 1, Math.floor((0.5 + lvl / 2) * o.resid.length))];
      if (o.actual >= o.pred + lo && o.actual <= o.pred + hi) hit++;
    }
    return 100 * hit / oof.length;
  };
  return { mae, r2: 1 - ssr / sst, crps: crps / oof.length, c50: cov(0.5), c80: cov(0.8), c90: cov(0.9), n: oof.length };
}

function groupedCV(FE) {
  const players = [...new Set(data.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const folds = Array.from({ length: 5 }, () => new Set());
  [...players].sort(() => rnd() - 0.5).forEach((p, i) => folds[i % 5].add(p));
  const oof = [];
  for (const test of folds) {
    const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
    if (tr.length < 60 || !te.length) continue;
    const f = ols(tr, FE);
    const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
    for (const d of te) oof.push({ pred: f(d), actual: d.y, resid });
  }
  return oof.length ? score(oof) : null;
}

function chronoHoldout(FE) {
  const seasons = [...new Set(data.map((d) => d.season))].sort();
  if (seasons.length < 2) return null;
  const last = seasons[seasons.length - 1];
  const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
  if (tr.length < 60 || te.length < 20) return null;
  const f = ols(tr, FE);
  const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
  return { ...score(te.map((d) => ({ pred: f(d), actual: d.y, resid }))), heldOut: last };
}

const row = (n, s) => s
  ? `  ${n.padEnd(14)} MAE ${s.mae.toFixed(3)}  R2 ${s.r2.toFixed(4)}  CRPS ${s.crps.toFixed(3)}  cov ${s.c50.toFixed(1)}/${s.c80.toFixed(1)}/${s.c90.toFixed(1)}  n=${s.n}`
  : `  ${n.padEnd(14)} (insufficient)`;

console.log('\n===== GROUPED 5-FOLD BY PLAYER =====');
const gA = groupedCV(SETS.A_openerMin), gB = groupedCV(SETS.B_assigned), gC = groupedCV(SETS.C_both);
console.log(row('A openerMin', gA)); console.log(row('B assigned', gB)); console.log(row('C both', gC));
console.log('\n===== CHRONOLOGICAL HOLDOUT (latest season) =====');
const cA = chronoHoldout(SETS.A_openerMin), cB = chronoHoldout(SETS.B_assigned), cC = chronoHoldout(SETS.C_both);
if (cA) console.log(`  held out: ${cA.heldOut}`);
console.log(row('A openerMin', cA)); console.log(row('B assigned', cB)); console.log(row('C both', cC));

if (gA && gB && gC) {
  const d = (x, y) => `${(y.mae - x.mae >= 0 ? '' : '+')}${(x.mae - y.mae).toFixed(3)}`;
  console.log('\nVERDICT (grouped CV, MAE — positive = improvement over A)');
  console.log(`  B assigned vs A: ${d(gA, gB)} MAE   R2 ${(gB.r2 - gA.r2 >= 0 ? '+' : '')}${(gB.r2 - gA.r2).toFixed(4)}   CRPS ${(gB.crps - gA.crps).toFixed(3)}`);
  console.log(`  C both     vs A: ${d(gA, gC)} MAE   R2 ${(gC.r2 - gA.r2 >= 0 ? '+' : '')}${(gC.r2 - gA.r2).toFixed(4)}   CRPS ${(gC.crps - gA.crps).toFixed(3)}`);
  console.log('\nNOTE: this sample is the subset of episodes WITH rotation coverage, so A here is not');
  console.log('directly comparable to the full-sample production figure (MAE 4.90 / R2 .541).');
  console.log('The A-vs-B-vs-C contrast within this table is the like-for-like comparison.');
}

// IS THE C-vs-A GAP REAL? A 1% MAE difference on 4,180 rows needs a significance test before it
// justifies any further work. Errors are clustered within player, so the bootstrap resamples
// PLAYERS, not rows — resampling rows would understate the standard error.
function pairedByPlayer(FE1, FE2) {
  const players = [...new Set(data.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const folds = Array.from({ length: 5 }, () => new Set());
  [...players].sort(() => rnd() - 0.5).forEach((p, i) => folds[i % 5].add(p));
  const per = new Map();          // pid -> [sum of (|errA| - |errB|), n]
  for (const test of folds) {
    const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
    if (tr.length < 60 || !te.length) continue;
    const f1 = ols(tr, FE1), f2 = ols(tr, FE2);
    for (const d of te) {
      const diff = Math.abs(f1(d) - d.y) - Math.abs(f2(d) - d.y);   // >0 means FE2 better
      const g = per.get(d.pid) || [0, 0]; g[0] += diff; g[1] += 1; per.set(d.pid, g);
    }
  }
  const arr = [...per.values()];
  const totalN = arr.reduce((a, g) => a + g[1], 0);
  const point = arr.reduce((a, g) => a + g[0], 0) / totalN;
  let s2 = 0; const B = 2000, boot = [];
  for (let b = 0; b < B; b++) {
    let num = 0, den = 0;
    for (let i = 0; i < arr.length; i++) {
      const g = arr[Math.floor(rnd() * arr.length)];
      num += g[0]; den += g[1];
    }
    boot.push(num / den);
  }
  boot.sort((a, b) => a - b);
  return { point, lo: boot[Math.floor(0.025 * B)], hi: boot[Math.floor(0.975 * B)] };
}
console.log('\n===== SIGNIFICANCE (player-clustered bootstrap, 2000 reps) =====');
for (const [lbl, s1, s2] of [['C both vs A', SETS.A_openerMin, SETS.C_both], ['B assigned vs A', SETS.A_openerMin, SETS.B_assigned]]) {
  const r = pairedByPlayer(s1, s2);
  const sig = (r.lo > 0 || r.hi < 0) ? 'excludes 0' : 'INCLUDES 0 — not distinguishable from no effect';
  console.log(`  ${lbl.padEnd(16)} MAE gain ${r.point >= 0 ? '+' : ''}${r.point.toFixed(3)} MPG  95% CI [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]  ${sig}`);
}
const relMean = data.reduce((a, d) => a + d.y, 0) / data.length;
console.log(`  for scale: mean sustained workload ${relMean.toFixed(1)} MPG · a 0.05 MAE gain is ${(100 * 0.05 / relMean).toFixed(2)}% of the mean`);

// LEARNING CURVE: would MORE opener games change the verdict? Subsample PLAYERS (not rows) so each
// point is a smaller but structurally identical dataset. If the C-over-A gap is flat across sample
// sizes, crawling more games cannot rescue it.
console.log('\n===== LEARNING CURVE (subsample by player) =====');
console.log('  n_episodes   A MAE    C MAE    gain');
{
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const players = [...new Set(data.map((d) => d.pid))].sort(() => rnd() - 0.5);
  const full = [...data];   // copy: assigning the reference let the reset below clear it too
  for (const frac of [0.15, 0.3, 0.5, 0.75, 1.0]) {
    const keep = new Set(players.slice(0, Math.max(20, Math.floor(players.length * frac))));
    const sub = full.filter((d) => keep.has(d.pid));
    if (sub.length < 150) continue;
    data.length = 0; data.push(...sub);
    const a = groupedCV(SETS.A_openerMin), c = groupedCV(SETS.C_both);
    if (a && c) console.log(`  ${String(sub.length).padStart(8)}   ${a.mae.toFixed(3)}   ${c.mae.toFixed(3)}   ${(a.mae - c.mae >= 0 ? '+' : '')}${(a.mae - c.mae).toFixed(3)}`);
    data.length = 0; data.push(...full);
  }
}

// ===================================================================================
// PRESPECIFIED HETEROGENEITY TEST — A vs C in eight groups fixed BEFORE looking.
//
// TULIP's intended use is not predicting every player equally well; it is finding underused players
// who receive materially expanded opportunities. A 1.1% aggregate MAE gain could hide a useful gain
// in exactly that population, or could be uniform noise. Three prespecified partitions, eight cells,
// no subdivision beyond this and no post-hoc thresholds.
// ===================================================================================
const GROUPS = [
  ['baseline <18 MPG', (d) => d.baselineMpg < 18],
  ['baseline 18-24', (d) => d.baselineMpg >= 18 && d.baselineMpg < 24],
  ['baseline >=24', (d) => d.baselineMpg >= 24],
  ['expansion <4 MPG', (d) => d.openerMin - d.baselineMpg < 4],
  ['expansion 4-8', (d) => d.openerMin - d.baselineMpg >= 4 && d.openerMin - d.baselineMpg < 8],
  ['expansion >=8', (d) => d.openerMin - d.baselineMpg >= 8],
  ['promoted to starter', (d) => d.promotedToStart === 1],
  ['not promoted', (d) => d.promotedToStart !== 1],
];

/** OOF predictions from both models on identical folds, carrying each row for later subsetting. */
function oofBoth() {
  const players = [...new Set(data.map((d) => d.pid))];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const folds = Array.from({ length: 5 }, () => new Set());
  [...players].sort(() => rnd() - 0.5).forEach((p, i) => folds[i % 5].add(p));
  const out = [];
  for (const test of folds) {
    const tr = data.filter((d) => !test.has(d.pid)), te = data.filter((d) => test.has(d.pid));
    if (tr.length < 60 || !te.length) continue;
    const fA = ols(tr, SETS.A_openerMin), fC = ols(tr, SETS.C_both);
    for (const d of te) out.push({ d, eA: Math.abs(fA(d) - d.y), eC: Math.abs(fC(d) - d.y) });
  }
  return out;
}
/** Player-clustered bootstrap of the MAE difference inside one subgroup. */
function subgroupGain(rowsIn, B = 1500) {
  if (!rowsIn.length) return null;
  const byP = new Map();
  for (const r of rowsIn) { if (!byP.has(r.d.pid)) byP.set(r.d.pid, []); byP.get(r.d.pid).push(r); }
  const groups = [...byP.values()];
  const pt = rowsIn.reduce((a, r) => a + (r.eA - r.eC), 0) / rowsIn.length;
  const maeA = rowsIn.reduce((a, r) => a + r.eA, 0) / rowsIn.length;
  let seed = 23; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(rnd() * groups.length)]; for (const r of g) { s += r.eA - r.eC; n++; } }
    boot.push(s / n);
  }
  boot.sort((a, b) => a - b);
  return { pt, maeA, rel: 100 * pt / maeA, lo: boot[Math.floor(0.025 * B)], hi: boot[Math.floor(0.975 * B)], n: rowsIn.length, players: groups.length };
}

const allOof = oofBoth();
console.log('\n===== PRESPECIFIED SUBGROUPS: A vs C (grouped-player OOF) =====');
console.log('  group                    n   players   MAE_A    gain    rel%    95% CI');
for (const [name, sel] of GROUPS) {
  const r = subgroupGain(allOof.filter((x) => sel(x.d)));
  if (!r) { console.log(`  ${name.padEnd(22)} (empty)`); continue; }
  const sig = (r.lo > 0 || r.hi < 0) ? '' : '  ns';
  console.log(`  ${name.padEnd(22)} ${String(r.n).padStart(5)} ${String(r.players).padStart(7)}   ${r.maeA.toFixed(3)}  ${r.pt >= 0 ? '+' : ''}${r.pt.toFixed(3)}  ${r.rel >= 0 ? '+' : ''}${r.rel.toFixed(1)}%  [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]${sig}`);
}

console.log('\n===== SAME SUBGROUPS ON THE CHRONOLOGICAL HOLDOUT (latest season) =====');
{
  const seasons = [...new Set(data.map((d) => d.season))].sort();
  const last = seasons[seasons.length - 1];
  const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
  const fA = ols(tr, SETS.A_openerMin), fC = ols(tr, SETS.C_both);
  const rowsC = te.map((d) => ({ d, eA: Math.abs(fA(d) - d.y), eC: Math.abs(fC(d) - d.y) }));
  console.log(`  held out ${last} · n=${te.length}`);
  for (const [name, sel] of GROUPS) {
    const s = rowsC.filter((x) => sel(x.d));
    // Underpowered cells are reported as underpowered, not as evidence of no effect.
    if (s.length < 40) { console.log(`  ${name.padEnd(22)} n=${String(s.length).padStart(4)}  underpowered`); continue; }
    const r = subgroupGain(s, 800);
    console.log(`  ${name.padEnd(22)} n=${String(r.n).padStart(4)}  MAE_A ${r.maeA.toFixed(3)}  gain ${r.pt >= 0 ? '+' : ''}${r.pt.toFixed(3)}  ${r.rel >= 0 ? '+' : ''}${r.rel.toFixed(1)}%  [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`);
  }
}

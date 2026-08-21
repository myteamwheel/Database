// PHASE 0, stage 2 — frozen replacement weights, instrument construction, overlap/support.
//
// OUTCOME-BLIND. Reads minutes and BOX-SCORE PRODUCTION only. plusMinus and win/loss are dropped at
// load and never referenced: production is a model INPUT (it is what TULIP Score is built from);
// team margin is the outcome and is untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
const shocks = JSON.parse(fs.readFileSync(`${S}/shocks.json`, 'utf8'));

const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId),
      teamId: String(r.teamId), min: r.min ?? 0,
      pts: r.pts, fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, oreb: r.oreb, dreb: r.dreb,
      ast: r.ast, stl: r.stl, blk: r.blk, pf: r.pf, tov: r.tov });   // NO plusMinus, NO wl
  }
}
const gs = (r) => r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm) + 0.7 * r.oreb + 0.3 * r.dreb
  + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;

const teamSeasonGames = new Map();   // season|team -> [gameId] chronological
const rowsByTeamGame = new Map();    // gameId|team -> rows
for (const r of rows) {
  const tk = `${r.season}|${r.teamId}`;
  if (!teamSeasonGames.has(tk)) teamSeasonGames.set(tk, new Map());
  teamSeasonGames.get(tk).set(r.gameId, r.gameDate);
  const gk = `${r.gameId}|${r.teamId}`;
  if (!rowsByTeamGame.has(gk)) rowsByTeamGame.set(gk, []);
  rowsByTeamGame.get(gk).push(r);
}
for (const [k, m] of teamSeasonGames) teamSeasonGames.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));
const minOf = new Map();
for (const r of rows) minOf.set(`${r.gameId}|${r.playerId}`, r.min);

/** Pre-game player value: shrunk GameScore/36 over prior games in season, standardized within season. */
function valueIndex(season, teamId, playerId, priorGames) {
  let m = 0, g = 0;
  for (const gid of priorGames) {
    const mm = minOf.get(`${gid}|${playerId}`);
    if (mm === undefined || mm <= 0) continue;
    const r = (rowsByTeamGame.get(`${gid}|${teamId}`) || []).find((x) => x.playerId === playerId);
    if (!r) continue;
    m += r.min; g += gs(r);
  }
  if (m < 60) return null;                       // too little to value
  return 36 * g / m;
}

// ---------- frozen replacement weights ----------
// w[p,a] = mean minutes for p in PRIOR games where a was OUT minus PRIOR games where a PLAYED.
// Requires >=1 prior out-game and >=3 prior in-games, all strictly before the shock date.
const MIN_PRIOR_OUT = 1, MIN_PRIOR_IN = 3;
let estimable = 0, notEstimable = 0;
const built = [];
for (const sh of shocks) {
  const tk = `${sh.season}|${sh.teamId}`;
  const games = teamSeasonGames.get(tk) || [];
  const i = games.indexOf(sh.gameId);
  if (i < 0) { notEstimable++; continue; }
  const prior = games.slice(0, i);
  const outG = [], inG = [];
  for (const gid of prior) {
    const mm = minOf.get(`${gid}|${sh.playerId}`);
    if (mm === undefined || mm <= 0) outG.push(gid); else inG.push(gid);
  }
  if (outG.length < MIN_PRIOR_OUT || inG.length < MIN_PRIOR_IN) { notEstimable++; continue; }
  // teammates present in this game
  const present = (rowsByTeamGame.get(`${sh.gameId}|${sh.teamId}`) || []).filter((r) => r.min > 0 && r.playerId !== sh.playerId);
  const w = [];
  for (const p of present) {
    const mo = outG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
    const mi = inG.map((g) => minOf.get(`${g}|${p.playerId}`) ?? 0);
    if (!mo.length || !mi.length) continue;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const wt = avg(mo) - avg(mi);
    const v = valueIndex(sh.season, sh.teamId, p.playerId, prior);
    if (v === null) continue;
    w.push({ playerId: p.playerId, w: wt, v, realizedMin: p.min, priorMin: avg(mi) });
  }
  if (w.length < 3) { notEstimable++; continue; }
  estimable++;
  // predicted VALUE flow: does the mechanical routing send minutes to higher- or lower-value players?
  const totW = w.reduce((a, x) => a + Math.max(0, x.w), 0);
  const vbar = w.reduce((a, x) => a + x.v * x.priorMin, 0) / Math.max(1e-9, w.reduce((a, x) => a + x.priorMin, 0));
  const predFlow = w.reduce((a, x) => a + Math.max(0, x.w) * (x.v - vbar), 0);
  const realizedFlow = w.reduce((a, x) => a + (x.realizedMin - x.priorMin) * (x.v - vbar), 0);
  built.push({ ...sh, nTeammates: w.length, totW, predFlow, realizedFlow,
    maxAbsRealizedShift: Math.max(...w.map((x) => Math.abs(x.realizedMin - x.priorMin))),
    shifts: w.map((x) => x.realizedMin - x.priorMin) });
}
console.log('================ PHASE 0, STAGE 2 — WEIGHTS, INSTRUMENT, OVERLAP ================\n');
console.log(`shocks with ESTIMABLE frozen replacement weights: ${estimable} of ${shocks.length} (${(100 * estimable / shocks.length).toFixed(1)}%)`);
console.log(`  not estimable (no prior out-game / too few priors / <3 valued teammates): ${notEstimable}\n`);

const byCls = {};
for (const b of built) byCls[b.cls] = (byCls[b.cls] || 0) + 1;
console.log('--- usable shocks by class ---');
for (const [c, n] of Object.entries(byCls).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(20)} ${String(n).padStart(6)}`);

// ---------- instrument dispersion & concentration ----------
const pf = built.map((b) => b.predFlow).sort((a, b) => a - b);
const q = (p) => pf[Math.min(pf.length - 1, Math.floor(p * pf.length))];
console.log('\n--- INSTRUMENT (predicted value flow) DISPERSION ---');
console.log(`  p10 ${q(0.10).toFixed(2)}  p25 ${q(0.25).toFixed(2)}  p50 ${q(0.50).toFixed(2)}  p75 ${q(0.75).toFixed(2)}  p90 ${q(0.90).toFixed(2)}`);
console.log(`  share with |predFlow| < 1 (essentially no routing signal): ${(100 * pf.filter((x) => Math.abs(x) < 1).length / pf.length).toFixed(1)}%`);
const contrib = built.map((b) => Math.abs(b.predFlow));
const tot = contrib.reduce((a, b) => a + b, 0);
const sortedC = [...contrib].sort((a, b) => b - a);
console.log(`  top 1% of shocks carry ${(100 * sortedC.slice(0, Math.ceil(0.01 * sortedC.length)).reduce((a, b) => a + b, 0) / tot).toFixed(1)}% of total |instrument| mass`);
console.log(`  top 5%                 ${(100 * sortedC.slice(0, Math.ceil(0.05 * sortedC.length)).reduce((a, b) => a + b, 0) / tot).toFixed(1)}%`);
const teamMass = new Map();
for (const b of built) teamMass.set(`${b.season}|${b.teamId}`, (teamMass.get(`${b.season}|${b.teamId}`) || 0) + Math.abs(b.predFlow));
const tm = [...teamMass.values()].sort((a, b) => b - a);
console.log(`  effective independent team-seasons (1/HHI): ${(1 / tm.reduce((a, x) => a + (x / tot) ** 2, 0)).toFixed(0)} of ${tm.length}`);

// ---------- FIRST STAGE (allocation only — permitted) ----------
const n = built.length;
const mx = built.reduce((a, b) => a + b.predFlow, 0) / n, my = built.reduce((a, b) => a + b.realizedFlow, 0) / n;
let sxy = 0, sxx = 0, syy = 0;
for (const b of built) { sxy += (b.predFlow - mx) * (b.realizedFlow - my); sxx += (b.predFlow - mx) ** 2; syy += (b.realizedFlow - my) ** 2; }
const beta = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
let sse = 0;
for (const b of built) { const e = (b.realizedFlow - my) - beta * (b.predFlow - mx); sse += e * e; }
const se = Math.sqrt(sse / (n - 2) / sxx), F = (beta / se) ** 2;
console.log('\n--- FIRST STAGE: predicted value flow -> REALIZED allocation flow (no outcome involved) ---');
console.log(`  n=${n}  beta ${beta.toFixed(3)}  r ${r.toFixed(3)}  R2 ${(r * r).toFixed(3)}  naive F ${F.toFixed(1)}`);
console.log('  (naive F only; weak-instrument-robust diagnostic is pre-registered for the outcome stage)');

// ---------- EMPIRICAL SUPPORT: how big a reallocation do shocks actually produce? ----------
const allShifts = built.flatMap((b) => b.shifts.map(Math.abs)).sort((a, b) => a - b);
console.log('\n--- EMPIRICAL SUPPORT FOR REALLOCATION MAGNITUDE (per teammate, |minute change|) ---');
console.log(`  observations: ${allShifts.length}`);
for (const t of [1, 2, 3, 5, 8]) {
  const share = allShifts.filter((x) => x >= t).length / allShifts.length;
  console.log(`  |shift| >= ${t} MPG : ${(100 * share).toFixed(1)}%   (n=${allShifts.filter((x) => x >= t).length})`);
}
const qs = (p) => allShifts[Math.min(allShifts.length - 1, Math.floor(p * allShifts.length))];
console.log(`  p50 ${qs(0.5).toFixed(1)}  p75 ${qs(0.75).toFixed(1)}  p90 ${qs(0.90).toFixed(1)}  p95 ${qs(0.95).toFixed(1)}  p99 ${qs(0.99).toFixed(1)}  max ${allShifts[allShifts.length - 1].toFixed(1)}`);
fs.writeFileSync(`${S}/built.json`, JSON.stringify(built.map(({ shifts, ...b }) => b)));

// Fit the cross-league models and attach their outputs to public/data.json.
// Run after build-v3.mjs (needs grades and TULIP frontiers) and before build-artifact.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { tulipMinutes } from './lib/minutes-response.mjs';
import { fileURLToPath } from 'node:url';
import {
  readinessFeatures, READINESS_BLOCKS, fitLogistic, predict, auc,
  per36TranslationFactors, paceAdjustment, translateTo36, nbaTo36,
} from './lib/crossleague.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public/data.json');
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const round = (v, n = 2) => (fin(v) ? Number(Number(v).toFixed(n)) : null);

const nbaAll = d.leagues.NBA.filter((p) => p.appeared);
const glAll = d.leagues.GLEAGUE.filter((p) => p.appeared);
console.log('='.repeat(78));
console.log('CROSS-LEAGUE MODELS');
console.log('='.repeat(78));

/* ---------------------------------------------------------- 1. TULIP minutes advice
 * Computed per TEAM, because the question is whether a roster is spending its minutes on the right
 * people. Multi-team players are excluded: their season line mixes rosters, so "his team" is not
 * well defined for them. BPM is required, which is why the G League gets no TULIP — that league's
 * feed carries no BPM, and substituting a different metric would put the two leagues on scales
 * that are not comparable. */
let optCount = 0, optNull = 0;
{
  const byTeam = new Map();
  const withBpm = nbaAll.filter((p) => p.appeared && fin(p.mpg) && p.mpg > 0 && fin(p.bpm)
    && fin(p.gp) && p.gp > 0 && !(p.teamCount > 1));
  const leagueBpm = withBpm.length ? withBpm.reduce((a, p) => a + p.bpm, 0) / withBpm.length : -0.8;
  for (const p of withBpm) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const advice = new Map();
  for (const [, roster] of byTeam) {
    const out = tulipMinutes(roster.map((p) => ({ playerId: p.playerId, bpm: p.bpm, gp: p.gp, mpg: p.mpg })), leagueBpm);
    if (out) for (const a of out) advice.set(a.playerId, a);
  }
  for (const p of [...nbaAll, ...glAll]) {
    const a = advice.get(p.playerId) || null;
    p.optimal = a;
    if (a) optCount++; else optNull++;
  }
  console.log(`\n--- TULIP minutes advice ---`);
  console.log(`  teams: ${byTeam.size} · league BPM prior ${leagueBpm.toFixed(2)}`);
  console.log(`  players with advice: ${optCount} of ${nbaAll.length + glAll.length}`);
  console.log(`  no advice (multi-team, under the minutes floor, or no BPM incl. all G League): ${optNull}`);
}
const deltas = [...nbaAll, ...glAll].filter((p) => fin(p.optimal?.minutesDelta)).map((p) => p.optimal.minutesDelta);
if (deltas.length) {
  const s = [...deltas].sort((a, b) => a - b);
  console.log(`  minutes delta: min ${s[0]}, median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}`);
  console.log(`  advised to play MORE: ${deltas.filter((x) => x > 0.4).length}`);
  console.log(`  advised to play LESS: ${deltas.filter((x) => x < -0.4).length}`);
}

/* ------------------------------------------------- 2. NBA readiness (G League) */
const byPerson = new Map();
for (const p of nbaAll) byPerson.set(String(p.nbaPersonId || p.playerId), p);
const pairs = [];
for (const g of glAll) {
  const n = byPerson.get(String(g.nbaPersonId || g.playerId));
  if (n) pairs.push({ gl: g, nba: n });
}

// "Effective NBA player" is defined against NBA rotation players, not against everyone: the
// benchmark is the median RATE grade among players with >= 500 NBA minutes. Rate grade is used
// because it measures on-court productivity per 36 rather than rewarding whoever played most.
const rotation = nbaAll.filter((p) => fin(p.minutes) && p.minutes >= 500 && fin(p.rateGrade));
const rotRates = rotation.map((p) => p.rateGrade).sort((a, b) => a - b);
const EFFECTIVE_THRESHOLD = round(rotRates[Math.floor(rotRates.length / 2)], 4);

const MIN_NBA_MIN = 150;
const train = pairs.filter(({ gl, nba }) =>
  fin(gl.minutes) && gl.minutes >= 150 && fin(nba.minutes) && nba.minutes >= MIN_NBA_MIN && fin(nba.rateGrade));
const featOf = readinessFeatures(glAll);
const BLOCKS = Object.keys(READINESS_BLOCKS);

const rows = train.map(({ gl, nba }) => {
  const f = featOf(gl);
  return { x: BLOCKS.map((b) => (fin(f[b]) ? f[b] : 0)), y: nba.rateGrade >= EFFECTIVE_THRESHOLD ? 1 : 0, name: gl.name };
});
console.log(`\n--- NBA readiness ---`);
console.log(`  dual-league players (appeared in both):        ${pairs.length}`);
console.log(`  usable for fitting (>=150 min in each league): ${rows.length}`);
console.log(`  "effective" = NBA rate grade >= ${EFFECTIVE_THRESHOLD} (median of ${rotation.length} NBA players with 500+ min)`);
console.log(`  effective in the training set: ${rows.filter((r) => r.y === 1).length} of ${rows.length}`);

let model = null, modelAuc = null, looAuc = null;
if (rows.length >= 30 && rows.some((r) => r.y === 1) && rows.some((r) => r.y === 0)) {
  const X = rows.map((r) => r.x), Y = rows.map((r) => r.y);
  model = fitLogistic(X, Y, { lambda: 2.0 });
  modelAuc = round(auc(X.map((x) => predict(model, x)), Y), 3);

  // Leave-one-out AUC. In-sample AUC on 85 rows with 5 features is optimistic by construction;
  // LOO is the number worth quoting, and if it collapses the model is not usable.
  const looScores = [];
  for (let i = 0; i < X.length; i++) {
    const Xi = X.filter((_, j) => j !== i), Yi = Y.filter((_, j) => j !== i);
    if (!Yi.some((v) => v === 1) || !Yi.some((v) => v === 0)) { looScores.push(0.5); continue; }
    looScores.push(predict(fitLogistic(Xi, Yi, { lambda: 2.0 }), X[i]));
  }
  looAuc = round(auc(looScores, Y), 3);
  console.log(`  in-sample AUC ${modelAuc} · leave-one-out AUC ${looAuc}`);
  console.log('  coefficients (log-odds per robust SD of each block):');
  console.log(`    intercept ${round(model[0], 3)}`);
  BLOCKS.forEach((b, i) => console.log(`    ${b.padEnd(12)} ${round(model[i + 1], 3)}`));
} else {
  console.log('  INSUFFICIENT SAMPLE — no readiness model fitted; the column stays null.');
}

for (const g of glAll) {
  if (!model) { g.nbaReadiness = null; continue; }
  const f = featOf(g);
  const present = BLOCKS.filter((b) => fin(f[b])).length;
  // Requiring most blocks present stops a player with two measurable skills getting a confident
  // number built mostly from zeros.
  if (present < BLOCKS.length - 1 || !fin(g.minutes) || g.minutes < 100) { g.nbaReadiness = null; continue; }
  g.nbaReadiness = round(100 * predict(model, BLOCKS.map((b) => (fin(f[b]) ? f[b] : 0))), 1);
  g.readinessBlocks = Object.fromEntries(BLOCKS.map((b) => [b, round(f[b], 2)]));
}
const rated = glAll.filter((p) => fin(p.nbaReadiness));
console.log(`  G League players scored: ${rated.length} of ${glAll.length}`);
if (rated.length) {
  const top = [...rated].sort((a, b) => b.nbaReadiness - a.nbaReadiness).slice(0, 5);
  console.log('  highest: ' + top.map((p) => `${p.name} ${p.nbaReadiness}%`).join(', '));
}

/* ------------------------------------------ 3. per-36 cross-league translation */
const factors = per36TranslationFactors(pairs);
const pace = paceAdjustment(nbaAll, glAll);
console.log(`\n--- per-36 translation ---`);
console.log(`  fitted on ${factors.sampleSize} players with >=${factors.minMinutes} minutes in BOTH leagues`);
console.log(`  pace: NBA ${pace.nbaPace}, G League ${pace.glPace} -> factor ${pace.factor}`);
for (const [k, v] of Object.entries(factors.stats)) {
  if (v.insufficient) { console.log(`    ${k.padEnd(8)} INSUFFICIENT (n=${v.n})`); continue; }
  console.log(v.mode === 'difference'
    ? `    ${k.padEnd(8)} ${v.delta > 0 ? '+' : ''}${v.delta} (n=${v.n})  [difference]`
    : `    ${k.padEnd(8)} x${v.factor} (n=${v.n})  IQR ${v.p25}-${v.p75}`);
}

for (const p of nbaAll) p.per36 = nbaTo36(p);
for (const p of glAll) {
  p.per36 = nbaTo36(p);                       // his actual G League line at 36
  p.per36Nba = translateTo36(p, factors, pace); // the NBA-equivalent projection
}

d.analysis = d.analysis || {};
d.analysis.crossLeague = {
  optimalMinutes: {
    estimated: optCount,
    method: 'Argmax of TULIP projected impact over the supported role bands (12/16/20/24/28/32/36 MPG). Requires at least two supported bands, and the spread across bands must exceed the width of the best band\'s own confidence interval.',
  },
  readiness: {
    fitted: !!model,
    trainingSize: rows.length,
    dualLeaguePlayers: pairs.length,
    effectiveThreshold: EFFECTIVE_THRESHOLD,
    effectiveDefinition: `NBA rate grade at or above ${EFFECTIVE_THRESHOLD}, the median among ${rotation.length} NBA players with 500+ minutes`,
    inSampleAuc: modelAuc,
    leaveOneOutAuc: looAuc,
    blocks: Object.fromEntries(Object.entries(READINESS_BLOCKS).map(([k, v]) => [k, v.note])),
    coefficients: model ? Object.fromEntries([['intercept', round(model[0], 3)], ...BLOCKS.map((b, i) => [b, round(model[i + 1], 3)])]) : null,
    excludes: 'Points and usage are deliberately excluded. Scoring volume against G League defence is the least transferable signal at this level.',
    limitation: 'Single season, small sample, and fitted only on players who actually got an NBA opportunity — which is itself a selected group. This is a descriptive similarity score, not a scouting projection.',
  },
  per36: {
    sampleSize: factors.sampleSize,
    minMinutes: factors.minMinutes,
    pace,
    factors: factors.stats,
    method: 'Counting stats: per-36 x median NBA/G-League ratio among dual-league players x pace factor. Efficiency rates use the median DIFFERENCE rather than a ratio, because a multiplicative factor distorts percentages near the tails.',
  },
};

fs.writeFileSync(DATA, JSON.stringify(d));
console.log(`\n-> public/data.json updated`);

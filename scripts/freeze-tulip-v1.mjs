// Freeze TULIP_CAPACITY_V1: coefficients, preprocessing, uncertainty, evidence rules, benchmarks,
// and source hashes so a later edit cannot silently overwrite V1.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const T = JSON.parse(fs.readFileSync(path.join(HIST, 'transitions.json'), 'utf8'));
const FE = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aTrend', 'aStartRate', 'aGames', 'aSeasons', 'aCareerHighMpg',
  'age', 'heightIn', 'weight', 'draftPick', 'undrafted', 'aGsPer36', 'aTs', 'aFgaPer36', 'aAstPer36', 'aRebPer36', 'aPfPer36'];
const RIDGE = 1e-5;
function fitFull(train, F, yk) {
  const m = F.length + 1;
  const mu = F.map((k) => train.reduce((a, d) => a + (d[k] ?? 0), 0) / train.length);
  const sd = F.map((k, i) => Math.sqrt(train.reduce((a, d) => a + ((d[k] ?? 0) - mu[i]) ** 2, 0) / train.length) || 1);
  const z = (d) => F.map((k, i) => ((d[k] ?? 0) - mu[i]) / sd[i]);
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) { const v = [1, ...z(d)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d[yk]; } }
  for (let a = 1; a < m; a++) A[a][a] += train.length * RIDGE;
  for (let c = 0; c < m; c++) { let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
  const w = A.map((r, i) => r[m] / A[i][i]);
  return { w, mu, sd, predict: (d) => w[0] + F.map((k, i) => ((d[k] ?? 0) - mu[i]) / sd[i]).reduce((s, v, i) => s + w[i + 1] * v, 0) };
}
const pool = T.filter((d) => Number.isFinite(d.tFirst10));
const seasons = [...new Set(pool.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const trV = pool.filter((d) => d.season !== last);
const prod = fitFull(pool, FE, 'tFirst10');          // production: all seasons
const val = fitFull(trV, FE, 'tFirst10');            // validation: pre-holdout, used for the leaderboard
const residProd = pool.map((d) => d.tFirst10 - prod.predict(d)).sort((a, b) => a - b);
const residVal = trV.map((d) => d.tFirst10 - val.predict(d)).sort((a, b) => a - b);
const qq = (r, p) => r[Math.min(r.length - 1, Math.max(0, Math.floor(p * r.length)))];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

const CARD = {
  version: 'TULIP_CAPACITY_V1',
  frozenAt: new Date().toISOString(),
  whatItIs: 'Predictive estimate of sustainable workload (MPG) after an OFFSEASON team change. NOT a causal or physiological latent minute ceiling.',
  eligiblePopulation: {
    rule: 'NBA player-team transitions with >=20 games on Team A before the cutoff and >=10 games on Team B after',
    scopeValidated: 'OFFSEASON / cross-season acquisitions only',
    scopeNotValidated: 'IN-SEASON trades — incremental value over Team A season MPG NOT established',
    n: { total: T.length, offseason: T.filter((d) => !d.inSeason).length, inSeason: T.filter((d) => d.inSeason).length,
      players: new Set(T.map((d) => d.pid)).size },
  },
  predictionCutoff: 'Immediately before the player\'s first Team B game. All inputs from Team A / pre-transition history only.',
  targets: {
    primary_tFirst10: 'mean MPG over the first 10 Team B games',
    t6to15: 'mean MPG over Team B games 6-15 (requires >=15) — reduces immediate-transition noise',
    tRest: 'mean MPG over all Team B games in that stint',
  },
  features: FE,
  featuresConsideredAndExcluded: {
    destinationContext: ['bAhead', 'bMinsAhead', 'bBestAhead', 'bDepth'],
    reason: 'The destination-context variables TESTED HERE added little incremental predictive value (54.6% vs 54.7% matched-pair concordance). This is a statement about these features, not about whether destination fit matters.',
  },
  preprocessing: 'z-score each feature using TRAINING mean/sd; ridge penalty 1e-5 * n on slopes only, never the intercept; missing attributes default age 26, height 78in, weight 210lb, draftPick 61, undrafted 1 (0.1% of rows).',
  trainingSeasons: seasons,
  validation: {
    grouped: '5-fold grouped by PLAYER — no player appears in both train and test',
    chronological: `train ${seasons.slice(0, -1).join(', ')} -> holdout ${last} (n=${pool.filter((d) => d.season === last).length})`,
    note: 'Both are reported. Chronological validation is NOT player-disjoint (92 of 138 holdout players appear in earlier seasons); grouped CV is the player-disjoint result. Neither alone is sufficient.',
  },
  uncertainty: 'Empirical residual quantiles from TRAINING data only. 50% interval = pred + [q25, q75]; 80% = pred + [q10, q90].',
  evidenceGrade: {
    basis: 'count of TRAINING transitions with Team A season MPG within +/-3 of the candidate',
    thresholds: { A: '>=300', B: '>=150', C: '>=60', D: '<60' },
    status: 'CONVENIENCE LABEL, NOT A STATISTICAL GUARANTEE. The cutoffs were chosen for readability and have not been separately validated. The raw support count is always shown alongside.',
    inSeasonOverride: 'Incremental TULIP evidence: Unproven — season-MPG baseline recommended',
  },
  frozenBenchmarks: {
    groupedByPlayer: {
      tFirst10: { teamASeasonMpg: 5.209, tulip: 5.050, maeGain: 0.159, ci95: [0.068, 0.240], dR2: 0.0229 },
      t6to15: { teamASeasonMpg: 5.183, tulip: 5.072, maeGain: 0.111, ci95: [0.035, 0.201], dR2: 0.0255 },
      tRest: { teamASeasonMpg: 4.938, tulip: 4.729, maeGain: 0.209, ci95: [0.109, 0.281], dR2: 0.0374 },
    },
    chronologicalHoldout2024_25: { teamASeasonMpg: 5.522, tulip: 5.357, naiveRecent10: 6.233, n: 155 },
    matchedPairsOnTeamASeasonMpg: {
      pairs: 73052, baseline: '51.0% [50.4, 51.6]', tulip: '54.7% [53.4, 56.5]',
      gapGE3: '61.4% (n=15187)', gapGE5: '68.1% (n=2518)',
    },
    byMoveType: {
      offseason: { n: 970, base: 5.087, tulip: 4.964, gain: 0.122, ci95: [0.035, 0.221], verdict: 'VALIDATED' },
      inSeason: { n: 500, base: 4.938, tulip: 4.898, gain: 0.040, ci95: [-0.075, 0.188], verdict: 'NOT ESTABLISHED' },
    },
  },
  knownLimitations: [
    'Individual MAE ~5.0-5.4 MPG. This is a ranking and comparison tool, not a precise minute forecast.',
    'In-season trades: no demonstrated incremental value over Team A season MPG.',
    'On the 2024-25 offseason holdout the advantage is inconsistent by quintile — worse than baseline in the two lowest-workload quintiles (6.26 vs 5.81, 6.69 vs 6.62), better in the upper three. n=18 per quintile.',
    'Predictive, NOT causal. Teams trade, waive and sign players for reasons the box score cannot observe; that selection is baked into the training data.',
    'No position field: height/weight act as a positional proxy.',
    'Holdout n=155 transitions is modest.',
    'Rest-of-season target is rest-of-STINT with that team, not literally the season end.',
  ],
  sourceHashes: {
    'lib/starter-flags.mjs': sha(path.join(ROOT, 'scripts/lib/starter-flags.mjs')),
    'portability-study.mjs': sha(path.join(ROOT, 'scripts/portability-study.mjs')),
    'portability-eval.mjs': sha(path.join(ROOT, 'scripts/portability-eval.mjs')),
    'final-gate.mjs': sha(path.join(ROOT, 'scripts/final-gate.mjs')),
    'tulip-capacity-product.mjs': sha(path.join(ROOT, 'scripts/tulip-capacity-product.mjs')),
    'transitions.json': sha(path.join(HIST, 'transitions.json')),
  },
  productionModel: { intercept: prod.w[0], coefficients: Object.fromEntries(FE.map((k, i) => [k, prod.w[i + 1]])),
    standardization: Object.fromEntries(FE.map((k, i) => [k, { mean: prod.mu[i], sd: prod.sd[i] }])),
    residualQuantiles: { q10: qq(residProd, 0.10), q25: qq(residProd, 0.25), q50: qq(residProd, 0.50), q75: qq(residProd, 0.75), q90: qq(residProd, 0.90) } },
  validationModel: { note: 'used ONLY for the out-of-sample historical leaderboard',
    intercept: val.w[0], residualQuantiles: { q25: qq(residVal, 0.25), q75: qq(residVal, 0.75) } },
};
fs.writeFileSync(path.join(ROOT, 'TULIP_CAPACITY_V1.json'), JSON.stringify(CARD, null, 2));
const cardHash = crypto.createHash('sha256').update(JSON.stringify(CARD)).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(ROOT, 'TULIP_CAPACITY_V1.id'), `TULIP_CAPACITY_V1  card-sha256:${cardHash}\n`);
console.log('frozen -> TULIP_CAPACITY_V1.json');
console.log('V1 identifier: card-sha256:' + cardHash);
console.log('\ntop production coefficients (z-scored, MPG per 1 sd):');
FE.map((k, i) => [k, prod.w[i + 1]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`));
console.log(`\nresidual quantiles (production): q25 ${qq(residProd, 0.25).toFixed(2)}  q75 ${qq(residProd, 0.75).toFixed(2)}  (50% interval width ${(qq(residProd, 0.75) - qq(residProd, 0.25)).toFixed(1)} MPG)`);

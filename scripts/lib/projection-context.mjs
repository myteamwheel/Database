// Transparent context extensions to the frozen veteran rate model. These are separately
// versioned: its historical accuracy must not be attributed to these new rules.
import { RATE_STATS, PCT_STATS, seasonStart, seasonPriors, perGameLine, roleFeatures, dot, MIN_FEATURES, GP_FEATURES, ageInSeason } from './projection.mjs';

export const CONTEXT_VERSION = 'context-1';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));


/** Minimise a weighted squared adjustment subject to bounds and a team-minute budget.
 * Effective minutes = MPG when playing * expected fraction of games played.
 * Lower-certainty roles can move further. This is accounting, not fitted predictive skill.
 */
export function reconcileMinutes(rows, budget = 240) {
  const items = rows.map(r => ({ r, base: r.mpg * r.share, lo: r.share,
    hi: 40 * r.share, mobility: 1 + 2 / (1 + (r.pr?.baseMin || 0) / 800) }));
  const capacity = items.reduce((s, x) => s + x.hi, 0);
  const floor = items.reduce((s, x) => s + x.lo, 0);
  const target = clamp(budget, floor, capacity);
  let lo = -1000, hi = 1000;
  for (let n = 0; n < 80; n++) {
    const mid = (lo + hi) / 2;
    const sum = items.reduce((s, x) => s + clamp(x.base + mid * x.mobility, x.lo, x.hi), 0);
    if (sum > target) hi = mid; else lo = mid;
  }
  for (const x of items) {
    const allocated = clamp(x.base + ((lo + hi) / 2) * x.mobility, x.lo, x.hi);
    x.r.minutesBeforeContext = x.r.mpg;
    x.r.mpg = allocated / x.r.share;
    x.r.minuteReconciliation = x.r.mpg - x.r.minutesBeforeContext;
    x.r.effectiveMpg = allocated;
  }
  return { budget, allocated: target, reserve: Math.max(0, budget - capacity),
    excessFloor: Math.max(0, floor - budget), players: rows.length };
}


/** Evaluate only the minute-reconciliation layer on already-projected held-out rows.
 * Rates are held fixed; per-game box-score stats scale only with the reconciled MPG.
 * This deliberately does not claim validation for rookies, returners, injuries or availability.
 */
export function evaluateMinuteReconciliation(rows, { budget = 240 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Held-out reconciliation rows are required.');
  const clones = rows.map((row) => {
    if (!row?.team || !Number.isFinite(row.mpg) || !Number.isFinite(row.share) || !row.line || !row.actual) {
      throw new Error('Held-out reconciliation row is missing team, minutes, share, line or actual.');
    }
    return { ...row, pr: { ...(row.pr || {}) }, line: { ...row.line }, actual: { ...row.actual },
      originalMpg: row.mpg, originalEffective: row.mpg * row.share };
  });
  const groups = new Map();
  for (const row of clones) {
    if (!groups.has(row.team)) groups.set(row.team, []);
    groups.get(row.team).push(row);
  }

  let exact = 0;
  let completeTeams = 0;
  let rosterPlayers = 0;
  for (const list of groups.values()) {
    const sizes = list.map((r) => r.rosterSize).filter(Number.isFinite);
    const rosterSize = sizes.length ? Math.max(...sizes) : list.length;
    rosterPlayers += rosterSize;
    if (rosterSize === list.length) completeTeams++;
    const result = reconcileMinutes(list, budget);
    if (Math.abs(result.allocated - budget) < 1e-6) exact++;
    for (const row of list) {
      const ratio = row.originalMpg > 0 ? row.mpg / row.originalMpg : 1;
      row.reconciledLine = {
        mpg: row.mpg,
        pts: row.line.pts * ratio,
        reb: row.line.reb * ratio,
        ast: row.line.ast * ratio,
      };
    }
  }

  const metrics = ['mpg','pts','reb','ast'];
  const legacy = {}, reconciled = {}, delta = {};
  for (const key of metrics) {
    let a = 0, b = 0;
    for (const row of clones) {
      if (!Number.isFinite(row.line[key]) || !Number.isFinite(row.reconciledLine[key]) || !Number.isFinite(row.actual[key])) {
        throw new Error(`Held-out reconciliation metric ${key} is not finite.`);
      }
      a += Math.abs(row.line[key] - row.actual[key]);
      b += Math.abs(row.reconciledLine[key] - row.actual[key]);
    }
    legacy[key] = a / clones.length;
    reconciled[key] = b / clones.length;
    delta[key] = reconciled[key] - legacy[key];
  }

  return {
    n: clones.length,
    teams: groups.size,
    population: 'history-eligible held-out players only',
    teamBudgetCoverage: { exact, teams: groups.size, budget },
    openingRosterCoverage: { modeledPlayers: clones.length, rosterPlayers, completeTeams, teams: groups.size },
    mae: { legacy, reconciled, delta },
    limitations: 'Minute-only reconciliation check on history-eligible held-out players. Missing rookies and returners are reported through opening-roster coverage and are not validated by this result; rates, injuries and availability are held fixed.',
  };
}

/** Build only completed, first NBA seasons strictly before the forecast year. No target
 * outcomes enter the cohort. Drafted players with zero first-year minutes remain in the
 * opportunity sample when the index contains them; historical index omissions remain a bias.
 */
export function rookieCohort(D, targetSeason) {
  const end = seasonStart(targetSeason), entries = [];
  const priors = new Map();
  for (const [season, map] of D.nba.seasons) if (seasonStart(season) < end) {
    priors.set(season, seasonPriors(map, D.bio));
  }
  for (const [pid, b] of D.bio) {
    const y = b.fromYear || b.draftYear;
    if (!(y >= end - 10 && y < end)) continue;
    const season = `${y}-${String(y + 1).slice(-2)}`, map = D.nba.seasons.get(season);
    if (!map || !priors.has(season)) continue;
    const row = map.get(pid);
    // Do not treat missing/undrafted index dates as a zero-minute rookie observation.
    if (!row && !(b.draftYear === y && b.draftNumber > 0)) continue;
    const games = D.nba.teamGames(season, row?.team);
    entries.push({ pid, bio: b, season, row, age: row?.age ?? null,
      share: row ? clamp(row.gp / games, 0, 1) : 0,
      effectiveMpg: row ? row.min / games : 0,
      prior: priors.get(season).at(b.big), leaguePace: priors.get(season).pace });
  }
  return entries;
}

/** A deliberately labeled fallback until verified college/international feature coverage is
 * available. Nearest historical entry cohorts use draft slot, position and known entry age.
 * Rates are era-relative to each cohort's position norms, then translated to current norms.
 */
export function rookieProjection(bio, age, cohort, currentPrior) {
  if (!bio || cohort.length < 20) return null;
  const pick = bio.draftNumber > 0 ? Math.min(61, bio.draftNumber) : 61;
  const candidates = cohort.filter(x => x.pid !== bio.pid).map(x => {
    const cp = x.bio.draftNumber > 0 ? Math.min(61, x.bio.draftNumber) : 61;
    const d = ((Math.log(pick + 3) - Math.log(cp + 3)) / 0.55) ** 2
      + ((bio.big - x.bio.big) / 0.65) ** 2
      + (Number.isFinite(age) && Number.isFinite(x.age) ? ((age - x.age) / 3) ** 2 : 0);
    return { ...x, w: Math.exp(-d / 2), distance: d };
  }).sort((a, b) => a.distance - b.distance || a.pid - b.pid).slice(0, 60);
  const sw = candidates.reduce((s, x) => s + x.w, 0);
  if (!(sw > 0)) return null;
  const mean = fn => candidates.reduce((s, x) => s + x.w * fn(x), 0) / sw;
  const share = clamp(mean(x => x.share), 0.05, 0.98);
  const mpg = clamp(mean(x => x.effectiveMpg) / share, 1, 36);
  const norm = currentPrior.at(bio.big), rate = {}, pct = {}, pieces = {};
  const observed = candidates.filter(x => x.row?.poss > 0);
  // Limit a peer's exposure weight so one workhorse does not define the whole prior.
  const volumeWeight = x => x.w * Math.min(1, x.row.poss / 1200);
  for (const k of RATE_STATS) {
    let num = 0, den = 0;
    for (const x of observed) if (x.prior[k] > 0) {
      const w = volumeWeight(x);
      num += w * clamp((x.row[k] / x.row.poss * 100) / x.prior[k], 0, 3);
      den += w;
    }
    rate[k] = norm[k] * (num + 2) / (den + 2);
    pieces[k] = { base: rate[k], prior: norm[k], own: null, weightOnOwn: den / (den + 2), ageF: 1, expF: 1, trendF: 1 };
  }
  rate.fg3a = Math.min(rate.fg3a, rate.fga);
  for (const [k, [made, att]] of Object.entries(PCT_STATS)) {
    let num = 0, den = 0;
    for (const x of observed) if (x.row[att] > 0) {
      const w = x.w * Math.min(1, x.row[att] / (k === 'fg3' ? 150 : 250));
      num += w * (x.row[made] / x.row[att] - x.prior[k]); den += w;
    }
    pct[k] = clamp(norm[k] + num / (den + 2), 0.05, 0.95);
    pieces[k] = { base: pct[k], prior: norm[k], own: null, weightOnOwn: den / (den + 2), ageAdd: 0 };
  }
  const evidence = { method: 'historical-entry-cohort', fallback: true, preNbaStats: 'unavailable',
    draftPick: pick === 61 ? null : pick, position: bio.position, age,
    peers: candidates.length, effectivePeers: sw ** 2 / candidates.reduce((s, x) => s + x.w ** 2, 0),
    seasons: [...new Set(candidates.map(x => x.season))].sort(),
    note: 'Draft/position/age cohort estimate, adjusted for team opportunity. College/international production, contract security and current injury clearance are not verified inputs. Not a player-specific scouting projection.' };
  evidence.coverage = rookieInputCoverage(evidence);
  return { mpg, share, pr: { rate, pct, pieces, age, yearsIn: 1, draft: pick, basePoss: 0, baseMin: 0 }, evidence };
}


export function historicalFallbackEvidence(hist, targetSeason, weightedHistoricalExposure, reliability) {
  const observed = (hist || []).filter((r) => r && (r.gp > 0 || r.min > 0));
  const lastObservedSeason = observed[0]?.season || null;
  const targetYear = seasonStart(targetSeason);
  const lastYear = lastObservedSeason ? seasonStart(lastObservedSeason) : null;
  const blankSeasonGapCount = Number.isFinite(lastYear) ? Math.max(0, targetYear - lastYear - 1) : null;
  const exposure = Number.isFinite(weightedHistoricalExposure) ? Math.max(0, weightedHistoricalExposure) : 0;
  const rel = Number.isFinite(reliability) ? clamp(reliability, 0, 1) : 0;
  const support = !lastObservedSeason || exposure <= 0
    ? 'unavailable'
    : (exposure >= 20 && rel >= 0.25 ? 'low' : 'very-low');
  return {
    lastObservedSeason,
    blankSeasonGapCount,
    weightedHistoricalExposure: exposure,
    reliability: rel,
    support,
    returnToPlayPredicted: false,
    note: 'Older NBA evidence only. This fallback does not predict return-to-play, injury clearance, contract status, or current medical availability.',
  };
}

const coverageField = (available, source, status = available ? 'available' : 'unavailable') => ({
  available: !!available,
  source,
  status,
});

export function rookieInputCoverage(evidence = {}) {
  const draft = Number.isFinite(evidence.draftPick) && evidence.draftPick > 0;
  const position = typeof evidence.position === 'string' && evidence.position.trim().length > 0;
  const age = Number.isFinite(evidence.age);
  const cohort = Number.isFinite(evidence.peers) && evidence.peers > 0;
  const preNba = evidence.preNbaStats && evidence.preNbaStats !== 'unavailable';
  const contract = evidence.contractSecurity && evidence.contractSecurity !== 'unavailable';
  const injury = evidence.currentInjuryClearance && evidence.currentInjuryClearance !== 'unavailable';
  return {
    draftSlot: coverageField(draft, 'NBA draft metadata'),
    position: coverageField(position, 'NBA player index'),
    entryAge: coverageField(age, 'NBA player index / projection row'),
    historicalCohort: coverageField(cohort, 'historical NBA rookie cohort'),
    preNbaProduction: coverageField(!!preNba, preNba ? 'verified pre-NBA input' : null),
    contractSecurity: coverageField(!!contract, contract ? 'verified contract input' : null),
    currentInjuryClearance: coverageField(!!injury, injury ? 'verified injury/availability input' : null),
  };
}

export function summarizeRookieCoverage(rows = []) {
  const keys = ['draftSlot','position','entryAge','historicalCohort','preNbaProduction','contractSecurity','currentInjuryClearance'];
  const out = { players: rows.length };
  for (const key of keys) {
    const available = rows.filter((r) => r?.[key]?.available).length;
    out[key] = { available, unavailable: rows.length - available };
  }
  return out;
}

/** Returner after at least three blank recent seasons: blend a no-recent-role model prior with
 * exposure-weighted older MPG/availability. True calendar gaps decay old evidence; this is an
 * explicit, low-support estimate, not an injury diagnosis. */
export function historicalRoleProjection(hist, T, bio, teamGames, rates, ctx, role, params, games) {
  const empty = [null, null, null];
  const prior = roleFeatures(empty, T, bio, teamGames, rates, ctx);
  Object.assign(prior, { miss2: 1, miss3: 1, lateMissing: 1 });
  const age = ageInSeason(hist, T);
  if (Number.isFinite(age)) Object.assign(prior, { age: age - 27, ageYoung: Math.max(0, 24 - age), ageOld: Math.max(0, age - 31) });
  const priorMpg = clamp(dot(role.minutes, prior, MIN_FEATURES), 1, 40);
  const priorShare = clamp(dot(role.gp, prior, GP_FEATURES), 0.05, 0.98);
  const entries = hist.filter(r => r?.gp > 0 && r?.min > 0).map(r => {
    const elapsed = Math.max(1, seasonStart(T) - seasonStart(r.season || T));
    const w = elapsed === 1 ? 1 : elapsed === 2 ? params.w2 : params.w3 ** (elapsed - 2);
    const sample = Math.min(games, r.gp);
    return { r, w, sample, mpg: r.min / r.gp, share: clamp(r.gp / teamGames(r.season || T, r.team), 0, 1) };
  });
  const exposure = entries.reduce((s, x) => s + x.w * x.sample, 0);
  if (!exposure) return { mpg: priorMpg, share: priorShare, priorMpg, priorShare, exposure: 0, reliability: 0,
    ...historicalFallbackEvidence(hist, T, 0, 0), f: prior };
  const oldMpg = entries.reduce((s, x) => s + x.w * x.sample * x.mpg, 0) / exposure;
  const oldShare = entries.reduce((s, x) => s + x.w * x.sample * x.share, 0) / exposure;
  const reliability = exposure / (exposure + 40);
  return { mpg: clamp(priorMpg + reliability * (oldMpg - priorMpg), 1, 40),
    share: clamp(priorShare + reliability * (oldShare - priorShare), 0.05, 0.98),
    priorMpg, priorShare, oldMpg, oldShare, exposure, reliability,
    ...historicalFallbackEvidence(hist, T, exposure, reliability), f: prior };
}

/** Independent chronological check of the fallback alone, including nonappearance outcomes.
 * Target-season position priors are never used. This does not validate team reconciliation.
 */
export function evaluateRookieFallback(D, season) {
  const cohort = rookieCohort(D, season), targetYear = seasonStart(season);
  const priorMap = D.nba.seasons.get(`${targetYear - 1}-${String(targetYear).slice(-2)}`);
  const actuals = D.nba.seasons.get(season);
  if (!priorMap || !actuals) return null;
  const pri = seasonPriors(priorMap, D.bio), errors = [];
  for (const [pid, b] of D.bio) {
    if ((b.fromYear || b.draftYear) !== targetYear) continue;
    const a = actuals.get(pid);
    if (!a && !(b.draftYear === targetYear && b.draftNumber > 0)) continue;
    // Entry age is unavailable in the pre-season snapshot: omit rather than use target outcome.
    const pr = rookieProjection(b, null, cohort, pri);
    if (!pr) continue;
    const line = perGameLine(pr.pr.rate, pr.pr.pct, pr.mpg, pr.share * 82, pri.pace);
    const tg = D.nba.teamGames(season, a?.team);
    const baseline = cohort.reduce((s, x) => s + x.effectiveMpg, 0) / cohort.length;
    errors.push({ pid, played: !!a, minutes: Math.abs(pr.mpg * pr.share - (a ? a.min / tg : 0)),
      baselineMinutes: Math.abs(baseline - (a ? a.min / tg : 0)),
      points: a ? Math.abs(line.pts - a.pts / a.gp) : null });
  }
  const avg = k => { const xs = errors.filter(x => Number.isFinite(x[k])); return xs.reduce((s, x) => s + x[k], 0) / (xs.length || 1); };
  return { season, n: errors.length, appeared: errors.filter(x => x.played).length,
    effectiveMinutesMae: avg('minutes'), unconditionedCohortMinutesMae: avg('baselineMinutes'),
    pointsMaeAmongAppearances: avg('points'),
    limitations: 'Retrospective player-index coverage and position labels; no archived pre-season bios or college features. Not a fully as-of backtest, and not validation of team-context adjustments.' };
}

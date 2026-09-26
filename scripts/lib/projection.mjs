// 2026-27 stat projection: shared model code.
//
// One formula, used identically by the backtest (scripts/fit-projections.mjs) and by the build
// (scripts/build-projections.mjs). Everything is estimated per 100 possessions and converted to
// per-game numbers at the very end, so team pace is an explicit factor instead of being baked into
// per-36 rates.
//
//   per-game stat = rate per 100 possessions x possessions per game
//   possessions per game = projected MPG x projected team pace / 48
//
//   rate  = BASE x AGE x EXPERIENCE x LEAGUE TREND x USAGE BALANCE (usage stats only)
//   BASE  = (sum over the last three seasons of weight x stat  +  R x prior rate)
//           / (sum of weight x possessions  +  R)
//           weights 1 / w2 / w3 for last season / two ago / three ago; R is how many possessions of
//           a position-typical player are mixed in, per stat (small for rebounds, large for steals).
//   shooting % = (weighted makes + R x prior %) / (weighted attempts + R), then aged.
//   MPG   = linear model (recent MPG, age, experience, draft slot, quality, availability,
//           team change, teammates competing for minutes), then scaled so each 2026-27 roster
//           adds up to a real 240-minute game.
//   GP    = linear model (recent availability, age, role, team change) x 82.
//
// All parameters are fitted on seasons up to 2024-25 and tested on 2025-26 before being refitted
// through 2025-26 for the 2026-27 numbers. See PROJECTION_2026_27.json for the fitted values.

export const RATE_STATS = ['fga', 'fg3a', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf'];
export const PCT_STATS = { fg2: ['fg2m', 'fg2a'], fg3: ['fg3m', 'fg3a'], ft: ['ftm', 'fta'] };
// Stats a team shares out: if a roster loses shot creation, the players left take more of it.
export const USAGE_STATS = ['fga', 'fg3a', 'fta', 'ast', 'tov'];
export const AGE_MIN = 18, AGE_MAX = 42;

export const seasonStart = (s) => Number(String(s).slice(0, 4));
export const seasonName = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
export const prevSeason = (s, n = 1) => seasonName(seasonStart(s) - n);

const rowsOf = (t) => t.rows.map((r) => Object.fromEntries(t.headers.map((h, i) => [h, r[i]])));
const inches = (h) => {
  const m = String(h || '').match(/^(\d+)-(\d+)$/);
  return m ? Number(m[1]) * 12 + Number(m[2]) : null;
};
/** Listed position as a number: 1 guard, 2 forward, 3 centre; hybrids sit between. */
export function bigness(position, heightIn) {
  const p = String(position || '').toUpperCase();
  const map = { G: 1, 'G-F': 1.4, 'F-G': 1.6, F: 2, 'F-C': 2.4, 'C-F': 2.6, C: 3 };
  if (map[p] !== undefined) return map[p];
  if (Number.isFinite(heightIn)) return heightIn <= 76 ? 1 : heightIn >= 83 ? 3 : 2;
  return 2;
}

/** Normalise one league's season tables into Map(season -> Map(playerId -> record)). */
function leagueSeasons(src) {
  const out = new Map();
  for (const [season, { base, adv }] of Object.entries(src)) {
    const a = new Map(rowsOf(adv).map((r) => [r.PLAYER_ID, r]));
    const m = new Map();
    for (const r of rowsOf(base)) {
      const x = a.get(r.PLAYER_ID) || {};
      if (!(r.MIN > 0)) continue;
      m.set(r.PLAYER_ID, {
        pid: r.PLAYER_ID, name: r.PLAYER_NAME, team: r.TEAM_ABBREVIATION, age: r.AGE,
        gp: r.GP, min: r.MIN, fgm: r.FGM, fga: r.FGA, fg3m: r.FG3M, fg3a: r.FG3A,
        fg2m: r.FGM - r.FG3M, fg2a: r.FGA - r.FG3A, ftm: r.FTM, fta: r.FTA,
        oreb: r.OREB, dreb: r.DREB, ast: r.AST, tov: r.TOV, stl: r.STL, blk: r.BLK, pf: r.PF,
        pts: r.PTS,
        usg: Number.isFinite(x.USG_PCT) ? x.USG_PCT : null,
        pace: Number.isFinite(x.PACE) && x.PACE > 0 ? x.PACE : null,
        // Possessions: the advanced table's count, or minutes at league pace when it is missing.
        poss: Number.isFinite(x.POSS) && x.POSS > 0 ? x.POSS : r.MIN * 100 / 48,
        pie: Number.isFinite(x.PIE) ? x.PIE : null,
      });
    }
    out.set(season, m);
  }
  return out;
}

/**
 * Games each team played. 82 in a normal season; the lockout and pandemic seasons are fixed; the
 * 2019-20 season ended unevenly, so a team's length is the most games any of its un-traded players
 * appeared in.
 */
function teamGamesFn(seasons, opening) {
  const fixed = { '2011-12': 66, '2020-21': 72 };
  const by2019 = new Map();
  const s19 = seasons.get('2019-20');
  if (s19) {
    const open = opening.get('2019-20') || new Map();
    for (const r of s19.values()) {
      if (open.has(r.pid) && open.get(r.pid) !== r.team) continue;
      by2019.set(r.team, Math.max(by2019.get(r.team) || 0, r.gp));
    }
  }
  return (season, team) => {
    if (fixed[season]) return fixed[season];
    if (season === '2019-20') return Math.max(63, Math.min(75, by2019.get(team) || 70));
    return 82;
  };
}

export function prepare(inputs) {
  const bio = new Map();
  const addBio = (r) => bio.set(r.PERSON_ID, {
    pid: r.PERSON_ID, name: `${r.PLAYER_FIRST_NAME} ${r.PLAYER_LAST_NAME}`.trim(),
    position: r.POSITION, heightIn: inches(r.HEIGHT), weight: Number(r.WEIGHT) || null,
    big: bigness(r.POSITION, inches(r.HEIGHT)),
    draftNumber: Number.isFinite(Number(r.DRAFT_NUMBER)) && r.DRAFT_NUMBER !== null ? Number(r.DRAFT_NUMBER) : null,
    draftYear: Number(r.DRAFT_YEAR) || null, fromYear: Number(r.FROM_YEAR) || null,
  });
  rowsOf(inputs.playerIndex).forEach(addBio);
  // Rookies drafted in 2026 are only in the current roster list.
  for (const r of rowsOf(inputs.rosters2627)) if (!bio.has(r.PERSON_ID)) addBio(r);

  const nbaOpening = new Map();
  for (const [s, t] of Object.entries(inputs.nbaOpening || {})) {
    nbaOpening.set(s, new Map(rowsOf(t).map((r) => [r.PLAYER_ID, r.TEAM_ABBREVIATION])));
  }
  const nbaSeasons = leagueSeasons(inputs.nba);
  // Role signals, NBA only: starts, and the minutes a player was getting after the All-Star break.
  for (const [s, m] of nbaSeasons) {
    const starts = new Map(inputs.nbaStarters?.[s] ? rowsOf(inputs.nbaStarters[s]).map((r) => [r.PLAYER_ID, r]) : []);
    const post = new Map(inputs.nbaPostAllStar?.[s] ? rowsOf(inputs.nbaPostAllStar[s]).map((r) => [r.PLAYER_ID, r]) : []);
    const postGps = [...post.values()].map((r) => r.GP).sort((a, b) => b - a);
    const postGames = postGps[Math.floor(postGps.length * 0.02)] || 27;
    for (const r of m.values()) {
      r.gs = starts.get(r.pid)?.GP ?? 0;
      r.postGp = post.get(r.pid)?.GP ?? 0;
      r.postMin = post.get(r.pid)?.MIN ?? 0;
      r.postGames = postGames;
    }
  }
  const glSeasons = leagueSeasons(inputs.gleague);
  const rosters2627 = new Map(rowsOf(inputs.rosters2627).map((r) => [r.PERSON_ID, r.TEAM_ABBREVIATION]));
  return {
    bio, rosters2627,
    nba: { key: 'nba', seasons: nbaSeasons, opening: nbaOpening, teamGames: teamGamesFn(nbaSeasons, nbaOpening) },
    gleague: { key: 'gleague', seasons: glSeasons, opening: new Map(), teamGames: () => 50 },
  };
}

/** The player's last three seasons before T, most recent first (null where he did not play). */
export function historyBefore(league, pid, T) {
  return [1, 2, 3].map((n) => league.seasons.get(prevSeason(T, n))?.get(pid) || null);
}

/* ------------------------------------------------------------------ league context per season */

/**
 * Position-typical rates for one season: per stat, the possession-weighted mean for guards (1),
 * forwards (2) and centres (3); a hybrid is interpolated. These are what a small sample is
 * pulled toward.
 */
export function seasonPriors(seasonMap, bio) {
  const acc = {};
  const groups = [1, 2, 3];
  for (const g of groups) acc[g] = { poss: 0 };
  for (const r of seasonMap.values()) {
    const b = bio.get(r.pid)?.big ?? 2;
    // Split a hybrid's weight between its two neighbouring groups.
    const lo = Math.floor(b), hi = Math.ceil(b), f = b - lo;
    for (const [g, wt] of lo === hi ? [[lo, 1]] : [[lo, 1 - f], [hi, f]]) {
      const a = acc[g];
      a.poss += r.poss * wt;
      for (const k of RATE_STATS) a[k] = (a[k] || 0) + r[k] * wt;
      // Shooting sums get their own keys: 'fg3a' and 'fta' are also volume stats above, and
      // sharing a key would count those attempts twice.
      for (const [k, [m, att]] of Object.entries(PCT_STATS)) {
        a['m:' + k] = (a['m:' + k] || 0) + r[m] * wt;
        a['a:' + k] = (a['a:' + k] || 0) + r[att] * wt;
      }
    }
  }
  const byGroup = {};
  for (const g of groups) {
    const a = acc[g];
    byGroup[g] = {};
    for (const k of RATE_STATS) byGroup[g][k] = a.poss > 0 ? (a[k] / a.poss) * 100 : 0;
    for (const k of Object.keys(PCT_STATS)) byGroup[g][k] = a['a:' + k] > 0 ? a['m:' + k] / a['a:' + k] : 0;
  }
  let lgPoss = 0, lgPaceMin = 0, lgMin = 0, usgPlays = 0, ftPts = 0, ftm = 0;
  for (const r of seasonMap.values()) {
    lgPoss += r.poss;
    if (r.pace) { lgPaceMin += r.pace * r.min; lgMin += r.min; }
    usgPlays += r.fga + 0.44 * r.fta + r.tov;
    ftPts += r.pts - 2 * r.fg2m - 3 * r.fg3m; ftm += r.ftm;
  }
  return {
    at(b) {
      const lo = Math.max(1, Math.min(3, Math.floor(b))), hi = Math.max(1, Math.min(3, Math.ceil(b)));
      const f = Math.max(0, Math.min(1, b - lo));
      const out = {};
      for (const k of Object.keys(byGroup[1])) out[k] = byGroup[lo][k] * (1 - f) + byGroup[hi][k] * f;
      return out;
    },
    byGroup,
    pace: lgMin > 0 ? lgPaceMin / lgMin : 100,
    // League "plays" (shots, trips to the line, turnovers) per 100 possessions.
    playsPer100: lgPoss > 0 ? (usgPlays / lgPoss) * 100 : 100,
    // Points per free throw made: 1 in the NBA. The G League has shot one free throw worth the
    // whole trip (2 or 3 points) since 2019-20, so a make there is worth more than a point.
    ftValue: ftm > 0 ? Math.max(1, ftPts / ftm) : 1,
  };
}

/**
 * Recent league drift: mean year-over-year log change of each league rate (and pace) over the
 * three seasons before T. Zero when there is not enough history.
 */
export function leagueTrend(league, T, bio) {
  const out = {};
  const seasons = [1, 2, 3, 4].map((n) => league.seasons.get(prevSeason(T, n)));
  if (seasons.some((s) => !s)) return { ...Object.fromEntries(RATE_STATS.map((k) => [k, 0])), pace: 0 };
  const lr = seasons.map(leagueRates);
  for (const k of RATE_STATS) {
    let s = 0;
    for (let i = 0; i < 3; i++) s += Math.log(lr[i][k] / lr[i + 1][k]);
    out[k] = s / 3;
  }
  const paces = seasons.map((m) => seasonPriors(m, bio).pace);
  out.pace = (Math.log(paces[0] / paces[1]) + Math.log(paces[1] / paces[2]) + Math.log(paces[2] / paces[3])) / 3;
  return out;
}

/** Team pace for a season: minutes-weighted on-court pace of the players who finished there. */
export function teamPaces(seasonMap) {
  const acc = new Map();
  for (const r of seasonMap.values()) {
    if (!r.pace) continue;
    const a = acc.get(r.team) || { pm: 0, m: 0 };
    a.pm += r.pace * r.min; a.m += r.min;
    acc.set(r.team, a);
  }
  return new Map([...acc].map(([t, a]) => [t, a.pm / a.m]));
}

/** League per-100 rate of each stat in a season (for the league-trend factor). */
export function leagueRates(seasonMap) {
  let poss = 0;
  const tot = {};
  for (const r of seasonMap.values()) {
    poss += r.poss;
    for (const k of RATE_STATS) tot[k] = (tot[k] || 0) + r[k];
    for (const [k, [m, a]] of Object.entries(PCT_STATS)) {
      tot['m:' + k] = (tot['m:' + k] || 0) + r[m];
      tot['a:' + k] = (tot['a:' + k] || 0) + r[a];
    }
  }
  const out = {};
  for (const k of RATE_STATS) out[k] = (tot[k] / poss) * 100;
  for (const k of Object.keys(PCT_STATS)) out[k] = tot['m:' + k] / tot['a:' + k];
  return out;
}

/* ------------------------------------------------------------------------------ the formula */

/** Linear interpolation into an age table indexed from AGE_MIN. */
export function ageLookup(table, age) {
  if (!table) return 0;
  const a = Math.max(AGE_MIN, Math.min(AGE_MAX, age));
  const i = Math.floor(a) - AGE_MIN, f = a - Math.floor(a);
  const lo = table[Math.max(0, Math.min(table.length - 1, i))];
  const hi = table[Math.max(0, Math.min(table.length - 1, i + 1))];
  return lo * (1 - f) + hi * f;
}

/** Age in season T from the most recent season we have. */
export function ageInSeason(hist, T) {
  for (let n = 0; n < hist.length; n++) if (hist[n] && Number.isFinite(hist[n].age)) return hist[n].age + n + 1;
  return null;
}

/**
 * The per-100-possession projection of every rate and shooting percentage, before team context.
 * Returns the pieces too, so the site can show how each number was built.
 */
export function projectRates(hist, T, bioRow, priors, P, trend) {
  const w = [1, P.w2, P.w3];
  // Shooting touch changes more slowly than role, so percentages can remember further back.
  const wp = [1, P.pw2 ?? P.w2, P.pw3 ?? P.w3];
  const big = bioRow?.big ?? 2;
  const prior = priors.at(big);
  const age = ageInSeason(hist, T);
  const startYear = seasonStart(T);
  const yearsIn = bioRow?.fromYear ? startYear - bioRow.fromYear + 1 : null;
  const draft = bioRow?.draftNumber ?? 61;
  let wPoss = 0, wMin = 0;
  const wSum = {};
  hist.forEach((r, i) => {
    if (!r) return;
    wPoss += w[i] * r.poss; wMin += w[i] * r.min;
    for (const k of RATE_STATS) wSum[k] = (wSum[k] || 0) + w[i] * r[k];
    for (const [k, [m, a]] of Object.entries(PCT_STATS)) {
      wSum['m:' + k] = (wSum['m:' + k] || 0) + wp[i] * r[m];
      wSum['a:' + k] = (wSum['a:' + k] || 0) + wp[i] * r[a];
    }
  });
  const rate = {}, pieces = {};
  for (const k of RATE_STATS) {
    const R = P.R[k], pr = prior[k] * P.m[k];
    const base = ((wSum[k] || 0) + (R * pr) / 100) / (wPoss + R) * 100;
    const ageF = 1 + ageLookup(P.age[k], age);
    const expF = 1 + experienceEffect(P.exp?.[k], yearsIn, draft);
    const trendF = 1 + (P.trendShare ?? 0) * (trend?.[k] ?? 0);
    rate[k] = Math.max(0, base * ageF * expF * trendF);
    pieces[k] = { own: wPoss > 0 ? (wSum[k] || 0) / wPoss * 100 : null, prior: pr, weightOnOwn: wPoss / (wPoss + R), base, ageF, expF, trendF };
  }
  const pct = {};
  for (const k of Object.keys(PCT_STATS)) {
    const R = P.Rpct[k];
    const pr = pctPrior(k, prior, rate, P);
    const att = wSum['a:' + k] || 0, made = wSum['m:' + k] || 0;
    const base = (made + R * pr) / (att + R);
    const ageAdd = ageLookup(P.age[k], age);
    pct[k] = Math.max(0.05, Math.min(0.98, base + ageAdd));
    pieces[k] = { own: att > 0 ? made / att : null, prior: pr, weightOnOwn: att / (att + R), base, ageAdd };
  }
  return { rate, pct, pieces, age, yearsIn, draft, basePoss: wPoss, baseMin: wMin };
}

/** Young-player development beyond age: stronger for high picks early in a career. */
export function experienceEffect(e, yearsIn, draft) {
  if (!e || !Number.isFinite(yearsIn) || yearsIn > 4) return 0;
  const pick = Math.min(61, Math.max(1, draft || 61));
  const pickScore = (61 - pick) / 60;                    // 1 for the first pick, 0 undrafted
  return (e[yearsIn - 1] || 0) + (e.pick || 0) * pickScore * (5 - yearsIn) / 4;
}

/**
 * Where a shooting percentage regresses to. 3P% depends on how much a player shoots threes
 * (volume shooters are better shooters) and on his free-throw touch; 2P% on position.
 */
export function pctPrior(k, prior, rate, P) {
  if (k === 'fg3') {
    const c = P.fg3Prior;
    const vol = Math.log(Math.max(0.3, rate.fg3a));
    return Math.max(0.2, Math.min(0.42, c[0] + c[1] * vol));
  }
  return prior[k] * (P.mPct?.[k] ?? 1);
}

/** Possession-used "plays" per 100 on-court possessions: shots, trips to the line, turnovers. */
export const playsPer100 = (rate) => rate.fga + 0.44 * rate.fta + rate.tov;

/* ------------------------------------------------------------------------- minutes and games */

export const MIN_FEATURES = ['one', 'mpg1', 'mpg2', 'mpg3', 'miss2', 'miss3', 'gpShare1', 'age', 'ageYoung', 'ageOld',
  'rookieScale', 'pickYoung', 'quality', 'moved', 'depth', 'lowMin', 'startRate1', 'lateMpg1', 'lateMissing',
  'mpg1sq', 'qualMpg', 'movedMpg', 'movedDepth'];
export const GP_FEATURES = ['one', 'gpShare1', 'gpShare2', 'gpShare3', 'miss2', 'miss3', 'age', 'ageOld', 'mpg1', 'moved',
  'lowMin', 'lateShare1', 'startRate1'];

/**
 * Feature row for the minutes and games models. `depth` is how many minutes last season the
 * player's 2026-27 (or season-T) teammates played in total, relative to a normal rotation.
 */
export function roleFeatures(hist, T, bioRow, teamGames, rates, ctx) {
  const [a, b, c] = hist;
  const mpg = (r) => (r && r.gp > 0 ? r.min / r.gp : 0);
  const share = (r, n) => (r ? Math.min(1, r.gp / teamGames(prevSeason(T, n), r.team)) : 0);
  const age = ageInSeason(hist, T) ?? 25;
  const yearsIn = bioRow?.fromYear ? seasonStart(T) - bioRow.fromYear + 1 : 6;
  const draft = bioRow?.draftNumber ?? 61;
  const quality = rates ? qualityIndex(rates) : 0;
  return {
    one: 1,
    mpg1: mpg(a), mpg2: mpg(b), mpg3: mpg(c),
    miss2: b ? 0 : 1, miss3: c ? 0 : 1,
    gpShare1: share(a, 1), gpShare2: b ? share(b, 2) : 0, gpShare3: c ? share(c, 3) : 0,
    age: age - 27, ageYoung: Math.max(0, 24 - age), ageOld: Math.max(0, age - 31),
    rookieScale: yearsIn <= 4 ? 1 : 0,
    pickYoung: yearsIn <= 4 ? (61 - Math.min(61, draft)) / 60 : 0,
    quality,
    moved: ctx?.moved ? 1 : 0,
    depth: ctx?.depth ?? 0,
    lowMin: a && a.min < 400 ? 1 : 0,
    // Role at the end of last season: starts, and minutes per game after the All-Star break
    // (a rookie who became a starter in March is not the same as his season average).
    startRate1: a && a.gp > 0 && Number.isFinite(a.gs) ? a.gs / a.gp : 0,
    lateMpg1: a && a.postGp >= 5 ? a.postMin / a.postGp - mpg(a) : 0,
    lateMissing: a && a.postGp >= 5 ? 0 : 1,
    lateShare1: a && Number.isFinite(a.postGames) && a.postGames > 0 ? Math.min(1, (a.postGp || 0) / a.postGames) : 0,
    // Curvature: stars keep their minutes more than the linear pull toward average implies, and a
    // good player's minutes are stickier than a poor one's.
    mpg1sq: (mpg(a) / 10) ** 2,
    qualMpg: quality * mpg(a) / 30,
    movedMpg: ctx?.moved ? mpg(a) / 30 : 0,
    movedDepth: ctx?.moved ? ctx.depth ?? 0 : 0,
  };
}

/**
 * A single number for "how productive per possession", used only to decide minutes: a
 * possession-scaled Game Score from the projected rates.
 */
export function qualityIndex(p) {
  const r = p.rate, s = p.pct;
  const fg2m = (r.fga - r.fg3a) * s.fg2, fg3m = r.fg3a * s.fg3, ftm = r.fta * s.ft;
  const pts = 2 * fg2m + 3 * fg3m + ftm;
  const gs = pts + 0.4 * (fg2m + fg3m) - 0.7 * r.fga - 0.4 * (r.fta - ftm) + 0.7 * r.oreb + 0.3 * r.dreb
    + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
  return gs / 10;
}

export const dot = (coef, feats, names) => names.reduce((s, n, i) => s + coef[i] * feats[n], 0);

/** Minutes per game a rookie plays (times his share of games), by draft slot. */
export function expectedRookieMin(coef, bioRow) {
  const pick = (61 - Math.min(61, bioRow?.draftNumber ?? 61)) / 60;
  return Math.max(0, coef[0] + coef[1] * pick + coef[2] * pick * pick);
}

/**
 * Competition for minutes: what the rest of the roster played per game last season (rookies at
 * their draft-slot expectation), relative to 200 minutes. Positive means a crowded rotation.
 */
export function rosterDepth(league, T, roster, pid, rookieCoef, bio) {
  let s = 0;
  for (const other of roster) {
    if (other === pid) continue;
    const h = historyBefore(league, other, T)[0];
    if (h) s += (h.min / h.gp) * Math.min(1, h.gp / league.teamGames(prevSeason(T), h.team));
    else s += expectedRookieMin(rookieCoef, bio.get(other));
  }
  return (s - 200) / 48;
}

/* ------------------------------------------------------------------------- per-game assembly */

/* ----------------------------------------------------------------------------- team context */

/**
 * Projected pace for a team: last season's pace relative to the league, partly persisting (rho),
 * on top of the league pace carried forward with part of its recent trend.
 */
export function projectedPace(priors, trend, teamPaceLast, P) {
  const lg = priors.pace * Math.exp((P.team.paceTrend ?? 0) * (trend?.pace || 0));
  if (!Number.isFinite(teamPaceLast)) return lg;
  return lg * (1 + P.team.paceRho * (teamPaceLast / priors.pace - 1));
}

/**
 * Everything that depends on WHO ELSE is on the roster, applied to one team's list of players.
 * Each item carries { pr (projectRates output), mpg, games, share, mpgLast, moved }.
 *   usage balance  a roster short of shot creation hands more to the players left; a crowded one
 *                  takes some away: shot volume x (roster plays / league plays)^-mu
 *   role shift     a player whose minutes jump takes a smaller share per possession, and vice versa
 *   new team       players who changed teams in the offseason
 *   pace           per-game numbers scale with the team's possessions
 */
export function applyTeamContext(list, priors, pace, P, opts = {}) {
  let pm = 0, m = 0;
  for (const r of list) { pm += playsPer100(r.pr.rate) * r.mpg * r.share; m += r.mpg * r.share; }
  const balance = m > 0 ? pm / m / priors.playsPer100 : 1;
  const uf = opts.noUsage ? 1 : Math.pow(balance, -(P.team.usageMu || 0));
  for (const r of list) {
    const shift = Number.isFinite(r.mpgLast) ? Math.max(-1, Math.min(1, (r.mpg - r.mpgLast) / 10)) : 0;
    const roleF = opts.noRole ? 1 : 1 + (P.team.roleGamma || 0) * shift;
    const movedF = opts.noMoved || !r.moved ? 1 : 1 + (P.team.movedUsage || 0);
    const rate = { ...r.pr.rate };
    for (const k of USAGE_STATS) rate[k] *= uf * roleF * movedF;
    r.rateFinal = rate;
    r.line = perGameLine(rate, r.pr.pct, r.mpg, r.games, pace, priors.ftValue);
    r.factors = { rosterBalance: balance, usage: uf, roleShift: roleF, newTeam: movedF, pace };
  }
}

/** Turn projected rates, minutes, games and pace into a per-game line. */
export function perGameLine(rate, pct, mpg, gp, pace, ftValue = 1) {
  const possPg = (mpg * pace) / 48;
  const f = possPg / 100;
  const fga = rate.fga * f, fg3a = Math.min(rate.fg3a, rate.fga) * f, fta = rate.fta * f;
  const fg2a = Math.max(0, fga - fg3a);
  const fg2m = fg2a * pct.fg2, fg3m = fg3a * pct.fg3, ftm = fta * pct.ft;
  const pts = 2 * fg2m + 3 * fg3m + ftm * ftValue;
  const oreb = rate.oreb * f, dreb = rate.dreb * f;
  return {
    gp, mpg, pts, reb: oreb + dreb, oreb, dreb, ast: rate.ast * f, stl: rate.stl * f, blk: rate.blk * f,
    tov: rate.tov * f, pf: rate.pf * f, fga, fg3a, fta, fgm: fg2m + fg3m, fg3m, ftm,
    fgPct: fga > 0 ? (fg2m + fg3m) / fga : null, fg3Pct: pct.fg3, ftPct: pct.ft,
    ts: fga + 0.44 * fta > 0 ? pts / (2 * (fga + 0.44 * fta)) : null,
    possPg,
  };
}

/** Actual per-game line from a season record, for comparison and for the naive baseline. */
export function actualLine(r) {
  const g = r.gp || 1;
  return {
    gp: r.gp, mpg: r.min / g, pts: r.pts / g, reb: (r.oreb + r.dreb) / g, oreb: r.oreb / g, dreb: r.dreb / g,
    ast: r.ast / g, stl: r.stl / g, blk: r.blk / g, tov: r.tov / g, pf: r.pf / g,
    fga: r.fga / g, fg3a: r.fg3a / g, fta: r.fta / g, fgm: r.fgm / g, fg3m: r.fg3m / g, ftm: r.ftm / g,
    fgPct: r.fga > 0 ? r.fgm / r.fga : null, fg3Pct: r.fg3a > 0 ? r.fg3m / r.fg3a : null,
    ftPct: r.fta > 0 ? r.ftm / r.fta : null,
    ts: r.fga + 0.44 * r.fta > 0 ? r.pts / (2 * (r.fga + 0.44 * r.fta)) : null,
  };
}

/* ------------------------------------------------------------------------ small linear algebra */

/** Weighted ridge regression. X rows are arrays; returns coefficients. */
export function ridge(X, y, w, lambda = 1e-6, unpenalised = [0]) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i], wi = w ? w[i] : 1;
    for (let j = 0; j < p; j++) {
      b[j] += wi * xi[j] * y[i];
      for (let k = j; k < p; k++) A[j][k] += wi * xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  for (let j = 0; j < p; j++) if (!unpenalised.includes(j)) A[j][j] += lambda;
  return solve(A, b);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

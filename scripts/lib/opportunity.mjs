// Exogenous opportunity-shock design: the identification strategy behind TULIP v3.
//
// THE PROBLEM THIS SOLVES. Observed minutes are assigned by coaches IN RESPONSE to performance, so
// "players produce more per minute when they play more" is measured across ten seasons two ways
// (+0.11 to +0.24 between seasons, t 4.4-8.9; +0.248 per minute within season) and both are
// dominated by that selection. Fitting a workload-response curve on raw minutes changes would
// conclude every player scales indefinitely, which is exactly the failure that made TULIP v1
// useless.
//
// THE STRATEGY. Use role expansions caused by a TEAM-MATE'S ABSENCE — the player's opportunity grew
// for a reason unrelated to how he had been playing.
//
// WHAT IS ACTUALLY BEING ESTIMATED, stated precisely. A team-mate's absence does NOT move minutes
// alone. It also moves usage, starting status, lineup quality, offensive role, defensive assignment
// and who creates shots for him. The exclusion restriction for a pure minutes effect therefore
// FAILS, and this file does not claim one. The estimand is:
//
//     What happens when a player is forced into a LARGER ROLE because a rotation team-mate
//     disappears?
//
// That is the honest reading, and it is also the more useful one. When a team signs a 19-MPG player
// and asks for 26, his usage, lineup and assignments change too — so an expanded-role effect is
// closer to the real question than an isolated minutes effect would be. Any downstream metric must
// describe itself as role capacity, never as "the causal effect of N extra minutes".

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

export const SHOCK_CONFIG = {
  // A "regular" is someone established enough in the rotation that his absence actually frees
  // minutes. Judged on the games BEFORE the one being tested, never the full season, so a player's
  // later role cannot leak backwards into an earlier classification.
  minPriorGames: 10,
  regularMpg: 18,
  // The player being measured needs a stable baseline to be measured against.
  minBaselineGames: 15,
  minBaselineMpg: 8,
  // A regular only counts as ABSENT if he played recently. Without this, a player who was traded,
  // shut down for the season, or sent to the G League counted as "absent" for every remaining game,
  // which put an absent regular in 81.7% of team-games and turned the shock design into a proxy for
  // roster churn rather than injury. Requiring recent activity isolates the temporary absences that
  // actually free minutes.
  recentWindow: 5,
  // A HIGH-CONFIDENCE shock needs the absent player to have been genuinely, currently in the
  // rotation — not merely to have averaged rotation minutes at some point. 62.7% of player-games
  // showing "an absent regular" was still far too loose to call an exogenous shock.
  activeInLastN: 5,
  activeAtLeast: 4,        // played 4 of his team's last 5 games
  // A temporary absence is one he RETURNS from. A permanent disappearance is a trade, a waiver or a
  // season-ending injury, none of which is the clean opportunity event being identified.
  returnsWithin: 15,
};

/**
 * Build per-team-game rosters and detect absences of established rotation players.
 * @param {Array} rows player-game rows for ONE season, each {gameId, gameDate, playerId, teamId, min, started}
 */
export function detectAbsences(rows) {
  const byTeamGame = new Map();
  const gamesByTeam = new Map();
  for (const r of rows) {
    const tg = `${r.gameId}|${r.teamId}`;
    if (!byTeamGame.has(tg)) byTeamGame.set(tg, { gameId: r.gameId, teamId: r.teamId, date: r.gameDate, players: [] });
    byTeamGame.get(tg).players.push(r);
    if (!gamesByTeam.has(r.teamId)) gamesByTeam.set(r.teamId, new Set());
    gamesByTeam.get(r.teamId).add(`${r.gameDate}|${r.gameId}`);
  }
  // Chronological team schedules, so "prior" means prior.
  const schedule = new Map();
  for (const [teamId, set] of gamesByTeam) {
    schedule.set(teamId, [...set].sort().map((s) => s.split('|')[1]));
  }

  // Running per-player history, walked forward in date order.
  const hist = new Map();   // playerId|teamId -> {games, minutes, playedIndices, lastGameIndex}
  const out = [];
  // Full appearance index per player, needed to ask whether an absence was temporary. Looking
  // FORWARD is legitimate here: it classifies the nature of the event, and is never used as a
  // feature describing the player receiving the opportunity.
  const futurePlayByTeam = new Map();
  for (const [teamId, gameIds] of schedule) {
    const m = new Map();
    gameIds.forEach((gid, i) => {
      const tg = byTeamGame.get(`${gid}|${teamId}`);
      for (const p of (tg?.players || [])) {
        if (!fin(p.min) || p.min <= 0) continue;
        const k = String(p.playerId);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(i);
      }
    });
    futurePlayByTeam.set(teamId, m);
  }
  for (const [teamId, gameIds] of schedule) {
    const seen = new Set();
    const futurePlay = futurePlayByTeam.get(teamId) || new Map();
    for (let gameIndex = 0; gameIndex < gameIds.length; gameIndex++) {
      const gameId = gameIds[gameIndex];
      const tg = byTeamGame.get(`${gameId}|${teamId}`);
      if (!tg) continue;
      const present = new Set(tg.players.filter((p) => fin(p.min) && p.min > 0).map((p) => String(p.playerId)));

      // Who was an established regular BEFORE this game but did not play in it?
      const absentRegulars = [];
      for (const key of seen) {
        const h = hist.get(key);
        if (!h || h.games < SHOCK_CONFIG.minPriorGames) continue;
        const pid = key.split('|')[0];
        if (present.has(pid)) continue;
        if (h.minutes / h.games < SHOCK_CONFIG.regularMpg) continue;
        // Only a recently-active regular is a genuine absence rather than a departure.
        if (gameIndex - h.lastGameIndex > SHOCK_CONFIG.recentWindow) continue;
        // Currently in the rotation: played at least 4 of the team's last 5 games.
        const recentPlayed = (h.playedIndices || []).filter((i) => i >= gameIndex - SHOCK_CONFIG.activeInLastN).length;
        if (recentPlayed < SHOCK_CONFIG.activeAtLeast) continue;
        // Temporary, not a departure: he plays again within the return window.
        // CAVEAT: this classifies the event using FUTURE information. It is acceptable for
        // retrospective fitting — it describes the nature of the absence, never the beneficiary —
        // but real injury and transaction feeds would identify a temporary absence directly and
        // should replace this once acquired.
        const returns = (futurePlay.get(pid) || []).some((i) => i > gameIndex && i <= gameIndex + SHOCK_CONFIG.returnsWithin);
        absentRegulars.push({ playerId: pid, priorMpg: h.minutes / h.games, priorGames: h.games, returns });
      }

      for (const p of tg.players) {
        if (!fin(p.min) || p.min <= 0) continue;
        const key = `${p.playerId}|${teamId}`;
        const h = hist.get(key);
        if (h && h.games >= SHOCK_CONFIG.minBaselineGames && h.minutes / h.games >= SHOCK_CONFIG.minBaselineMpg) {
          out.push({
            season: p.season, gameId, teamId, playerId: p.playerId, date: tg.date,
            min: p.min, row: p,
            baselineMpg: h.minutes / h.games,
            baselineGames: h.games,
            // PRE-EVENT quality and form, accumulated from prior games only. These are the controls
            // the decisive selection test requires: without them, "opener predicts later" cannot be
            // separated from "better players open hot and stay good".
            preGsPer36: h.minutes > 0 ? (h.gs / h.minutes) * 36 : null,
            preTs: h.tsa > 0 ? h.pts / (2 * h.tsa) : null,
            preFgaPer36: h.minutes > 0 ? (h.fga / h.minutes) * 36 : null,
            preAstPer36: h.minutes > 0 ? (h.ast / h.minutes) * 36 : null,
            preTovPer36: h.minutes > 0 ? (h.tov / h.minutes) * 36 : null,
            preRebPer36: h.minutes > 0 ? (h.reb / h.minutes) * 36 : null,
            preStartRate: h.games > 0 ? h.starts / h.games : null,
            // Recent form: production over the player's last five games before this one.
            preForm5: h.recent.length ? h.recent.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, h.recent.length) : null,
            // The shock: how much established rotation workload was unavailable.
            absentRegulars: absentRegulars.length,
            absentMinutes: absentRegulars.reduce((a, x) => a + x.priorMpg, 0),
            // The subset that meets every temporary-absence condition. This is the shock design;
            // the looser count above is kept only for comparison.
            confirmedTemporary: absentRegulars.filter((x) => x.returns).length,
            confirmedTemporaryMinutes: absentRegulars.filter((x) => x.returns).reduce((a, x) => a + x.priorMpg, 0),
            // MEDIATORS — recorded for description, and NEVER to be conditioned on. If the absence
            // causes him to start and starting delivers the minutes, controlling for starting
            // removes part of the causal effect being measured. An earlier version of this file
            // described these as "confounders the response model must condition on", which was
            // exactly backwards and would have biased the response toward zero.
            mediators: {
              startedThisGame: p.started === true ? 1 : p.started === false ? 0 : null,
              minutesGained: fin(h.minutes) ? p.min - h.minutes / h.games : null,
            },
            // A genuine pre-event control: fixed before the absence occurred.
            isHome: p.isHome === true ? 1 : p.isHome === false ? 0 : null,
          });
        }
        // Update history AFTER recording, so a game never informs its own baseline.
        const cur = hist.get(key) || { games: 0, minutes: 0, lastGameIndex: -99, playedIndices: [],
          gs: 0, pts: 0, tsa: 0, fga: 0, ast: 0, tov: 0, reb: 0, starts: 0, recent: [] };
        cur.games++; cur.minutes += p.min; cur.lastGameIndex = gameIndex; cur.playedIndices.push(gameIndex);
        const gsv = (p.pts ?? 0) + 0.4 * (p.fgm ?? 0) - 0.7 * (p.fga ?? 0) - 0.4 * ((p.fta ?? 0) - (p.ftm ?? 0))
          + 0.7 * (p.oreb ?? 0) + 0.3 * (p.dreb ?? 0) + (p.stl ?? 0) + 0.7 * (p.ast ?? 0) + 0.7 * (p.blk ?? 0)
          - 0.4 * (p.pf ?? 0) - (p.tov ?? 0);
        cur.gs += gsv; cur.pts += p.pts ?? 0; cur.tsa += (p.fga ?? 0) + 0.44 * (p.fta ?? 0);
        cur.fga += p.fga ?? 0; cur.ast += p.ast ?? 0; cur.tov += p.tov ?? 0; cur.reb += p.reb ?? 0;
        if (p.started === true) cur.starts++;
        if (p.min > 0) cur.recent.push((gsv / p.min) * 36);
        hist.set(key, cur);
        seen.add(key);
      }
    }
  }
  return out;
}

/**
 * Relevance check: does a team-mate's absence actually MOVE the player's minutes?
 *
 * TERMINOLOGY. This is an exogenous opportunity-shock design, a natural experiment — NOT
 * instrumental-variables estimation. Nothing here runs a two-stage least squares, so calling the
 * absence an "instrument" would imply stronger identification than the model has. It is a shock
 * whose relevance is tested here and whose exogeneity is probed by the pre-trend and placebo tests
 * below.
 */
export function firstStage(obs) {
  const pts = obs.filter((o) => fin(o.min) && fin(o.baselineMpg) && fin(o.absentMinutes))
    .map((o) => ({ x: o.absentMinutes, y: o.min - o.baselineMpg }));
  const n = pts.length;
  if (n < 100) return { n, insufficient: true };
  const mx = pts.reduce((a, c) => a + c.x, 0) / n, my = pts.reduce((a, c) => a + c.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const c of pts) { sxy += (c.x - mx) * (c.y - my); sxx += (c.x - mx) ** 2; syy += (c.y - my) ** 2; }
  const slope = sxy / sxx;
  const se = Math.sqrt((syy - slope * sxy) / (n - 2) / sxx);
  return {
    n, slope: Number(slope.toFixed(4)), t: Number((slope / se).toFixed(2)),
    r: Number((sxy / Math.sqrt(sxx * syy)).toFixed(3)),
    meanAbsentMinutes: Number(mx.toFixed(2)),
    meanMinutesGain: Number(my.toFixed(2)),
  };
}


/**
 * PRE-TREND AND PLACEBO TESTS. A strong first stage only proves relevance: absences move minutes.
 * It says nothing about whether the absence was itself a response to something already happening.
 * These two checks are what distinguish an opportunity shock from a rotation decision already
 * underway.
 *
 * Pre-trend: in the games immediately BEFORE a confirmed absence, was the beneficiary's workload
 * already climbing? What matters is the absence of a POSITIVE anticipatory run-up. Measured leads
 * are slightly NEGATIVE and statistically detectable (about -0.2 minutes, t near -3), so the run-up
 * is not literally flat; it simply runs the opposite way from the event, which is the direction
 * that would matter for contamination.
 *
 * Placebo: assign fake shock dates to games with no absence at all. The estimator must find
 * nothing there. If it finds an "effect", the design is picking up trend rather than treatment.
 */
export function preTrendAndPlacebo(obs) {
  // Index observations by player-team, in game order.
  const byPlayer = new Map();
  for (const o of obs) {
    const k = `${o.playerId}|${o.teamId}|${o.season}`;
    if (!byPlayer.has(k)) byPlayer.set(k, []);
    byPlayer.get(k).push(o);
  }
  const lead = { m3: [], m2: [], m1: [], t0: [] };
  const placebo = [];
  const treatedProfile = [];
  for (const list of byPlayer.values()) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (let i = 3; i < list.length; i++) {
      const cur = list[i];
      const isShock = cur.confirmedTemporary > 0;
      const priorClean = [1, 2, 3].every((k) => list[i - k].confirmedTemporary === 0);
      if (isShock && priorClean) {
        // Minutes relative to the player's own rolling baseline, at each lead.
        lead.m3.push(list[i - 3].min - list[i - 3].baselineMpg);
        lead.m2.push(list[i - 2].min - list[i - 2].baselineMpg);
        lead.m1.push(list[i - 1].min - list[i - 1].baselineMpg);
        lead.t0.push(cur.min - cur.baselineMpg);
        treatedProfile.push({ base: cur.baselineMpg, games: cur.baselineGames });
      }
      // Placebo, MATCHED. A random no-absence game is an easy test: it can differ from the treated
      // games in season timing, role and workload, so finding nothing there proves little. This
      // requires the pseudo-event to look like a real one on pre-event characteristics — same
      // rough point of the season, comparable baseline workload, comparable established role.
      if (!isShock && priorClean && list[i - 1].confirmedTemporary === 0) {
        placebo.push({ v: cur.min - cur.baselineMpg, base: cur.baselineMpg, games: cur.baselineGames });
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const se = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length);
  };
  const r = (a) => (a.length ? { n: a.length, mean: Number(mean(a).toFixed(3)), t: Number((mean(a) / se(a)).toFixed(2)) } : null);
  // Keep only placebo games whose pre-event profile falls inside the treated distribution.
  const q = (a, p) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? s2[Math.floor((s2.length - 1) * p)] : null; };
  const bLo = q(treatedProfile.map((x) => x.base), 0.1), bHi = q(treatedProfile.map((x) => x.base), 0.9);
  const gLo = q(treatedProfile.map((x) => x.games), 0.1), gHi = q(treatedProfile.map((x) => x.games), 0.9);
  const matched = placebo.filter((x) => x.base >= bLo && x.base <= bHi && x.games >= gLo && x.games <= gHi).map((x) => x.v);
  return {
    minus3: r(lead.m3), minus2: r(lead.m2), minus1: r(lead.m1), event: r(lead.t0),
    placeboAll: r(placebo.map((x) => x.v)),
    placeboMatched: r(matched),
    matchWindow: { baselineMpg: [bLo, bHi], baselineGames: [gLo, gHi] },
  };
}

/* ==================================================================================
 * ROLE OVERLAP
 *
 * An absent player's minutes are not equally available to everyone on the roster. A 28-MPG centre
 * going out frees very little for a small point guard. Binary positional matching ("C replaces C")
 * is too crude for modern rotations, so overlap is CONTINUOUS.
 *
 * Historical game logs carry no position or height, so the role vector is built from the production
 * that defines role — how a player rebounds, creates, protects the rim and shoots. Two players with
 * similar profiles compete for the same minutes regardless of what position they are listed at,
 * which is closer to how rotations actually work than a label would be.
 * ================================================================================== */
export const ROLE_AXES = ['bigness', 'creation', 'perimeter', 'usage'];

/** Per-36 role vector from accumulated box-score totals. */
export function roleVector(tot) {
  const m = tot.min;
  if (!fin(m) || m <= 0) return null;
  const p36 = (v) => (fin(v) ? (v / m) * 36 : 0);
  const reb = p36(tot.reb), blk = p36(tot.blk), ast = p36(tot.ast);
  const fg3a = p36(tot.fg3a), fga = p36(tot.fga), ftaR = p36(tot.fta);
  return {
    // Interior presence: rebounding and rim protection.
    bigness: reb * 0.6 + blk * 3.0,
    // Playmaking load.
    creation: ast,
    // Perimeter orientation; a stretch big scores mid-range here, a centre near zero.
    perimeter: fg3a,
    // Shot volume, standing in for usage which the logs do not carry directly.
    usage: fga + 0.44 * ftaR,
  };
}

/**
 * Overlap in [0,1] between an absent player and a potential beneficiary.
 * Scaled by the spread of each axis across the league so no single axis dominates by unit size.
 */
export function roleOverlap(a, b, scale) {
  if (!a || !b) return 0;
  let d2 = 0;
  for (const k of ROLE_AXES) {
    const s = scale[k] || 1;
    d2 += ((a[k] - b[k]) / s) ** 2;
  }
  // Gaussian falloff: identical profiles score 1, and similarity decays smoothly with distance
  // rather than at an arbitrary cutoff.
  return Math.exp(-d2 / (2 * ROLE_AXES.length));
}

/** League-wide spread per axis, used to normalise the distance above. */
export function roleScale(vectors) {
  const out = {};
  for (const k of ROLE_AXES) {
    const v = vectors.map((x) => x[k]).filter(fin);
    const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    out[k] = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1)) || 1;
  }
  return out;
}

/**
 * Calibrate the overlap width against ACTUAL minute redistribution.
 *
 * The width must not be tuned because a number "looks too low". The empirical question is: when a
 * rotation player misses a game, which team-mates actually absorb his minutes? Fit the width so
 * predicted overlap best explains observed redistribution, and the role model is anchored to
 * basketball behaviour instead of to intuition.
 *
 * Role vectors passed in MUST be built from pre-shock games only. If they are computed from
 * season-end totals, the expanded role being studied contaminates the features used to classify it.
 *
 * @param {Array} events  [{ absentVec, gainers:[{vec, minutesGained}] }]
 */
export function calibrateOverlapWidth(events, scale, widths = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6]) {
  const results = [];
  for (const w of widths) {
    // Correlate predicted overlap with the share of the absent player's minutes each team-mate
    // actually picked up.
    const xs = [], ys = [];
    for (const ev of events) {
      const tot = ev.gainers.reduce((a, g) => a + Math.max(0, g.minutesGained), 0);
      if (tot <= 0) continue;
      for (const g of ev.gainers) {
        let d2 = 0;
        for (const k of ROLE_AXES) { const s = scale[k] || 1; d2 += ((ev.absentVec[k] - g.vec[k]) / s) ** 2; }
        xs.push(Math.exp(-d2 / (2 * w * w)));
        ys.push(Math.max(0, g.minutesGained) / tot);
      }
    }
    const n = xs.length;
    if (n < 50) { results.push({ width: w, n, insufficient: true }); continue; }
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    results.push({ width: w, n, r: Number((sxy / Math.sqrt(sxx * syy)).toFixed(4)) });
  }
  const usable = results.filter((r) => !r.insufficient && fin(r.r));
  const best = usable.length ? usable.reduce((a, b) => (b.r > a.r ? b : a)) : null;
  return { results, best };
}

/* ==================================================================================
 * ABSENCE EPISODES — separating treatment from outcome in time
 *
 * THE DANGER THIS ADDRESSES. Once realized minute gain becomes the treatment, same-game reverse
 * causality returns: a player who is playing well gets left on the floor, so "+9 minutes" is partly
 * an EFFECT of the performance being measured. Reading that as "he handled +9 minutes" repeats the
 * coach-selection error that made the naive workload curves useless.
 *
 * THE FIX. Treat a continuous absence as one EPISODE, then split it in time:
 *   treatment  = workload change measured on the FIRST game of the episode
 *   outcome    = performance on the SUBSEQUENT games of the episode
 * This eliminates MECHANICAL same-game outcome contamination. It does NOT make the treatment
 * exogenous: a coach can still expand the opening-game workload in response to how the player is
 * performing that night, so opener minutes remain endogenous to opener performance. A player who
 * plays well early may both reach the +10 bucket AND be likely to play well again, so the design
 * can still learn "players good enough to earn +10 stay good" rather than "this profile handles
 * +10". quantifyOpenerSelection() below measures how large that residual bias is instead of
 * assuming it away. Episodes with only one game yield no outcome and are dropped.
 *
 * This is still NOT a clean causal estimate — a coach chooses who gets the opening using knowledge
 * this data does not hold. The honest framing is predictive: when players with this pre-event
 * profile actually receive an externally opened larger role, how often do they stay effective?
 * ================================================================================== */
export const EPISODE_CONFIG = {
  minEpisodeGames: 2,      // one game gives treatment but no independent outcome
  maxEpisodeGames: 20,
  minTreatmentGain: 2,     // below this the role did not meaningfully expand
};

/**
 * Group per-game observations into absence episodes per player.
 * @param {Array} obs output of detectAbsences, already carrying baselineMpg and confirmedTemporary
 */
export function buildEpisodes(obs) {
  const byPlayer = new Map();
  for (const o of obs) {
    const k = `${o.playerId}|${o.teamId}|${o.season}`;
    if (!byPlayer.has(k)) byPlayer.set(k, []);
    byPlayer.get(k).push(o);
  }
  const episodes = [];
  for (const [key, list] of byPlayer) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let cur = null;
    for (const o of list) {
      const shocked = o.confirmedTemporary > 0;
      if (shocked) {
        if (!cur) cur = { key, playerId: o.playerId, season: o.season, games: [] };
        cur.games.push(o);
      } else if (cur) {
        if (cur.games.length >= EPISODE_CONFIG.minEpisodeGames) episodes.push(cur);
        cur = null;
      }
    }
    if (cur && cur.games.length >= EPISODE_CONFIG.minEpisodeGames) episodes.push(cur);
  }
  return episodes
    .filter((e) => e.games.length <= EPISODE_CONFIG.maxEpisodeGames)
    .map((e) => {
      const opener = e.games[0];
      const later = e.games.slice(1);
      // TREATMENT from the opener only.
      const treatment = opener.min - opener.baselineMpg;
      // OUTCOME workload and production from later games only.
      const lm = later.reduce((a, g) => a + g.min, 0);
      return {
        playerId: e.playerId, season: e.season, episodeGames: e.games.length,
        baselineMpg: opener.baselineMpg,
        baselineGames: opener.baselineGames,
        // Pre-event quality and form, carried through from the opener so the selection test can
        // condition on what was known BEFORE the opening game.
        pre: {
          preGsPer36: opener.preGsPer36, preTs: opener.preTs, preFgaPer36: opener.preFgaPer36,
          preAstPer36: opener.preAstPer36, preTovPer36: opener.preTovPer36,
          preRebPer36: opener.preRebPer36, preStartRate: opener.preStartRate, preForm5: opener.preForm5,
        },
        treatmentGain: treatment,
        sustainedMpg: later.length ? lm / later.length : null,
        // Rows for the later games, so production outcomes can be computed by the caller without
        // ever touching the opener that defined the treatment.
        outcomeRows: later.map((g) => g.row),
        openerRow: opener.row,
        meaningful: treatment >= EPISODE_CONFIG.minTreatmentGain,
      };
    })
    .filter((e) => e.outcomeRows.length > 0);
}

/**
 * Quantify how much of the treatment is earned rather than assigned.
 *
 * Within a treatment bucket, split episodes by whether the OPENING game went unusually well or
 * badly for that player. If only the hot openers sustain the role and perform later, then bucket
 * membership is largely a reward for the opener and the design still carries heavy selection.
 * If hot and cold openers sustain similarly, the expansion looks more like an assignment.
 *
 * @param {Array} episodes  buildEpisodes output
 * @param {(row:any)=>number} scoreOf  per-game production, e.g. game score per 36
 */
export function quantifyOpenerSelection(episodes, scoreOf, bands = [[2, 4], [4, 6], [6, 8], [8, 10], [10, 99]]) {
  const out = [];
  for (const [lo, hi] of bands) {
    const grp = episodes.filter((e) => e.meaningful && e.treatmentGain >= lo && e.treatmentGain < hi
      && fin(e.sustainedMpg) && e.outcomeRows.length);
    if (grp.length < 40) { out.push({ band: `${lo}-${hi}`, n: grp.length, insufficient: true }); continue; }
    const withScores = grp.map((e) => ({
      openerScore: scoreOf(e.openerRow),
      laterScore: e.outcomeRows.reduce((a, r) => a + scoreOf(r), 0) / e.outcomeRows.length,
      sustainedGain: e.sustainedMpg - e.baselineMpg,
    })).filter((x) => fin(x.openerScore) && fin(x.laterScore));
    const sorted = [...withScores].sort((a, b) => a.openerScore - b.openerScore);
    const q = Math.floor(sorted.length / 3);
    const cold = sorted.slice(0, q), hot = sorted.slice(-q);
    const mean = (a, k) => a.reduce((x, y) => x + y[k], 0) / a.length;
    out.push({
      band: `${lo}-${hi}`, n: withScores.length,
      coldOpenerLater: Number(mean(cold, 'laterScore').toFixed(2)),
      hotOpenerLater: Number(mean(hot, 'laterScore').toFixed(2)),
      coldSustainedGain: Number(mean(cold, 'sustainedGain').toFixed(2)),
      hotSustainedGain: Number(mean(hot, 'sustainedGain').toFixed(2)),
    });
  }
  return out;
}

// Exogenous workload shocks: the identification strategy behind TULIP v3.
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
  // which put an absent regular in 81.7% of team-games and turned the instrument into a proxy for
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
            // The instrument: how much established rotation workload was unavailable.
            absentRegulars: absentRegulars.length,
            absentMinutes: absentRegulars.reduce((a, x) => a + x.priorMpg, 0),
            // The subset that meets every temporary-absence condition. This is the instrument;
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
        const cur = hist.get(key) || { games: 0, minutes: 0, lastGameIndex: -99, playedIndices: [] };
        cur.games++; cur.minutes += p.min; cur.lastGameIndex = gameIndex; cur.playedIndices.push(gameIndex);
        hist.set(key, cur);
        seen.add(key);
      }
    }
  }
  return out;
}

/**
 * First-stage check: does a team-mate's absence actually MOVE the player's minutes?
 * An instrument that does not shift the treatment is useless, and this is the test that says so.
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

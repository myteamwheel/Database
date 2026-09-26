// Apply the frozen 2026-27 projection (PROJECTION_2026_27.json) to every player in public/data.json.
//
// Offline and deterministic: reads the committed stats.nba.com inputs, the frozen card and the
// built database, and writes p.proj on each player plus DATA.projectionMeta. It never refits
// anything; refitting is scripts/fit-projections.mjs.
//
// Usage: node scripts/build-projections.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  prepare, historyBefore, seasonPriors, teamPaces, leagueTrend, projectRates, roleFeatures, dot,
  applyTeamContext, projectedPace, perGameLine, rosterDepth, prevSeason,
  MIN_FEATURES, GP_FEATURES, RATE_STATS,
} from './lib/projection.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public/data.json');
const CARD = path.join(ROOT, 'PROJECTION_2026_27.json');
const INPUTS = path.join(ROOT, 'scripts/data/projection/inputs.json');

const T = '2026-27', LAST = '2025-26';

/**
 * Compute every player's projection into `data` (mutated in place) and return the counts.
 * Pure given its arguments, so the test suite can rebuild in memory and compare.
 */
export function buildProjections(data, rawInputs, card) {
  const inputsSha = crypto.createHash('sha256').update(rawInputs).digest('hex');
  if (card.builtFrom.sha256 !== inputsSha) {
    throw new Error(`inputs.json (${inputsSha.slice(0, 12)}) is not the file the card was fitted on (${card.builtFrom.sha256.slice(0, 12)}). Refit with scripts/fit-projections.mjs.`);
  }
  const inputs = JSON.parse(rawInputs);
  const D = prepare(inputs);
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

  /** Points per 100 possessions implied by a set of rates and percentages. */
  function pts100(rate, pct, ftValue) {
    const fg3a = Math.min(rate.fg3a, rate.fga);
    return 2 * (rate.fga - fg3a) * pct.fg2 + 3 * fg3a * pct.fg3 + rate.fta * pct.ft * ftValue;
  }

  /** Look up the 10th-90th percentile miss for a projected value, from the held-out season. */
  function band(bands, k, v) {
    const list = bands?.[k];
    if (!list || !Number.isFinite(v)) return [null, null];
    const b = list.find((x) => x.upTo === null || v <= x.upTo) || list.at(-1);
    return [Math.max(0, v + b.p10), Math.max(0, v + b.p90)];
  }

  /** How much a group of features moves projected minutes, holding the rest fixed. */
  function minutesEffect(coef, f, zero) {
    const g = { ...f, ...zero };
    return dot(coef, f, MIN_FEATURES) - dot(coef, g, MIN_FEATURES);
  }

  function projectLeague(leagueKey, players) {
    const L = D[leagueKey];
    const fit = card[leagueKey];
    const P = fit.params, role = fit.role;
    const lastSeason = L.seasons.get(LAST);
    const ctx = { priors: seasonPriors(lastSeason, D.bio), paces: teamPaces(lastSeason), trend: leagueTrend(L, T, D.bio) };
    const isNba = leagueKey === 'nba';
    const games = isNba ? 82 : card.gleague.games;

    // 2026-27 rosters (NBA). Players with no NBA past who were not drafted are camp invites; most
    // are cut before opening night, so they do not count as competition for minutes.
    const rosters = new Map();
    if (isNba) {
      for (const [pid, team] of D.rosters2627) {
        const b = D.bio.get(pid);
        const hasPast = historyBefore(L, pid, T).some(Boolean);
        if (!hasPast && !(b?.draftYear === 2026 && b?.draftNumber)) continue;
        if (!rosters.has(team)) rosters.set(team, []);
        rosters.get(team).push(pid);
      }
    }

    const rows = [];
    for (const p of players) {
      const pid = Number(p.nbaPersonId);
      const hist = historyBefore(L, pid, T);
      if (!hist.some(Boolean)) {
        p.proj = { abstain: true, reason: isNba
          ? 'No NBA minutes in 2023-24, 2024-25 or 2025-26 to project from.'
          : 'No G League minutes in 2023-24, 2024-25 or 2025-26 to project from.' };
        continue;
      }
      const last = hist.find(Boolean);
      const bio = D.bio.get(pid);
      const team26 = isNba ? D.rosters2627.get(pid) || null : null;
      const status = !isNba ? (D.rosters2627.has(pid) ? 'nba-roster' : 'gleague')
        : team26 ? (team26 === last.team ? 'same' : 'new') : 'unsigned';
      const moved = status === 'new';
      const depth = isNba && team26 ? rosterDepth(L, T, rosters.get(team26) || [], pid, role.rookie, D.bio) : 0;
      const pr = projectRates(hist, T, bio, ctx.priors, P, ctx.trend);
      const f = roleFeatures(hist, T, bio, L.teamGames, pr, { moved, depth });
      const mpgRaw = dot(role.minutes, f, MIN_FEATURES);
      const mpg = Math.max(1, Math.min(isNba ? 40 : 42, mpgRaw));
      const share = Math.max(0.05, Math.min(1, dot(role.gp, f, GP_FEATURES)));
      rows.push({ p, pid, hist, last, bio, team: team26 || last.team, status, moved, depth, pr, f, mpgRaw, mpg, share,
        games: share * games, mpgLast: hist[0] ? hist[0].min / hist[0].gp : null });
    }

    // Team context. Unsigned players and the G League get neutral context (no roster to balance).
    const groups = new Map();
    for (const r of rows) {
      const key = isNba && r.status !== 'unsigned' ? r.team : `solo:${r.pid}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, list] of groups) {
      const solo = key.startsWith('solo:');
      const pace = solo || !isNba ? projectedPace(ctx.priors, ctx.trend, NaN, P)
        : projectedPace(ctx.priors, ctx.trend, ctx.paces.get(key), P);
      applyTeamContext(list, ctx.priors, pace, P, solo ? { noUsage: true, noRole: true } : {});
    }

    const bands = card.backtest[leagueKey]?.residualBands;
    for (const r of rows) {
      const { p, line, pr, f } = r;
      const actualPts100 = r.hist[0] ? (r.hist[0].pts / r.hist[0].poss) * 100 : null;
      const basePct = Object.fromEntries(Object.keys(pr.pct).map((k) => [k, pr.pieces[k].base]));
      const baseRate = Object.fromEntries(RATE_STATS.map((k) => [k, pr.pieces[k].base]));
      const ftV = ctx.priors.ftValue;
      const [ptsLo, ptsHi] = band(bands, 'pts', line.pts);
      const [rebLo, rebHi] = band(bands, 'reb', line.reb);
      const [astLo, astHi] = band(bands, 'ast', line.ast);
      const [mpgLo, mpgHi] = band(bands, 'mpg', line.mpg);
      const [gpLo, gpHi] = band(bands, 'gp', r.games);
      const coef = card[leagueKey].role.minutes;
      const seasonsUsed = r.hist.map((h, i) => (h ? { season: prevSeason(T, i + 1), team: h.team, gp: h.gp, min: Math.round(h.min),
        weight: [1, P.w2, P.w3][i] } : null)).filter(Boolean);
      p.proj = {
        season: T, team: r.team, status: r.status, age: pr.age,
        gp: r1(r.games), mpg: r1(line.mpg), pts: r1(line.pts), reb: r1(line.reb), oreb: r1(line.oreb), dreb: r1(line.dreb),
        ast: r1(line.ast), stl: r1(line.stl), blk: r1(line.blk), tov: r1(line.tov), fg3m: r1(line.fg3m),
        fga: r1(line.fga), fg3a: r1(line.fg3a), fta: r1(line.fta),
        fgPct: r3(line.fgPct), fg3Pct: r3(line.fg3Pct), ftPct: r3(line.ftPct), ts: r3(line.ts),
        ptsLo: r1(ptsLo), ptsHi: r1(ptsHi), rebLo: r1(rebLo), rebHi: r1(rebHi), astLo: r1(astLo), astHi: r1(astHi),
        mpgLo: r1(mpgLo), mpgHi: r1(Math.min(isNba ? 42 : 44, mpgHi)), gpLo: r1(gpLo), gpHi: r1(Math.min(games, gpHi)),
        dPts: r1(line.pts - (p.pts ?? NaN)), dReb: r1(line.reb - (p.reb ?? NaN)), dAst: r1(line.ast - (p.ast ?? NaN)),
        dMpg: r1(line.mpg - (p.mpg ?? NaN)),
        why: {
          seasons: seasonsUsed,
          possessions: Math.round(pr.basePoss),
          // Share of each rate that comes from the player's own record rather than the position norm.
          ownShare: { fga: r2(pr.pieces.fga.weightOnOwn), reb: r2((pr.pieces.oreb.weightOnOwn + pr.pieces.dreb.weightOnOwn) / 2),
            ast: r2(pr.pieces.ast.weightOnOwn), fg3: r2(pr.pieces.fg3.weightOnOwn), ft: r2(pr.pieces.ft.weightOnOwn) },
          age: { scoring: r3(pr.pieces.fga.ageF - 1), freeThrows: r3(pr.pieces.fta.ageF - 1), rebounds: r3(pr.pieces.dreb.ageF - 1),
            assists: r3(pr.pieces.ast.ageF - 1), steals: r3(pr.pieces.stl.ageF - 1), blocks: r3(pr.pieces.blk.ageF - 1) },
          development: r3(pr.pieces.fga.expF - 1), yearsIn: pr.yearsIn,
          pts100: { last: r1(actualPts100), blended: r1(pts100(baseRate, basePct, ftV)), aged: r1(pts100(pr.rate, pr.pct, ftV)),
            final: r1(pts100(r.rateFinal, pr.pct, ftV)) },
          minutes: {
            last: r1(r.mpgLast), lateSeason: r.hist[0]?.postGp >= 5 ? r1(r.hist[0].postMin / r.hist[0].postGp) : null,
            startRate: r.hist[0] && Number.isFinite(r.hist[0].gs) ? r2(r.hist[0].gs / r.hist[0].gp) : null,
            projected: r1(line.mpg),
            effects: {
              age: r1(minutesEffect(coef, f, { age: 0, ageYoung: 0, ageOld: 0 })),
              newTeam: r1(minutesEffect(coef, f, { moved: 0, movedMpg: 0, movedDepth: 0 })),
              depth: r1(minutesEffect(coef, f, { depth: 0, movedDepth: 0 })),
              draftAndYouth: r1(minutesEffect(coef, f, { rookieScale: 0, pickYoung: 0 })),
            },
            depth: isNba && r.status !== 'unsigned' ? r2(r.depth) : null,
          },
          games: { lastShare: r2(f.gpShare1), projectedShare: r2(r.share) },
          team: { usage: r3(r.factors.usage - 1), newTeam: r3(r.factors.newTeam - 1), pace: r1(r.factors.pace),
            leaguePace: r1(ctx.priors.pace), rosterBalance: r3(r.factors.rosterBalance) },
        },
      };
    }
    return { scored: rows.length, abstained: players.length - rows.length,
      moved: rows.filter((r) => r.status === 'new').length, unsigned: rows.filter((r) => r.status === 'unsigned').length,
      teamMinutes: isNba ? teamMinuteTotals(rows) : null };
  }

  /** Diagnostic: projected minutes per game each 2026-27 roster adds up to (players we project). */
  function teamMinuteTotals(rows) {
    const t = new Map();
    for (const r of rows) {
      if (r.status === 'unsigned') continue;
      t.set(r.team, (t.get(r.team) || 0) + r.line.mpg * r.share);
    }
    const v = [...t.values()].sort((a, b) => a - b);
    return { min: r1(v[0]), median: r1(v[Math.floor(v.length / 2)]), max: r1(v.at(-1)) };
  }

  // The G League base season is the database's own 2025-26 line, which includes Showcase Cup games
  // the regular-season table leaves out (more games, same league).
  {
    const gl = D.gleague.seasons.get(LAST);
    for (const p of data.leagues.GLEAGUE) {
      if (!p.appeared || !(p.gp > 0) || !(p.minutes > 0)) continue;
      const g = p.gp, pid = Number(p.nbaPersonId);
      const fg3m = (p.fg3 || 0) * g, fg3a = (p.fg3a || 0) * g, fgm = (p.fg || 0) * g, fga = (p.fga || 0) * g;
      gl.set(pid, {
        pid, name: p.name, team: p.team, age: p.age, gp: g, min: p.minutes,
        fgm, fga, fg3m, fg3a, fg2m: fgm - fg3m, fg2a: fga - fg3a, ftm: (p.ft || 0) * g, fta: (p.fta || 0) * g,
        oreb: (p.oreb || 0) * g, dreb: (p.dreb || 0) * g, ast: (p.ast || 0) * g, tov: (p.tov || 0) * g,
        stl: (p.stl || 0) * g, blk: (p.blk || 0) * g, pf: (p.pf || 0) * g, pts: (p.pts || 0) * g,
        usg: Number.isFinite(p.usg) ? p.usg / 100 : null, pace: Number.isFinite(p.pace) ? p.pace : null,
        poss: Number.isFinite(p.poss) && p.poss > 0 ? p.poss : p.minutes * 100 / 48, pie: null,
      });
    }
  }

  const nba = projectLeague('nba', data.leagues.NBA);
  const gleague = projectLeague('gleague', data.leagues.GLEAGUE);

  const bt = card.backtest;
  data.projectionMeta = {
    id: card.id, season: T, basedOn: LAST,
    rostersAsOf: inputs.fetchedAt.slice(0, 10),
    inputsSha256: inputsSha.slice(0, 16),
    counts: { nba, gleague },
    params: {
      recencyWeights: [1, card.nba.params.w2, card.nba.params.w3],
      shootingWeights: [1, card.nba.params.pw2, card.nba.params.pw3],
      regressionPossessions: card.nba.params.R, shootingRegressionAttempts: card.nba.params.Rpct,
      team: card.nba.params.team,
    },
    backtest: {
      protocol: bt.protocol, development: bt.development,
      nba: { season: bt.nba.season, n: bt.nba.all.n, mae: bt.nba.all.mae, rotation: bt.nba.rotation1000,
        gain: bt.nba.gainVsBaselines, ablation: bt.nba.ablation },
      gleague: { season: bt.gleague.season, n: bt.gleague.n, mae: bt.gleague.mae },
    },
  };
  return { nba, gleague };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const { nba, gleague } = buildProjections(data, fs.readFileSync(INPUTS), JSON.parse(fs.readFileSync(CARD, 'utf8')));
  fs.writeFileSync(DATA, JSON.stringify(data));
  console.log(`2026-27 projections: NBA ${nba.scored} projected (${nba.moved} on new teams, ${nba.unsigned} not on a roster), ${nba.abstained} without recent NBA minutes`);
  console.log(`  G League ${gleague.scored} projected, ${gleague.abstained} without recent G League minutes`);
  console.log(`  2026-27 projected team minutes per game (projected players only): ${JSON.stringify(nba.teamMinutes)}`);
}

// CROSS-TEAM PORTABILITY — does information observed on Team A predict sustained workload on Team B?
//
// This is the original TULIP Capacity question. It is a PREDICTIVE test, not a causal one: players
// are traded, waived and signed partly because teams know things about them, so nothing here is a
// claim about what moving does to a player.
//
// Design, fixed before any result was seen:
//   transition   consecutive games for one player on different teams
//   cutoff       the moment immediately before his first Team B game
//   predictors   Team A / pre-transition ONLY
//   targets      Team B workload over three prespecified windows, all reported
//
// The bar is `recent-10 MPG on Team A`. That rule already reproduces the within-team ranking, so any
// claim for TULIP Capacity has to beat it here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) rows.push(r);
}
// starter flags
{
  const st = new Set();
  for (const s of SEASONS) for (const slug of ['regular', 'playoffs']) {
    const f = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) if (r.started === true) st.add(`${r.gameId}|${r.playerId}`);
  }
  for (const r of rows) r.started = st.has(`${r.gameId}|${r.playerId}`);
}
const bio = new Map();
for (const s of SEASONS) {
  const f = path.join(HIST, 'bio', `${s}.json`);
  if (!fs.existsSync(f)) continue;
  for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const dn = Number(b.draftNumber);
    bio.set(`${s}|${b.playerId}`, { age: Number(b.age) || null, heightIn: Number(b.heightIn) || null,
      weight: Number(b.weight) || null, draftPick: Number.isFinite(dn) && dn > 0 ? dn : 61,
      undrafted: Number.isFinite(dn) && dn > 0 ? 0 : 1 });
  }
}
const nameOf = new Map();
const byPlayer = new Map(), byTeam = new Map();
for (const r of rows) {
  nameOf.set(String(r.playerId), r.playerName);
  const pk = String(r.playerId);
  if (!byPlayer.has(pk)) byPlayer.set(pk, []);
  byPlayer.get(pk).push(r);
  if (!byTeam.has(r.teamId)) byTeam.set(r.teamId, []);
  byTeam.get(r.teamId).push(r);
}
const bydate = (a, b) => String(a.gameDate).localeCompare(String(b.gameDate));
for (const v of byPlayer.values()) v.sort(bydate);
for (const v of byTeam.values()) v.sort(bydate);

const gs = (r) => r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm) + 0.7 * r.oreb + 0.3 * r.dreb
  + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const MIN_A = 20, MIN_B = 10;
const T = [];
for (const [pk, g] of byPlayer) {
  for (let i = 1; i < g.length; i++) {
    if (g[i].teamId === g[i - 1].teamId) continue;
    const cutoff = g[i].gameDate, teamA = g[i - 1].teamId, teamB = g[i].teamId;
    const inSeason = g[i].season === g[i - 1].season;
    const pre = g.slice(0, i);
    if (pre.length < MIN_A) continue;
    // Team B stint: consecutive games on B starting at i, same season
    const post = [];
    for (let j = i; j < g.length; j++) {
      if (g[j].teamId !== teamB || g[j].season !== g[i].season) break;
      post.push(g[j]);
    }
    if (post.length < MIN_B) continue;
    const last20 = pre.slice(-20), last10 = pre.slice(-10), last5 = pre.slice(-5), prev10 = pre.slice(-15, -5);
    const mins20 = last20.reduce((a, r) => a + (r.min ?? 0), 0);
    const seasonPre = pre.filter((r) => r.season === g[i - 1].season);
    const bySeason = new Map();
    for (const r of pre) { const v = bySeason.get(r.season) || [0, 0]; v[0] += r.min ?? 0; v[1]++; bySeason.set(r.season, v); }
    // ---- Team B context KNOWN AT ACQUISITION: B's own last 20 team-games before the cutoff ----
    const bRows = byTeam.get(teamB) || [];
    let hi = 0; while (hi < bRows.length && String(bRows[hi].gameDate) < String(cutoff)) hi++;
    const bPrior = bRows.slice(Math.max(0, hi - 20 * 18), hi);
    const bGameIds = [...new Set(bPrior.map((r) => r.gameId))].slice(-20);
    const bSet = new Set(bGameIds);
    const bMpg = new Map();
    for (const r of bPrior) {
      if (!bSet.has(r.gameId)) continue;
      const k = String(r.playerId);
      const v = bMpg.get(k) || [0, 0]; v[0] += r.min ?? 0; v[1]++; bMpg.set(k, v);
    }
    const bRot = [...bMpg.entries()].filter(([k]) => k !== pk).map(([, v]) => v[0] / Math.max(1, v[1]))
      .sort((a, b) => b - a);
    const aRecent10 = mean(last10.map((r) => r.min ?? 0)) ?? 0;
    const ahead = bRot.filter((x) => x > aRecent10);
    const b = bio.get(`${g[i].season}|${g[i].playerId}`) || {};
    T.push({
      pid: pk, season: g[i].season, inSeason: inSeason ? 1 : 0, cutoff,
      // ---- Team A predictors ----
      aSeasonMpg: mean(seasonPre.map((r) => r.min ?? 0)) ?? aRecent10,
      aRecent10, aRecent5: mean(last5.map((r) => r.min ?? 0)) ?? aRecent10,
      aTrend: (mean(last5.map((r) => r.min ?? 0)) ?? 0) - (mean(prev10.map((r) => r.min ?? 0)) ?? 0),
      aStartRate: mean(last20.map((r) => (r.started ? 1 : 0))) ?? 0,
      aGames: pre.length, aSeasons: bySeason.size,
      aCareerHighMpg: Math.max(...[...bySeason.values()].map(([m, n]) => (n >= 10 ? m / n : 0)), 0),
      aGsPer36: mins20 > 0 ? 36 * last20.reduce((a, r) => a + (gs(r) ?? 0), 0) / mins20 : 0,
      aTs: (() => { const f2 = last20.reduce((a, r) => a + r.fga, 0), ft = last20.reduce((a, r) => a + r.fta, 0), p = last20.reduce((a, r) => a + r.pts, 0);
        return f2 + 0.44 * ft > 0 ? p / (2 * (f2 + 0.44 * ft)) : 0.5; })(),
      aFgaPer36: mins20 > 0 ? 36 * last20.reduce((a, r) => a + r.fga, 0) / mins20 : 0,
      aAstPer36: mins20 > 0 ? 36 * last20.reduce((a, r) => a + r.ast, 0) / mins20 : 0,
      aRebPer36: mins20 > 0 ? 36 * last20.reduce((a, r) => a + r.reb, 0) / mins20 : 0,
      aPfPer36: mins20 > 0 ? 36 * last20.reduce((a, r) => a + r.pf, 0) / mins20 : 0,
      age: b.age ?? 26, heightIn: b.heightIn ?? 78, weight: b.weight ?? 210,
      draftPick: b.draftPick ?? 61, undrafted: b.undrafted ?? 1,
      // ---- Team B destination context ----
      bAhead: ahead.length, bMinsAhead: ahead.reduce((a, x) => a + x, 0),
      bBestAhead: ahead.length ? ahead[0] : 0, bDepth: bRot.filter((x) => x >= 15).length,
      bRotKnown: bRot.length ? 1 : 0,
      // ---- targets ----
      tFirst10: mean(post.slice(0, 10).map((r) => r.min ?? 0)),
      t6to15: post.length >= 15 ? mean(post.slice(5, 15).map((r) => r.min ?? 0)) : null,
      tRest: mean(post.map((r) => r.min ?? 0)),
      nPost: post.length,
    });
  }
}
console.log(`CROSS-TEAM PORTABILITY STUDY`);
console.log(`transitions qualifying (>=${MIN_A} Team A games, >=${MIN_B} Team B games): ${T.length}`);
console.log(`  distinct players ${new Set(T.map((x) => x.pid)).size} · in-season ${T.filter((x) => x.inSeason).length} · offseason ${T.filter((x) => !x.inSeason).length}`);
console.log(`  seasons ${[...new Set(T.map((x) => x.season))].sort().join(', ')}`);
console.log(`  Team B rotation context available: ${T.filter((x) => x.bRotKnown).length}`);
fs.writeFileSync(path.join(HIST, 'transitions.json'), JSON.stringify(T));
console.log(`  -> transitions.json`);

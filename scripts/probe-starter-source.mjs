// Phase 2 source evaluation for historical per-game starter status.
//
// A previous version of this file exported hardcoded STARTER_RELIABLE_SEASONS /
// STARTER_UNRELIABLE_SEASONS arrays derived from three sampled games per season. Three games is
// enough to discover a catastrophic defect; it is nowhere near enough to certify a season of
// 1,230 games. Those arrays are gone. This script now emits an evidence MANIFEST, and validity is
// recorded at the smallest practical unit — the team-game — because a clean season sample does
// not make every game in that season clean.
//
// KNOWN DEFECT. stats.nba.com box scores report START_POSITION for five players per team from
// 2017-18 onward, but in 2015-16 and 2016-17 the field is populated for bench players too
// (2015-16 game 0021500001: Detroit shows nine, including Aron Baynes on 10:51).
// boxscoretraditionalv3 reproduces it, so it is the underlying data, not the endpoint version.
// Starters are NEVER inferred from minutes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const OUT = path.join(HIST, 'starter_source_manifest.json');

const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const ENDPOINT = 'https://stats.nba.com/stats/boxscoretraditionalv2';
const SOURCE_VERSION = 'boxscoretraditionalv2 / START_POSITION';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(url, { headers: H, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 2) return { __err: e.message }; await wait(2000); }
  }
}
const boxUrl = (g) => ENDPOINT + '?' + new URLSearchParams({
  GameID: g, StartPeriod: '0', EndPeriod: '10', StartRange: '0', EndRange: '28800', RangeType: '0' });

/**
 * Evaluate one game. Returns per-team-game validity rather than a single game verdict, since a
 * game can be clean for one team and malformed for the other. Starter identities are preserved
 * so an exhaustive accepted crawl can be reused by the historical ingest instead of fetched twice.
 */
export async function evaluateGame(gameId) {
  const r = await get(boxUrl(gameId));
  if (r.__err) return { gameId, status: 'MISSING', error: r.__err, teams: [] };
  const ps = r.resultSets?.find((x) => x.name === 'PlayerStats');
  if (!ps || !ps.rowSet.length) return { gameId, status: 'MISSING', error: 'no PlayerStats', teams: [] };
  const i = Object.fromEntries(ps.headers.map((h, k) => [h, k]));
  for (const required of ['TEAM_ID', 'TEAM_ABBREVIATION', 'PLAYER_ID', 'START_POSITION']) {
    if (!(required in i)) return { gameId, status: 'MISSING', error: `PlayerStats missing ${required}`, teams: [] };
  }
  const byTeam = new Map();
  for (const row of ps.rowSet) {
    const teamId = String(row[i.TEAM_ID]);
    const team = row[i.TEAM_ABBREVIATION];
    if (!byTeam.has(teamId)) byTeam.set(teamId, { teamId, team, starters: 0, players: 0, positions: [], starterPlayerIds: [] });
    const t = byTeam.get(teamId);
    t.players++;
    const pos = String(row[i.START_POSITION] ?? '').trim();
    if (pos !== '') {
      t.starters++;
      t.positions.push(pos);
      t.starterPlayerIds.push(String(row[i.PLAYER_ID]));
    }
  }
  const teams = [...byTeam.values()].map((t) => ({
    ...t,
    // A usable team-game has exactly five distinct flagged starter identities.
    status: t.starters === 5 && new Set(t.starterPlayerIds).size === 5 ? 'VALID' : 'INVALID',
  }));
  return { gameId, status: teams.every((t) => t.status === 'VALID') ? 'VALID' : 'INVALID', teams };
}

/** Stratified game selection: season phases, plus playoffs separately. */
function sampleGames(season, perSeason) {
  const out = { 'Regular Season': [], Playoffs: [] };
  for (const [file, st] of [['gamelog.json', 'Regular Season'], ['gamelog_playoffs.json', 'Playoffs']]) {
    const p = path.join(HIST, season, file);
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Order by date so "early / middle / late" is meaningful, and spread across teams.
    const byDate = [...new Set(rows.map((r) => `${r.gameDate}|${r.gameId}`))].sort();
    const ids = byDate.map((x) => x.split('|')[1]);
    const want = st === 'Playoffs' ? Math.max(6, Math.floor(perSeason / 3)) : perSeason;
    const step = Math.max(1, Math.floor(ids.length / want));
    const picked = [];
    for (let k = 0; k < ids.length && picked.length < want; k += step) picked.push(ids[k]);
    // Always include the very last game of the phase (post-deadline / finals).
    if (ids.length && !picked.includes(ids[ids.length - 1])) picked.push(ids[ids.length - 1]);
    out[st] = picked;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const perSeason = Number(process.argv[2] || 25);
  const seasons = JSON.parse(fs.readFileSync(path.join(HIST, 'provenance.json'), 'utf8')).seasons;
  const manifest = {
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT, sourceVersion: SOURCE_VERSION,
    method: 'Stratified sample across each phase, ordered by date. Validity recorded per TEAM-GAME: exactly five distinct flagged starter identities = VALID.',
    caveat: 'A sample cannot certify every game in a season. The ingest must re-validate each team-game and set started=null wherever the team-game is not VALID.',
    seasons: {},
  };
  console.log(`stratified probe: up to ${perSeason} regular-season + ~${Math.max(6, Math.floor(perSeason / 3))} playoff games per season\n`);
  console.log('season     type              games  teamGames  valid  invalid  missing  defect%');
  for (const season of seasons) {
    const picks = sampleGames(season, perSeason);
    manifest.seasons[season] = {};
    for (const [st, ids] of Object.entries(picks)) {
      if (!ids.length) continue;
      let valid = 0, invalid = 0, missing = 0, teamGames = 0;
      const examples = [];
      for (const g of ids) {
        const res = await evaluateGame(g);
        if (res.status === 'MISSING') { missing++; await wait(1250); continue; }
        for (const t of res.teams) {
          teamGames++;
          if (t.status === 'VALID') valid++;
          else { invalid++; if (examples.length < 5) examples.push({ gameId: g, team: t.team, starters: t.starters }); }
        }
        await wait(1250);
      }
      const defectRate = teamGames ? invalid / teamGames : null;
      manifest.seasons[season][st] = {
        gamesSampled: ids.length, teamGamesTested: teamGames,
        valid, invalid, missingBoxScores: missing,
        defectRate: defectRate === null ? null : Number(defectRate.toFixed(4)),
        // Status is evidence about the SAMPLE, never a guarantee about the season.
        sampleStatus: defectRate === null ? 'NO_DATA' : defectRate === 0 ? 'CLEAN_SAMPLE'
          : defectRate < 0.02 ? 'MOSTLY_CLEAN_SAMPLE' : 'DEFECTIVE',
        invalidExamples: examples,
      };
      console.log(`${season}  ${st.padEnd(16)} ${String(ids.length).padStart(5)}  ${String(teamGames).padStart(9)}` +
        `  ${String(valid).padStart(5)}  ${String(invalid).padStart(7)}  ${String(missing).padStart(7)}` +
        `  ${defectRate === null ? '   n/a' : (100 * defectRate).toFixed(1).padStart(6)}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1));
  console.log(`\nmanifest -> scripts/data/history/starter_source_manifest.json`);
  console.log('No season is marked "reliable". The ingest validates every team-game itself.');
}

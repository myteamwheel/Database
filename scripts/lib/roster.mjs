// Per-team stint history and position normalisation.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, num } from './sources.mjs';

/**
 * Canonical position family, so a filter means the same thing in both panels.
 *
 * The NBA player index lists G / F / C / G-F / F-C / F-G / C-F. The G League mixes that with
 * Basketball-Reference's PG / SG / SF / PF taxonomy for the 104 players whose position comes
 * from there, so filtering "G" silently excluded everyone listed "PG". `position` keeps the
 * source's own string; `positionFamily` is what the filter uses.
 */
const FAMILY = {
  PG: 'G', SG: 'G', G: 'G',
  SF: 'F', PF: 'F', F: 'F',
  C: 'C',
};

export function positionFamily(pos) {
  if (!pos) return null;
  const parts = String(pos).split('-').map((s) => FAMILY[s.trim().toUpperCase()]).filter(Boolean);
  if (!parts.length) return null;
  const uniq = [...new Set(parts)];
  if (uniq.length === 1) return uniq[0];
  // Guard order so "F-G" and "G-F" collapse to the same family.
  const order = ['G', 'F', 'C'];
  return uniq.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('-');
}

function loadArray(file) {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

const STINT_FIELDS = ['GP', 'W', 'L', 'MIN', 'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA',
  'OREB', 'DREB', 'REB', 'AST', 'TOV', 'STL', 'BLK', 'PF', 'PTS', 'PLUS_MINUS'];

/**
 * Build per-player, per-team stint lines. `halves` is a list of {file, label} where each file
 * holds team-scoped rows; rows for the same player+team across halves are summed.
 */
/**
 * teamId -> abbreviation, learned from players who only appeared for one team.
 * Needed because the stint rows carry the player's current team abbreviation rather than the
 * team the row actually describes; only the queried team id is trustworthy.
 */
function teamAbbrevMap(halves) {
  const map = new Map();
  for (const { file } of halves) {
    for (const r of loadArray(file)) {
      if ((r.TEAM_COUNT || 1) === 1 && r.QUERIED_TEAM_ID && r.TEAM_ABBREVIATION) {
        map.set(r.QUERIED_TEAM_ID, r.TEAM_ABBREVIATION);
      }
    }
  }
  return map;
}

export function buildStints(halves) {
  const abbrev = teamAbbrevMap(halves);
  const byPlayer = new Map();
  for (const { file, label } of halves) {
    for (const r of loadArray(file)) {
      const pid = r.PLAYER_ID;
      const tid = r.QUERIED_TEAM_ID ?? r.TEAM_ID;
      const team = abbrev.get(tid) || (r.QUERIED_TEAM_ID ? null : r.TEAM_ABBREVIATION);
      if (!pid || !team) continue;
      if (!byPlayer.has(pid)) byPlayer.set(pid, new Map());
      const teams = byPlayer.get(pid);
      if (!teams.has(team)) {
        teams.set(team, { team, teamId: tid, halves: {}, ...Object.fromEntries(STINT_FIELDS.map((f) => [f, 0])) });
      }
      const s = teams.get(team);
      s.halves[label] = num(r.GP) || 0;
      for (const f of STINT_FIELDS) s[f] += num(r[f]) || 0;
    }
  }
  const out = new Map();
  for (const [pid, teams] of byPlayer) {
    const list = [...teams.values()]
      .map((s) => ({
        team: s.team,
        teamId: s.teamId,
        gp: s.GP,
        min: Math.round(s.MIN * 10) / 10,
        mpg: s.GP ? Math.round((s.MIN / s.GP) * 10) / 10 : null,
        pts: s.GP ? Math.round((s.PTS / s.GP) * 10) / 10 : null,
        reb: s.GP ? Math.round((s.REB / s.GP) * 10) / 10 : null,
        ast: s.GP ? Math.round((s.AST / s.GP) * 10) / 10 : null,
        stl: s.GP ? Math.round((s.STL / s.GP) * 10) / 10 : null,
        blk: s.GP ? Math.round((s.BLK / s.GP) * 10) / 10 : null,
        fgPct: s.FGA ? Math.round((s.FGM / s.FGA) * 1000) / 1000 : null,
        fg3Pct: s.FG3A ? Math.round((s.FG3M / s.FG3A) * 1000) / 1000 : null,
        ftPct: s.FTA ? Math.round((s.FTM / s.FTA) * 1000) / 1000 : null,
        plusMinus: s.PLUS_MINUS,
        halves: s.halves,
      }))
      .sort((a, b) => b.min - a.min);   // most-used team first
    out.set(pid, list);
  }
  return out;
}

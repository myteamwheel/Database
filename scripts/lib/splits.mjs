// Situational splits and roster-only players.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, num } from './sources.mjs';

export const SPLIT_NAMES = ['home', 'road', 'wins', 'losses', 'starter', 'bench',
  'preallstar', 'postallstar', 'clutch',
  // Month is SEASON-relative on this API, not calendar: 1 is the season's opening month.
  // The NBA serves seven; the G League returns nothing for this parameter, and absent files
  // are simply skipped rather than faked.
  'month1', 'month2', 'month3', 'month4', 'month5', 'month6', 'month7'];

/** Fields worth keeping per split; the rest is noise multiplied nine times over. */
const KEEP = ['GP', 'W', 'L', 'MIN', 'FGM', 'FGA', 'FG_PCT', 'FG3M', 'FG3A', 'FG3_PCT',
  'FTM', 'FTA', 'FT_PCT', 'OREB', 'DREB', 'REB', 'AST', 'TOV', 'STL', 'BLK', 'PF', 'PTS',
  'PLUS_MINUS'];

function load(dir, name) {
  const p = path.join(DATA_DIR, dir, `${name}.json`);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  if (!rs || !rs.rowSet) return [];
  return rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]])));
}

/**
 * Per-player split lines, summed across the supplied directories so a G League split covers the
 * same combined season the headline line does. Percentages are recomputed from summed totals.
 */
export function buildSplits(dirs) {
  const out = new Map();
  for (const name of SPLIT_NAMES) {
    const acc = new Map();
    for (const dir of dirs) {
      for (const r of load(dir, name)) {
        const id = r.PLAYER_ID;
        if (!id) continue;
        if (!acc.has(id)) acc.set(id, {});
        const s = acc.get(id);
        for (const f of KEEP) {
          if (f.endsWith('_PCT')) continue;
          const v = num(r[f]);
          if (v !== null) s[f] = (s[f] || 0) + v;
        }
      }
    }
    for (const [id, s] of acc) {
      if (!s.GP) continue;
      const gp = s.GP;
      const rec = {
        gp, min: s.MIN, mpg: s.MIN / gp,
        pts: s.PTS / gp, reb: s.REB / gp, ast: s.AST / gp,
        stl: s.STL / gp, blk: s.BLK / gp, tov: s.TOV / gp,
        fgPct: s.FGA ? s.FGM / s.FGA : null,
        fg3Pct: s.FG3A ? s.FG3M / s.FG3A : null,
        ftPct: s.FTA ? s.FTM / s.FTA : null,
        ts: (s.FGA || s.FTA) ? s.PTS / (2 * (s.FGA + 0.44 * s.FTA)) : null,
        plusMinus: s.PLUS_MINUS,
      };
      if (!out.has(id)) out.set(id, {});
      out.get(id)[name] = rec;
    }
  }
  return out;
}

/** Roster entries, including people who never appeared in a game. */
export function loadRoster(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Age in whole years at a reference date. */
export function ageAt(birthdate, refIso) {
  if (!birthdate) return null;
  const b = new Date(birthdate), r = new Date(refIso);
  if (Number.isNaN(b.getTime())) return null;
  let a = r.getUTCFullYear() - b.getUTCFullYear();
  const m = r.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && r.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

/** 2025-26 reference dates. Opening night is the NBA's; 1 February is Basketball-Reference's. */
export const OPENING_NIGHT = '2025-10-21';
export const FEB_FIRST = '2026-02-01';

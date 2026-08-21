// Attach REAL starter flags to gamelog rows.
//
// gamelog.json carries `started: null` for every row in every season — the field exists but was
// never populated. Anything downstream reading it (Model A's `startedOpener` and `promotedToStart`)
// has therefore been a constant zero, and the documented rationale for those features describes a
// signal that is not present in the data.
//
// starters_*.json holds the real flags and agrees with GameRotation's opening five 42/42 on the
// untouched validation games, so it is trustworthy where it exists. Coverage is partial, so the
// distinction between "did not start" and "unknown" is preserved rather than collapsed to false.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Mutates rows in place: sets `started` true/false where official data covers the team-game, and
 * leaves it null where coverage is absent. Returns coverage counts.
 */
export function attachStarterFlags(rows, HIST) {
  const startedSet = new Set(), coveredTeamGames = new Set();
  for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
    for (const slug of ['regular', 'playoffs']) {
      const f = path.join(HIST, s, `starters_${slug}.json`);
      if (!fs.existsSync(f)) continue;
      for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
        if (r.started !== true) continue;
        startedSet.add(`${r.gameId}|${r.playerId}`);
        coveredTeamGames.add(`${r.gameId}|${r.teamId}`);
      }
    }
  }
  let set = 0, unknown = 0;
  for (const r of rows) {
    if (!coveredTeamGames.has(`${r.gameId}|${r.teamId}`)) { r.started = null; unknown++; continue; }
    r.started = startedSet.has(`${r.gameId}|${r.playerId}`);
    set++;
  }
  return { set, unknown, coverage: set / (set + unknown) };
}

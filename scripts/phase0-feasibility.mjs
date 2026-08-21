// PHASE 0 — OUTCOME-BLIND FEASIBILITY AND OVERLAP AUDIT for TULIP Design A (and restricted B).
//
// HARD RULE ENFORCED IN CODE: this script must never read a post-game outcome. Margin, win/loss and
// plus/minus are stripped from every row on load, so a later edit cannot quietly reintroduce them.
// Allocation (minutes) IS permitted — the first stage is allocation-on-instrument, which the design
// explicitly allows. Nothing here touches scoring margin, wins or net rating.
//
// Purpose: decide whether Design A is even runnable BEFORE any outcome coefficient exists, and
// establish how large a reallocation the historical data can actually support. If support only
// covers small changes, TULIP V1 is a small-adjustment metric and must say so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();

// ---- shock classes, PRE-REGISTERED and never pooled to gain sample ----
// Rest/load-management is deliberately its own class: it is a strategic team decision that can
// depend on opponent, schedule density, standings and expected win probability, so it is the most
// endogenous of the four and may not be merged with suspensions or personal absences.
function shockClass(comment) {
  const c = (comment || '').toUpperCase().replace(/[_\s]+/g, ' ').trim();
  if (!c) return null;
  if (/COACH'?S DECISION/.test(c)) return 'C0_COACH_DECISION';        // endogenous: excluded from identification
  if (/SUSPEN/.test(c)) return 'C1_ADMIN';                            // league/team suspension
  if (/PERSONAL|BEREAVEMENT|FAMILY|VISA|NOT WITH TEAM/.test(c)) return 'C2_PERSONAL';
  if (/REST|RECONDITION|LOAD MANAGEMENT/.test(c)) return 'C4_TEAM_REST'; // explicitly endogenous
  if (/INJUR|ILLNESS|SORE|STRAIN|SPRAIN|PROTOCOL|SURGER|FRACTURE|CONTUSION|TIGHTNESS|SPASM|HEALTH/.test(c)) return 'C3_INJURY';
  return 'C5_OTHER';
}

// ---- load: minutes + roster presence + DNP reason. OUTCOMES STRIPPED. ----
const rows = [];            // {season, gameId, gameDate, playerId, teamId, min}
const rosterRows = [];      // {season, gameId, playerId, teamId, comment, played}
for (const s of SEASONS) {
  const gf = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(gf)) {
    for (const r of JSON.parse(fs.readFileSync(gf, 'utf8'))) {
      // strip outcomes at the boundary
      rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: r.teamId, min: r.min ?? 0 });
    }
  }
  const sf = path.join(HIST, s, 'starters_regular.json');
  if (fs.existsSync(sf)) {
    const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
    if (Array.isArray(j)) for (const r of j) {
      rosterRows.push({ season: s, gameId: r.gameId, playerId: String(r.playerId), teamId: r.teamId, comment: r.comment || '', played: !!(r.minutes && String(r.minutes) !== '0:00') });
    }
  }
}
const dateOf = new Map();
for (const r of rows) dateOf.set(r.gameId, r.gameDate);
for (const r of rosterRows) r.gameDate = dateOf.get(r.gameId) || '';

// team -> chronological game list
const teamGames = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!teamGames.has(k)) teamGames.set(k, new Map());
  teamGames.get(k).set(r.gameId, r.gameDate);
}
for (const [k, m] of teamGames) teamGames.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));

// player minutes lookup
const minOf = new Map();      // gameId|playerId -> min
for (const r of rows) minOf.set(`${r.gameId}|${r.playerId}`, r.min);

// ---- ROTATION-PLAYER definition (pre-registered): a shock only counts if the absent player was
// genuinely part of the rotation going in. Measured on the 10 team-games before the shock. ----
const PRIOR_W = 10, MIN_PRIOR_APP = 6, MIN_PRIOR_MPG = 15;

const shocks = [];
for (const [key, games] of teamGames) {
  const [season, teamId] = key.split('|');
  const idx = new Map(games.map(([g], i) => [g, i]));
  // roster rows for this team-season, by game
  const byGame = new Map();
  for (const rr of rosterRows) {
    if (rr.season !== season || String(rr.teamId) !== teamId) continue;
    if (!byGame.has(rr.gameId)) byGame.set(rr.gameId, []);
    byGame.get(rr.gameId).push(rr);
  }
  for (const [gameId] of games) {
    const i = idx.get(gameId);
    if (i < PRIOR_W) continue;                      // need a prior window
    const priorGames = games.slice(i - PRIOR_W, i).map(([g]) => g);
    for (const rr of (byGame.get(gameId) || [])) {
      if (rr.played) continue;                       // he played: not a shock
      const cls = shockClass(rr.comment);
      if (!cls || cls === 'C0_COACH_DECISION') continue;   // no reason recorded, or endogenous
      const priorMins = priorGames.map((g) => minOf.get(`${g}|${rr.playerId}`)).filter((v) => v !== undefined && v > 0);
      if (priorMins.length < MIN_PRIOR_APP) continue;
      const mpg = priorMins.reduce((a, b) => a + b, 0) / priorMins.length;
      if (mpg < MIN_PRIOR_MPG) continue;
      shocks.push({ season, teamId, gameId, gameDate: rr.gameDate, playerId: rr.playerId, cls, priorMpg: mpg, gameIdx: i });
    }
  }
}

console.log('================ PHASE 0 — OUTCOME-BLIND FEASIBILITY AUDIT ================');
console.log('No margin, win/loss or plus-minus is read anywhere in this script.\n');
console.log(`seasons: ${SEASONS.length} (${SEASONS[0]}..${SEASONS[SEASONS.length - 1]})`);
console.log(`rotation-player absence shocks (>=${MIN_PRIOR_APP}/${PRIOR_W} prior apps, >=${MIN_PRIOR_MPG} prior MPG): ${shocks.length}\n`);

console.log('--- SHOCK CLASSES (pre-registered, never pooled) ---');
const byCls = {};
for (const s of shocks) byCls[s.cls] = (byCls[s.cls] || 0) + 1;
for (const [c, n] of Object.entries(byCls).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(20)} ${String(n).padStart(6)}  (${(100 * n / shocks.length).toFixed(1)}%)`);
}
console.log('\n--- shocks per season, by class ---');
const seasonCls = {};
for (const s of shocks) { seasonCls[s.season] = seasonCls[s.season] || {}; seasonCls[s.season][s.cls] = (seasonCls[s.season][s.cls] || 0) + 1; }
const classList = Object.keys(byCls).sort();
console.log('  season    ' + classList.map((c) => c.slice(0, 11).padStart(12)).join(''));
for (const s of SEASONS) {
  if (!seasonCls[s]) continue;
  console.log('  ' + s.padEnd(10) + classList.map((c) => String(seasonCls[s][c] || 0).padStart(12)).join(''));
}

console.log('\n--- INDEPENDENCE / CONCENTRATION of the shock pool ---');
const teamsHit = new Set(shocks.map((s) => `${s.season}|${s.teamId}`));
const playersHit = new Set(shocks.map((s) => s.playerId));
const perTeamGame = new Map();
for (const s of shocks) perTeamGame.set(`${s.gameId}|${s.teamId}`, (perTeamGame.get(`${s.gameId}|${s.teamId}`) || 0) + 1);
console.log(`  distinct team-seasons with >=1 shock: ${teamsHit.size}`);
console.log(`  distinct absent players:              ${playersHit.size}`);
console.log(`  distinct shocked team-games:          ${perTeamGame.size}`);
console.log(`  team-games with multiple simultaneous absences: ${[...perTeamGame.values()].filter((v) => v > 1).length}`);
const perPlayer = new Map();
for (const s of shocks) perPlayer.set(s.playerId, (perPlayer.get(s.playerId) || 0) + 1);
const counts = [...perPlayer.values()].sort((a, b) => b - a);
const hhiP = counts.reduce((a, n) => a + (n / shocks.length) ** 2, 0);
console.log(`  shocks per absent player: median ${counts[Math.floor(counts.length / 2)]}, max ${counts[0]}`);
console.log(`  effective independent absent players (1/HHI): ${(1 / hhiP).toFixed(0)} of ${playersHit.size}`);
console.log(`  players with >=2 shocks (needed for within-player FE): ${counts.filter((n) => n >= 2).length}`);
fs.writeFileSync('/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad/shocks.json', JSON.stringify(shocks));
console.log('\n-> shocks.json written for the weights/overlap stage');

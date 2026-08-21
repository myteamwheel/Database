// Build-time production of TULIP Capacity V1 values for the current-season NBA player set.
//
// Team A = the current source season. The question answered for each player is:
//   "From this player's own history alone, what MPG would V1 expect him to sustain after an
//    OFFSEASON move to another NBA team?"
// No destination information is used — V1 is a player-portability model. (Destination-context
// variables were tested during validation and did not materially improve prediction; that is a
// statement about those features, not about whether destination fit matters.)
//
// Anything V1 cannot support returns a genuine abstention. Never a zero, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrozenCard, loadTrainingTransitions, scoreCapacity, buildFeatures } from './tulip-capacity-v1.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HIST = path.join(ROOT, 'scripts/data/history');

/**
 * @param {string} season   current source season, e.g. '2025-26'
 * @returns {{card, id, byPersonId: Map, stats: object}}
 */
export function buildCapacityIndex(season) {
  // Fails loudly if the frozen artifact is missing or altered — never silently degrade to legacy.
  const { card, id } = loadFrozenCard();
  const training = loadTrainingTransitions(card);

  const seasons = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
  const upTo = seasons.filter((s) => s <= season);
  if (!upTo.includes(season)) {
    return { card, id, byPersonId: new Map(), stats: { reason: `no gamelog for source season ${season}`, eligible: 0, scored: 0, abstained: 0 } };
  }
  // career rows (chronological) and current-season rows, per player
  const career = new Map(), current = new Map();
  for (const s of upTo) {
    const f = path.join(HIST, s, 'gamelog.json');
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const k = String(r.playerId);
      if (!career.has(k)) career.set(k, []);
      career.get(k).push(r);
      if (s === season) {
        if (!current.has(k)) current.set(k, []);
        current.get(k).push(r);
      }
    }
  }
  // Per-game starter flags. V1's aStartRate needs them; without them the player abstains rather
  // than silently scoring as if he never started.
  const started = new Set(), coveredTeamGames = new Set();
  for (const s of upTo) {
    for (const slug of ['regular', 'playoffs']) {
      const f = path.join(HIST, s, `starters_${slug}.json`);
      if (!fs.existsSync(f)) continue;
      for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
        if (r.started === true) started.add(`${r.gameId}|${r.playerId}`);
        coveredTeamGames.add(`${r.gameId}|${r.teamId}`);
      }
    }
  }
  const bydate = (a, b) => String(a.gameDate).localeCompare(String(b.gameDate));
  for (const v of career.values()) v.sort(bydate);
  for (const v of current.values()) v.sort(bydate);

  const byPersonId = new Map();
  let scored = 0, abstained = 0, noStarterCoverage = 0;
  const abstainReasons = {};
  for (const [pid, rows] of current) {
    const careerRows = career.get(pid) || [];
    // annotate started; a game-row with no starter coverage leaves `started` undefined so it is
    // visible rather than being coerced to false
    let covered = 0;
    for (const r of careerRows) {
      if (coveredTeamGames.has(`${r.gameId}|${r.teamId}`)) { r.started = started.has(`${r.gameId}|${r.playerId}`); covered++; }
      else r.started = undefined;
    }
    const last20 = careerRows.slice(-20);
    const last20Covered = last20.filter((r) => r.started !== undefined).length;
    if (last20Covered < last20.length) { noStarterCoverage++; }
    const feats = buildFeatures(rows, careerRows, {});
    if (!feats) { abstained++; abstainReasons.no_rows = (abstainReasons.no_rows || 0) + 1; continue; }
    // aStartRate is only trustworthy when the whole 20-game window is covered.
    if (last20Covered < last20.length) feats.aStartRate = NaN;
    byPersonId.set(pid, { feats, careerGames: careerRows.length });
  }
  return { card, id, byPersonId, training,
    stats: { season, players: current.size, starterGaps: noStarterCoverage, scored, abstained, abstainReasons } };
}

/** Score one player record from the site dataset. */
export function capacityForRecord(rec, idx) {
  const pid = String(rec.nbaPersonId ?? rec.playerId ?? '');
  const entry = idx.byPersonId.get(pid);
  if (!entry) return { abstain: true, reason: 'no_game_log_for_source_season', version: idx.card.version };
  const draftNum = Number(rec.draftNumber);
  const feats = {
    ...entry.feats,
    age: Number.isFinite(Number(rec.ageOpeningNight)) ? Number(rec.ageOpeningNight)
      : Number.isFinite(Number(rec.age)) ? Number(rec.age) : undefined,
    heightIn: Number.isFinite(Number(rec.heightInches)) ? Number(rec.heightInches) : undefined,
    weight: Number.isFinite(Number(rec.weight)) ? Number(rec.weight) : undefined,
    draftPick: Number.isFinite(draftNum) && draftNum > 0 ? draftNum : 61,
    undrafted: Number.isFinite(draftNum) && draftNum > 0 ? 0 : 1,
  };
  const out = scoreCapacity(feats, { card: idx.card, training: idx.training, inSeason: false });
  return { ...out, version: idx.card.version };
}

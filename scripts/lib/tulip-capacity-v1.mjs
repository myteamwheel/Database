// TULIP CAPACITY V1 — canonical scorer.
//
// This module is the ONLY sanctioned way to produce a TULIP Capacity value for the product. It reads
// the frozen specification from TULIP_CAPACITY_V1.json rather than re-implementing or approximating
// it, and it refuses to run if that card does not match the frozen identifier. The model is
// immutable: input player data may change between builds, V1 may not.
//
//   frozen id: card-sha256:96cb2f34c6cd06c3
//
// WHAT IT PREDICTS. Expected sustainable MPG after an OFFSEASON team change, from the player's
// previous-team history only. Predictive, not causal. Not a physiological ceiling, not a
// recommendation, and NOT validated for in-season trades.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CARD_PATH = path.join(ROOT, 'TULIP_CAPACITY_V1.json');
const ID_PATH = path.join(ROOT, 'TULIP_CAPACITY_V1.id');
const TRANSITIONS_PATH = path.join(ROOT, 'scripts/data/history/transitions.json');

/**
 * Load and VERIFY the frozen card. Throws loudly on any mismatch — the build must never silently
 * fall back to a legacy formulation or to an unverified card.
 */
export function loadFrozenCard() {
  if (!fs.existsSync(CARD_PATH)) throw new Error(`TULIP V1 card missing at ${CARD_PATH} — refusing to build`);
  if (!fs.existsSync(ID_PATH)) throw new Error(`TULIP V1 id file missing at ${ID_PATH} — refusing to build`);
  const card = JSON.parse(fs.readFileSync(CARD_PATH, 'utf8'));
  // The id records a hash of the COMPACT serialization, not the pretty-printed file on disk.
  const recomputed = crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16);
  const expected = (fs.readFileSync(ID_PATH, 'utf8').match(/card-sha256:([0-9a-f]+)/) || [])[1];
  if (!expected) throw new Error('TULIP V1 id file is unreadable — refusing to build');
  if (recomputed !== expected) {
    throw new Error(`TULIP V1 CARD HASH MISMATCH — expected ${expected}, recomputed ${recomputed}. `
      + 'The frozen model has been altered. Refusing to build. Do NOT regenerate the card to make this pass.');
  }
  return { card, id: expected };
}

/** Support counts come from the exact training set the card was frozen against. */
export function loadTrainingTransitions(card) {
  if (!fs.existsSync(TRANSITIONS_PATH)) throw new Error('transitions.json missing — cannot compute evidence support');
  const buf = fs.readFileSync(TRANSITIONS_PATH);
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const expected = card.sourceHashes?.['transitions.json'];
  if (expected && h !== expected) {
    throw new Error(`transitions.json hash mismatch — expected ${expected}, got ${h}. Evidence counts would not match V1.`);
  }
  return JSON.parse(buf.toString('utf8'));
}

/**
 * Score one candidate. Returns an ABSTENTION rather than a number whenever the card's eligibility or
 * input requirements are not met — never a zero, never a guess.
 *
 * @param {object} f  feature bag using the card's own feature names
 * @param {object} ctx {card, training, inSeason}
 */
export function scoreCapacity(f, { card, training, inSeason = false }) {
  const M = card.productionModel;
  const FE = card.features;

  // Eligibility: the card requires >=20 games of Team A history.
  if (!Number.isFinite(f.aGames) || f.aGames < 20) {
    return { abstain: true, reason: 'insufficient_team_a_history', minGamesRequired: 20, gamesAvailable: f.aGames ?? null };
  }
  // Workload features are REQUIRED. The card's missing-data rule covers attributes only
  // (age/height/weight/draft); it does not permit defaulting workload inputs.
  const REQUIRED = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aTrend', 'aStartRate', 'aGames', 'aSeasons', 'aCareerHighMpg'];
  const missing = REQUIRED.filter((k) => !Number.isFinite(f[k]));
  if (missing.length) return { abstain: true, reason: 'missing_required_workload_inputs', missing };

  // Attribute defaults, exactly as the card specifies.
  const withDefaults = {
    ...f,
    age: Number.isFinite(f.age) ? f.age : 26,
    heightIn: Number.isFinite(f.heightIn) ? f.heightIn : 78,
    weight: Number.isFinite(f.weight) ? f.weight : 210,
    draftPick: Number.isFinite(f.draftPick) ? f.draftPick : 61,
    undrafted: Number.isFinite(f.undrafted) ? f.undrafted : 1,
  };
  for (const k of ['aGsPer36', 'aTs', 'aFgaPer36', 'aAstPer36', 'aRebPer36', 'aPfPer36']) {
    if (!Number.isFinite(withDefaults[k])) return { abstain: true, reason: 'missing_required_production_inputs', missing: [k] };
  }

  // z-score with the FROZEN training mean/sd, then apply frozen coefficients.
  let capacity = M.intercept;
  for (const k of FE) {
    const s = M.standardization[k];
    capacity += M.coefficients[k] * (((withDefaults[k] ?? 0) - s.mean) / s.sd);
  }

  const q = M.residualQuantiles;
  const support = training.filter((t) => Math.abs(t.aSeasonMpg - f.aSeasonMpg) <= 3).length;
  const th = card.evidenceGrade.thresholds;
  const grade = support >= 300 ? 'A' : support >= 150 ? 'B' : support >= 60 ? 'C' : 'D';

  return {
    abstain: false,
    version: card.version,
    capacityMpg: round1(capacity),
    teamASeasonMpg: round1(f.aSeasonMpg),
    headroom: round1(capacity - f.aSeasonMpg),
    interval50Low: round1(capacity + q.q25),
    interval50High: round1(capacity + q.q75),
    interval80Low: round1(capacity + q.q10),
    interval80High: round1(capacity + q.q90),
    supportCount: support,
    // The letter is a readability aid. The raw count travels with it everywhere.
    evidenceGrade: inSeason ? null : grade,
    evidenceNote: inSeason
      ? 'Incremental TULIP evidence: Unproven — Team A season MPG baseline recommended'
      : `${grade} · ${support} comparable transitions`,
    scope: inSeason ? 'in_season_unvalidated' : 'offseason_acquisition',
    scopeLabel: inSeason ? 'Not validated for in-season trades' : 'Validated: Offseason acquisition',
  };
}
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * Build V1 features from a player's chronological game rows on his current (Team A) season, plus
 * career history and attributes. Mirrors portability-study.mjs exactly.
 *
 * @param {Array} seasonRows  current-season rows, chronological, one per game
 * @param {Array} careerRows  ALL rows up to and including the season, chronological
 */
export function buildFeatures(seasonRows, careerRows, attrs) {
  if (!seasonRows?.length || !careerRows?.length) return null;
  const mins = (r) => r.min ?? 0;
  const last20 = careerRows.slice(-20), last10 = careerRows.slice(-10), last5 = careerRows.slice(-5);
  const prev10 = careerRows.slice(-15, -5);
  const m20 = last20.reduce((a, r) => a + mins(r), 0);
  const bySeason = new Map();
  for (const r of careerRows) { const v = bySeason.get(r.season) || [0, 0]; v[0] += mins(r); v[1]++; bySeason.set(r.season, v); }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const gsSum = (k) => last20.reduce((a, r) => a + (r[k] ?? 0), 0);
  const gameScore = (r) => r.pts + 0.4 * r.fgm - 0.7 * r.fga - 0.4 * (r.fta - r.ftm) + 0.7 * r.oreb
    + 0.3 * r.dreb + r.stl + 0.7 * r.ast + 0.7 * r.blk - 0.4 * r.pf - r.tov;
  const fga = gsSum('fga'), fta = gsSum('fta'), pts = gsSum('pts');
  return {
    aSeasonMpg: avg(seasonRows.map(mins)),
    aRecent10: avg(last10.map(mins)),
    aRecent5: avg(last5.map(mins)),
    aTrend: (avg(last5.map(mins)) ?? 0) - (avg(prev10.map(mins)) ?? 0),
    aStartRate: avg(last20.map((r) => (r.started ? 1 : 0))),
    aGames: careerRows.length,
    aSeasons: bySeason.size,
    aCareerHighMpg: Math.max(...[...bySeason.values()].map(([mm, n]) => (n >= 10 ? mm / n : 0)), 0),
    aGsPer36: m20 > 0 ? 36 * last20.reduce((a, r) => a + (gameScore(r) ?? 0), 0) / m20 : null,
    aTs: fga + 0.44 * fta > 0 ? pts / (2 * (fga + 0.44 * fta)) : null,
    aFgaPer36: m20 > 0 ? 36 * fga / m20 : null,
    aAstPer36: m20 > 0 ? 36 * gsSum('ast') / m20 : null,
    aRebPer36: m20 > 0 ? 36 * gsSum('reb') / m20 : null,
    aPfPer36: m20 > 0 ? 36 * gsSum('pf') / m20 : null,
    ...attrs,
  };
}

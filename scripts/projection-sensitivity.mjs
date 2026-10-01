import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RATE_STATS,
  PCT_STATS,
  prepare,
  seasonPriors,
  projectRates,
  applyTeamContext,
} from './lib/projection.mjs';
import { reconcileMinutes } from './lib/projection-context.mjs';
import { projectionRoleLabel } from './build-projections.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = path.join(ROOT, 'scripts/data/projection/inputs.json');
const CARD = path.join(ROOT, 'PROJECTION_2026_27.json');
const DATA = path.join(ROOT, 'public/data.json');

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : value;

function scaledRecord(row, factor) {
  const out = { ...row };
  const keys = new Set([...RATE_STATS, ...Object.values(PCT_STATS).flat(), 'pts']);
  for (const key of keys) if (Number.isFinite(row[key])) out[key] = row[key] * factor;
  if (Number.isFinite(row.poss)) out.poss = row.poss * factor;
  if (Number.isFinite(row.min)) out.min = row.min * factor;
  return out;
}

function sampleSizeProbe(inputs, card) {
  const D = prepare(inputs);
  const season = D.nba.seasons.get('2025-26');
  const priors = seasonPriors(season, D.bio);
  const row = [...season.values()].filter((r) => r.poss > 100 && D.bio.has(r.pid)).sort((a, b) => a.pid - b.pid)[0];
  if (!row) throw new Error('No supported NBA record for sample-size sensitivity probe.');
  const low = projectRates([scaledRecord(row, 0.25), null, null], '2026-27', D.bio.get(row.pid), priors, card.nba.params, null);
  const high = projectRates([scaledRecord(row, 4), null, null], '2026-27', D.bio.get(row.pid), priors, card.nba.params, null);
  return {
    playerId: row.pid,
    lowPossessions: round(low.basePoss),
    highPossessions: round(high.basePoss),
    astOwnWeightLow: round(low.pieces.ast.weightOnOwn),
    astOwnWeightHigh: round(high.pieces.ast.weightOnOwn),
    fgaOwnWeightLow: round(low.pieces.fga.weightOnOwn),
    fgaOwnWeightHigh: round(high.pieces.fga.weightOnOwn),
  };
}

function contextRow({ moved = false, mpg = 30, mpgLast = 30 } = {}) {
  return {
    pr: {
      rate: { fga: 24, fg3a: 8, fta: 6, oreb: 1, dreb: 5, ast: 7, stl: 1, blk: 0.5, tov: 3, pf: 2 },
      pct: { fg2: 0.52, fg3: 0.36, ft: 0.8 },
    },
    mpg,
    games: 70,
    share: 1,
    mpgLast,
    moved,
  };
}

function teamContextProbe(card) {
  const P = { team: clone(card.nba.params.team) };
  const priors = { playsPer100: 20, ftValue: 1 };
  const full = [contextRow({ moved: true }), contextRow()];
  const noUsage = clone(full);
  const noMoved = clone(full);
  const noRole = clone(full);
  applyTeamContext(full, priors, 100, P);
  applyTeamContext(noUsage, priors, 100, P, { noUsage: true });
  applyTeamContext(noMoved, priors, 100, P, { noMoved: true });
  applyTeamContext(noRole, priors, 100, P, { noRole: true });
  return {
    parameters: clone(P.team),
    rosterBalance: round(full[0].factors.rosterBalance),
    usageFactor: round(full[0].factors.usage),
    movedFactor: round(full[0].factors.newTeam),
    roleFactor: round(full[0].factors.roleShift),
    points: {
      full: round(full[0].line.pts),
      noUsage: round(noUsage[0].line.pts),
      noMoved: round(noMoved[0].line.pts),
      noRole: round(noRole[0].line.pts),
    },
  };
}

function roleDemandProbe() {
  const mk = (mpg = 30) => ({ mpg, share: 1, pr: { baseMin: 900 } });
  const base = Array.from({ length: 8 }, () => mk());
  reconcileMinutes(base, 240);
  const raised = Array.from({ length: 8 }, () => mk());
  raised[0].mpg += 1;
  reconcileMinutes(raised, 240);
  return {
    targetBase: round(base[0].effectiveMpg),
    targetRaised: round(raised[0].effectiveMpg),
    teammatesBase: round(base.slice(1).reduce((sum, row) => sum + row.effectiveMpg, 0)),
    teammatesRaised: round(raised.slice(1).reduce((sum, row) => sum + row.effectiveMpg, 0)),
    raisedTotal: round(raised.reduce((sum, row) => sum + row.effectiveMpg, 0)),
  };
}

function availabilityProbe() {
  const mk = (share = 1) => ({ mpg: 30, share, pr: { baseMin: 900 } });
  const base = Array.from({ length: 8 }, () => mk());
  reconcileMinutes(base, 240);
  const reduced = Array.from({ length: 8 }, () => mk());
  reduced[0].share = 0.5;
  reconcileMinutes(reduced, 240);
  return {
    targetEffectiveBase: round(base[0].effectiveMpg),
    targetEffectiveReduced: round(reduced[0].effectiveMpg),
    teammateEffectiveBase: round(base.slice(1).reduce((sum, row) => sum + row.effectiveMpg, 0)),
    teammateEffectiveReduced: round(reduced.slice(1).reduce((sum, row) => sum + row.effectiveMpg, 0)),
    baseTotal: round(base.reduce((sum, row) => sum + row.effectiveMpg, 0)),
    reducedTotal: round(reduced.reduce((sum, row) => sum + row.effectiveMpg, 0)),
  };
}

function thresholdProbe(data) {
  const thresholds = [10, 18, 28];
  const projected = data.leagues.NBA.filter((p) => p.proj && !p.proj.abstain && Number.isFinite(p.proj.mpg));
  const exposure = Object.fromEntries(thresholds.map((threshold) => [String(threshold), {
    within025: projected.filter((p) => Math.abs(p.proj.mpg - threshold) <= 0.25).length,
    within050: projected.filter((p) => Math.abs(p.proj.mpg - threshold) <= 0.5).length,
    within100: projected.filter((p) => Math.abs(p.proj.mpg - threshold) <= 1).length,
    below: projectionRoleLabel(threshold - 0.01),
    at: projectionRoleLabel(threshold),
  }]));
  return { thresholds, projectedPlayers: projected.length, exposure };
}

function ablationSummary(card) {
  const full = card.backtest?.nba?.all?.mae;
  const ablation = card.backtest?.nba?.ablation;
  if (!full || !ablation) throw new Error('Frozen card is missing held-out ablation evidence.');
  const metrics = ['pts', 'mpg', 'reb', 'ast'];
  const out = {};
  for (const [name, row] of Object.entries(ablation)) {
    out[name] = {};
    for (const metric of metrics) {
      const baseline = full[metric]?.model;
      const value = row[metric];
      out[name][metric] = { mae: value, deltaVsFull: round(value - baseline) };
    }
  }
  return out;
}

export function buildSensitivityReport({ inputs, card, data }) {
  const report = {
    schemaVersion: 1,
    modelId: card.id,
    season: data.projectionMeta?.season || '2026-27',
    note: 'Engineering sensitivity evidence only. Controlled perturbations and held-out ablations describe model behavior; they do not establish causal effects or future-season accuracy.',
    controlled: {
      teamContext: teamContextProbe(card),
      roleDemand: roleDemandProbe(),
      availability: availabilityProbe(),
      sampleSize: sampleSizeProbe(inputs, card),
      thresholds: thresholdProbe(data),
    },
    heldoutAblation: ablationSummary(card),
  };
  report.observations = {
    roleRateDriverActive: Number(card.nba.params.team.roleGamma || 0) !== 0,
    roleRateDriverNote: Number(card.nba.params.team.roleGamma || 0) === 0
      ? 'Frozen roleGamma is 0, so the team-context rate role-shift multiplier is intentionally inactive; role still affects projected minutes through the role model and reconciliation.'
      : 'Frozen roleGamma is non-zero; role shifts affect usage-rate context.',
    actualAvailabilityVerified: false,
    actualAvailabilityNote: 'The production availability basis is historical appearance rate; current injury/availability inputs are not verified by this test.',
  };
  return report;
}

export function loadSensitivityReport() {
  return buildSensitivityReport({
    inputs: JSON.parse(fs.readFileSync(INPUTS, 'utf8')),
    card: JSON.parse(fs.readFileSync(CARD, 'utf8')),
    data: JSON.parse(fs.readFileSync(DATA, 'utf8')),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(loadSensitivityReport(), null, 2) + '\n');
}

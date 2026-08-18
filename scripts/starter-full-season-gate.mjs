// Exhaustive acceptance gate for historical NBA per-game starter status.
//
// This is intentionally fail-closed. A stratified sample can discover defects but cannot certify
// a season. This gate evaluates every unique regular-season and playoff game in the hydrated
// historical cache. It accepts a phase only when every box score is present, every team-game has
// exactly five START_POSITION players, and observed counts reconcile exactly to the local game
// logs. Regular Season also reconciles starter edges against the independently fetched
// leaguedashplayerstats StarterBench=Starters split.
//
// The gate does NOT infer starters from minutes and does NOT write starter assignments into the
// game logs. Its output is evidence that a later ingest may consume only after verifying the same
// season and source contract.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateGame } from './probe-starter-source.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const GATE_SCHEMA_VERSION = 1;
const SOURCE_VERSION = 'boxscoretraditionalv2 / START_POSITION';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(file) {
  const b = fs.readFileSync(file);
  return { bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} missing: ${path.relative(ROOT, file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function phaseInput(season, seasonType) {
  const file = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
  const rows = readJson(file, `${season} ${seasonType} game log`);
  const games = new Map();
  for (const row of rows) {
    if (!row.gameId || !row.teamId) throw new Error(`${season} ${seasonType}: row missing gameId/teamId`);
    if (!games.has(row.gameId)) games.set(row.gameId, new Set());
    games.get(row.gameId).add(String(row.teamId));
  }
  const malformedLocalGames = [...games.entries()]
    .filter(([, teams]) => teams.size !== 2)
    .map(([gameId, teams]) => ({ gameId, localTeams: teams.size }));
  return {
    file,
    rows,
    gameIds: [...games.keys()].sort(),
    expectedTeamGames: [...games.values()].reduce((n, teams) => n + teams.size, 0),
    malformedLocalGames,
    fingerprint: sha256File(file),
  };
}

function starterSplitExpectation(season) {
  const file = path.join(HIST, season, 'starter_splits.json');
  const split = readJson(file, `${season} starter split`);
  if (!Array.isArray(split.starters)) throw new Error(`${season}: starter_splits.json lacks starters[]`);
  let starts = 0;
  for (const row of split.starters) {
    const gp = Number(row.gp);
    if (!Number.isFinite(gp) || gp < 0) throw new Error(`${season}: invalid starter GP for player ${row.playerId}`);
    starts += gp;
  }
  return { file, starterRows: split.starters.length, expectedStarterEdges: starts, fingerprint: sha256File(file) };
}

async function evaluatePhase(season, seasonType, delayMs) {
  const input = phaseInput(season, seasonType);
  const failures = [];
  let evaluatedGames = 0;
  let observedTeamGames = 0;
  let validTeamGames = 0;
  let invalidTeamGames = 0;
  let missingBoxScores = 0;
  let starterEdges = 0;

  for (const gameId of input.gameIds) {
    const result = await evaluateGame(gameId);
    evaluatedGames++;
    if (result.status === 'MISSING') {
      missingBoxScores++;
      failures.push({ gameId, kind: 'MISSING_BOX_SCORE', error: result.error || null });
    } else {
      observedTeamGames += result.teams.length;
      for (const team of result.teams) {
        starterEdges += team.starters;
        if (team.status === 'VALID') validTeamGames++;
        else {
          invalidTeamGames++;
          failures.push({ gameId, team: team.team, kind: 'INVALID_STARTER_COUNT', starters: team.starters });
        }
      }
      if (result.teams.length !== 2) failures.push({ gameId, kind: 'BOX_SCORE_TEAM_COUNT', teams: result.teams.length });
    }
    if (delayMs > 0) await wait(delayMs);
    if (evaluatedGames % 100 === 0 || evaluatedGames === input.gameIds.length) {
      console.log(`  ${season} ${seasonType}: ${evaluatedGames}/${input.gameIds.length} games`);
    }
  }

  const reconciliations = {
    games: { expected: input.gameIds.length, observed: evaluatedGames, pass: evaluatedGames === input.gameIds.length },
    teamGames: { expected: input.expectedTeamGames, observed: observedTeamGames, pass: observedTeamGames === input.expectedTeamGames },
    localTwoTeamGames: { failures: input.malformedLocalGames.length, pass: input.malformedLocalGames.length === 0 },
    allTeamGamesValid: { valid: validTeamGames, invalid: invalidTeamGames, pass: invalidTeamGames === 0 },
    sourceCompleteness: { missingBoxScores, pass: missingBoxScores === 0 },
  };

  if (seasonType === 'Regular Season') {
    const split = starterSplitExpectation(season);
    reconciliations.starterSplit = {
      expectedStarterEdges: split.expectedStarterEdges,
      observedStarterEdges: starterEdges,
      starterRows: split.starterRows,
      pass: split.expectedStarterEdges === starterEdges,
      input: { path: path.relative(ROOT, split.file), ...split.fingerprint },
    };
  }

  const accepted = Object.values(reconciliations).every((r) => r.pass === true);
  return {
    seasonType,
    accepted,
    input: { path: path.relative(ROOT, input.file), ...input.fingerprint },
    counts: {
      games: input.gameIds.length,
      evaluatedGames,
      expectedTeamGames: input.expectedTeamGames,
      observedTeamGames,
      validTeamGames,
      invalidTeamGames,
      missingBoxScores,
      starterEdges,
    },
    reconciliations,
    failures: failures.slice(0, 100),
    failureCount: failures.length + input.malformedLocalGames.length,
    localMalformedExamples: input.malformedLocalGames.slice(0, 20),
  };
}

const season = process.argv[2];
if (!season) {
  console.error('usage: node scripts/starter-full-season-gate.mjs <season> [delayMs]');
  process.exit(2);
}
const delayMs = Number(process.argv[3] ?? 1250);
if (!Number.isFinite(delayMs) || delayMs < 0) {
  console.error('delayMs must be a non-negative number');
  process.exit(2);
}

const provenance = readJson(path.join(HIST, 'provenance.json'), 'history provenance');
if (!Array.isArray(provenance.seasons) || !provenance.seasons.includes(season)) {
  throw new Error(`${season} is not present in scripts/data/history/provenance.json`);
}

console.log(`Exhaustive starter acceptance gate: ${season}`);
const phases = [];
for (const seasonType of ['Regular Season', 'Playoffs']) {
  phases.push(await evaluatePhase(season, seasonType, delayMs));
}

const accepted = phases.every((p) => p.accepted);
const scriptFile = fileURLToPath(import.meta.url);
const checkerFile = path.join(ROOT, 'scripts/probe-starter-source.mjs');
const output = {
  schemaVersion: GATE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  season,
  accepted,
  acceptanceRule: 'Every historical game must be evaluated; every box score must exist; every game must expose exactly two teams; every team-game must expose exactly five START_POSITION players; observed game/team-game counts must exactly reconcile to the hydrated local game logs; Regular Season starter edges must also exactly reconcile to the independent StarterBench=Starters season split.',
  sourceVersion: SOURCE_VERSION,
  implementation: {
    gate: { path: path.relative(ROOT, scriptFile), ...sha256File(scriptFile) },
    checker: { path: path.relative(ROOT, checkerFile), ...sha256File(checkerFile) },
  },
  phases,
};

const outFile = path.join(HIST, `starter_acceptance_${season}.json`);
fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`\n${accepted ? 'ACCEPTED' : 'REJECTED'} -> ${path.relative(ROOT, outFile)}`);
if (!accepted) process.exitCode = 1;

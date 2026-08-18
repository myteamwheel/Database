// Exhaustive acceptance gate for historical NBA per-game starter status.
//
// This is intentionally fail-closed. A stratified sample can discover defects but cannot certify
// a season. This gate evaluates every unique regular-season and playoff game in the hydrated
// historical cache. It accepts a phase only when every box score is present, every team-game has
// exactly five distinct START_POSITION players, source team identities match the local game log,
// every flagged starter belongs to that local team-game roster, and observed counts reconcile
// exactly to the local game logs. Regular Season also reconciles starter edges against the
// independently fetched leaguedashplayerstats StarterBench=Starters split.
//
// The gate NEVER infers starters from minutes. Only after the entire season is accepted does it
// write the exact validated starter identities fetched during this crawl, bound to the same input
// and implementation fingerprints. A rejected run removes any stale assignment artifact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateGame } from './probe-starter-source.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const GATE_SCHEMA_VERSION = 2;
const ASSIGNMENT_SCHEMA_VERSION = 1;
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

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function phaseInput(season, seasonType) {
  const file = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
  const rows = readJson(file, `${season} ${seasonType} game log`);
  const games = new Map();
  const rosters = new Map();
  for (const row of rows) {
    if (!row.gameId || !row.teamId || !row.playerId) {
      throw new Error(`${season} ${seasonType}: row missing gameId/teamId/playerId`);
    }
    const gameId = String(row.gameId);
    const teamId = String(row.teamId);
    const playerId = String(row.playerId);
    if (!games.has(gameId)) games.set(gameId, new Set());
    games.get(gameId).add(teamId);
    const key = `${gameId}|${teamId}`;
    if (!rosters.has(key)) rosters.set(key, new Set());
    rosters.get(key).add(playerId);
  }
  const malformedLocalGames = [...games.entries()]
    .filter(([, teams]) => teams.size !== 2)
    .map(([gameId, teams]) => ({ gameId, localTeams: teams.size }));
  return {
    file,
    rows,
    games,
    rosters,
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
  const assignments = [];
  let evaluatedGames = 0;
  let observedTeamGames = 0;
  let validTeamGames = 0;
  let invalidTeamGames = 0;
  let missingBoxScores = 0;
  let starterEdges = 0;
  let teamIdentityMismatches = 0;
  let starterMembershipMismatches = 0;

  for (const gameId of input.gameIds) {
    const result = await evaluateGame(gameId);
    evaluatedGames++;
    if (result.status === 'MISSING') {
      missingBoxScores++;
      failures.push({ gameId, kind: 'MISSING_BOX_SCORE', error: result.error || null });
    } else {
      observedTeamGames += result.teams.length;
      const localTeams = input.games.get(gameId) || new Set();
      const sourceTeams = new Set(result.teams.map((team) => String(team.teamId)));
      if (!sameSet(localTeams, sourceTeams)) {
        teamIdentityMismatches++;
        failures.push({
          gameId,
          kind: 'TEAM_IDENTITY_MISMATCH',
          localTeamIds: [...localTeams].sort(),
          sourceTeamIds: [...sourceTeams].sort(),
        });
      }

      for (const team of result.teams) {
        starterEdges += team.starters;
        if (team.status === 'VALID') validTeamGames++;
        else {
          invalidTeamGames++;
          failures.push({ gameId, team: team.team, teamId: team.teamId, kind: 'INVALID_STARTER_COUNT_OR_IDENTITY', starters: team.starters });
        }

        const localRoster = input.rosters.get(`${gameId}|${team.teamId}`) || new Set();
        const missingStarters = team.starterPlayerIds.filter((playerId) => !localRoster.has(String(playerId)));
        if (missingStarters.length) {
          starterMembershipMismatches += missingStarters.length;
          failures.push({
            gameId,
            team: team.team,
            teamId: team.teamId,
            kind: 'STARTER_NOT_IN_LOCAL_TEAM_GAME',
            playerIds: missingStarters,
          });
        }

        assignments.push({
          seasonType,
          gameId,
          teamId: String(team.teamId),
          team: team.team,
          starterPlayerIds: [...team.starterPlayerIds].map(String).sort(),
        });
      }
      if (result.teams.length !== 2) failures.push({ gameId, kind: 'BOX_SCORE_TEAM_COUNT', teams: result.teams.length });
    }
    if (delayMs > 0) await wait(delayMs);
    if (evaluatedGames % 100 === 0 || evaluatedGames === input.gameIds.length) {
      console.log(`  ${season} ${seasonType}: ${evaluatedGames}/${input.gameIds.length} games`);
    }
  }

  const assignmentEdges = assignments.reduce((n, row) => n + row.starterPlayerIds.length, 0);
  const reconciliations = {
    games: { expected: input.gameIds.length, observed: evaluatedGames, pass: evaluatedGames === input.gameIds.length },
    teamGames: { expected: input.expectedTeamGames, observed: observedTeamGames, pass: observedTeamGames === input.expectedTeamGames },
    localTwoTeamGames: { failures: input.malformedLocalGames.length, pass: input.malformedLocalGames.length === 0 },
    sourceTeamIdentity: { mismatchedGames: teamIdentityMismatches, pass: teamIdentityMismatches === 0 },
    allTeamGamesValid: { valid: validTeamGames, invalid: invalidTeamGames, pass: invalidTeamGames === 0 },
    starterMembership: { mismatchedStarterEdges: starterMembershipMismatches, pass: starterMembershipMismatches === 0 },
    sourceCompleteness: { missingBoxScores, pass: missingBoxScores === 0 },
    assignmentCapture: {
      expectedTeamGames: input.expectedTeamGames,
      observedTeamGames: assignments.length,
      expectedStarterEdges: input.expectedTeamGames * 5,
      observedStarterEdges: assignmentEdges,
      pass: assignments.length === input.expectedTeamGames && assignmentEdges === input.expectedTeamGames * 5,
    },
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
      assignmentTeamGames: assignments.length,
      assignmentStarterEdges: assignmentEdges,
    },
    reconciliations,
    failures: failures.slice(0, 100),
    failureCount: failures.length + input.malformedLocalGames.length,
    localMalformedExamples: input.malformedLocalGames.slice(0, 20),
    assignments,
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
const phaseRuns = [];
for (const seasonType of ['Regular Season', 'Playoffs']) {
  phaseRuns.push(await evaluatePhase(season, seasonType, delayMs));
}

const accepted = phaseRuns.every((p) => p.accepted);
const scriptFile = fileURLToPath(import.meta.url);
const checkerFile = path.join(ROOT, 'scripts/probe-starter-source.mjs');
const implementation = {
  gate: { path: path.relative(ROOT, scriptFile), ...sha256File(scriptFile) },
  checker: { path: path.relative(ROOT, checkerFile), ...sha256File(checkerFile) },
};
const phases = phaseRuns.map(({ assignments, ...summary }) => summary);
const assignmentFile = path.join(HIST, `starter_assignments_${season}.json`);
let assignmentArtifact = null;

if (accepted) {
  const assignmentRows = phaseRuns.flatMap((p) => p.assignments);
  const assignmentEdges = assignmentRows.reduce((n, row) => n + row.starterPlayerIds.length, 0);
  const assignmentOutput = {
    schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    season,
    sourceVersion: SOURCE_VERSION,
    rule: 'Exact START_POSITION identities captured during the exhaustive accepted source gate. No starter is inferred from minutes. Consumers must verify this file fingerprint against the acceptance record before use.',
    implementation,
    inputs: phases.map((phase) => ({
      seasonType: phase.seasonType,
      gameLog: phase.input,
      starterSplit: phase.reconciliations.starterSplit?.input || null,
    })),
    counts: { teamGames: assignmentRows.length, starterEdges: assignmentEdges },
    assignments: assignmentRows,
  };
  fs.writeFileSync(assignmentFile, JSON.stringify(assignmentOutput, null, 2));
  assignmentArtifact = {
    path: path.relative(ROOT, assignmentFile),
    ...sha256File(assignmentFile),
    teamGames: assignmentRows.length,
    starterEdges: assignmentEdges,
  };
} else if (fs.existsSync(assignmentFile)) {
  fs.unlinkSync(assignmentFile);
}

const output = {
  schemaVersion: GATE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  season,
  accepted,
  acceptanceRule: 'Every historical game must be evaluated; every box score must exist; every game must expose exactly the two local team IDs; every team-game must expose exactly five distinct START_POSITION player IDs; every starter ID must belong to that local team-game roster; observed game/team-game/assignment counts must exactly reconcile to the hydrated local game logs; Regular Season starter edges must also exactly reconcile to the independent StarterBench=Starters season split.',
  sourceVersion: SOURCE_VERSION,
  implementation,
  starterAssignments: assignmentArtifact,
  phases,
};

const outFile = path.join(HIST, `starter_acceptance_${season}.json`);
fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`\n${accepted ? 'ACCEPTED' : 'REJECTED'} -> ${path.relative(ROOT, outFile)}`);
if (assignmentArtifact) console.log(`validated assignments -> ${assignmentArtifact.path}`);
if (!accepted) process.exitCode = 1;

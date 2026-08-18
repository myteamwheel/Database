// Build a compact historical player-season index from the local 2015-16..2024-25 game-log cache.
//
// This is product-facing history, not TULIP Forecast training data. It deliberately aggregates
// regular season and playoffs separately and carries starter coverage/provenance so unknown
// starter rows never become inferred bench games.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const OUT = path.join(HIST, 'player_season_summary.json');
const PRODUCT_OUT = path.join(HIST, 'player_history_product.json');
const starterFile = path.join(HIST, 'starters/player_game_starters.json');
const provenanceFile = path.join(HIST, 'provenance.json');

const prov = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
const seasons = prov.seasons;
const GENERATED_AT = process.env.BUILD_GENERATED_AT || new Date().toISOString();

const starterByKey = new Map();
let starterSchemaVersion = null;
let starterCoveragePhases = [];
if (fs.existsSync(starterFile)) {
  const s = JSON.parse(fs.readFileSync(starterFile, 'utf8'));
  starterSchemaVersion = s.schemaVersion ?? null;
  starterCoveragePhases = Array.isArray(s.scope?.seasonPhases) ? [...s.scope.seasonPhases].sort() : [];
  if (s.onUnknownSchemaVersion === 'FAIL_CLOSED' && starterSchemaVersion !== 1) {
    throw new Error(`unsupported starter artifact schemaVersion ${starterSchemaVersion}`);
  }
  const schema = s.schema || [];
  const ix = Object.fromEntries(schema.map((k, i) => [k, i]));
  for (const row of s.rows || []) {
    const k = `${row[ix.gameId]}|${row[ix.playerId]}|${row[ix.teamId]}`;
    starterByKey.set(k, {
      starter: row[ix.starter],
      source: row[ix.starterSource],
      validation: row[ix.starterValidation],
      evidence: row[ix.starterEvidence],
    });
  }
}

const pct = (m, a) => a ? m / a : null;
const div = (a, b) => b ? a / b : null;
const round = (v, d = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d));

function aggregate(rows, season, seasonType) {
  const byPlayer = new Map();
  for (const r of rows) {
    const id = Number(r.playerId);
    if (!byPlayer.has(id)) byPlayer.set(id, {
      season, seasonType, playerId: id, name: r.playerName,
      teams: new Map(), gp: 0, min: 0, pts: 0, reb: 0, oreb: 0, dreb: 0, ast: 0,
      stl: 0, blk: 0, tov: 0, pf: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0,
      plusMinus: 0, wins: 0,
      starterKnownAppearances: 0, starts: 0,
      starterSources: new Map(), firstGameDate: r.gameDate, lastGameDate: r.gameDate,
    });
    const p = byPlayer.get(id);
    p.name = r.playerName || p.name;
    p.gp++;
    p.min += Number(r.min) || 0; p.pts += Number(r.pts) || 0; p.reb += Number(r.reb) || 0;
    p.oreb += Number(r.oreb) || 0; p.dreb += Number(r.dreb) || 0; p.ast += Number(r.ast) || 0;
    p.stl += Number(r.stl) || 0; p.blk += Number(r.blk) || 0; p.tov += Number(r.tov) || 0;
    p.pf += Number(r.pf) || 0; p.fgm += Number(r.fgm) || 0; p.fga += Number(r.fga) || 0;
    p.fg3m += Number(r.fg3m) || 0; p.fg3a += Number(r.fg3a) || 0; p.ftm += Number(r.ftm) || 0;
    p.fta += Number(r.fta) || 0; p.plusMinus += Number(r.plusMinus) || 0;
    if (r.wl === 'W') p.wins++;
    p.firstGameDate = String(r.gameDate) < String(p.firstGameDate) ? r.gameDate : p.firstGameDate;
    p.lastGameDate = String(r.gameDate) > String(p.lastGameDate) ? r.gameDate : p.lastGameDate;
    const team = r.team || String(r.teamId);
    p.teams.set(team, (p.teams.get(team) || 0) + 1);

    const st = starterByKey.get(`${r.gameId}|${r.playerId}|${r.teamId}`);
    if (st && typeof st.starter === 'boolean') {
      p.starterKnownAppearances++;
      if (st.starter) p.starts++;
      p.starterSources.set(st.source, (p.starterSources.get(st.source) || 0) + 1);
    }
  }

  return [...byPlayer.values()].map((p) => {
    const trueShootingDen = 2 * (p.fga + 0.44 * p.fta);
    return {
      season: p.season, seasonType: p.seasonType, playerId: p.playerId, name: p.name,
      teams: [...p.teams.entries()].sort((a, b) => b[1] - a[1]).map(([team, gp]) => ({ team, gp })),
      gp: p.gp, wins: p.wins, minutes: round(p.min, 1), mpg: round(div(p.min, p.gp), 2),
      pts: round(div(p.pts, p.gp), 2), reb: round(div(p.reb, p.gp), 2), ast: round(div(p.ast, p.gp), 2),
      stl: round(div(p.stl, p.gp), 2), blk: round(div(p.blk, p.gp), 2), tov: round(div(p.tov, p.gp), 2),
      fgPct: round(div(p.fgm, p.fga), 4), fg3Pct: round(div(p.fg3m, p.fg3a), 4),
      ftPct: round(div(p.ftm, p.fta), 4), ts: round(div(p.pts, trueShootingDen), 4),
      plusMinusPerGame: round(div(p.plusMinus, p.gp), 2),
      starts: p.starterKnownAppearances ? p.starts : null,
      startShareOfAppearances: p.starterKnownAppearances ? round(pct(p.starts, p.starterKnownAppearances), 4) : null,
      starterKnownAppearances: p.starterKnownAppearances,
      starterCoverage: round(pct(p.starterKnownAppearances, p.gp), 4),
      starterSources: Object.fromEntries([...p.starterSources.entries()].sort()),
      firstGameDate: p.firstGameDate, lastGameDate: p.lastGameDate,
    };
  });
}

const all = [];
for (const season of seasons) {
  for (const [seasonType, file] of [['Regular Season', 'gamelog.json'], ['Playoffs', 'gamelog_playoffs.json']]) {
    const f = path.join(HIST, season, file);
    if (!fs.existsSync(f)) continue;
    all.push(...aggregate(JSON.parse(fs.readFileSync(f, 'utf8')), season, seasonType));
  }
}
all.sort((a, b) => a.playerId - b.playerId || a.season.localeCompare(b.season) || a.seasonType.localeCompare(b.seasonType));

const byPlayer = {};
for (const r of all) (byPlayer[r.playerId] = byPlayer[r.playerId] || []).push(r);

// Product artifact: only players who are in the current 2025-26 NBA/G League database, joined by
// official person id. The full 10-season summary stays local/regenerable; this compact subset is
// small enough to track and lets a clean clone render historical profiles without the 190 MB cache.
function idsFromLeagueDash(file) {
  if (!fs.existsSync(file)) return [];
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rs = d.resultSets?.find((x) => x.name === 'LeagueDashPlayerStats') || d.resultSets?.[0];
  if (!rs) return [];
  const ix = rs.headers.indexOf('PLAYER_ID');
  return ix < 0 ? [] : rs.rowSet.map((r) => Number(r[ix]));
}
const currentIds = new Set();
for (const rel of [
  'scripts/data/official_nba/base_totals.json',
  'scripts/data/official_gleague_regular/base_totals.json',
  'scripts/data/official_gleague_showcase/base_totals.json',
]) for (const id of idsFromLeagueDash(path.join(ROOT, rel))) currentIds.add(id);
for (const rel of ['scripts/data/rosters_nba.json', 'scripts/data/rosters_gleague.json']) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) if (r.PLAYER_ID != null) currentIds.add(Number(r.PLAYER_ID));
}

const PRODUCT_ROW_SCHEMA = ['season', 'seasonType', 'teams', 'gp', 'mpg', 'pts', 'reb', 'ast', 'ts', 'starts', 'startShareOfAppearances', 'starterKnownAppearances', 'starterCoverage'];
const productByPlayer = {};
let productRows = 0;
for (const id of currentIds) {
  const rows = byPlayer[id] || [];
  if (!rows.length) continue;
  productByPlayer[id] = rows.map((r) => [
    r.season, r.seasonType, (r.teams || []).map((t) => t.team), r.gp, r.mpg, r.pts, r.reb,
    r.ast, r.ts, r.starts, r.startShareOfAppearances, r.starterKnownAppearances, r.starterCoverage,
  ]);
  productRows += rows.length;
}

const artifact = {
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  seasons,
  source: 'local historical leaguegamelog cache + canonical starter artifact',
  starterArtifactSchemaVersion: starterSchemaVersion,
  starterCoveragePhases,
  caveats: [
    'Starter values are populated only where the canonical starter artifact establishes them; unknown is never treated as bench.',
    'This is descriptive historical product data, not a leakage-safe TULIP Forecast training set.',
    'Regular season and playoffs remain separate rows.',
  ],
  playerSeasonRows: all.length,
  players: Object.keys(byPlayer).length,
  byPlayer,
};
fs.writeFileSync(OUT, JSON.stringify(artifact));
const starterKnownAll = all.reduce((sum, r) => sum + r.starterKnownAppearances, 0);
const productArtifact = {
  schemaVersion: 1,
  generatedAt: artifact.generatedAt,
  seasons,
  source: artifact.source,
  caveats: artifact.caveats,
  starterCoveragePhases: artifact.starterCoveragePhases,
  rowSchema: PRODUCT_ROW_SCHEMA,
  inventory: {
    allPlayerSeasonPhaseRows: all.length,
    allHistoricalPlayers: Object.keys(byPlayer).length,
    starterKnownAppearancesAll: starterKnownAll,
    currentDatabasePersonIds: currentIds.size,
    currentPlayersWithHistory: Object.keys(productByPlayer).length,
    currentPlayerSeasonPhaseRows: productRows,
  },
  byPlayer: productByPlayer,
};
fs.writeFileSync(PRODUCT_OUT, JSON.stringify(productArtifact));
console.log(`history summary: ${all.length.toLocaleString()} player-season-phase rows · ${Object.keys(byPlayer).length.toLocaleString()} players`);
console.log(`starter-known appearances in summary: ${starterKnownAll.toLocaleString()}`);
console.log(`-> ${path.relative(ROOT, OUT)} ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB (local/regenerable)`);
console.log(`-> ${path.relative(ROOT, PRODUCT_OUT)} ${(fs.statSync(PRODUCT_OUT).size / 1e6).toFixed(2)} MB (${Object.keys(productByPlayer).length} current players)`);

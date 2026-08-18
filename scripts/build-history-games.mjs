// Build an on-demand historical game-log product for current NBA/G League database players.
//
// The raw ten-season cache is ~190 MB and stays local/ignored. This product keeps only the fields
// needed for player game-log/trend UI, keyed by official person id and gzip-compressed for static
// delivery. Starter status is joined only from the canonical accepted starter artifact; unknown is
// preserved as null rather than inferred from minutes or candidate sets.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const OUT = path.join(ROOT, 'public/history-games.json.gz');
const GENERATED_AT = process.env.BUILD_GENERATED_AT || new Date().toISOString();
const prov = JSON.parse(fs.readFileSync(path.join(HIST, 'provenance.json'), 'utf8'));

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

const starterByKey = new Map();
let starterCoveragePhases = [];
const starterFile = path.join(HIST, 'starters/player_game_starters.json');
if (fs.existsSync(starterFile)) {
  const s = JSON.parse(fs.readFileSync(starterFile, 'utf8'));
  if (s.onUnknownSchemaVersion === 'FAIL_CLOSED' && s.schemaVersion !== 1) {
    throw new Error(`unsupported starter artifact schemaVersion ${s.schemaVersion}`);
  }
  starterCoveragePhases = Array.isArray(s.scope?.seasonPhases) ? [...s.scope.seasonPhases].sort() : [];
  const ix = Object.fromEntries((s.schema || []).map((k, i) => [k, i]));
  for (const row of s.rows || []) {
    starterByKey.set(`${row[ix.gameId]}|${row[ix.playerId]}|${row[ix.teamId]}`, row[ix.starter]);
  }
}

const ROW_SCHEMA = [
  'season', 'seasonType', 'gameDate', 'gameId', 'team', 'opponent', 'minutes',
  'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'plusMinus', 'started',
];
const byPlayer = {};
let rows = 0;
for (const season of prov.seasons) {
  for (const [seasonType, file] of [['Regular Season', 'gamelog.json'], ['Playoffs', 'gamelog_playoffs.json']]) {
    const f = path.join(HIST, season, file);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const id = Number(r.playerId);
      if (!currentIds.has(id)) continue;
      const starter = starterByKey.has(`${r.gameId}|${r.playerId}|${r.teamId}`)
        ? starterByKey.get(`${r.gameId}|${r.playerId}|${r.teamId}`) : null;
      (byPlayer[id] ||= []).push([
        season, seasonType, r.gameDate, r.gameId, r.team, r.opponent,
        Number(r.min) || 0, Number(r.pts) || 0, Number(r.reb) || 0, Number(r.ast) || 0,
        Number(r.stl) || 0, Number(r.blk) || 0, Number(r.tov) || 0, Number(r.plusMinus) || 0,
        typeof starter === 'boolean' ? starter : null,
      ]);
      rows++;
    }
  }
}
for (const list of Object.values(byPlayer)) list.sort((a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[3]).localeCompare(String(b[3])));

const artifact = {
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  seasons: prov.seasons,
  source: 'historical leaguegamelog cache + canonical starter artifact',
  rowSchema: ROW_SCHEMA,
  starterCoveragePhases,
  caveats: [
    'Descriptive game logs only; not TULIP Forecast training output.',
    'Starter is null outside accepted canonical starter source coverage; null is never bench.',
    'Regular season and playoffs remain separate phases.',
  ],
  inventory: { currentDatabasePersonIds: currentIds.size, playersWithGames: Object.keys(byPlayer).length, playerGameRows: rows },
  byPlayer,
};
const raw = Buffer.from(JSON.stringify(artifact), 'utf8');
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
console.log(`history game product: ${rows.toLocaleString()} rows · ${Object.keys(byPlayer).length} current players`);
console.log(`-> ${path.relative(ROOT, OUT)} ${(raw.length / 1e6).toFixed(2)} MB JSON -> ${(gz.length / 1e6).toFixed(2)} MB gzip`);

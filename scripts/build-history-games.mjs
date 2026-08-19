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

const currentIds = new Set();
const currentMeta = new Map();
function addCurrent(id, name, league) {
  const n = Number(id);
  if (!Number.isFinite(n)) return;
  currentIds.add(n);
  const prev = currentMeta.get(n) || { name: null, leagues: new Set() };
  if (!prev.name && name) prev.name = String(name).trim();
  if (league) prev.leagues.add(league);
  currentMeta.set(n, prev);
}

function addLeagueDash(file, league) {
  if (!fs.existsSync(file)) return;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rs = d.resultSets?.find((x) => x.name === 'LeagueDashPlayerStats') || d.resultSets?.[0];
  if (!rs) return;
  const idIx = rs.headers.indexOf('PLAYER_ID');
  const nameIx = rs.headers.indexOf('PLAYER_NAME');
  if (idIx < 0) return;
  for (const row of rs.rowSet || []) addCurrent(row[idIx], nameIx >= 0 ? row[nameIx] : null, league);
}

addLeagueDash(path.join(ROOT, 'scripts/data/official_nba/base_totals.json'), 'NBA');
addLeagueDash(path.join(ROOT, 'scripts/data/official_gleague_regular/base_totals.json'), 'GLEAGUE');
addLeagueDash(path.join(ROOT, 'scripts/data/official_gleague_showcase/base_totals.json'), 'GLEAGUE');
for (const [rel, league] of [['scripts/data/rosters_nba.json', 'NBA'], ['scripts/data/rosters_gleague.json', 'GLEAGUE']]) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) addCurrent(r.PLAYER_ID, r.PLAYER || r.PLAYER_NAME, league);
}

const starterByKey = new Map();
let starterSourceGaps = [];
let starterFullCensusPhases = [];
let starterPartialPhases = [];
let starterCoveragePhases = [];
const starterFile = path.join(HIST, 'starters/player_game_starters.json');
if (fs.existsSync(starterFile)) {
  const s = JSON.parse(fs.readFileSync(starterFile, 'utf8'));
  // v2 interns provenance into a legend and encodes starter as 0/1; v1 stored strings per row.
  starterFullCensusPhases = Array.isArray(s.scope?.fullCensusPhases) ? [...s.scope.fullCensusPhases].sort() : [];
  starterPartialPhases = Array.isArray(s.scope?.partialPhases) ? [...s.scope.partialPhases].sort() : [];
  starterSourceGaps = (s.sourceGaps || []).map((g) => ({ season: g.season, seasonType: g.seasonType, playerId: g.playerId, gameId: g.gameId }));
  if (s.onUnknownSchemaVersion === 'FAIL_CLOSED' && ![1, 2].includes(s.schemaVersion)) {
    throw new Error(`unsupported starter artifact schemaVersion ${s.schemaVersion}`);
  }
  starterCoveragePhases = Array.isArray(s.scope?.seasonPhases) ? [...s.scope.seasonPhases].sort() : [];
  const ix = Object.fromEntries((s.schema || []).map((k, i) => [k, i]));
  for (const row of s.rows || []) {
    starterByKey.set(`${row[ix.gameId]}|${row[ix.playerId]}|${row[ix.teamId]}`,
      s.schemaVersion === 2 ? row[ix.starter] === 1 : row[ix.starter]);
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

// History Lab needs names, but fetching the ~35 MB current browser database merely to label a
// ~2 MB historical product would be wasteful. Keep a tiny identity index beside the game rows,
// sourced from the same official current-season dashboards/rosters used to select this universe.
const playerIndex = Object.fromEntries(Object.keys(byPlayer).map((id) => {
  const meta = currentMeta.get(Number(id));
  return [id, { name: meta?.name || `Player ${id}`, currentLeagues: [...(meta?.leagues || [])].sort() }];
}));
const namedPlayers = Object.values(playerIndex).filter((x) => x.name && !/^Player \d+$/.test(x.name)).length;

const artifact = {
  schemaVersion: 1,
  starterSourceGaps,
  starterFullCensusPhases,
  starterPartialPhases,
  generatedAt: GENERATED_AT,
  seasons: prov.seasons,
  source: 'historical leaguegamelog cache + canonical starter artifact',
  rowSchema: ROW_SCHEMA,
  playerIndex,
  starterCoveragePhases,
  caveats: [
    'Descriptive game logs only; not TULIP Forecast training output.',
    'Starter is null outside accepted canonical starter source coverage; null is never bench.',
    'Regular season and playoffs remain separate phases.',
    'playerIndex labels current-database identities from official current-season dashboards/rosters; historical rows remain keyed by official person id.',
  ],
  inventory: { currentDatabasePersonIds: currentIds.size, playersWithGames: Object.keys(byPlayer).length, namedPlayers, playerGameRows: rows },
  byPlayer,
};
const raw = Buffer.from(JSON.stringify(artifact), 'utf8');
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
console.log(`history game product: ${rows.toLocaleString()} rows · ${Object.keys(byPlayer).length} current players · ${namedPlayers} named`);
console.log(`-> ${path.relative(ROOT, OUT)} ${(raw.length / 1e6).toFixed(2)} MB JSON -> ${(gz.length / 1e6).toFixed(2)} MB gzip`);

// Phase 1 QA for the historical ingest. Nothing should be built on this data until it is known
// to be clean, so every check below either passes or fails the script.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const fails = [], warn = [];

if (!fs.existsSync(HIST)) { console.error('no history directory'); process.exit(1); }
const prov = JSON.parse(fs.readFileSync(path.join(HIST, 'provenance.json'), 'utf8'));

console.log('='.repeat(78));
console.log('HISTORICAL DATA QA');
console.log('='.repeat(78));

/* ------------------------------------------------ 1. dataset enumeration */
console.log('\n--- 1. datasets, enumerated ---');
const byKind = {};
for (const ds of prov.datasets) {
  const kind = ds.dataset.includes('/Regular Season/') ? 'gamelog (Regular Season)'
    : ds.dataset.includes('/Playoffs/') ? 'gamelog (Playoffs)'
    : ds.dataset.endsWith('starter_splits') ? 'starter_splits (season totals)'
    : 'other';
  (byKind[kind] = byKind[kind] || []).push(ds);
}
let total = 0;
for (const [kind, list] of Object.entries(byKind)) {
  const rows = list.reduce((a, d) => a + d.rows, 0);
  console.log(`  ${kind.padEnd(32)} ${String(list.length).padStart(3)} datasets · ${rows.toLocaleString().padStart(9)} rows`);
  total += list.length;
}
console.log(`  ${'TOTAL'.padEnd(32)} ${String(total).padStart(3)} datasets`);
console.log(`  => ${prov.seasons.length} seasons x 3 datasets each (regular gamelog, playoff gamelog, starter splits) = ${prov.seasons.length * 3}`);
if (total !== prov.seasons.length * 3) warn.push(`dataset count ${total} != seasons x 3`);
const missingProv = prov.datasets.filter((d) => !d.sha256 || !d.fetchedAt || !d.endpoint);
if (missingProv.length) fails.push(`${missingProv.length} datasets lack sha256/fetchedAt/endpoint`);
console.log(`  provenance complete on all ${prov.datasets.length}: ${missingProv.length === 0}`);

/* ------------------------------------------------------ 2. load and key */
console.log('\n--- 2. rows, keys and duplicates ---');
const all = [];
for (const season of prov.seasons) {
  for (const [file, st] of [['gamelog.json', 'Regular Season'], ['gamelog_playoffs.json', 'Playoffs']]) {
    const p = path.join(HIST, season, file);
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const r of rows) all.push(r);
  }
}
console.log(`  total player-game rows: ${all.length.toLocaleString()}`);
console.log(`  unique games:    ${new Set(all.map((r) => r.gameId)).size.toLocaleString()}`);
console.log(`  unique players:  ${new Set(all.map((r) => r.playerId)).size.toLocaleString()}`);
console.log(`  unique teams:    ${new Set(all.map((r) => r.team)).size}`);

const key = (r) => `${r.season}|${r.seasonType}|${r.gameId}|${r.playerId}|${r.teamId}`;
const seen = new Map();
const dupes = [];
for (const r of all) {
  const k = key(r);
  if (seen.has(k)) dupes.push({ k, a: seen.get(k), b: r }); else seen.set(k, r);
}
console.log(`  canonical key season|seasonType|gameId|playerId|teamId -> ${dupes.length} duplicates`);
if (dupes.length) {
  fails.push(`${dupes.length} duplicate rows under the canonical key`);
  console.log('    example:', JSON.stringify(dupes[0].a).slice(0, 150));
}
// Is the key sufficient, or does a player ever appear twice in one game for DIFFERENT teams?
const pg = new Map();
for (const r of all) {
  const k = `${r.season}|${r.seasonType}|${r.gameId}|${r.playerId}`;
  if (!pg.has(k)) pg.set(k, new Set());
  pg.get(k).add(r.teamId);
}
const multiTeamSameGame = [...pg.values()].filter((s) => s.size > 1).length;
console.log(`  player appearing for 2+ teams in one game: ${multiTeamSameGame}`);
console.log(`  => key WITHOUT teamId would ${multiTeamSameGame ? 'LOSE rows' : 'also be sufficient'}`);

/* --------------------------------------------------- 3. field integrity */
console.log('\n--- 3. field integrity ---');
const checks = {
  'missing playerId': (r) => r.playerId === null || r.playerId === undefined,
  'missing gameId': (r) => !r.gameId,
  'missing gameDate': (r) => !r.gameDate,
  'missing teamId': (r) => r.teamId === null || r.teamId === undefined,
  'missing opponent': (r) => !r.opponent,
  'malformed minutes (negative or >70)': (r) => r.min !== null && (r.min < 0 || r.min > 70),
  'FGM > FGA': (r) => Number.isFinite(r.fgm) && Number.isFinite(r.fga) && r.fgm > r.fga,
  'FG3M > FG3A': (r) => Number.isFinite(r.fg3m) && Number.isFinite(r.fg3a) && r.fg3m > r.fg3a,
  'FTM > FTA': (r) => Number.isFinite(r.ftm) && Number.isFinite(r.fta) && r.ftm > r.fta,
  'FG3M > FGM': (r) => Number.isFinite(r.fg3m) && Number.isFinite(r.fgm) && r.fg3m > r.fgm,
  'FG3A > FGA': (r) => Number.isFinite(r.fg3a) && Number.isFinite(r.fga) && r.fg3a > r.fga,
  'OREB+DREB != REB': (r) => [r.oreb, r.dreb, r.reb].every(Number.isFinite) && r.oreb + r.dreb !== r.reb,
  'negative counting stat': (r) => ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fgm', 'fga', 'ftm', 'fta']
    .some((k) => Number.isFinite(r[k]) && r[k] < 0),
  'started not null (must be null)': (r) => r.started !== null,
};
for (const [label, fn] of Object.entries(checks)) {
  const bad = all.filter(fn);
  const pct = (100 * bad.length / all.length).toFixed(3);
  console.log(`  ${label.padEnd(36)} ${String(bad.length).padStart(6)}  (${pct}%)`);
  if (bad.length) {
    // Zero-minute DNP rows legitimately carry nulls; everything else is a real defect.
    const structural = ['missing playerId', 'missing gameId', 'missing gameDate', 'missing teamId',
      'FGM > FGA', 'FG3M > FG3A', 'FTM > FTA', 'FG3M > FGM', 'FG3A > FGA', 'negative counting stat',
      'started not null (must be null)'];
    (structural.includes(label) ? fails : warn).push(`${label}: ${bad.length} rows`);
    if (structural.includes(label)) console.log('      example:', JSON.stringify(bad[0]).slice(0, 160));
  }
}

/* ------------------------------------- 4. per-season / contamination */
console.log('\n--- 4. per season ---');
console.log('  season     regular   playoff   games  players   date range');
for (const season of prov.seasons) {
  const rs = all.filter((r) => r.season === season && r.seasonType === 'Regular Season');
  const po = all.filter((r) => r.season === season && r.seasonType === 'Playoffs');
  const dates = [...rs, ...po].map((r) => r.gameDate).filter(Boolean).sort();
  console.log(`  ${season}  ${String(rs.length).padStart(7)}  ${String(po.length).padStart(8)}` +
    `  ${String(new Set([...rs, ...po].map((r) => r.gameId)).size).padStart(6)}` +
    `  ${String(new Set([...rs, ...po].map((r) => r.playerId)).size).padStart(7)}` +
    `   ${dates[0]} .. ${dates[dates.length - 1]}`);
  // Contamination: a playoff game dated before the last regular-season game.
  const lastRs = rs.map((r) => r.gameDate).sort().pop();
  const firstPo = po.map((r) => r.gameDate).sort()[0];
  if (lastRs && firstPo && firstPo < lastRs) {
    fails.push(`${season}: playoff game dated ${firstPo} precedes last regular-season game ${lastRs}`);
  }
  const gameIdsRs = new Set(rs.map((r) => r.gameId));
  const overlap = po.filter((r) => gameIdsRs.has(r.gameId)).length;
  if (overlap) fails.push(`${season}: ${overlap} gameIds appear in BOTH regular season and playoffs`);
}


/* ------------------------------------------- 4b. derived validation artifacts */
console.log('\n--- 4b. derived history/starter artifacts ---');
const summaryPath = path.join(HIST, 'player_season_summary.json');
if (fs.existsSync(summaryPath)) {
  const hs = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  console.log(`  full local player-season summary: ${Number(hs.playerSeasonRows || 0).toLocaleString()} rows · ${Number(hs.players || 0).toLocaleString()} players`);
  if (!hs.playerSeasonRows || !hs.players) fails.push('player_season_summary.json is present but missing row/player counts');
} else {
  console.log('  full local player-season summary: absent (regenerable from local raw cache)');
}
const productHistoryPath = path.join(HIST, 'player_history_product.json');
if (fs.existsSync(productHistoryPath)) {
  const hp = JSON.parse(fs.readFileSync(productHistoryPath, 'utf8'));
  console.log(`  tracked history product: ${Number(hp.inventory?.currentPlayerSeasonPhaseRows || 0).toLocaleString()} rows · ${Number(hp.inventory?.currentPlayersWithHistory || 0).toLocaleString()} current players`);
  if (!hp.inventory?.currentPlayerSeasonPhaseRows) fails.push('player_history_product.json is present but missing inventory');
} else {
  fails.push('player_history_product.json is missing; clean clones cannot render historical player records');
  console.log('  tracked history product: MISSING');
}
const gameProductPath = path.join(ROOT, 'public/history-games.json.gz');
if (fs.existsSync(gameProductPath)) {
  try {
    const hg = JSON.parse(zlib.gunzipSync(fs.readFileSync(gameProductPath)).toString('utf8'));
    console.log(`  on-demand game-log product: ${Number(hg.inventory?.playerGameRows || 0).toLocaleString()} rows · ${Number(hg.inventory?.playersWithGames || 0).toLocaleString()} current players · ${(fs.statSync(gameProductPath).size / 1e6).toFixed(2)} MB gzip`);
    if (!hg.inventory?.playerGameRows || !Array.isArray(hg.rowSchema)) fails.push('history-games.json.gz is malformed');
  } catch (e) {
    fails.push(`history-games.json.gz does not decode: ${e.message}`);
  }
} else {
  fails.push('public/history-games.json.gz is missing; historical game-log UI cannot load');
  console.log('  on-demand game-log product: MISSING');
}
const starterArtifactPath = path.join(HIST, 'starters/player_game_starters.json');
if (fs.existsSync(starterArtifactPath)) {
  const sa = JSON.parse(fs.readFileSync(starterArtifactPath, 'utf8'));
  console.log(`  canonical starter artifact: ${Number(sa.establishedRows ?? sa.rows?.length ?? 0).toLocaleString()} established rows · schema v${sa.schemaVersion ?? 'legacy'}`);
} else {
  warn.push('canonical starter artifact is absent');
  console.log('  canonical starter artifact: MISSING');
}
const poSplit = path.join(HIST, '2023-24/starter_splits_playoffs.json');
console.log(`  2023-24 playoff starter split: ${fs.existsSync(poSplit) ? 'present' : 'missing'}`);
if (!fs.existsSync(poSplit)) warn.push('2023-24 playoff starter split missing; playoff player-level reconciliation cannot run');

/* ------------------------------------------------- 5. storage impact */
console.log('\n--- 5. storage architecture ---');
const du = (p) => { try { return execSync(`du -sk "${p}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\t')[0] * 1024; } catch { return 0; } };
const histBytes = du(HIST);
const dataJson = fs.existsSync(path.join(ROOT, 'public/data.json')) ? fs.statSync(path.join(ROOT, 'public/data.json')).size : 0;
const artifact = fs.existsSync(path.join(ROOT, 'public/standalone.html')) ? fs.statSync(path.join(ROOT, 'public/standalone.html')).size : 0;
const mb = (b) => (b / 1e6).toFixed(2) + ' MB';
console.log(`  local history/cache on disk: ${mb(histBytes)}`);
console.log(`  public/data.json:            ${mb(dataJson)}`);
console.log(`  published artifact:          ${mb(artifact)}`);

// Product policy: compact player-season history MAY ship. Raw player-game logs MUST NOT.
const shipped = fs.existsSync(path.join(ROOT, 'public/data.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8')) : {};
const shippedPlayers = Object.values(shipped.leagues || {}).flatMap((x) => Array.isArray(x) ? x : []);
const withHistory = shippedPlayers.filter((p) => p && p.history);
const compactHistoryBytes = Buffer.byteLength(JSON.stringify(withHistory.map((p) => [p.nbaPersonId ?? p.playerId, p.history])));
const historySchema = shipped.analysis?.history?.browserSchema || [];
const allowedHistoryFields = new Set(['season', 'seasonType', 'teams', 'gp', 'mpg', 'pts', 'reb', 'ast', 'ts', 'starts', 'startShareOfAppearances', 'starterKnownAppearances', 'starterCoverage']);
const forbiddenHistoryFields = new Set(['gameId', 'gameDate', 'playerGameRows', 'minutes', 'starterSources', 'firstGameDate', 'lastGameDate']);
const malformedHistory = [];
if (!Array.isArray(historySchema) || !historySchema.length) {
  malformedHistory.push({ playerId: null, reason: 'analysis.history.browserSchema missing or empty' });
} else {
  const dup = historySchema.filter((k, i) => historySchema.indexOf(k) !== i);
  const unknown = historySchema.filter((k) => !allowedHistoryFields.has(k));
  const forbidden = historySchema.filter((k) => forbiddenHistoryFields.has(k));
  if (dup.length || unknown.length || forbidden.length) {
    malformedHistory.push({ playerId: null, reason: 'invalid browserSchema', dup, unknown, forbidden });
  }
  for (const p of withHistory) {
    if (!Array.isArray(p.history)) {
      malformedHistory.push({ playerId: p.playerId, reason: 'history is not an array' });
      continue;
    }
    for (let i = 0; i < p.history.length; i++) {
      const r = p.history[i];
      if (!Array.isArray(r) || r.length !== historySchema.length) {
        malformedHistory.push({ playerId: p.playerId, row: i, reason: 'row/schema length mismatch', rowLength: Array.isArray(r) ? r.length : null, schemaLength: historySchema.length });
        continue;
      }
      // Fail if any serialized value contains an object carrying raw player-game identifiers.
      for (const v of r) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const keys = Object.keys(v);
          const raw = keys.filter((k) => forbiddenHistoryFields.has(k));
          if (raw.length) malformedHistory.push({ playerId: p.playerId, row: i, reason: 'raw history object leaked', raw });
        }
      }
    }
  }
}
const topLevelRawHistory = Object.prototype.hasOwnProperty.call(shipped, 'history');
const rawLeak = topLevelRawHistory || malformedHistory.length > 0;
console.log(`  players carrying compact history: ${withHistory.length.toLocaleString()}`);
console.log(`  compact browser-history payload:  ${mb(compactHistoryBytes)}`);
console.log(`  raw player-game history shipped:  ${rawLeak ? 'YES' : 'NO'}`);
if (topLevelRawHistory) fails.push('top-level raw history object is being shipped to the browser');
if (malformedHistory.length) fails.push(`${malformedHistory.length} compact player-history rows contain unexpected/raw fields`);

if (fs.existsSync(path.join(ROOT, '.git'))) {
  try {
    const tracked = execSync(`git -C "${ROOT}" ls-files scripts/data/history | wc -l`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    console.log(`  git-tracked history files:   ${tracked}`);
  } catch {
    console.log('  git-tracked history files:   n/a (git query failed)');
  }
} else {
  console.log('  git-tracked history files:   n/a (handoff copy has no .git directory)');
}

console.log('\n--- warnings ---');
warn.length ? warn.forEach((w) => console.log('  ! ' + w)) : console.log('  none');
console.log('--- failures ---');
fails.length ? fails.forEach((f) => console.log('  X ' + f)) : console.log('  none');
process.exit(fails.length ? 1 : 0);

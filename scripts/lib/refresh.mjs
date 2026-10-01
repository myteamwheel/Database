// Validated, staged NBA imports. Fetch failure must preserve the last valid snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const NBA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36', Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com', Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' };
export function resultTable(json) {
  const rs = Array.isArray(json?.resultSets) ? json.resultSets[0] : json?.resultSets || json?.resultSet;
  if (!Array.isArray(rs?.headers) || !Array.isArray(rs?.rowSet)) throw new Error('Invalid NBA result table');
  if (new Set(rs.headers).size !== rs.headers.length) throw new Error('Duplicate source columns');
  if (rs.rowSet.some((r) => !Array.isArray(r) || r.length !== rs.headers.length)) throw new Error('Malformed source row');
  return rs;
}

export function diffResultTables(previousJson, nextJson, spec = {}) {
  const next = resultTable(nextJson);
  const previous = previousJson ? resultTable(previousJson) : { headers: next.headers, rowSet: [] };
  const idName = spec.id || 'PLAYER_ID';
  const prevId = previous.headers.indexOf(idName);
  const nextId = next.headers.indexOf(idName);
  if (prevId < 0 || nextId < 0) throw new Error(`Cannot diff source without ${idName}`);

  const rowObject = (headers, row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]).sort(([a],[b]) => a.localeCompare(b)));
  const prev = new Map(previous.rowSet.map((row) => [String(row[prevId]), rowObject(previous.headers, row)]));
  const cur = new Map(next.rowSet.map((row) => [String(row[nextId]), rowObject(next.headers, row)]));
  const addedIds = [...cur.keys()].filter((id) => !prev.has(id)).sort();
  const removedIds = [...prev.keys()].filter((id) => !cur.has(id)).sort();
  const changedIds = [...cur.keys()].filter((id) => prev.has(id)
    && JSON.stringify(prev.get(id)) !== JSON.stringify(cur.get(id))).sort();
  return {
    previousRows: previous.rowSet.length,
    nextRows: next.rowSet.length,
    added: addedIds.length,
    removed: removedIds.length,
    changed: changedIds.length,
    addedIds,
    removedIds,
    changedIds,
  };
}

export function archiveSeasonSnapshot({ outDir, archiveRoot, nextSeason }) {
  if (!/^\d{4}-\d{2}$/.test(String(nextSeason || ''))) throw new Error('Invalid next season');
  const manifestPath = path.join(outDir, '_refresh-manifest.json');
  if (!fs.existsSync(manifestPath)) return { rolledOver: false, previousSeason: null, nextSeason };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const previousSeason = manifest?.season;
  if (!previousSeason || previousSeason === nextSeason) {
    return { rolledOver: false, previousSeason: previousSeason || null, nextSeason };
  }
  const archiveDir = path.join(archiveRoot, previousSeason, path.basename(outDir));
  if (fs.existsSync(archiveDir)) throw new Error(`Season rollover destination already exists: ${archiveDir}`);
  if (path.resolve(archiveDir).startsWith(path.resolve(outDir) + path.sep)) {
    throw new Error('Season rollover destination cannot be inside the live source directory');
  }
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
  fs.renameSync(outDir, archiveDir);
  fs.mkdirSync(outDir, { recursive: true });
  return { rolledOver: true, previousSeason, nextSeason, archiveDir };
}

export function validateSource(json, spec, previous = null) {
  const table = resultTable(json);
  for (const column of spec.columns || []) if (!table.headers.includes(column)) throw new Error(`Missing ${column}`);
  if (spec.required && table.rowSet.length === 0) throw new Error('Required source unexpectedly empty');
  const id = table.headers.indexOf(spec.id || 'PLAYER_ID');
  if (id >= 0) {
    const values = table.rowSet.map((r) => r[id]);
    if (values.some((x) => !Number.isFinite(Number(x)) || Number(x) <= 0)) throw new Error('Missing/invalid player ID');
    if (new Set(values.map(String)).size !== values.length) throw new Error('Duplicate player ID');
  }
  // Row-count change is deliberately not a failure condition: at season start, statistics can
  // legitimately go from a full season to a small live sample. Schema, IDs and accounting below
  // are stable checks; source manifests preserve the exact counts for review.
  if (spec.totals) {
    const ix = Object.fromEntries(table.headers.map((h, i) => [h, i]));
    for (const r of table.rowSet) {
      for (const k of ['GP', 'MIN', 'PTS', 'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA', 'REB', 'OREB', 'DREB']) {
        if (ix[k] !== undefined && (!Number.isFinite(r[ix[k]]) || r[ix[k]] < 0)) throw new Error(`Invalid ${k}`);
      }
      for (const [made, attempt] of [['FGM', 'FGA'], ['FG3M', 'FG3A'], ['FTM', 'FTA']]) {
        if (ix[made] !== undefined && ix[attempt] !== undefined && r[ix[made]] > r[ix[attempt]]) throw new Error(`${made} exceeds ${attempt}`);
      }
      if (['REB', 'OREB', 'DREB'].every((k) => ix[k] !== undefined) && Math.abs(r[ix.REB] - r[ix.OREB] - r[ix.DREB]) > 0.01) throw new Error('Rebounds do not reconcile');
    }
  }
  return table;
}
export async function fetchJson(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 30000, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let failure;
  for (let n = 0; n < attempts; n++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: NBA_HEADERS, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (e) { failure = e; }
    finally { clearTimeout(timer); }
    if (n + 1 < attempts) await pause(1500 * (n + 1));
  }
  throw failure;
}
/** Validate every required response before touching any destination. Optional failures are explicit. */
export async function refreshSources({ jobs, outDir, season, seasonType, leagueId, fetchImpl = fetchJson, now = new Date().toISOString(), pauseMs = 800 }) {
  const manifestPath = path.join(outDir, '_refresh-manifest.json');
  const previousManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (previousManifest?.season && previousManifest.season !== season) throw new Error('Season rollover requires a separate destination and an updated builder');
  const staged = [], sources = [], failures = [];
  for (const job of jobs) {
    if (!/^[a-z0-9_]+$/.test(job.name)) throw new Error('Invalid source name');
    const destination = path.join(outDir, `${job.name}.json`);
    const old = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null;
    const prior = previousManifest?.sources?.find((s) => s.name === job.name);
    try {
      const json = await fetchImpl(job.url), previousJson = old ? JSON.parse(old) : null;
      const table = validateSource(json, job, previousJson);
      const bytes = JSON.stringify(json), hash = sha256(bytes), changed = !old || sha256(old) !== hash;
      const changeSummary = diffResultTables(previousJson, json, job);
      staged.push({ destination, bytes, changed, old });
      sources.push({ name: job.name, url: job.url, required: !!job.required, status: 'ok', rows: table.rowSet.length,
        sha256: hash, checkedAt: now, fetchedAt: changed ? now : prior?.fetchedAt || now, changed, changeSummary });
    } catch (error) {
      sources.push({ name: job.name, url: job.url, required: !!job.required, status: old ? 'retained' : 'unavailable',
        checkedAt: now, fetchedAt: prior?.fetchedAt || null, sha256: old ? sha256(old) : null, reason: error.message });
      if (job.required) failures.push(`${job.name}: ${error.message}`);
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  if (failures.length) throw new Error(`Required imports failed; previous snapshot preserved. ${failures.join('; ')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const temp = fs.mkdtempSync(path.join(outDir, '.refresh-'));
  const promoted = [];
  try {
    for (const entry of staged.filter((s) => s.changed)) fs.writeFileSync(path.join(temp, path.basename(entry.destination)), entry.bytes);
    for (const entry of staged.filter((s) => s.changed)) {
      fs.renameSync(path.join(temp, path.basename(entry.destination)), entry.destination);
      promoted.push(entry);
    }
    const manifest = { version: 1, season, seasonType, leagueId, checkedAt: now, sources };
    fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(path.join(temp, 'manifest.json'), manifestPath);
    return { changed: staged.filter((s) => s.changed).length, retained: sources.filter((s) => s.status === 'retained').length, manifest };
  } catch (error) {
    for (const entry of promoted.reverse()) {
      if (entry.old === null) fs.rmSync(entry.destination, { force: true });
      else fs.writeFileSync(entry.destination, entry.old);
    }
    throw new Error(`Import promotion failed; prior source files were restored: ${error.message}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

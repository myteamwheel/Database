import crypto from 'node:crypto';

const PROJECTION_FIELDS = [
  'season','team','status','basis','age','modelVersion','timeframe','role','effectiveMpg','usage',
  'gp','mpg','pts','reb','oreb','dreb','ast','stl','blk','tov',
  'fgm','fga','fg3m','fg3a','ftm','fta','fgPct','fg3Pct','ftPct','ts',
  'ptsLo','ptsHi','rebLo','rebHi','astLo','astHi','mpgLo','mpgHi','gpLo','gpHi',
  'accounting',
];

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function projectionIdentity(league, player) {
  const id = player?.nbaPersonId ?? player?.playerId;
  if (id === null || id === undefined || id === '') throw new Error(`missing canonical player id for ${league}`);
  return `${league}:${id}`;
}

export function extractArchivedPlayer(league, player) {
  const identity = projectionIdentity(league, player);
  const proj = player?.proj;
  if (!proj || typeof proj !== 'object') throw new Error(`${identity}: missing projection payload`);
  const base = {
    identity,
    league,
    playerId: player.playerId ?? null,
    nbaPersonId: player.nbaPersonId ?? null,
    name: player.name ?? null,
  };
  if (proj.abstain === true) {
    return { ...base, abstain: true, reason: proj.reason || 'unspecified' };
  }
  const projection = {};
  for (const key of PROJECTION_FIELDS) if (proj[key] !== undefined) projection[key] = structuredClone(proj[key]);
  return {
    ...base,
    team: proj.team ?? null,
    status: proj.status ?? null,
    basis: proj.basis ?? null,
    age: proj.age ?? null,
    modelVersion: proj.modelVersion ?? null,
    timeframe: proj.timeframe ?? null,
    projection,
    uncertainty: structuredClone(proj.uncertainty ?? null),
    availability: structuredClone(proj.availability ?? null),
    why: structuredClone(proj.why ?? null),
  };
}

function finite(v) { return Number.isFinite(v); }
function approx(a, b, tol = 0.11) { return finite(a) && finite(b) && Math.abs(a - b) <= tol; }

function validateProjection(row) {
  const p = row.projection;
  if (!p || typeof p !== 'object') throw new Error(`${row.identity}: projected row missing projection`);
  const pairs = [['FGM','fgm','FGA','fga'], ['3PM','fg3m','3PA','fg3a'], ['FTM','ftm','FTA','fta']];
  for (const [mLabel,m,aLabel,a] of pairs) {
    if (finite(p[m]) && finite(p[a]) && p[m] > p[a] + 1e-9) throw new Error(`${row.identity}: ${mLabel} exceeds ${aLabel}`);
  }
  if (finite(p.fg3m) && finite(p.fgm) && p.fg3m > p.fgm + 1e-9) throw new Error(`${row.identity}: 3PM exceeds FGM`);
  if (finite(p.fg3a) && finite(p.fga) && p.fg3a > p.fga + 1e-9) throw new Error(`${row.identity}: 3PA exceeds FGA`);
  if (finite(p.reb) && finite(p.oreb) && finite(p.dreb) && !approx(p.reb, p.oreb + p.dreb)) {
    throw new Error(`${row.identity}: REB does not equal OREB + DREB`);
  }
  if (finite(p.pts) && finite(p.fgm) && finite(p.fg3m) && finite(p.ftm)) {
    const ftValue = finite(p.accounting?.ftValue) ? p.accounting.ftValue : 1;
    const implied = 2 * (p.fgm - p.fg3m) + 3 * p.fg3m + p.ftm * ftValue;
    if (!approx(p.pts, implied)) throw new Error(`${row.identity}: points accounting does not reconcile`);
  }
  for (const [pct,m,a,label] of [
    ['fgPct','fgm','fga','FG%'], ['fg3Pct','fg3m','fg3a','3P%'], ['ftPct','ftm','fta','FT%'],
  ]) {
    if (finite(p[a]) && p[a] > 0 && finite(p[m]) && finite(p[pct]) && Math.abs(p[pct] - p[m] / p[a]) > 0.015) {
      throw new Error(`${row.identity}: ${label} does not reconcile with makes/attempts`);
    }
  }
}

export function validateArchive(archive) {
  if (!archive || !Array.isArray(archive.players)) throw new Error('archive.players must be an array');
  const seen = new Set();
  const byLeague = {};
  let projected = 0, abstained = 0;
  for (const row of archive.players) {
    if (!row?.identity) throw new Error('archive row missing identity');
    if (seen.has(row.identity)) throw new Error(`duplicate forecast identity ${row.identity}`);
    seen.add(row.identity);
    byLeague[row.league] = (byLeague[row.league] || 0) + 1;
    if (row.abstain === true) {
      abstained++;
      if ('projection' in row) throw new Error(`${row.identity}: abstention must not carry projection values`);
      if (!row.reason) throw new Error(`${row.identity}: abstention missing reason`);
      continue;
    }
    projected++;
    validateProjection(row);
  }
  return { projected, abstained, byLeague };
}

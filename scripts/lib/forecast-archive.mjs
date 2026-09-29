import { actualLine, historyBefore, prevSeason, prepare } from './projection.mjs';
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
  const acc = p.accounting;
  if (acc && finite(acc.pts) && finite(acc.fgm) && finite(acc.fg3m) && finite(acc.ftm)) {
    const ftValue = finite(acc.ftValue) ? acc.ftValue : 1;
    const implied = 2 * (acc.fgm - acc.fg3m) + 3 * acc.fg3m + acc.ftm * ftValue;
    if (Math.abs(acc.pts - implied) > 1e-6) throw new Error(`${row.identity}: points accounting does not reconcile`);
    if (finite(p.pts) && Math.abs(p.pts - acc.pts) > 0.11) throw new Error(`${row.identity}: published points differ from accounting`);
  } else if (finite(p.pts) && finite(p.fgm) && finite(p.fg3m) && finite(p.ftm)) {
    const implied = 2 * (p.fgm - p.fg3m) + 3 * p.fg3m + p.ftm;
    if (Math.abs(p.pts - implied) > 0.35) throw new Error(`${row.identity}: points accounting does not reconcile`);
  }
  for (const [pct,m,a,label] of [
    ['fgPct','fgm','fga','FG%'], ['fg3Pct','fg3m','fg3a','3P%'], ['ftPct','ftm','fta','FT%'],
  ]) {
    if (acc && finite(acc[a]) && acc[a] > 0 && finite(acc[m])) {
      const implied = acc[m] / acc[a];
      if (finite(acc[pct]) && Math.abs(acc[pct] - implied) > 1e-6) {
        throw new Error(`${row.identity}: ${label} accounting does not reconcile with makes/attempts`);
      }
      const exactPct = finite(acc[pct]) ? acc[pct] : implied;
      if (finite(p[pct]) && Math.abs(p[pct] - exactPct) > 0.002) {
        throw new Error(`${row.identity}: published ${label} differs from accounting`);
      }
    } else if (finite(p[a]) && p[a] > 0 && finite(p[m]) && finite(p[pct]) && Math.abs(p[pct] - p[m] / p[a]) > 0.05) {
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

const BASELINE_STAT_KEYS = ['mpg','gp','pts','reb','ast','stl','blk','tov','fg3m'];

export function nbaBaselines(D, pid, targetSeason) {
  const hist = historyBefore(D.nba, pid, targetSeason);
  const last = hist.find(Boolean);
  if (!last) return { repeat: null, avg3: null, evidence: { seasons: [] } };
  const idx = hist.indexOf(last);
  const repeat = actualLine(last);
  repeat.gp = Math.min(1, last.gp / D.nba.teamGames(last.season || prevSeason(targetSeason, idx + 1), last.team)) * 82;

  const weights = [5,4,3];
  const lines = hist.map(r => r ? actualLine(r) : null);
  let den = 0;
  hist.forEach((r,i) => { if (r) den += weights[i] * r.gp; });
  if (!(den > 0)) return { repeat, avg3: null, evidence: { seasons: hist.filter(Boolean).map(r => r.season) } };
  const avg3 = {};
  for (const k of [...BASELINE_STAT_KEYS, 'fga','fg3a','fta']) {
    let total = 0;
    hist.forEach((r,i) => { if (r) total += weights[i] * r.gp * lines[i][k]; });
    avg3[k] = total / den;
  }
  const weightedTotal = (key) => hist.reduce((sum,r,i) => sum + (r ? weights[i] * r[key] : 0), 0);
  avg3.fgPct = weightedTotal('fga') > 0 ? weightedTotal('fgm') / weightedTotal('fga') : null;
  avg3.fg3Pct = weightedTotal('fg3a') > 0 ? weightedTotal('fg3m') / weightedTotal('fg3a') : null;
  avg3.ftPct = weightedTotal('fta') > 0 ? weightedTotal('ftm') / weightedTotal('fta') : null;
  let share = 0, shareWeight = 0;
  hist.forEach((r,i) => {
    if (!r) return;
    const games = D.nba.teamGames(r.season || prevSeason(targetSeason, i + 1), r.team);
    share += weights[i] * Math.min(1, r.gp / games);
    shareWeight += weights[i];
  });
  avg3.gp = shareWeight > 0 ? (share / shareWeight) * 82 : null;
  return {
    repeat,
    avg3,
    evidence: { seasons: hist.filter(Boolean).map(r => r.season), weights: [5,4,3] },
  };
}

export function gleagueBaseline(D, pid, targetSeason, games = 50) {
  const hist = historyBefore(D.gleague, pid, targetSeason);
  const last = hist.find(Boolean);
  return {
    repeat: last ? actualLine(last) : null,
    evidence: { seasons: hist.filter(Boolean).map(r => r.season), targetGames: games },
  };
}


function injectPublishedGLeagueBase(D, data, season = '2025-26') {
  const gl = D.gleague?.seasons?.get(season);
  if (!gl) return;
  for (const p of data.leagues?.GLEAGUE || []) {
    if (!p.appeared || !(p.gp > 0) || !(p.minutes > 0)) continue;
    const g = p.gp, pid = Number(p.nbaPersonId);
    if (!Number.isFinite(pid)) continue;
    const fg3m = (p.fg3 || 0) * g, fg3a = (p.fg3a || 0) * g, fgm = (p.fg || 0) * g, fga = (p.fga || 0) * g;
    gl.set(pid, {
      pid, name: p.name, team: p.team, season, age: p.age, gp: g, min: p.minutes,
      fgm, fga, fg3m, fg3a, fg2m: fgm - fg3m, fg2a: fga - fg3a,
      ftm: (p.ft || 0) * g, fta: (p.fta || 0) * g,
      oreb: (p.oreb || 0) * g, dreb: (p.dreb || 0) * g, ast: (p.ast || 0) * g, tov: (p.tov || 0) * g,
      stl: (p.stl || 0) * g, blk: (p.blk || 0) * g, pf: (p.pf || 0) * g, pts: (p.pts || 0) * g,
      usg: Number.isFinite(p.usg) ? p.usg / 100 : null, pace: Number.isFinite(p.pace) ? p.pace : null,
      poss: Number.isFinite(p.poss) && p.poss > 0 ? p.poss : p.minutes * 100 / 48, pie: null,
    });
  }
}

export function buildArchive({ data, card, rawInputs, sourceCommit, publishedAt, publicationBasis = 'verified-release-date', forecastId, sources = null, roster = null }) {
  if (!forecastId) throw new Error('forecast id is required');
  if (!publishedAt) throw new Error('publishedAt is required');
  const meta = data?.projectionMeta;
  if (!meta?.season || !meta?.timeframe) throw new Error('projection season/timeframe is ambiguous');
  const raw = Buffer.isBuffer(rawInputs) ? rawInputs : Buffer.from(String(rawInputs));
  if (card?.builtFrom?.sha256 && card.builtFrom.sha256 !== sha256(raw)) throw new Error('projection card does not match frozen inputs');
  const parsed = JSON.parse(raw.toString('utf8'));
  if (roster) parsed.rosters2627 = roster;
  const D = prepare(parsed);
  injectPublishedGLeagueBase(D, data, '2025-26');
  const players = [];
  for (const [league, list] of Object.entries(data.leagues || {})) {
    if (!['NBA','GLEAGUE'].includes(league)) continue;
    for (const p of list) {
      const row = extractArchivedPlayer(league, p);
      const pid = Number(p.nbaPersonId);
      row.baselines = league === 'NBA' ? nbaBaselines(D, pid, meta.season) : gleagueBaseline(D, pid, meta.season, card?.gleague?.games || 50);
      players.push(row);
    }
  }
  players.sort((a,b) => a.identity.localeCompare(b.identity));
  const archive = {
    schemaVersion: 1,
    forecastId,
    season: meta.season,
    type: meta.timeframe,
    publishedAt,
    publicationBasis,
    sourceCommit,
    sourceCommitTime: null,
    model: { id: meta.id ?? card?.id ?? null, contextVersion: meta.contextVersion ?? null },
    roster: { asOf: meta.rostersAsOf ?? null, sha256: meta.rosterSha256 ?? null },
    sources: sources || {},
    players,
  };
  validateArchive(archive);
  return archive;
}


const SCORE_METRICS = ['gp','mpg','pts','reb','ast','stl','blk','tov','fg3m','fgPct','fg3Pct','ftPct'];

export function deriveCohorts(player) {
  if (!player || player.abstain) return [];
  const out = [];
  const status = player.status;
  const basis = player.basis;
  if (status === 'rookie' || basis === 'rookie-cohort-fallback') out.push('rookie');
  else if (basis === 'multi-year-history') out.push('recent-history-veteran');
  if (basis === 'older-history-fallback') out.push('older-history-returner');
  if (status === 'same') out.push('same-team');
  if (status === 'new') out.push('new-team');
  if (status === 'unsigned') out.push('unsigned-at-forecast');
  if (Number.isFinite(player.age) && player.age <= 23) out.push('age-23-and-under');
  if (Number.isFinite(player.age) && player.age >= 33) out.push('age-33-and-over');
  const last = player.why?.minutes?.last;
  if (Number.isFinite(last)) out.push(last >= 24 ? 'prior-high-minutes' : 'prior-lower-minutes');
  return out;
}

function actualIdentity(league, row) {
  const id = row?.nbaPersonId;
  if (id === null || id === undefined || id === '') throw new Error(`actual ${league} row missing nbaPersonId`);
  return `${league}:${id}`;
}

function actualPerGame(row) {
  const gp = Number(row.gp);
  if (!(gp > 0)) return { gp: Number.isFinite(gp) ? gp : null };
  const pg = (k) => Number.isFinite(Number(row[k])) ? Number(row[k]) / gp : null;
  const fga = Number(row.fga), fg3a = Number(row.fg3a), fta = Number(row.fta);
  return {
    gp,
    mpg: pg('min'), pts: pg('pts'),
    reb: Number.isFinite(Number(row.oreb)) && Number.isFinite(Number(row.dreb)) ? (Number(row.oreb)+Number(row.dreb))/gp : null,
    ast: pg('ast'), stl: pg('stl'), blk: pg('blk'), tov: pg('tov'), fg3m: pg('fg3m'),
    fgPct: fga > 0 && Number.isFinite(Number(row.fgm)) ? Number(row.fgm)/fga : null,
    fg3Pct: fg3a > 0 && Number.isFinite(Number(row.fg3m)) ? Number(row.fg3m)/fg3a : null,
    ftPct: fta > 0 && Number.isFinite(Number(row.ftm)) ? Number(row.ftm)/fta : null,
    attempts: { fga: Number.isFinite(fga) ? fga : 0, fg3a: Number.isFinite(fg3a) ? fg3a : 0, fta: Number.isFinite(fta) ? fta : 0 },
  };
}

export function normalizeActualResults(actuals) {
  if (actuals?.schemaVersion !== 1) throw new Error('actual results schemaVersion must be 1');
  if (!actuals?.season || !actuals?.asOf || !['final','interim'].includes(actuals?.status)) {
    throw new Error('actual results require season, asOf, and final/interim status');
  }
  const out = new Map();
  for (const league of ['NBA','GLEAGUE']) {
    for (const row of actuals.leagues?.[league] || []) {
      const key = actualIdentity(league,row);
      if (out.has(key)) throw new Error(`duplicate actual identity ${key}`);
      out.set(key,{...row,league,identity:key,line:actualPerGame(row)});
    }
  }
  return out;
}

function metricEligible(metric, actual, interim) {
  if (metric === 'gp' && interim) return false;
  if (metric === 'fgPct') return actual.line.attempts?.fga >= 100;
  if (metric === 'fg3Pct') return actual.line.attempts?.fg3a >= 50;
  if (metric === 'ftPct') return actual.line.attempts?.fta >= 50;
  return true;
}

function summarize(values) {
  if (!values.length) return { available:false, n:0 };
  let abs=0, sq=0, bias=0;
  for (const [pred,act] of values) { const e=pred-act; abs+=Math.abs(e); sq+=e*e; bias+=e; }
  return { available:true, n:values.length, mae:abs/values.length, rmse:Math.sqrt(sq/values.length), bias:bias/values.length };
}

function scoreOne(rows, getter, interim) {
  const metrics = {};
  for (const metric of SCORE_METRICS) {
    if (metric === 'gp' && interim) continue;
    const values=[];
    for (const row of rows) {
      if (!metricEligible(metric,row.actual,interim)) continue;
      const pred=getter(row)?.[metric], act=row.actual.line?.[metric];
      if (Number.isFinite(pred) && Number.isFinite(act)) values.push([pred,act]);
    }
    metrics[metric]=summarize(values);
  }
  return {metrics};
}

function scorePair(rows, baseline, interim) {
  const model={metrics:{}}, base={metrics:{}};
  for (const metric of SCORE_METRICS) {
    if (metric === 'gp' && interim) continue;
    const modelValues=[], baseValues=[];
    for (const row of rows) {
      if (!metricEligible(metric,row.actual,interim)) continue;
      const mp=row.player.projection?.[metric], bp=row.player.baselines?.[baseline]?.[metric], act=row.actual.line?.[metric];
      if (Number.isFinite(mp) && Number.isFinite(bp) && Number.isFinite(act)) {
        modelValues.push([mp,act]); baseValues.push([bp,act]);
      }
    }
    model.metrics[metric]=summarize(modelValues); base.metrics[metric]=summarize(baseValues);
  }
  return {model,baseline:base};
}

function scoreGroup(rows, league, interim) {
  const result={allModel:scoreOne(rows,r=>r.player.projection,interim),vsRepeat:scorePair(rows,'repeat',interim)};
  if (league === 'NBA') result.vsAvg3=scorePair(rows,'avg3',interim);
  return result;
}

export function scoreArchive(archive, actuals, {interim=false}={}) {
  if (!archive?.season || archive.season !== actuals?.season) {
    throw new Error(`forecast/actual season mismatch: ${archive?.season} vs ${actuals?.season}`);
  }
  if (actuals.status === 'interim' && !interim) throw new Error('interim actual results require explicit interim mode');
  if (actuals.status === 'final' && interim) throw new Error('interim mode requires interim actual results');
  const actualMap=normalizeActualResults(actuals);
  const output={schemaVersion:1,forecastId:archive.forecastId,season:archive.season,asOf:actuals.asOf,status:actuals.status,
    interim:actuals.status==='interim',coverage:{},leagues:{}};
  for (const league of ['NBA','GLEAGUE']) {
    const players=(archive.players||[]).filter(p=>p.league===league);
    const coverage={archiveRows:players.length,projected:players.filter(p=>!p.abstain).length,
      abstained:players.filter(p=>p.abstain).length,actualMatched:players.filter(p=>actualMap.has(p.identity)).length,
      repeatAvailable:players.filter(p=>p.baselines?.repeat).length,avg3Available:players.filter(p=>p.baselines?.avg3).length};
    output.coverage[league]=coverage;
    const rows=players.filter(p=>!p.abstain && actualMap.has(p.identity)).map(player=>({player,actual:actualMap.get(player.identity)}));
    const scored=scoreGroup(rows,league,output.interim);
    const cohorts={};
    const names=[...new Set(rows.flatMap(r=>deriveCohorts(r.player)))].sort();
    for (const name of names) cohorts[name]=scoreGroup(rows.filter(r=>deriveCohorts(r.player).includes(name)),league,output.interim);
    output.leagues[league]={...scored,cohorts};
  }
  return output;
}

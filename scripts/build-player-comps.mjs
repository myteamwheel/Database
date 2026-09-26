// Historical player-comparison engine.
//
// Builds top-three same-league comps for every current database player from the committed
// projection history: NBA 2009-10..2025-26 and G League 2014-15..2025-26.
//
// Design rules:
//   1. Physical profile is the first and heaviest block (height, weight, wingspan/reach when known).
//   2. Position is NOT a hard gate. A guard and wing can compare if their bodies/roles actually match.
//   3. Production, role, shooting mix and defensive activity then refine the match.
//   4. Missing measurements are never invented. Block weights renormalise over available evidence,
//      while missing physical coverage carries an explicit penalty so "unknown size" cannot beat a
//      genuinely close measured match by accident.
//   5. Current-season deep style axes are used only when both records have them; historical seasons
//      are not pretended to contain tracking/shot-zone data that was never acquired.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'public/data.json');
const INPUTS_PATH = path.join(ROOT, 'scripts/data/projection/inputs.json');
const COMBINE_PATH = path.join(ROOT, 'scripts/data/combine_anthro.json');

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const n = (v) => fin(v) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => fin(v) ? Math.round(Number(v) * 10) / 10 : null;
const r2 = (v) => fin(v) ? Math.round(Number(v) * 100) / 100 : null;
const rowsOf = (t) => (t?.rows || []).map((row) => Object.fromEntries((t.headers || []).map((h, i) => [h, row[i]])));
const inches = (h) => {
  if (fin(h)) return Number(h);
  const m = String(h || '').trim().match(/^(\d+)-(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);
  const q = String(h || '').match(/(\d+)['’]\s*(\d+(?:\.\d+)?)/);
  return q ? Number(q[1]) * 12 + Number(q[2]) : null;
};
const per36 = (total, minutes) => fin(total) && fin(minutes) && Number(minutes) > 0 ? Number(total) * 36 / Number(minutes) : null;

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const inputs = JSON.parse(fs.readFileSync(INPUTS_PATH, 'utf8'));

const bio = new Map();
const addBio = (x) => bio.set(Number(x.PERSON_ID), {
  playerId: Number(x.PERSON_ID),
  name: [x.PLAYER_FIRST_NAME, x.PLAYER_LAST_NAME].filter(Boolean).join(' ').trim(),
  position: x.POSITION || null,
  height: inches(x.HEIGHT),
  weight: n(x.WEIGHT),
});
rowsOf(inputs.playerIndex).forEach(addBio);
rowsOf(inputs.rosters2627).forEach((x) => { if (!bio.has(Number(x.PERSON_ID))) addBio(x); });

const combine = new Map();
if (fs.existsSync(COMBINE_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(COMBINE_PATH, 'utf8'));
    for (const x of raw.rows || []) {
      const pid = Number(x.playerId ?? x.PLAYER_ID);
      if (!pid) continue;
      combine.set(pid, {
        wingspan: n(x.wingspanInches ?? x.WINGSPAN),
        standingReach: n(x.standingReachInches ?? x.STANDING_REACH),
        heightNoShoes: n(x.heightNoShoesInches ?? x.HEIGHT_WO_SHOES),
        combineWeight: n(x.weight ?? x.WEIGHT),
      });
    }
  } catch (e) {
    console.warn('player comps: combine data ignored:', e.message);
  }
}

function historyRows(src, league) {
  const out = [];
  for (const [season, tables] of Object.entries(src || {})) {
    const adv = new Map(rowsOf(tables.adv).map((x) => [Number(x.PLAYER_ID), x]));
    for (const x of rowsOf(tables.base)) {
      const pid = Number(x.PLAYER_ID), minutes = n(x.MIN), gp = n(x.GP);
      if (!pid || !fin(minutes) || minutes <= 0 || !fin(gp) || gp <= 0) continue;
      const a = adv.get(pid) || {};
      const b = bio.get(pid) || {};
      const c = combine.get(pid) || {};
      const fga = n(x.FGA), fg3a = n(x.FG3A), fta = n(x.FTA), fg3m = n(x.FG3M), fgm = n(x.FGM);
      const ftm = n(x.FTM), pts = n(x.PTS), poss = n(a.POSS);
      const ts = fin(a.TS_PCT) ? Number(a.TS_PCT)
        : fin(pts) && fin(fga) && fin(fta) && (fga + 0.44 * fta) > 0 ? pts / (2 * (fga + 0.44 * fta)) : null;
      out.push({
        league, season, playerId: String(pid), nbaPersonId: pid, name: x.PLAYER_NAME || b.name || String(pid),
        team: x.TEAM_ABBREVIATION || null, position: b.position || null,
        age: n(x.AGE), gp, minutes,
        physical: {
          height: b.height ?? c.heightNoShoes ?? null,
          weight: b.weight ?? c.combineWeight ?? null,
          wingspan: c.wingspan ?? null,
          standingReach: c.standingReach ?? null,
        },
        features: {
          mpg: minutes / gp,
          usg: n(a.USG_PCT),
          pts36: per36(pts, minutes),
          fga36: per36(fga, minutes),
          threeA36: per36(fg3a, minutes),
          fta36: per36(fta, minutes),
          reb36: per36(n(x.REB), minutes),
          ast36: per36(n(x.AST), minutes),
          stl36: per36(n(x.STL), minutes),
          blk36: per36(n(x.BLK), minutes),
          tov36: per36(n(x.TOV), minutes),
          oreb36: per36(n(x.OREB), minutes),
          dreb36: per36(n(x.DREB), minutes),
          threeRate: fin(fga) && fga > 0 && fin(fg3a) ? fg3a / fga : null,
          ftRate: fin(fga) && fga > 0 && fin(fta) ? fta / fga : null,
          fg3Pct: fin(fg3a) && fg3a >= 15 && fin(fg3m) ? fg3m / fg3a : null,
          fgPct: fin(fga) && fga > 0 && fin(fgm) ? fgm / fga : null,
          ftPct: fin(fta) && fta >= 10 && fin(ftm) ? ftm / fta : null,
          ts,
          astPct: n(a.AST_PCT),
          orebPct: n(a.OREB_PCT),
          drebPct: n(a.DREB_PCT),
          pie: n(a.PIE),
          pace: n(a.PACE),
          poss,
        },
      });
    }
  }
  return out;
}

const histories = {
  NBA: historyRows(inputs.nba, 'NBA'),
  GLEAGUE: historyRows(inputs.gleague, 'GLEAGUE'),
};

// Current 2025-26 records have extra shot-style/tracking information. Attach a small common overlay
// so two current-season players can be distinguished more precisely without pretending old seasons
// had the same tracking coverage.
const currentByLeaguePid = {};
for (const lg of ['NBA', 'GLEAGUE']) {
  currentByLeaguePid[lg] = new Map((data.leagues?.[lg] || []).map((p) => [String(p.nbaPersonId ?? p.playerId), p]));
}
function deepOverlay(p) {
  const s = p?.skillProfile || {};
  return {
    selfCreation: n(s.selfCreation), paintScoring: n(s.paintScoring), rimPressure: n(s.rimPressure),
    threeVolume: n(s.threeVolume), threeAccuracy: n(s.threeAccuracy), shootingEff: n(s.shootingEff),
    playmaking: n(s.playmaking), assistRate: n(s.assistRate), ballSecurity: n(s.ballSecurity),
    offRebounding: n(s.offRebounding), defRebounding: n(s.defRebounding),
    steals: n(s.steals), rimProtection: n(s.rimProtection), usagePctile: n(s.usage),
  };
}

const BLOCKS = {
  physical: {
    weight: 0.46,
    axes: {
      height: { scale: 2.5, weight: 1.25, label: 'height' },
      weight: { scale: 18, weight: 1.0, label: 'weight' },
      wingspan: { scale: 3.0, weight: 1.45, label: 'wingspan' },
      standingReach: { scale: 3.0, weight: 1.0, label: 'standing reach' },
    },
  },
  role: {
    weight: 0.22,
    axes: {
      mpg: { scale: 5, weight: 0.45, label: 'minutes/role' },
      usg: { scale: 0.055, weight: 1.0, label: 'usage' },
      fga36: { scale: 3.5, weight: 0.75, label: 'shot volume' },
      ast36: { scale: 2.3, weight: 0.9, label: 'playmaking volume' },
      reb36: { scale: 3.2, weight: 0.65, label: 'rebounding role' },
      tov36: { scale: 1.2, weight: 0.45, label: 'turnover load' },
    },
  },
  scoring: {
    weight: 0.19,
    axes: {
      pts36: { scale: 5.5, weight: 1.0, label: 'scoring rate' },
      ts: { scale: 0.045, weight: 0.8, label: 'true shooting' },
      threeRate: { scale: 0.12, weight: 0.9, label: 'three-point shot share' },
      fg3Pct: { scale: 0.055, weight: 0.45, label: 'three-point accuracy' },
      ftRate: { scale: 0.13, weight: 0.7, label: 'free-throw pressure' },
      fta36: { scale: 2.5, weight: 0.5, label: 'free-throw volume' },
    },
  },
  defense: {
    weight: 0.13,
    axes: {
      stl36: { scale: 0.45, weight: 0.8, label: 'steal activity' },
      blk36: { scale: 0.65, weight: 0.9, label: 'rim protection' },
      drebPct: { scale: 0.055, weight: 0.65, label: 'defensive rebounding' },
      orebPct: { scale: 0.045, weight: 0.35, label: 'offensive rebounding' },
      pie: { scale: 0.035, weight: 0.45, label: 'box-score impact share' },
    },
  },
};
const DEEP = {
  selfCreation: { scale: 22, weight: 1.0, label: 'self-created offense' },
  paintScoring: { scale: 22, weight: 0.9, label: 'paint scoring' },
  rimPressure: { scale: 20, weight: 0.8, label: 'rim pressure' },
  threeVolume: { scale: 20, weight: 0.9, label: 'three-point volume' },
  threeAccuracy: { scale: 20, weight: 0.6, label: 'three-point accuracy' },
  playmaking: { scale: 20, weight: 0.8, label: 'playmaking' },
  ballSecurity: { scale: 20, weight: 0.5, label: 'ball security' },
  steals: { scale: 20, weight: 0.6, label: 'defensive activity' },
  rimProtection: { scale: 20, weight: 0.7, label: 'rim protection' },
};

function blockDistance(target, cand, spec, targetPhysical = false) {
  let acc = 0, w = 0, avail = 0, possible = 0;
  const detail = [];
  for (const [key, a] of Object.entries(spec.axes)) {
    possible += a.weight;
    const x = target[key], y = cand[key];
    if (!fin(x) || !fin(y)) continue;
    avail += a.weight;
    const z = Math.abs(Number(x) - Number(y)) / a.scale;
    const capped = Math.min(z, 4);
    acc += a.weight * capped * capped;
    w += a.weight;
    detail.push({ key, label: a.label, gap: Math.abs(Number(x) - Number(y)), z });
  }
  if (!w) return { distance: null, coverage: 0, detail: [] };
  let distance = Math.sqrt(acc / w);
  // Missing body data is materially worse than missing one style statistic because size is the
  // first screen requested for this product.
  const coverage = possible ? avail / possible : 0;
  if (targetPhysical) distance *= 1 + (1 - coverage) * 0.75;
  return { distance, coverage, detail };
}

function deepDistance(a, b) {
  let acc = 0, w = 0; const detail = [];
  for (const [key, s] of Object.entries(DEEP)) {
    const x = a?.[key], y = b?.[key];
    if (!fin(x) || !fin(y)) continue;
    const z = Math.abs(Number(x) - Number(y)) / s.scale;
    acc += s.weight * Math.min(z, 4) ** 2; w += s.weight;
    detail.push({ key, label: s.label, gap: Math.abs(Number(x) - Number(y)), z });
  }
  return w ? { distance: Math.sqrt(acc / w), detail } : { distance: null, detail: [] };
}

function compare(target, cand, targetDeep, candDeep) {
  const parts = [];
  let total = 0, totalW = 0;
  for (const [name, spec] of Object.entries(BLOCKS)) {
    const a = name === 'physical' ? target.physical : target.features;
    const b = name === 'physical' ? cand.physical : cand.features;
    const d = blockDistance(a, b, spec, name === 'physical');
    if (!fin(d.distance)) continue;
    total += spec.weight * d.distance * d.distance;
    totalW += spec.weight;
    parts.push({ name, weight: spec.weight, ...d });
  }
  const deep = deepDistance(targetDeep, candDeep);
  if (fin(deep.distance)) {
    const w = 0.07; // bonus refinement only; historical candidates are not punished for unavailable tracking.
    total += w * deep.distance * deep.distance; totalW += w;
    parts.push({ name: 'currentStyle', weight: w, distance: deep.distance, coverage: 1, detail: deep.detail });
  }
  if (!totalW) return null;
  let distance = Math.sqrt(total / totalW);

  // Size-first guardrails. These are penalties, not position rules: cross-position comps still work.
  const dh = fin(target.physical.height) && fin(cand.physical.height)
    ? Math.abs(target.physical.height - cand.physical.height) : null;
  const dw = fin(target.physical.weight) && fin(cand.physical.weight)
    ? Math.abs(target.physical.weight - cand.physical.weight) : null;
  const dws = fin(target.physical.wingspan) && fin(cand.physical.wingspan)
    ? Math.abs(target.physical.wingspan - cand.physical.wingspan) : null;
  if (fin(dh) && dh > 4.5) distance += (dh - 4.5) * 0.35;
  if (fin(dw) && dw > 40) distance += (dw - 40) / 35;
  if (fin(dws) && dws > 5) distance += (dws - 5) * 0.18;

  const physical = parts.find((x) => x.name === 'physical');
  const coverage = totalW > 0 ? parts.reduce((a, x) => a + x.weight * (x.coverage ?? 1), 0) / totalW : 0;
  const score = clamp(100 * Math.exp(-0.32 * distance), 0, 100);
  const details = parts.flatMap((x) => x.detail.map((d) => ({ ...d, block: x.name })));
  details.sort((a, b) => a.z - b.z);
  return {
    score, distance, coverage,
    physicalCoverage: physical?.coverage ?? 0,
    blockScores: Object.fromEntries(parts.map((x) => [x.name, r1(100 * Math.exp(-0.32 * x.distance))])),
    best: details.slice(0, 4),
    worst: [...details].sort((a, b) => b.z - a.z).slice(0, 4),
  };
}

function currentHistoricalTarget(p, leagueHist) {
  const pid = String(p.nbaPersonId ?? p.playerId);
  // Prefer the exact committed 2025-26 projection-input row so target/candidate units are identical.
  let row = leagueHist.find((x) => x.playerId === pid && x.season === '2025-26');
  if (row) return row;
  if (!p.appeared || !(p.minutes > 0)) return null;
  const b = bio.get(Number(pid)) || {};
  const c = combine.get(Number(pid)) || {};
  return {
    league: p.league, season: '2025-26', playerId: pid, nbaPersonId: Number(pid), name: p.name,
    team: p.team, position: p.position, age: p.age, gp: p.gp, minutes: p.minutes,
    physical: {
      height: p.heightInches ?? b.height ?? c.heightNoShoes ?? null,
      weight: p.weight ?? b.weight ?? c.combineWeight ?? null,
      wingspan: c.wingspan ?? null, standingReach: c.standingReach ?? null,
    },
    features: {
      mpg: p.mpg, usg: fin(p.usg) ? (Number(p.usg) > 1 ? Number(p.usg) / 100 : Number(p.usg)) : null,
      pts36: per36(p.pts, p.mpg), fga36: per36(p.fga, p.mpg), threeA36: per36(p.fg3a, p.mpg),
      fta36: per36(p.fta, p.mpg), reb36: per36(p.reb, p.mpg), ast36: per36(p.ast, p.mpg),
      stl36: per36(p.stl, p.mpg), blk36: per36(p.blk, p.mpg), tov36: per36(p.tov, p.mpg),
      oreb36: per36(p.oreb, p.mpg), dreb36: per36(p.dreb, p.mpg),
      threeRate: fin(p.fg3a) && fin(p.fga) && p.fga > 0 ? p.fg3a / p.fga : null,
      ftRate: fin(p.fta) && fin(p.fga) && p.fga > 0 ? p.fta / p.fga : null,
      fg3Pct: p.fg3Pct, fgPct: p.fgPct, ftPct: p.ftPct, ts: p.ts,
      astPct: p.astPct, orebPct: p.orebPct, drebPct: p.drebPct, pie: p.pie, pace: p.pace,
    },
  };
}

function fmtSize(x) {
  if (!fin(x)) return null;
  const ft = Math.floor(x / 12), inch = Math.round((x - ft * 12) * 10) / 10;
  return `${ft}'${inch}"`;
}
function relation(target, comp) {
  const t = target.features, c = comp.features;
  const mods = [];
  if (fin(t.threeRate) && fin(c.threeRate) && t.threeRate - c.threeRate > 0.10) mods.push('more three-point oriented');
  else if (fin(t.threeRate) && fin(c.threeRate) && c.threeRate - t.threeRate > 0.10) mods.push('less three-point oriented');
  if (fin(t.ts) && fin(c.ts) && t.ts - c.ts > 0.045) mods.push('more scoring-efficient');
  else if (fin(t.ts) && fin(c.ts) && c.ts - t.ts > 0.045) mods.push('less scoring-efficient');
  if (fin(t.ast36) && fin(c.ast36) && t.ast36 - c.ast36 > 2.2) mods.push('more playmaking-heavy');
  else if (fin(t.ast36) && fin(c.ast36) && c.ast36 - t.ast36 > 2.2) mods.push('less playmaking-heavy');
  if (fin(t.ftRate) && fin(c.ftRate) && t.ftRate - c.ftRate > 0.12) mods.push('more rim/free-throw pressure');
  if (fin(target.physical.weight) && fin(comp.physical.weight) && target.physical.weight - comp.physical.weight > 18) mods.push('stronger/heavier framed');
  else if (fin(target.physical.weight) && fin(comp.physical.weight) && comp.physical.weight - target.physical.weight > 18) mods.push('lighter framed');
  return mods.slice(0, 2);
}
function serializeComp(target, cand, m) {
  const cur = currentByLeaguePid[target.league]?.get(cand.playerId);
  return {
    playerId: cand.playerId, name: cand.name, season: cand.season, team: cand.team, position: cand.position,
    age: r1(cand.age), similarity: r1(m.score), coverage: r1(m.coverage * 100),
    physicalCoverage: r1(m.physicalCoverage * 100),
    heightInches: r1(cand.physical.height), height: fmtSize(cand.physical.height),
    weight: r1(cand.physical.weight), wingspanInches: r1(cand.physical.wingspan),
    wingspan: fmtSize(cand.physical.wingspan), standingReach: fmtSize(cand.physical.standingReach),
    mpg: r1(cand.features.mpg), pts36: r1(cand.features.pts36), reb36: r1(cand.features.reb36),
    ast36: r1(cand.features.ast36), ts: r2(cand.features.ts), threeRate: r2(cand.features.threeRate),
    ftRate: r2(cand.features.ftRate), stl36: r1(cand.features.stl36), blk36: r1(cand.features.blk36),
    blockScores: m.blockScores,
    mostSimilar: m.best.map((x) => x.label),
    biggestDifferences: m.worst.map((x) => ({ label: x.label, normalizedGap: r1(x.z) })),
    relation: relation(target, cand),
    currentSeasonDetailed: !!cur,
  };
}

const result = { NBA: {}, GLEAGUE: {} };
for (const lg of ['NBA', 'GLEAGUE']) {
  const pool = histories[lg];
  const minMinutes = lg === 'NBA' ? 300 : 200;
  for (const p of data.leagues?.[lg] || []) {
    if (!p.appeared || !(p.minutes > 0)) continue;
    const target = currentHistoricalTarget(p, pool);
    if (!target) continue;
    const targetDeep = deepOverlay(p);
    const top = [];
    for (const cand of pool) {
      if (cand.playerId === target.playerId || cand.minutes < minMinutes) continue;
      const candCurrent = cand.season === '2025-26' ? currentByLeaguePid[lg].get(cand.playerId) : null;
      const m = compare(target, cand, targetDeep, deepOverlay(candCurrent));
      if (!m) continue;
      // Prefer known body matches when target body is known. This is a soft penalty, not exclusion.
      let score = m.score;
      if ((fin(target.physical.height) || fin(target.physical.weight)) && m.physicalCoverage < 0.45) score *= 0.82;
      const item = { cand, m: { ...m, score } };
      if (top.length < 8) {
        top.push(item); top.sort((a, b) => b.m.score - a.m.score);
      } else if (score > top.at(-1).m.score) {
        top[top.length - 1] = item; top.sort((a, b) => b.m.score - a.m.score);
      }
    }
    const best = top.slice(0, 3).map((x) => serializeComp(target, x.cand, x.m));
    if (!best.length) continue;
    const total = best.reduce((a, x) => a + Math.max(1, x.similarity), 0);
    const blend = best.map((x) => ({ name: x.name, season: x.season, share: Math.round(100 * Math.max(1, x.similarity) / total) }));
    // Make integer shares add to 100.
    if (blend.length) blend[0].share += 100 - blend.reduce((a, x) => a + x.share, 0);
    const primary = best[0], rel = primary.relation || [];
    result[lg][String(p.playerId)] = {
      top3: best,
      blend,
      shorthand: rel.length
        ? `A ${rel.join(', ')} version of ${primary.name} (${primary.season}), with the rest of the blend pulled toward ${best.slice(1).map((x) => x.name).join(' and ') || 'the same comp'}.`
        : `Closest overall style/physical match: ${primary.name} (${primary.season}); the three-player blend adds ${best.slice(1).map((x) => x.name).join(' and ') || 'no additional comp'}.`,
      targetPhysical: {
        heightInches: r1(target.physical.height), height: fmtSize(target.physical.height),
        weight: r1(target.physical.weight), wingspanInches: r1(target.physical.wingspan),
        wingspan: fmtSize(target.physical.wingspan), standingReach: fmtSize(target.physical.standingReach),
      },
    };
  }
}

data.analysis = data.analysis || {};
data.analysis.playerComps = result;
data.analysis.playerCompsMeta = {
  version: '1.0.0',
  generatedAt: process.env.BUILD_GENERATED_AT || new Date().toISOString(),
  sameLeagueOnly: true,
  nbaHistory: '2009-10 through 2025-26',
  gleagueHistory: '2014-15 through 2025-26',
  priority: 'physical profile first, then role/production, scoring mix, defensive activity; current-season deep style used when common',
  physicalWeight: 0.46,
  positionGate: false,
  minimumHistoricalMinutes: { NBA: 300, GLEAGUE: 200 },
  combineMeasurementsLoaded: combine.size,
  combineNote: combine.size
    ? 'Listed professional height/weight stay primary; official combine wingspan and standing reach are added where measured. Players who never attended keep those length fields blank.'
    : 'No combine measurement cache was present in this build. Height/weight still drive the physical block; wingspan/reach remain blank rather than invented.',
  limitations: [
    'Historical shot-zone/tracking coverage is not uniform across seasons, so old player-seasons are compared on the common historical feature set rather than fabricated paint/mid-range data.',
    'G League historical body coverage is thinner for players who never appeared in the NBA player index.',
    'A player can match across listed positions; position labels are descriptive, not a hard filter.',
  ],
};
fs.writeFileSync(DATA_PATH, JSON.stringify(data));
console.log(`player comps: NBA ${Object.keys(result.NBA).length}, G League ${Object.keys(result.GLEAGUE).length}; combine rows ${combine.size}`);

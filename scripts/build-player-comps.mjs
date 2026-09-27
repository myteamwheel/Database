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

// Current site records fill G League/current-player physical gaps that the NBA player index does not
// cover. This never backfills an old season with a made-up body; it only supplies known listed bio
// information for that actual person.
for (const lg of ['NBA', 'GLEAGUE']) {
  for (const p of data.leagues?.[lg] || []) {
    const pid = Number(p.nbaPersonId ?? p.playerId);
    if (!pid) continue;
    const old = bio.get(pid) || { playerId: pid, name: p.name || String(pid) };
    bio.set(pid, {
      ...old,
      name: old.name || p.name || String(pid),
      position: old.position || p.position || null,
      height: old.height ?? n(p.heightInches) ?? inches(p.height),
      weight: old.weight ?? n(p.weight),
    });
  }
}

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
        team: x.TEAM_ABBREVIATION || null, teamId: n(x.TEAM_ID), position: b.position || null,
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
          pf36: per36(n(x.PF), minutes),
          plusMinus36: per36(n(x.PLUS_MINUS), minutes),
          oreb36: per36(n(x.OREB), minutes),
          dreb36: per36(n(x.DREB), minutes),
          threeRate: fin(fga) && fga > 0 && fin(fg3a) ? fg3a / fga : null,
          ftRate: fin(fga) && fga > 0 && fin(fta) ? fta / fga : null,
          fg3Pct: fin(fg3a) && fg3a >= 15 && fin(fg3m) ? fg3m / fg3a : null,
          fgPct: fin(fga) && fga > 0 && fin(fgm) ? fgm / fga : null,
          efgPct: fin(fga) && fga > 0 && fin(fgm) && fin(fg3m) ? (fgm + 0.5 * fg3m) / fga : null,
          ftPct: fin(fta) && fta >= 10 && fin(ftm) ? ftm / fta : null,
          ts,
          astPct: n(a.AST_PCT),
          astTo: n(a.AST_TO),
          astRatio: n(a.AST_RATIO),
          orebPct: n(a.OREB_PCT),
          drebPct: n(a.DREB_PCT),
          rebPct: n(a.REB_PCT),
          offRtg: n(a.OFF_RATING),
          defRtg: n(a.DEF_RATING),
          netRtg: n(a.NET_RATING),
          tmTovPct: n(a.TM_TOV_PCT),
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
  const st = p?.stats || {};
  const cu = p?.custom || {};
  return {
    selfCreation: n(s.selfCreation), paintScoring: n(s.paintScoring), rimPressure: n(s.rimPressure),
    threeVolume: n(s.threeVolume), threeAccuracy: n(s.threeAccuracy), shootingEff: n(s.shootingEff),
    playmaking: n(s.playmaking), assistRate: n(s.assistRate), ballSecurity: n(s.ballSecurity),
    offRebounding: n(s.offRebounding), defRebounding: n(s.defRebounding),
    steals: n(s.steals), rimProtection: n(s.rimProtection), usagePctile: n(s.usage),
    // Direct current-season shot-shape signals. These answer "where/how does he shoot?" much more
    // literally than a generic efficiency number: paint share, mid-range share, catch-and-shoot
    // volume and pull-up volume. They are only used when both players actually carry the field.
    pctPtsPaint: n(st.oscore_pct_pts_paint),
    pctPtsMidrange: n(st.oscore_pct_pts_2pt_mr),
    catchShootFga: n(st.trk_catchshoot_catch_shoot_fga),
    pullUpFga: n(st.trk_pullup_pull_up_fga),
    paintPts36: n(cu.paintPts36Raw ?? cu.paintPts36),
    selfCreatedPts36: n(cu.selfCreatedPts36Raw ?? cu.selfCreatedPts36),
    shotLocationValue: n(cu.shotLocationValue),
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
    // Archetype/role block: creation load, shot volume, playmaking and rebounding shape.
    weight: 0.22,
    axes: {
      mpg: { scale: 5, weight: 0.45, label: 'minutes/role' },
      usg: { scale: 0.055, weight: 1.0, label: 'usage' },
      fga36: { scale: 3.5, weight: 0.75, label: 'shot volume' },
      ast36: { scale: 2.3, weight: 0.9, label: 'playmaking volume' },
      reb36: { scale: 3.2, weight: 0.65, label: 'rebounding role' },
      tov36: { scale: 1.2, weight: 0.45, label: 'turnover load' },
      astPct: { scale: 0.075, weight: 0.45, label: 'assist rate' },
      astTo: { scale: 1.1, weight: 0.25, label: 'assist-to-turnover profile' },
      astRatio: { scale: 6, weight: 0.18, label: 'assist ratio' },
      tmTovPct: { scale: 0.045, weight: 0.18, label: 'team-turnover share context' },
      rebPct: { scale: 0.055, weight: 0.30, label: 'total rebounding rate' },
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
      efgPct: { scale: 0.045, weight: 0.45, label: 'effective field-goal percentage' },
      fgPct: { scale: 0.045, weight: 0.25, label: 'field-goal percentage' },
      ftPct: { scale: 0.085, weight: 0.15, label: 'free-throw accuracy' },
      offRtg: { scale: 7, weight: 0.12, label: 'offensive rating context' },
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
      defRtg: { scale: 7, weight: 0.20, label: 'defensive rating context' },
      netRtg: { scale: 9, weight: 0.18, label: 'net-rating context' },
      plusMinus36: { scale: 6, weight: 0.12, label: 'plus-minus per 36 context' },
      pf36: { scale: 1.4, weight: 0.12, label: 'foul activity' },
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
  pctPtsPaint: { scale: 0.12, weight: 0.8, label: 'paint scoring share' },
  pctPtsMidrange: { scale: 0.10, weight: 0.8, label: 'mid-range scoring share' },
  catchShootFga: { scale: 2.5, weight: 0.65, label: 'catch-and-shoot volume' },
  pullUpFga: { scale: 2.5, weight: 0.7, label: 'pull-up volume' },
  paintPts36: { scale: 4.0, weight: 0.65, label: 'paint scoring per 36' },
  selfCreatedPts36: { scale: 4.0, weight: 0.7, label: 'self-created scoring per 36' },
  shotLocationValue: { scale: 18, weight: 0.45, label: 'shot-location profile' },
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

function similarityFromDistance(distance) {
  if (!fin(distance)) return null;
  // Absolute similarity calibration, not rank normalization:
  // ~90 = extremely close, ~65 = strong, ~50 = moderate, ~35 = loose, <35 = weak reference.
  // The steeper curve prevents the top three nearest neighbors from all looking artificially equal.
  return clamp(100 * Math.exp(-0.72 * Math.pow(Math.max(0, distance), 1.55)), 0, 100);
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
  const score = similarityFromDistance(distance);
  const details = parts.flatMap((x) => x.detail.map((d) => ({ ...d, block: x.name })));
  details.sort((a, b) => a.z - b.z);
  return {
    score, distance, coverage,
    physicalCoverage: physical?.coverage ?? 0,
    blockScores: Object.fromEntries(parts.map((x) => [x.name, r1(similarityFromDistance(x.distance))])),
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
      pf36: per36(p.pf, p.mpg), plusMinus36: per36(p.plusMinus, p.mpg),
      oreb36: per36(p.oreb, p.mpg), dreb36: per36(p.dreb, p.mpg),
      threeRate: fin(p.fg3a) && fin(p.fga) && p.fga > 0 ? p.fg3a / p.fga : null,
      ftRate: fin(p.fta) && fin(p.fga) && p.fga > 0 ? p.fta / p.fga : null,
      fg3Pct: p.fg3Pct, fgPct: p.fgPct, ftPct: p.ftPct, ts: p.ts,
      astPct: p.astPct, astTo: p.astTo, astRatio: p.astRatio,
      orebPct: p.orebPct, drebPct: p.drebPct, rebPct: p.rebPct,
      offRtg: p.offRtg, defRtg: p.defRtg, netRtg: p.netRtg, tmTovPct: p.tmTovPct,
      pie: p.pie, pace: p.pace,
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
  if (fin(t.fg3Pct) && fin(c.fg3Pct) && t.fg3Pct - c.fg3Pct > 0.04) mods.push('better three-point shooting');
  else if (fin(t.fg3Pct) && fin(c.fg3Pct) && c.fg3Pct - t.fg3Pct > 0.04) mods.push('worse three-point shooting');
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
    playerId: cand.playerId, league: cand.league, name: cand.name, season: cand.season,
    team: cand.team, teamId: cand.teamId ?? null, position: cand.position,
    age: r1(cand.age), similarity: r1(m.score), coverage: r1(m.coverage * 100),
    physicalCoverage: r1(m.physicalCoverage * 100),
    heightInches: r1(cand.physical.height), height: fmtSize(cand.physical.height),
    weight: r1(cand.physical.weight), wingspanInches: r1(cand.physical.wingspan),
    wingspan: fmtSize(cand.physical.wingspan), standingReach: fmtSize(cand.physical.standingReach),
    mpg: r1(cand.features.mpg), usg: r2(cand.features.usg),
    pts36: r1(cand.features.pts36), fga36: r1(cand.features.fga36), threeA36: r1(cand.features.threeA36),
    fta36: r1(cand.features.fta36), reb36: r1(cand.features.reb36), ast36: r1(cand.features.ast36),
    tov36: r1(cand.features.tov36), pf36: r1(cand.features.pf36), plusMinus36: r1(cand.features.plusMinus36),
    oreb36: r1(cand.features.oreb36), dreb36: r1(cand.features.dreb36),
    fgPct: r2(cand.features.fgPct), efgPct: r2(cand.features.efgPct), fg3Pct: r2(cand.features.fg3Pct),
    ftPct: r2(cand.features.ftPct), ts: r2(cand.features.ts), threeRate: r2(cand.features.threeRate),
    ftRate: r2(cand.features.ftRate), astPct: r2(cand.features.astPct),
    astTo: r2(cand.features.astTo), astRatio: r2(cand.features.astRatio),
    orebPct: r2(cand.features.orebPct), drebPct: r2(cand.features.drebPct), rebPct: r2(cand.features.rebPct),
    offRtg: r1(cand.features.offRtg), defRtg: r1(cand.features.defRtg), netRtg: r1(cand.features.netRtg),
    tmTovPct: r2(cand.features.tmTovPct), pie: r2(cand.features.pie), stl36: r1(cand.features.stl36), blk36: r1(cand.features.blk36),
    style: deepOverlay(cur),
    blockScores: m.blockScores,
    mostSimilar: m.best.map((x) => x.label),
    biggestDifferences: m.worst.map((x) => ({ label: x.label, normalizedGap: r1(x.z) })),
    relation: relation(target, cand),
    currentSeasonDetailed: !!cur,
  };
}

function blendQuality(comp) {
  const b = comp.blockScores || {};
  const blocks = [b.physical, b.role, b.scoring, b.defense].filter(fin);
  const overall = fin(comp.similarity) ? Number(comp.similarity) : 0;
  const physical = fin(b.physical) ? Number(b.physical) : overall;
  const role = fin(b.role) ? Number(b.role) : overall;
  const scoring = fin(b.scoring) ? Number(b.scoring) : overall;
  const defense = fin(b.defense) ? Number(b.defense) : overall;

  // Use the absolute match as the backbone, then reward agreement across the four interpretable
  // blocks. This stops one spectacular dimension from dominating an otherwise weak comp.
  const composite = 0.55 * overall + 0.20 * physical + 0.10 * role + 0.10 * scoring + 0.05 * defense;
  const maxBlock = blocks.length ? Math.max(...blocks) : overall;
  const minBlock = blocks.length ? Math.min(...blocks) : overall;
  const harmony = maxBlock > 0 ? minBlock / maxBlock : 0;
  const coverage = fin(comp.coverage) ? clamp(Number(comp.coverage) / 100, 0, 1) : 0.75;
  return composite * (0.82 + 0.12 * coverage + 0.06 * harmony);
}

function blendShares(comps) {
  if (!comps.length) return [];
  const q = comps.map(blendQuality);
  const maxQ = Math.max(...q);
  // Softmax temperature of 8 points. Meaningful quality gaps produce visibly different blend
  // shares, while truly near-equal comps remain near one-third each.
  const raw = q.map((x) => Math.exp((x - maxQ) / 8));
  const sum = raw.reduce((a, x) => a + x, 0) || 1;
  const exact = raw.map((x) => 100 * x / sum);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, x) => a + x, 0);
  const order = exact.map((x, i) => ({ i, rem: x - floors[i] }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let j = 0; j < left; j++) floors[order[j % order.length].i]++;
  return comps.map((comp, i) => ({
    name: comp.name, season: comp.season, playerId: comp.playerId,
    share: floors[i], quality: r1(q[i]), matchScore: comp.similarity,
  }));
}

function blendConfidence(comps, blend) {
  if (!comps.length || !blend.length) return null;
  const weighted = comps.reduce((acc, comp, i) => acc + (blend[i].share / 100) * Number(comp.similarity || 0), 0);
  const coverage = comps.reduce((acc, comp, i) => acc + (blend[i].share / 100) * Number(comp.coverage || 0), 0) / 100;
  return r1(clamp(weighted * (0.88 + 0.12 * coverage), 0, 100));
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
    // Pool is player-SEASON based, but the requested output is three distinct PLAYERS. Keep only
    // each candidate player's single best-matching historical season before ranking the final three.
    const bestByPlayer = new Map();
    for (const cand of pool) {
      if (cand.playerId === target.playerId || cand.minutes < minMinutes) continue;
      const candCurrent = cand.season === '2025-26' ? currentByLeaguePid[lg].get(cand.playerId) : null;
      const m = compare(target, cand, targetDeep, deepOverlay(candCurrent));
      if (!m) continue;
      // Prefer known body matches when target body is known. This is a soft penalty, not exclusion.
      let score = m.score;
      if ((fin(target.physical.height) || fin(target.physical.weight)) && m.physicalCoverage < 0.45) score *= 0.82;
      const item = { cand, m: { ...m, score } };
      const prior = bestByPlayer.get(cand.playerId);
      if (!prior || item.m.score > prior.m.score) bestByPlayer.set(cand.playerId, item);
    }
    const top = [...bestByPlayer.values()].sort((a, b) => b.m.score - a.m.score).slice(0, 3);
    const best = top.map((x) => serializeComp(target, x.cand, x.m));
    if (!best.length) continue;
    const blend = blendShares(best);
    const confidence = blendConfidence(best, blend);
    const primary = best[0], rel = primary.relation || [];
    result[lg][String(p.playerId)] = {
      top3: best,
      blend,
      blendConfidence: confidence,
      matchSummary: blend.map((x) => ({ name: x.name, season: x.season, share: x.share, matchScore: x.matchScore })),
      shorthand: rel.length
        ? `A ${rel.join(', ')} blend led by ${primary.name} (${primary.season}).`
        : `Historical blend led by ${primary.name} (${primary.season}).`,
      targetPhysical: {
        heightInches: r1(target.physical.height), height: fmtSize(target.physical.height),
        weight: r1(target.physical.weight), wingspanInches: r1(target.physical.wingspan),
        wingspan: fmtSize(target.physical.wingspan), standingReach: fmtSize(target.physical.standingReach),
      },
      targetStats: {
        mpg: r1(target.features.mpg), usg: r2(target.features.usg),
        pts36: r1(target.features.pts36), fga36: r1(target.features.fga36), threeA36: r1(target.features.threeA36),
        fta36: r1(target.features.fta36), reb36: r1(target.features.reb36), ast36: r1(target.features.ast36),
        tov36: r1(target.features.tov36), pf36: r1(target.features.pf36), plusMinus36: r1(target.features.plusMinus36),
        oreb36: r1(target.features.oreb36), dreb36: r1(target.features.dreb36),
        fgPct: r2(target.features.fgPct), efgPct: r2(target.features.efgPct), fg3Pct: r2(target.features.fg3Pct),
        ftPct: r2(target.features.ftPct), ts: r2(target.features.ts), threeRate: r2(target.features.threeRate),
        ftRate: r2(target.features.ftRate), astPct: r2(target.features.astPct),
        astTo: r2(target.features.astTo), astRatio: r2(target.features.astRatio),
        orebPct: r2(target.features.orebPct), drebPct: r2(target.features.drebPct), rebPct: r2(target.features.rebPct),
        offRtg: r1(target.features.offRtg), defRtg: r1(target.features.defRtg), netRtg: r1(target.features.netRtg),
        tmTovPct: r2(target.features.tmTovPct), pie: r2(target.features.pie), stl36: r1(target.features.stl36), blk36: r1(target.features.blk36),
      },
      targetStyle: targetDeep,
    };
  }
}

// Product contract: every player who actually appeared in the current source season must receive
// exactly three DISTINCT same-league historical player comps. Fail the build rather than silently
// shipping a partial comparison card for an edge-case player.
for (const lg of ['NBA', 'GLEAGUE']) {
  const expectedIds = (data.leagues?.[lg] || [])
    .filter((p) => p.appeared && Number(p.minutes) > 0)
    .map((p) => String(p.playerId));
  const missing = expectedIds.filter((id) => !result[lg][id]);
  const short = Object.entries(result[lg]).filter(([, set]) =>
    (set.top3 || []).length !== 3 || new Set((set.top3 || []).map((x) => String(x.playerId))).size !== 3);
  const wrongLeague = Object.entries(result[lg]).filter(([, set]) =>
    (set.top3 || []).some((x) => x.league !== lg));
  const badBlend = Object.entries(result[lg]).filter(([, set]) =>
    (set.blend || []).length !== 3
    || set.blend.reduce((a, x) => a + Number(x.share || 0), 0) !== 100
    || !fin(set.blendConfidence));
  if (missing.length || short.length || wrongLeague.length || badBlend.length) {
    throw new Error(`player comps contract failed for ${lg}: missing=${missing.length}, short/duplicate=${short.length}, wrongLeague=${wrongLeague.length}, badBlend=${badBlend.length}`);
  }
}

const pct = (arr, q) => {
  const x = arr.filter(fin).slice().sort((a, b) => a - b);
  if (!x.length) return null;
  const i = (x.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return r1(x[lo] + (x[hi] - x[lo]) * (i - lo));
};
const scoreDistribution = {}, blendDistribution = {};
for (const lg of ['NBA', 'GLEAGUE']) {
  const sets = Object.values(result[lg]);
  const top1 = sets.map((set) => set.top3?.[0]?.similarity).filter(fin);
  const all = sets.flatMap((set) => (set.top3 || []).map((x) => x.similarity)).filter(fin);
  const leadShares = sets.map((set) => Math.max(...(set.blend || []).map((x) => Number(x.share || 0)))).filter(fin);
  const confidences = sets.map((set) => set.blendConfidence).filter(fin);
  const nearThird = sets.filter((set) => {
    const s = (set.blend || []).map((x) => Number(x.share || 0));
    return s.length === 3 && Math.max(...s) - Math.min(...s) <= 4;
  }).length;
  const patterns = new Set(sets.map((set) => (set.blend || []).map((x) => x.share).join('/')));
  scoreDistribution[lg] = {
    top1: { min: r1(Math.min(...top1)), p10: pct(top1, .10), median: pct(top1, .50), p90: pct(top1, .90), max: r1(Math.max(...top1)) },
    allCandidates: { min: r1(Math.min(...all)), median: pct(all, .50), max: r1(Math.max(...all)) },
  };
  blendDistribution[lg] = {
    leadShare: { min: r1(Math.min(...leadShares)), p10: pct(leadShares, .10), median: pct(leadShares, .50), p90: pct(leadShares, .90), max: r1(Math.max(...leadShares)) },
    confidence: { p10: pct(confidences, .10), median: pct(confidences, .50), p90: pct(confidences, .90) },
    nearThirdCount: nearThird,
    total: sets.length,
    distinctSharePatterns: patterns.size,
  };
  console.log(`player comps ${lg} blend distribution: ${JSON.stringify(blendDistribution[lg])}`);
}

data.analysis = data.analysis || {};
data.analysis.playerComps = result;
data.analysis.playerCompsMeta = {
  version: '1.0.0',
  generatedAt: process.env.BUILD_GENERATED_AT || new Date().toISOString(),
  sameLeagueOnly: true,
  nbaHistory: '2009-10 through 2025-26',
  gleagueHistory: '2014-15 through 2025-26',
  priority: 'physical profile first, then archetype/role and production, scoring mix, defensive activity; current-season deep style used when common',
  physicalWeight: 0.46,
  similarityScale: 'internal absolute match score: 100*exp(-0.72*distance^1.55)',
  blendMethod: 'three nearest distinct players; quality = 55% absolute match + 20% physical + 10% role + 10% scoring + 5% defense, adjusted for coverage/block harmony; softmax temperature 8; integer shares use largest-remainder rounding and always total 100',
  blendConfidence: 'blend-share-weighted absolute match score with a small feature-coverage adjustment',
  scoreDistribution,
  blendDistribution,
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

// 2025-26 NBA + NBA G League ranked performance database — build v3.
//
// v2 was built entirely from Basketball-Reference because stats.nba.com does not answer
// from GitHub-hosted runners. It does answer from a normal machine, so v3 uses the
// official source as the backbone and keeps Basketball-Reference as a second opinion.
// That closes v2's real gaps: G League ages (38% missing), G League listed positions
// (68% inferred), and the entire BPM/VORP-family impact tier (100% missing).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOfficial, byId, resolveName, num, round } from './lib/sources.mjs';
import { combineHalves } from './lib/combine.mjs';
import { computeCustom, computeGrades, cohortRanks, COMPONENT_WEIGHTS, COMPONENT_INGREDIENTS } from './lib/metrics.mjs';
import { buildStints, positionFamily } from './lib/roster.mjs';
import { buildSplits, loadRoster, ageAt, OPENING_NIGHT, FEB_FIRST } from './lib/splits.mjs';
import { buildCatalog, TOP_LEVEL_CATALOG } from './lib/catalog.mjs';


const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = '2025-26';
/** Birthdates, so age is stated against a fixed date instead of inherited from a source. */
const bdPath = path.join(ROOT, 'scripts/data/birthdates.json');
const birthdates = fs.existsSync(bdPath) ? JSON.parse(fs.readFileSync(bdPath, 'utf8')) : {};


/* ------------------------------------------------------------------ sources */

function halvesFor(dir) {
  const sets = {
    totals: loadOfficial(dir, 'base_totals'),
    advanced: loadOfficial(dir, 'advanced'),
    misc: loadOfficial(dir, 'misc'),
    scoring: loadOfficial(dir, 'scoring'),
    usage: loadOfficial(dir, 'usage'),
    defense: loadOfficial(dir, 'defense'),
  };
  const idx = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, byId(v)]));
  const ids = new Set(sets.totals.map((r) => r.PLAYER_ID));
  const out = new Map();
  for (const id of ids) {
    out.set(id, Object.fromEntries(Object.entries(idx).map(([k, m]) => [k, m.get(id) || null])));
  }
  return out;
}

function extraFor(dir, files) {
  const out = {};
  for (const f of files) {
    const rows = loadOfficial(dir, f);
    if (rows.length) out[f] = byId(rows, rows[0].PERSON_ID !== undefined ? 'PERSON_ID' : 'PLAYER_ID');
  }
  return out;
}

/** Per-player bio lookups for the 39 players absent from the bulk bio dashboards. */
const bioPatchPath = path.join(ROOT, 'scripts/data/player_bios.json');
const bioPatch = fs.existsSync(bioPatchPath) ? JSON.parse(fs.readFileSync(bioPatchPath, 'utf8')) : {};

/** Basketball-Reference v2 build, reused as the second source (no re-scrape). */
const brefBuild = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/bref_build_v2.json'), 'utf8'));
const brefIndex = {
  NBA: new Map(brefBuild.leagues.NBA.map((p) => [resolveName(p.name), p])),
  GLEAGUE: new Map(brefBuild.leagues.GLEAGUE.map((p) => [resolveName(p.name), p])),
};

/* ------------------------------------------------------------- record build */

function flat(prefix, obj, skip = new Set()) {
  const out = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || k.endsWith('_RANK')) continue;
    if (v === null || v === undefined || v === '') continue;
    out[`${prefix}_${k.toLowerCase()}`] = typeof v === 'number' ? round(v, 4) : v;
  }
  return out;
}

/** Treat the API's placeholder strings as absent. */
const blank = (v) => {
  const s = typeof v === 'string' ? v.trim() : v;
  return s && s !== 'None' && s !== 'Unknown' && s !== '-' ? s : null;
};

/** Fraction (0-1) from stats.nba.com -> percentage points, the conventional presentation. */
const pctPoints = (v) => (num(v) === null ? null : num(v) * 100);

/** "6-11" -> 83 inches. */
function heightToInches(h) {
  if (!h || typeof h !== 'string' || !h.includes('-')) return null;
  const [ft, inch] = h.split('-').map(Number);
  return Number.isFinite(ft) && Number.isFinite(inch) ? ft * 12 + inch : null;
}

const ID_COLS = new Set(['PLAYER_ID', 'PLAYER_NAME', 'NICKNAME', 'TEAM_ID', 'TEAM_ABBREVIATION',
  'PERSON_ID', 'PLAYER_LAST_NAME', 'PLAYER_FIRST_NAME', 'PLAYER_SLUG', 'TEAM_SLUG',
  'TEAM_CITY', 'TEAM_NAME', 'STATS_TIMEFRAME']);

/**
 * Sum a tracking measure across both halves of the season.
 * Regular-season-only tracking beside a combined-season headline line was an audit finding:
 * the Shooting view showed 40 games of production next to 29 games of catch-and-shoot.
 */
function combinedTracking(regularDir, showcaseDir, names) {
  const out = new Map();
  for (const name of names) {
    const rs = byId(loadOfficial(regularDir, `${name}_totals`));
    const sc = showcaseDir ? byId(loadOfficial(showcaseDir, `${name}_totals`)) : new Map();
    if (!rs.size && !sc.size) continue;
    for (const id of new Set([...rs.keys(), ...sc.keys()])) {
      const a = rs.get(id), b = sc.get(id);
      const merged = {};
      for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        if (key.endsWith('_RANK')) continue;
        const x = num(a?.[key]), y = num(b?.[key]);
        if (x === null && y === null) continue;
        merged[key] = typeof (a?.[key] ?? b?.[key]) === 'number' ? (x || 0) + (y || 0) : (a?.[key] ?? b?.[key]);
      }
      // Percentages must be re-derived from the summed totals, never added.
      const g = (k) => num(merged[k]) || 0;
      if (name === 'pt_catchshoot') {
        if (g('CATCH_SHOOT_FGA')) merged.CATCH_SHOOT_FG_PCT = g('CATCH_SHOOT_FGM') / g('CATCH_SHOOT_FGA');
        if (g('CATCH_SHOOT_FG3A')) merged.CATCH_SHOOT_FG3_PCT = g('CATCH_SHOOT_FG3M') / g('CATCH_SHOOT_FG3A');
      } else if (name === 'pt_pullup') {
        if (g('PULL_UP_FGA')) merged.PULL_UP_FG_PCT = g('PULL_UP_FGM') / g('PULL_UP_FGA');
        if (g('PULL_UP_FG3A')) merged.PULL_UP_FG3_PCT = g('PULL_UP_FG3M') / g('PULL_UP_FG3A');
      }
      if (!out.has(id)) out.set(id, {});
      Object.assign(out.get(id), Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [`${name.replace(/^pt_/, '')}_${k}`, v])));
    }
  }
  return out;
}

function buildLeague({ league, leagueLabel, regularDir, showcaseDir, extraDir, extraFiles,
                      stintHalves, combineTracking, splitDirs, rosterFile }) {
  const rsHalves = halvesFor(regularDir);
  const scHalves = showcaseDir ? halvesFor(showcaseDir) : new Map();
  const extras = extraFor(extraDir, extraFiles);
  const stints = buildStints(stintHalves);
  const splits = splitDirs ? buildSplits(splitDirs) : new Map();
  const trackCombined = combineTracking ? combinedTracking(regularDir, showcaseDir, combineTracking) : new Map();
  // Official per-36 and per-100 tables were being downloaded and then discarded.
  // Named *Rows to avoid shadowing the per-100 helper used inside the record loop.
  const per36Rows = byId(loadOfficial(regularDir, 'base_per36'));
  const per100Rows = byId(loadOfficial(regularDir, 'base_per100'));

  const bios = byId(loadOfficial(extraDir, 'bios'));
  const pindexRows = loadOfficial(extraDir, 'playerindex');
  const pindex = byId(pindexRows, 'PERSON_ID');

  const ids = new Set([...rsHalves.keys(), ...scHalves.keys()]);
  const records = [];

  for (const id of ids) {
    const rs = rsHalves.get(id) || {};
    const sc = scHalves.get(id) || {};
    const anchor = rs.totals || sc.totals;
    if (!anchor) continue;

    const o = combineHalves(rs, sc);
    const t = o.totals;
    const gp = t.GP || 0;
    const pg = (v) => (gp > 0 && num(v) !== null ? round(num(v) / gp, 3) : null);

    const bio = bios.get(id) || null;
    const pi = pindex.get(id) || null;
    const patch = bioPatch[String(id)] || null;
    const bref = brefIndex[league].get(resolveName(anchor.PLAYER_NAME)) || null;

    // Position: official listed position first, Basketball-Reference second.
    let position = null, positionSource = null;
    if (pi && pi.POSITION) { position = pi.POSITION; positionSource = 'official-listed'; }
    else if (bref && bref.position) { position = bref.position; positionSource = 'basketball-reference'; }

    const poss = num(o.advanced.POSS);
    const per100 = (v) => (poss > 0 && num(v) !== null ? round((100 * num(v)) / poss, 2) : null);

    const stats = {
      ...flat('off', { ...t, ...o.exact }, ID_COLS),
      ...flat('oadv', o.advanced, ID_COLS),
      ...flat('omisc', o.misc, ID_COLS),
      ...flat('oscore', o.scoring, ID_COLS),
      ...flat('ousage', o.usage, ID_COLS),
      ...flat('odef', o.defense, ID_COLS),
      ...flat('obio', bio, ID_COLS),
    };
    for (const [f, m] of Object.entries(extras)) {
      const row = m.get(id);
      if (row) Object.assign(stats, flat(f.replace(/^pt_/, 'trk_'), row, ID_COLS));
    }
    // Season-consistent tracking overwrites the regular-season-only version above.
    const tc = trackCombined.get(id);
    if (tc) Object.assign(stats, flat('trk', tc, ID_COLS));
    const sp = splits.get(id);
    if (sp) for (const [name, rec] of Object.entries(sp)) {
      Object.assign(stats, flat(`sit_${name}`, rec, ID_COLS));
    }
    Object.assign(stats, flat('op36', per36Rows.get(id), ID_COLS));
    Object.assign(stats, flat('op100', per100Rows.get(id), ID_COLS));
    // Half-season splits, so the combination is inspectable rather than asserted.
    if (rs.totals) Object.assign(stats, flat('split_reg', rs.totals, ID_COLS));
    if (sc.totals) Object.assign(stats, flat('split_showcase', sc.totals, ID_COLS));
    // Basketball-Reference second opinion (adds PER / win shares / BPM family for NBA).
    if (bref) {
      for (const [k, v] of Object.entries(bref.stats || {})) {
        if (v === null || v === undefined || v === '') continue;
        stats[`bref_${k}`] = v;
      }
    }

    records.push({
      league, leagueLabel, season: SEASON,
      playerId: String(id),
      nbaPersonId: id,
      brefId: bref ? bref.playerId : null,
      name: anchor.PLAYER_NAME,
      team: anchor.TEAM_ABBREVIATION,
      teamCount: num(anchor.TEAM_COUNT),
      position, positionSource,
      positionFamily: positionFamily(position),
      teams: stints.get(id) || [],
      // NBA.com's listed age. Basketball-Reference's season age (age on 1 February of
      // the season) runs a year lower for anyone with a February-to-August birthday,
      // so both are carried rather than silently picking one.
      age: num(bio?.AGE) ?? num(anchor.AGE) ?? (bref ? num(bref.age) : null),
      seasonAge: bref ? num(bref.age) : null,
      // Deterministic ages from a real birthdate. `age` above is whatever the source listed;
      // these two are unambiguous, which is what an "age 22 season" query actually needs.
      birthdate: birthdates[String(id)]?.birthdate || null,
      ageOpeningNight: ageAt(birthdates[String(id)]?.birthdate, OPENING_NIGHT),
      ageFeb1: ageAt(birthdates[String(id)]?.birthdate, FEB_FIRST),
      height: pi?.HEIGHT || bio?.PLAYER_HEIGHT || patch?.height || null,
      heightInches: num(bio?.PLAYER_HEIGHT_INCHES) ?? heightToInches(patch?.height),
      weight: num(bio?.PLAYER_WEIGHT) || num(pi?.WEIGHT) || num(patch?.weight) || null,
      // The API writes the literal string "None" for players with no college.
      college: blank(bio?.COLLEGE) || blank(pi?.COLLEGE) || blank(patch?.school) || null,
      country: blank(bio?.COUNTRY) || blank(pi?.COUNTRY) || blank(patch?.country) || null,
      jersey: pi?.JERSEY_NUMBER || null,
      // "Undrafted" is a fact; a missing record is not. Kept apart so the interface can say
      // "draft status unknown" instead of asserting the player went undrafted.
      draftYear: blank(bio?.DRAFT_YEAR) || blank(pi?.DRAFT_YEAR) || blank(patch?.draftYear) || null,
      draftRound: blank(bio?.DRAFT_ROUND) || blank(pi?.DRAFT_ROUND) || blank(patch?.draftRound) || null,
      draftNumber: blank(bio?.DRAFT_NUMBER) || blank(pi?.DRAFT_NUMBER) || blank(patch?.draftNumber) || null,
      draftStatus: (() => {
        const y = blank(bio?.DRAFT_YEAR) || blank(pi?.DRAFT_YEAR) || blank(patch?.draftYear);
        if (!y) return 'unknown';
        return String(y).toLowerCase() === 'undrafted' ? 'undrafted' : 'drafted';
      })(),

      gp,
      gs: bref ? num(bref.gs) : null,
      wins: num(t.W), losses: num(t.L),
      regularGP: o.split.regularGP, showcaseGP: o.split.showcaseGP,
      blendedSeason: o.blended,
      mpg: gp > 0 ? round(t.MIN / gp, 1) : null,
      minutes: num(t.MIN),

      pts: pg(t.PTS), reb: pg(t.REB), oreb: pg(t.OREB), dreb: pg(t.DREB),
      ast: pg(t.AST), stl: pg(t.STL), blk: pg(t.BLK), blka: pg(t.BLKA),
      tov: pg(t.TOV), pf: pg(t.PF), pfd: pg(t.PFD), plusMinus: pg(t.PLUS_MINUS),
      fg: pg(t.FGM), fga: pg(t.FGA), fg3: pg(t.FG3M), fg3a: pg(t.FG3A),
      fg2: pg(o.exact.FG2M), fg2a: pg(o.exact.FG2A), ft: pg(t.FTM), fta: pg(t.FTA),
      dd2: num(t.DD2), td3: num(t.TD3),

      fgPct: round(o.exact.FG_PCT, 4), fg3Pct: round(o.exact.FG3_PCT, 4),
      fg2Pct: round(o.exact.FG2_PCT, 4), ftPct: round(o.exact.FT_PCT, 4),
      efg: round(o.exact.EFG_PCT, 4), ts: round(o.exact.TS_PCT, 4),
      astTo: round(o.exact.AST_TO, 3),
      fg3Ar: t.FGA ? round(t.FG3A / t.FGA, 4) : null,
      ftr: t.FGA ? round(t.FTA / t.FGA, 4) : null,

      // stats.nba.com returns these as fractions; Basketball-Reference and every
      // convention users expect state them in percentage points.
      usg: round(pctPoints(o.advanced.USG_PCT), 2), astPct: round(pctPoints(o.advanced.AST_PCT), 2),
      astRatio: round(num(o.advanced.AST_RATIO), 2),
      orebPct: round(pctPoints(o.advanced.OREB_PCT), 2), drebPct: round(pctPoints(o.advanced.DREB_PCT), 2),
      rebPct: round(pctPoints(o.advanced.REB_PCT), 2),
      // NBA.com's TM_TOV_PCT is turnovers per 100 possessions used — not Basketball-Reference's
      // TOV% (turnovers per possession ended). Kept apart rather than merged under one label.
      toRatio: round(num(o.advanced.TM_TOV_PCT), 2),
      tovPct: bref ? num(bref.tovPct) : null,
      offRtg: round(num(o.advanced.OFF_RATING), 1), defRtg: round(num(o.advanced.DEF_RATING), 1),
      netRtg: round(num(o.advanced.NET_RATING), 1), pace: round(num(o.advanced.PACE), 1),
      pie: round(num(o.advanced.PIE), 4), poss: num(o.advanced.POSS),
      stlPer100: per100(t.STL), blkPer100: per100(t.BLK), astPer100: per100(t.AST),
      tovPer100: per100(t.TOV), defWs: round(num(o.defense.DEF_WS), 3),

      // Basketball-Reference impact tier — present for the NBA, absent for the G League,
      // which does not publish it. Never substituted with a neutral value.
      //
      // Scope warning: Basketball-Reference's G League table is regular season only, while the
      // headline line here is Regular Season + Showcase Cup. Isaac Jones shows 40 games but his
      // PER is computed over 29. The scope and its sample are carried explicitly so the
      // interface can label them rather than presenting two samples as one.
      brefGP: bref ? num(bref.stats?.adv_g ?? bref.gp) : null,
      brefScope: bref ? (league === 'GLEAGUE' && (o.split.showcaseGP || 0) > 0
        ? 'regular-season-only' : 'full-season') : null,
      per: bref ? num(bref.per) : null,
      ows: bref ? num(bref.ows) : null, dws: bref ? num(bref.dws) : null,
      ws: bref ? num(bref.ws) : null, ws48: bref ? num(bref.ws48) : null,
      obpm: bref ? num(bref.obpm) : null, dbpm: bref ? num(bref.dbpm) : null,
      bpm: bref ? num(bref.bpm) : null, vorp: bref ? num(bref.vorp) : null,
      stlPct: bref ? num(bref.stlPct) : null, blkPct: bref ? num(bref.blkPct) : null,
      wsPerGame: bref && gp ? round(num(bref.ws) / gp, 4) : null,
      dwsPerGame: bref && gp ? round(num(bref.dws) / gp, 4) : null,
      vorpPerGame: bref && gp ? round(num(bref.vorp) / gp, 4) : null,

      sourceIds: { nbaStats: id, basketballReference: bref ? bref.playerId : null },
      _official: o,
      stats,
    });
  }

  // Players who were on a roster but never took the floor. They have no performance to grade,
  // so grade stays null rather than 0 — a 0 would rank them below every player who did play,
  // which is a different and false claim.
  const rosterOnly = [];
  if (rosterFile) {
    const seen = new Set(records.map((r) => r.nbaPersonId));
    for (const e of loadRoster(rosterFile)) {
      const pid = e.PLAYER_ID;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      rosterOnly.push({
        league, leagueLabel, season: SEASON,
        playerId: String(pid), nbaPersonId: pid, brefId: null,
        name: e.PLAYER || e.PLAYER_NAME || String(pid),
        team: e.TEAM_ABBREVIATION || null, teamCount: 1,
        position: e.POSITION || null, positionSource: e.POSITION ? 'roster-listed' : null,
        positionFamily: positionFamily(e.POSITION),
        teams: [], height: e.HEIGHT || null, weight: num(e.WEIGHT),
        college: blank(e.SCHOOL), country: null, jersey: e.NUM || null,
        birthdate: birthdates[String(pid)]?.birthdate || null,
        ageOpeningNight: ageAt(birthdates[String(pid)]?.birthdate, OPENING_NIGHT),
        ageFeb1: ageAt(birthdates[String(pid)]?.birthdate, FEB_FIRST),
        age: num(e.AGE), seasonAge: null,
        gp: 0, minutes: 0, mpg: null, regularGP: 0, showcaseGP: 0,
        appeared: false, rosterOnly: true,
        grade: null, rateGrade: null, reliabilityWeight: 0, rank: null,
        custom: {}, components: {}, stats: {}, sourceIds: { nbaStats: pid },
      });
    }
  }

  // ---- metrics + grade
  const { custom, norm, K: customK, possFloor } = computeCustom(records.map((r) => r._official));
  // Two grades on two bases. The headline `grade` is per-GAME, matching the original brief;
  // `rateGrade` is the per-36 view, which answers a different question and is kept beside it
  // rather than substituted for it.
  const g = computeGrades(records, custom, norm, { basis: 'perGame' });
  const gr = computeGrades(records, custom, norm, { basis: 'per36' });

  records.forEach((r, i) => {
    r.custom = custom[i];
    r.components = g.components[i];
    r.rateComponents = gr.components[i];
    r.gradeRaw = g.raw[i];
    r.gradeShrunk = g.shrunk[i];
    r.grade = g.grade[i];
    r.rateGrade = gr.grade[i];
    // Renamed from `sampleConfidence`: this is the weight a player's own line carried in the
    // shrinkage, not a statistical confidence level, and it tops out well short of 100.
    r.reliabilityWeight = g.reliability[i];
    delete r._official;
  });
  records.forEach((r) => { r.appeared = true; r.rosterOnly = false; });
  records.sort((a, b) => b.grade - a.grade);
  records.forEach((r, i) => { r.rank = i + 1; });
  // Appended after ranking so they never occupy a rank position.
  records.push(...rosterOnly);

  // Cohort ranks. A single league-wide rank hides that the grade favours big men by roughly
  // 0.9 points; position-relative standing is reported rather than the grade being adjusted.
  const graded = records.filter((r) => r.grade !== null);
  const posRanks = cohortRanks(graded, (r) => r.positionFamily).out;
  const ageRanks = cohortRanks(graded, (r) => {
    const a = r.ageOpeningNight ?? r.age;
    return a == null ? null : a <= 23 ? 'u24' : 'over23';
  }).out;
  const teamRanks = cohortRanks(graded, (r) => r.team).out;
  records.forEach((r) => {
    const p = posRanks.get(r), a = ageRanks.get(r), t = teamRanks.get(r);
    r.cohortRanks = {
      position: p ? Object.values(p)[0] : null,
      ageGroup: a ? Object.values(a)[0] : null,
      team: t ? Object.values(t)[0] : null,
    };
  });

  // Positional bias, measured every build so a metric change cannot quietly worsen it.
  const byPos = {};
  records.forEach((r) => {
    if (!r.positionFamily || r.grade === null) return;
    (byPos[r.positionFamily] = byPos[r.positionFamily] || []).push(r.grade);
  });
  const positionalBias = Object.fromEntries(Object.entries(byPos).map(([k, v]) =>
    [k, { n: v.length, meanGrade: round(v.reduce((a, x) => a + x, 0) / v.length, 3) }]));

  return {
    records,
    model: { ...g.model, rateModel: gr.model, customK, possFloor, positionalBias },
  };
}

/* ------------------------------------------------------------------- assemble */

const TRACK_NBA = ['hustle', 'pt_drives', 'pt_defense', 'pt_passing', 'pt_rebounding',
  'pt_touches', 'pt_catchshoot', 'pt_pullup', 'pt_efficiency'];
const TRACK_GL = ['pt_catchshoot', 'pt_pullup'];

console.log('building NBA …');
const nba = buildLeague({
  league: 'NBA', leagueLabel: 'NBA',
  regularDir: 'official_nba', showcaseDir: null,
  extraDir: 'official_nba', extraFiles: TRACK_NBA,
  stintHalves: [{ file: 'stints_nba.json', label: 'regular' }],
  splitDirs: ['splits_nba'],
  rosterFile: 'rosters_nba.json',
});
console.log(`  ${nba.records.length} players`);

console.log('building G League …');
const gl = buildLeague({
  league: 'GLEAGUE', leagueLabel: 'NBA G League',
  regularDir: 'official_gleague_regular', showcaseDir: 'official_gleague_showcase',
  extraDir: 'official_gleague_regular', extraFiles: TRACK_GL,
  stintHalves: [
    { file: 'stints_gleague_regular.json', label: 'regular' },
    { file: 'stints_gleague_showcase.json', label: 'showcase' },
  ],
  combineTracking: ['pt_catchshoot', 'pt_pullup'],
  splitDirs: ['splits_gleague_regular', 'splits_gleague_showcase'],
  rosterFile: 'rosters_gleague.json',
});
console.log(`  ${gl.records.length} players`);

// Crossover by official NBA person id — an exact identity join, not a name or id-suffix guess.
// Crossover means APPEARED in both. A player rostered in one league without playing is not a
// cross-league statistical comparison, which is what the flag is used for.
const nbaIds = new Set(nba.records.filter((r) => r.appeared).map((r) => r.nbaPersonId));
const glIds = new Set(gl.records.filter((r) => r.appeared).map((r) => r.nbaPersonId));
let both = 0;
for (const r of nba.records) { r.bothLeagues = r.appeared && glIds.has(r.nbaPersonId); if (r.bothLeagues) both++; }
for (const r of gl.records) { r.bothLeagues = r.appeared && nbaIds.has(r.nbaPersonId); }

const metricDefinitions = {
  grade: 'Within-league per-game performance rating on 0.0000-9.9999. Six weighted percentile components, shrunk toward the minutes-weighted league mean in proportion to minutes played, then stretched onto the 0-9.9999 range by an affine map. Because the last step is a stretch and not a second percentile rank, equal grade differences mean equal differences in the underlying composite. NBA and G League are separate ranking universes.',
  reliabilityWeight: 'The weight a player\'s own line carried in the shrinkage: minutes / (minutes + K), as a percentage, where K is 60% of the league median minutes. It is NOT a statistical confidence level, and it does not reach 100 — the observed maximum is about 84. A full-season starter sits in the high seventies to low eighties; a two-game call-up sits near 10.',
  selfCreatedPts36: 'Points per 36 minutes from unassisted twos, unassisted threes and free throws. Free throws are included whole, so the figure overstates self-creation for players who draw many off-ball, technical or intentional-foul attempts. Reliability-adjusted.',
  situationalPts36: 'Fast-break plus points-off-turnovers plus second-chance points per 36. These are overlapping situational categories in NBA.com\'s definitions, not a partition of scoring — a transition bucket after a steal can count in two of them — so treat this as a situational-involvement index rather than a literal point total. Reliability-adjusted.',
  possessionSwing36: 'Net possessions won per 36: steals + offensive rebounds + 0.6x blocks, minus turnovers and 0.4x own shots blocked. Spans both ends of the floor, so it is not used in the Defense grade component. Reliability-adjusted.',
  defensiveSwing36: 'The defence-only half of possession swing: steals + 0.6x blocks + 0.2x defensive rebounds per 36. This is what feeds the Defense component, so no offensive rebound or own turnover enters a defensive rating. Reliability-adjusted.',
  whistleDiff36: 'Fouls drawn minus fouls committed per 36 minutes. Reliability-adjusted.',
  disruptionPerFoul: 'Steals plus blocks per personal foul. Rewards defenders who create events without fouling. Reliability-adjusted.',
  creationLoad36: 'Assists plus unassisted field goals made per 36 — scoring possessions finished through a player\'s own creation, for himself or a team-mate. Reliability-adjusted.',
  paintPts36: 'Points scored in the paint per 36 minutes. Reliability-adjusted.',
  efficiencyOverExpected: 'True shooting minus the true shooting the league actually averages at that usage rate, in TS points. The reference curve is piecewise across eight minutes-weighted usage bins — not one straight line — and is fitted only on players past a 200-possession floor. Reliability-adjusted, so a one-game outlier no longer tops the sort.',
  impactOverExpected: 'PIE minus the PIE the league averages at that usage rate, in PIE points. Replaces the earlier PIE-divided-by-usage ratio, which exploded toward zero usage and put one-game players at the top of the board. Reliability-adjusted.',
  shotLocationValue: 'Share of scoring from the paint, the arc and the line, against long twos. 0-100. This describes WHERE a player scores, not how well — a poor shooter can score highly — so it is a shot-location profile, not an efficiency measure.',
  versatilityIndex: 'Geometric mean of within-league percentiles for scoring, rebounding, playmaking, steals+blocks and true shooting. Geometric so one elite category cannot mask a missing one.',
  twoWayIndex: 'Equal blend of offensive percentiles (offensive rating, true shooting, scoring) and defensive percentiles (defensive rating, DEF WS per 36, steals+blocks, defensive rebound rate). PIE is deliberately excluded: it already contains defensive rebounds, steals and blocks, so including it made defence count on both sides.',
  selfSufficiencyIndex: 'Geometric blend of unassisted-field-goal share and usage rate. High means carrying a large offensive load largely under his own power.',
  defensiveDisruptionIndex: 'Composite of steals+blocks, defensive rebound rate, defensive rating and DEF WS per 36, 0-100 within league.',
};

const modelNotes = {
  teamContext: 'Offensive rating, defensive rating, net rating and plus/minus are TEAM results while the player is on court, per NBA.com\'s own definitions — not isolated individual value. They carry real information about a player but are influenced by team-mates and lineups. They contribute to the Impact component (10% of the grade) and to Two-Way Index; nothing here is a plus/minus model like RAPM, and no such data is published for the G League.',
  duplicateIngredients: 'Each component averages its ingredients once. An earlier version inserted points twice into Scoring and assists twice into Playmaking, which acted as undeclared extra weight.',
  minutes: 'Minutes govern the reliability shrinkage only. Minutes per game is deliberately NOT an ingredient of any component, so two players with identical per-possession production are not separated by how large a role they were given.',
  brefScope: 'Basketball-Reference\'s G League table covers the regular season only, while the G League headline line here combines Regular Season and Showcase Cup. PER, win shares and WS/48 therefore describe a smaller sample than the rest of the row; every record carries brefGP and brefScope so the interface can label it.',
};

/**
 * Provenance for every committed source file: row count, byte size and a content hash. When a
 * number changes later this is what distinguishes a source correction from a formula change
 * from a bug.
 */
function provenance() {
  const dir = path.join(ROOT, 'scripts/data');
  const entries = [];
  const walk = (d, prefix = '') => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full, prefix + name + '/'); continue; }
      if (!name.endsWith('.json')) continue;
      const buf = fs.readFileSync(full);
      let rows = null;
      try {
        const j = JSON.parse(buf);
        rows = Array.isArray(j) ? j.length
          : j.resultSets ? (Array.isArray(j.resultSets) ? j.resultSets[0]?.rowSet?.length : null)
          : (j.leagues ? null : Object.keys(j).length);
      } catch { /* not a payload we can count */ }
      entries.push({
        file: prefix + name,
        bytes: st.size,
        rows,
        sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
        modified: st.mtime.toISOString(),
      });
    }
  };
  walk(dir);
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

let buildCommit = null;
try {
  buildCommit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
} catch { /* not a git checkout */ }

const out = {
  season: SEASON,
  seasonType: 'NBA Regular Season; G League Regular Season + Showcase Cup combined',
  generatedAt: new Date().toISOString(),
  primarySource: 'stats.nba.com official league dashboards (LeagueID 00 and 20), with Basketball-Reference 2025-26 tables as a second source',
  sourceNote: 'v3 backbone is the official stats.nba.com data, which does answer from a normal machine even though it does not answer from GitHub-hosted runners. Basketball-Reference supplies PER, win shares and the BPM/VORP family for the NBA; the G League publishes no BPM/VORP family anywhere and none is invented.',
  counts: {
    // Headline counts are players who APPEARED. Roster-only players are carried but reported
    // separately, so a tab label never implies more people played than did.
    NBA: nba.records.filter((r) => r.appeared).length,
    GLEAGUE: gl.records.filter((r) => r.appeared).length,
    both,
    rosterOnlyNBA: nba.records.filter((r) => r.rosterOnly).length,
    rosterOnlyGLEAGUE: gl.records.filter((r) => r.rosterOnly).length,
    records: nba.records.filter((r) => r.appeared).length + gl.records.filter((r) => r.appeared).length,
    uniquePeople: new Set([...nba.records, ...gl.records].filter((r) => r.appeared).map((p) => p.nbaPersonId)).size,
    totalRowsIncludingRosterOnly: nba.records.length + gl.records.length,
  },
  metricDefinitions,
  modelNotes,
  gradeModel: {
    version: '3.1',
    scale: '0.0000-9.9999 affine stretch of a minutes-shrunk weighted-percentile composite',
    componentWeights: COMPONENT_WEIGHTS,
    componentIngredients: COMPONENT_INGREDIENTS,
    shrinkage: {
      NBA: nba.model, GLEAGUE: gl.model,
      rationale: 'Shrinkage keeps per-game production as the thing measured while weighting a player against the league mean by how much evidence exists. The same correction is now applied to the custom metrics themselves, not only the headline grade.',
    },
  },
  fieldCatalog: { ...buildCatalog({ NBA: nba.records, GLEAGUE: gl.records }), _topLevel: TOP_LEVEL_CATALOG },
  provenance: {
    buildCommit,
    gradeModelVersion: '3.3',
    generatedAt: new Date().toISOString(),
    ageReferenceDates: { openingNight: OPENING_NIGHT, febFirst: FEB_FIRST },
    sources: provenance(),
  },
  leagues: { NBA: nba.records, GLEAGUE: gl.records },
};

fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/data.json'), JSON.stringify(out));
console.log(`\nwrote public/data.json  (${(fs.statSync(path.join(ROOT, 'public/data.json')).size / 1e6).toFixed(1)} MB)`);
console.log(`NBA ${nba.records.length} · G League ${gl.records.length} · crossovers ${both}`);
console.log('\nNBA top 10:');
nba.records.slice(0, 10).forEach((p) => console.log(`  ${String(p.rank).padStart(2)} ${p.grade.toFixed(4)} gp=${String(p.gp).padStart(2)} ${p.name}`));
console.log('G League top 10:');
gl.records.slice(0, 10).forEach((p) => console.log(`  ${String(p.rank).padStart(2)} ${p.grade.toFixed(4)} gp=${String(p.gp).padStart(2)} ${p.name}`));

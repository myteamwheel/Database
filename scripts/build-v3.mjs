// 2025-26 NBA + NBA G League ranked performance database — build v3.
//
// v2 was built entirely from Basketball-Reference because stats.nba.com does not answer
// from GitHub-hosted runners. It does answer from a normal machine, so v3 uses the
// official source as the backbone and keeps Basketball-Reference as a second opinion.
// That closes v2's real gaps: G League ages (38% missing), G League listed positions
// (68% inferred), and the entire BPM/VORP-family impact tier (100% missing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOfficial, byId, resolveName, num, round } from './lib/sources.mjs';
import { combineHalves } from './lib/combine.mjs';
import { computeCustom, computeGrades, COMPONENT_WEIGHTS } from './lib/metrics.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = '2025-26';

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

function buildLeague({ league, leagueLabel, regularDir, showcaseDir, extraDir, extraFiles }) {
  const rsHalves = halvesFor(regularDir);
  const scHalves = showcaseDir ? halvesFor(showcaseDir) : new Map();
  const extras = extraFor(extraDir, extraFiles);

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
      // NBA.com's listed age. Basketball-Reference's season age (age on 1 February of
      // the season) runs a year lower for anyone with a February-to-August birthday,
      // so both are carried rather than silently picking one.
      age: num(bio?.AGE) ?? num(anchor.AGE) ?? (bref ? num(bref.age) : null),
      seasonAge: bref ? num(bref.age) : null,
      height: pi?.HEIGHT || bio?.PLAYER_HEIGHT || patch?.height || null,
      heightInches: num(bio?.PLAYER_HEIGHT_INCHES) ?? heightToInches(patch?.height),
      weight: num(bio?.PLAYER_WEIGHT) || num(pi?.WEIGHT) || num(patch?.weight) || null,
      // The API writes the literal string "None" for players with no college.
      college: blank(bio?.COLLEGE) || blank(pi?.COLLEGE) || blank(patch?.school) || null,
      country: blank(bio?.COUNTRY) || blank(pi?.COUNTRY) || blank(patch?.country) || null,
      jersey: pi?.JERSEY_NUMBER || null,
      draftYear: bio?.DRAFT_YEAR || pi?.DRAFT_YEAR || patch?.draftYear || null,
      draftRound: bio?.DRAFT_ROUND || pi?.DRAFT_ROUND || patch?.draftRound || null,
      draftNumber: bio?.DRAFT_NUMBER || pi?.DRAFT_NUMBER || patch?.draftNumber || null,

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

  // ---- metrics + grade
  const { custom, norm, tsUsgFit } = computeCustom(records.map((r) => r._official));
  const g = computeGrades(records, custom, norm);
  records.forEach((r, i) => {
    r.custom = custom[i];
    r.components = g.components[i];
    r.gradeRaw = g.raw[i];
    r.gradeShrunk = g.shrunk[i];
    r.grade = g.grade[i];
    r.sampleConfidence = g.confidence[i];
    delete r._official;
  });
  records.sort((a, b) => b.grade - a.grade);
  records.forEach((r, i) => { r.rank = i + 1; });

  return { records, model: { ...g.model, tsUsgFit } };
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
});
console.log(`  ${nba.records.length} players`);

console.log('building G League …');
const gl = buildLeague({
  league: 'GLEAGUE', leagueLabel: 'NBA G League',
  regularDir: 'official_gleague_regular', showcaseDir: 'official_gleague_showcase',
  extraDir: 'official_gleague_regular', extraFiles: TRACK_GL,
});
console.log(`  ${gl.records.length} players`);

// Crossover by official NBA person id — an exact identity join, not a name or id-suffix guess.
const nbaIds = new Set(nba.records.map((r) => r.nbaPersonId));
const glIds = new Set(gl.records.map((r) => r.nbaPersonId));
let both = 0;
for (const r of nba.records) { r.bothLeagues = glIds.has(r.nbaPersonId); if (r.bothLeagues) both++; }
for (const r of gl.records) { r.bothLeagues = nbaIds.has(r.nbaPersonId); }

const metricDefinitions = {
  grade: 'Within-league per-game performance rating on 0.0000-9.9999. Six weighted percentile components, then shrunk toward the minutes-weighted league mean in proportion to minutes played, then percentile-ranked inside the league. NBA and G League are ranked as separate universes.',
  sampleConfidence: 'The weight a player\'s own statistical line received in the grade, as a percentage. minutes / (minutes + K), where K is 60% of the league median. A full-season player sits near 100; a two-game call-up sits near 10.',
  selfCreatedPts36: 'Points per 36 minutes generated without an assist: unassisted twos, unassisted threes and free throws. Separates shot creators from finishers.',
  chaosPts36: 'Fast-break plus off-turnover plus second-chance points per 36 minutes. Scoring produced outside settled half-court offence.',
  possessionSwing36: 'Net possessions won per 36: steals + offensive rebounds + 0.6x blocks, minus turnovers and 0.4x own shots blocked.',
  whistleDiff36: 'Fouls drawn minus fouls committed per 36 minutes. Positive means a player puts the other team in the penalty more than his own.',
  disruptionPerFoul: 'Steals plus blocks per personal foul. Rewards defenders who create events without fouling.',
  creationLoad36: 'Assists plus unassisted field goals made per 36. How many scoring possessions a player finishes through his own creation, for himself or a team-mate.',
  paintPts36: 'Points scored in the paint per 36 minutes.',
  efficiencyOverExpected: 'True shooting percentage minus the true shooting the league averages at that usage rate, in TS points. The usage-to-efficiency curve is fitted within each league and weighted by minutes. Positive means beating the efficiency normally lost when taking on a bigger role.',
  shotDietIndex: 'Share of scoring coming from the paint, the three-point line and the free-throw line, against long twos. 0-100, higher means a more value-efficient shot diet.',
  versatilityIndex: 'Geometric mean of within-league percentiles for scoring, rebounding, playmaking, steals+blocks and true shooting. Geometric so that one elite category cannot mask a missing one.',
  twoWayIndex: 'Equal blend of offensive impact percentiles (PIE, offensive rating, true shooting) and defensive percentiles (defensive rating, defensive win shares, steals+blocks, defensive rebound rate).',
  selfSufficiencyIndex: 'Geometric blend of unassisted-field-goal share and usage rate. High means carrying a large offensive load largely under his own power.',
  defensiveDisruptionIndex: 'Composite of steals+blocks, defensive rebound rate, defensive rating and defensive win shares, 0-100 within league.',
  roleAdjustedImpact: 'PIE per point of usage rate. Impact produced per unit of offensive role, which surfaces efficient low-usage contributors.',
};

const out = {
  season: SEASON,
  seasonType: 'NBA Regular Season; G League Regular Season + Showcase Cup combined',
  generatedAt: new Date().toISOString(),
  primarySource: 'stats.nba.com official league dashboards (LeagueID 00 and 20), with Basketball-Reference 2025-26 tables as a second source',
  sourceNote: 'v3 backbone is the official stats.nba.com data, which does answer from a normal machine even though it does not answer from GitHub-hosted runners. Basketball-Reference supplies PER, win shares and the BPM/VORP family for the NBA; the G League publishes no BPM/VORP family anywhere and none is invented.',
  counts: { NBA: nba.records.length, GLEAGUE: gl.records.length, both },
  metricDefinitions,
  gradeModel: {
    version: '3.0',
    scale: '0.0000-9.9999 within-league percentile of a minutes-shrunk composite',
    componentWeights: COMPONENT_WEIGHTS,
    shrinkage: {
      NBA: nba.model, GLEAGUE: gl.model,
      rationale: 'v2 graded raw per-game rates with no shrinkage, so its top two G League players had played two and three games. Shrinkage keeps per-game production as the thing measured while weighting a player against the league mean by how much evidence exists.',
    },
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

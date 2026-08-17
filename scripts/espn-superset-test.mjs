// Test the SUPERSET ASSUMPTION that constrained reconstruction depends on:
//
//     the true five starters are always among the NBA-flagged candidates
//
// Flow feasibility is necessary but not sufficient, so until now this assumption was untestable.
// ESPN publishes an explicit `starter` boolean for these seasons, which gives a second-source
// starter classification that does not exhibit the NBA START_POSITION defect.
//
// Usage: node scripts/espn-superset-test.mjs <season> [gamesPerPhase]
//
// A single credible violation invalidates reconstruction for that season.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, scoreboardUrl, summaryUrl, startersFromSummary, normName, nbaAbbr, resolveName, IDENTITY_CLASSES } from './lib/espn.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const season = process.argv[2] || '2015-16';
const perPhase = Number(process.argv[3] || 30);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NBA_H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const boxUrl = (g) => 'https://stats.nba.com/stats/boxscoretraditionalv2?' + new URLSearchParams({
  GameID: g, StartPeriod: '0', EndPeriod: '10', StartRange: '0', EndRange: '28800', RangeType: '0' });

async function nbaBox(gameId) {
  const cached = path.join(HIST, season, 'starters_regular', `${gameId}.json`);
  const cachedPo = path.join(HIST, season, 'starters_playoffs', `${gameId}.json`);
  for (const c of [cached, cachedPo]) if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
  for (let i = 0; i < 4; i++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 40000);
      const r = await fetch(boxUrl(gameId), { headers: NBA_H, signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 3) return null; await wait(2000 * (i + 1)); }
  }
}

/** Stratified sample across a phase, ordered by date. */
function sample(seasonType, n) {
  const f = path.join(HIST, season, seasonType === 'Playoffs' ? 'gamelog_playoffs.json' : 'gamelog.json');
  if (!fs.existsSync(f)) return [];
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  const byGame = new Map();
  for (const r of rows) if (!byGame.has(r.gameId)) byGame.set(r.gameId, r.gameDate);
  const ids = [...byGame.entries()].sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]));
  const step = Math.max(1, Math.floor(ids.length / n));
  const out = [];
  for (let i = 0; i < ids.length && out.length < n; i += step) out.push({ gameId: ids[i][0], date: ids[i][1] });
  return out;
}

const stats = {
  gamesRequested: 0, espnPagesMissing: 0, mappingFailures: 0, nbaMissing: 0,
  teamGamesTested: 0, starterEdgesTested: 0, supersetViolations: 0,
  nbaCandidateCounts: [], espnStarterCountNot5: 0, identityMapFailures: 0, surnameFallbacks: 0,
};
const violations = [];
const idFailures = [];
const mapFailures = [];
const fallbacks = [];
const identity = {};

console.log('='.repeat(78));
console.log(`SUPERSET ASSUMPTION TEST — ${season}   (ESPN explicit starters vs NBA candidate sets)`);
console.log('='.repeat(78));

const scoreboardCache = new Map();

for (const seasonType of ['Regular Season', 'Playoffs']) {
  const games = sample(seasonType, seasonType === 'Playoffs' ? Math.max(10, Math.floor(perPhase / 3)) : perPhase);
  if (!games.length) continue;
  console.log(`\n--- ${seasonType}: ${games.length} sampled games ---`);

  for (const g of games) {
    stats.gamesRequested++;
    const yyyymmdd = g.date.replace(/-/g, '');

    // 1. NBA side: the corrupted candidate set.
    const nba = await nbaBox(g.gameId);
    if (!nba) { stats.nbaMissing++; continue; }
    const ps = nba.resultSets?.find((x) => x.name === 'PlayerStats');
    if (!ps) { stats.nbaMissing++; continue; }
    const ix = Object.fromEntries(ps.headers.map((h, k) => [h, k]));
    const nbaTeams = new Map();
    for (const row of ps.rowSet) {
      const ab = row[ix.TEAM_ABBREVIATION];
      if (!nbaTeams.has(ab)) nbaTeams.set(ab, { candidates: new Set(), roster: new Set() });
      const t = nbaTeams.get(ab);
      const nm = normName(row[ix.PLAYER_NAME]);
      t.roster.add(nm);
      if (String(row[ix.START_POSITION] ?? '').trim() !== '') t.candidates.add(nm);
    }

    // 2. ESPN side: map by date + the two teams, never by name alone.
    if (!scoreboardCache.has(yyyymmdd)) {
      const sb = await getJson(scoreboardUrl(yyyymmdd));
      scoreboardCache.set(yyyymmdd, sb?.__err ? null : sb);
      await wait(400);
    }
    const sb = scoreboardCache.get(yyyymmdd);
    if (!sb) { stats.espnPagesMissing++; continue; }
    const want = new Set([...nbaTeams.keys()]);
    const event = (sb.events || []).find((e) => {
      const comp = e.competitions?.[0];
      const abbrs = new Set((comp?.competitors || []).map((c) => nbaAbbr(c.team?.abbreviation)));
      return abbrs.size === want.size && [...want].every((w) => abbrs.has(w));
    });
    if (!event) {
      stats.mappingFailures++;
      if (mapFailures.length < 10) mapFailures.push({ gameId: g.gameId, date: g.date, nbaTeams: [...want],
        espnEventsThatDay: (sb.events || []).map((e) => (e.competitions?.[0]?.competitors || []).map((c) => nbaAbbr(c.team?.abbreviation)).join('/')) });
      continue;
    }

    const sum = await getJson(summaryUrl(event.id));
    await wait(400);
    if (sum?.__err) { stats.espnPagesMissing++; continue; }
    const espnTeams = startersFromSummary(sum);
    if (!espnTeams.length) { stats.espnPagesMissing++; continue; }

    // 3. Compare, per team-game.
    for (const et of espnTeams) {
      const nt = nbaTeams.get(et.team);
      if (!nt) { stats.mappingFailures++; continue; }
      if (et.count !== 5) { stats.espnStarterCountNot5++; continue; }
      stats.teamGamesTested++;
      stats.nbaCandidateCounts.push(nt.candidates.size);

      for (const s of et.starters) {
        stats.starterEdgesTested++;
        const res = resolveName(s.name, nt.roster, s.id);
        const nm = res.match;
        identity[res.how] = (identity[res.how] || 0) + 1;
        if (res.how === 'unique_roster_surname_fallback' && fallbacks.length < 30) {
          fallbacks.push({ date: g.date, team: et.team, espn: s.name, matched: nm });
        }
        // Identity check first: an ESPN starter absent from the NBA ROSTER is a name-mapping
        // failure, not evidence about the superset assumption. Kept strictly separate.
        if (!nm) {
          stats.identityMapFailures++;
          if (idFailures.length < 20) {
            // Record the NBA roster so a name-variant mismatch can be told apart from a genuine
            // roster disagreement between the two sources.
            idFailures.push({ gameId: g.gameId, date: g.date, team: et.team, espn: s.name,
              espnNorm: nm, nbaRoster: [...nt.roster] });
          }
          continue;
        }
        if (!nt.candidates.has(nm)) {
          stats.supersetViolations++;
          if (violations.length < 15) {
            violations.push({ gameId: g.gameId, date: g.date, team: et.team, player: s.name,
              nbaCandidates: nt.candidates.size });
          }
        }
      }
    }
  }
}

const c = stats.nbaCandidateCounts;
c.sort((a, b) => a - b);
console.log('\n--- results ---');
console.log(`  games sampled                        ${stats.gamesRequested}`);
console.log(`  NBA box scores missing               ${stats.nbaMissing}`);
console.log(`  ESPN pages missing                   ${stats.espnPagesMissing}`);
console.log(`  ESPN<->NBA game mapping failures     ${stats.mappingFailures}`);
console.log(`  ESPN team-games not showing 5        ${stats.espnStarterCountNot5}`);
console.log(`  team-games tested                    ${stats.teamGamesTested}`);
console.log(`  starter edges tested                 ${stats.starterEdgesTested}`);
console.log(`  player identity mapping failures     ${stats.identityMapFailures}`);
console.log('  identity resolution distribution:');
for (const cls of IDENTITY_CLASSES) console.log(`    ${cls.padEnd(32)} ${identity[cls] || 0}`);
if (c.length) {
  console.log(`  NBA candidate-set size  min ${c[0]} · median ${c[Math.floor(c.length / 2)]} · max ${c[c.length - 1]}` +
    ` · mean ${(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2)}`);
}
if (idFailures.length) {
  console.log('\n  --- player identity mapping failures (ESPN starter not found in NBA roster) ---');
  for (const f of idFailures) console.log(`    ${f.date} ${f.team}: ESPN "${f.espn}" -> "${f.espnNorm}" not in NBA roster`);
}
if (fallbacks.length) {
  console.log('\n  --- surname fallback used (reported, never silent) ---');
  for (const f of fallbacks) console.log(`    ${f.date} ${f.team}: ESPN "${f.espn}" -> NBA "${f.matched}"`);
}
if (mapFailures.length) {
  console.log('\n  --- ESPN<->NBA game mapping failures ---');
  for (const f of mapFailures) console.log(`    ${f.date} ${f.gameId} NBA=${f.nbaTeams.join('/')} ESPN that day: ${f.espnEventsThatDay.join(', ') || '(none)'}`);
}
console.log(`\n  SUPERSET VIOLATIONS                  ${stats.supersetViolations}`);
if (violations.length) {
  console.log('  (an ESPN explicit starter absent from the NBA candidate set)');
  for (const v of violations) console.log(`    ${v.date} ${v.gameId} ${v.team}: ${v.player} (candidates=${v.nbaCandidates})`);
  console.log('\n  => The superset assumption is VIOLATED. Constraint-derived statuses for this season');
  console.log('     must not be treated as valid.');
} else if (stats.starterEdgesTested) {
  console.log('  => No violation found in this sample. The assumption survives; it is not proved.');
}

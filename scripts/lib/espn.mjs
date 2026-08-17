// ESPN historical box scores as a SECOND-SOURCE starter classification.
//
// ESPN's summary endpoint carries an explicit boolean `starter` per athlete, so the starter/bench
// split is semantic — it is not inferred from row order, minutes, or position. On 2015-10-27
// DET/ATL, the game where NBA START_POSITION flags nine Detroit players, ESPN marks exactly five
// starters and puts Johnson, Baynes, Blake and Meeks in the bench group.
//
// PROVENANCE CAUTION: this is a second-source *representation*, not proven upstream independence.
// ESPN may share a feed with the NBA somewhere above both. It is labelled DIRECT_ESPN_SECONDARY
// and never silently merged with NBA-sourced values.
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
      const r = await fetch(url, { headers: UA, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) return { __err: e.message }; await wait(1500 * (i + 1)); }
  }
}

/** ESPN abbreviation -> NBA abbreviation. ESPN shortens several and uses historical names. */
export const ESPN_TO_NBA = {
  GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHX: 'PHX', PHO: 'PHX',
  BKN: 'BKN', CHA: 'CHA', NOP: 'NOP', PHI: 'PHI',
};
export const nbaAbbr = (espn) => ESPN_TO_NBA[espn] || espn;

/**
 * Normalise a player name for within-team-game matching. Only ever used inside a single roster of
 * ~13 players, never league-wide, so collision risk is negligible and any collision is reported.
 */
export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')    // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g, '')          // suffixes: ESPN "Marcus Morris Sr."
    // Drop EVERY non-letter, spaces included. The sources disagree on hyphenation — NBA writes
    // "Rondae Hollis-Jefferson", ESPN writes "Rondae Hollis Jefferson" — so collapsing to letters
    // alone makes those identical. An earlier version deleted the hyphen but kept the space, which
    // made exactly those names fail to match.
    .replace(/[^a-z]/g, '');
}

/** Surname key for the documented fallback below. */
export function lastNameKey(s) {
  const parts = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g, '')
    .split(/[^a-z]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Resolve an ESPN name against one team-game's NBA roster (~13 names).
 * Exact normalised match first. Falls back to an unambiguous surname match, which covers genuine
 * nickname divergence such as ESPN "Marcelinho Huertas" vs NBA "Marcelo Huertas". The fallback is
 * only used when exactly one roster surname matches, and it is REPORTED, never applied silently.
 * @returns {{match:string|null, how:'exact'|'surname'|'none', ambiguous?:string[]}}
 */
export function resolveName(espnName, nbaRoster, espnAthleteId = null, idMap = null) {
  // 1. Strongest: a verified ESPN athlete id -> NBA player id mapping.
  if (idMap && espnAthleteId != null && idMap.has(String(espnAthleteId))) {
    const m = idMap.get(String(espnAthleteId));
    if (nbaRoster.has(m)) return { match: m, how: 'exact_id' };
  }
  // 2. Normalised name equality within this team-game's roster.
  const n = normName(espnName);
  if (nbaRoster.has(n)) return { match: n, how: 'exact_normalized_name' };
  // 3. A human-verified alias. Nickname divergence lives here, never in the fallback.
  const alias = NAME_ALIASES[n];
  if (alias && nbaRoster.has(alias)) return { match: alias, how: 'explicit_alias' };
  // 4. Last resort: a surname unique within this ~13-player roster. Reported, never promoted to
  //    the alias table automatically — "unique surname happened to match once" is not an alias.
  const key = lastNameKey(espnName);
  const hits = [...nbaRoster].filter((r) => r.endsWith(key) && key.length >= 4);
  if (hits.length === 1) return { match: hits[0], how: 'unique_roster_surname_fallback' };
  return { match: null, how: 'unresolved', ambiguous: hits };
}

/**
 * Human-verified ESPN -> NBA name aliases, keyed by normName(espn) -> normName(nba).
 * Each entry must be confirmed as the same athlete before being added. These are genuine
 * naming divergences, not spelling noise.
 */
export const NAME_ALIASES = {
  marcelinhohuertas: 'marcelohuertas',   // ESPN nickname; NBA uses "Marcelo Huertas"
};

export const IDENTITY_CLASSES = [
  'exact_id', 'exact_normalized_name', 'explicit_alias', 'unique_roster_surname_fallback', 'unresolved',
];

export const scoreboardUrl = (yyyymmdd) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}&limit=100`;
export const summaryUrl = (eventId) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;

/**
 * Extract explicit starters per team from an ESPN summary.
 * @returns {Array<{team, starters:[{id,name}], bench:[{id,name}], roster:[{id,name}], count}>}
 */
export function startersFromSummary(j) {
  const out = [];
  for (const tm of j?.boxscore?.players || []) {
    const st = tm.statistics?.[0];
    if (!st?.athletes) continue;
    const starters = [], bench = [], roster = [];
    for (const a of st.athletes) {
      const rec = { id: a.athlete?.id, name: a.athlete?.displayName, dnp: !!a.didNotPlay };
      roster.push(rec);
      // `starter` is an explicit boolean on the athlete record, not a positional convention.
      if (a.starter === true) starters.push(rec); else bench.push(rec);
    }
    out.push({
      team: nbaAbbr(tm.team?.abbreviation), espnTeam: tm.team?.abbreviation,
      teamId: tm.team?.id, starters, bench, roster, count: starters.length,
    });
  }
  return out;
}

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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g, '')          // suffixes: ESPN "Marcus Morris Sr."
    .replace(/[^a-z ]/g, '')                             // punctuation: "Jeff Teague", "O'Neal"
    .replace(/\s+/g, ' ').trim();
}

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

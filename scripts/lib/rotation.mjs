// ASSIGNED WORKLOAD from rotation behaviour.
//
// WHY THIS EXISTS. Model A previously used the opener's FINAL minutes as the workload the team
// "attempted". That conflates three different things: what the team intended to give him, what he
// actually logged, and everything that happened in between — foul trouble cutting a role short,
// blowouts inflating or deflating it, overtime adding minutes nobody planned. The Nets question is
// about the role a team would OFFER, so the offer has to be separated from the outcome.
//
// Rotation pattern early in the game is far closer to the intent than the final box score, because
// it is set before most of that noise accumulates: when he first checks in, how long his first
// stint runs, whether he returns on the normal second-quarter rotation, whether he opens the second
// half. Those are decisions, not results.
//
// This module derives those features. It does NOT invent a new formula to replace openerMin — the
// resulting proxy must be VALIDATED against subsequent normal-rotation workload before it is used.

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** ISO 8601 duration on the game clock ("PT06M43.00S") to seconds remaining in the period. */
export function clockToSeconds(c) {
  const m = /PT(\d+)M([\d.]+)S/.exec(String(c || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const PERIOD_SECONDS = 720, OT_SECONDS = 300;
/** Elapsed game seconds at an event, so stints can be measured across periods. */
export function elapsed(period, clock) {
  const rem = clockToSeconds(clock);
  if (rem === null) return null;
  const before = period <= 4 ? (period - 1) * PERIOD_SECONDS
    : 4 * PERIOD_SECONDS + (period - 5) * OT_SECONDS;
  const len = period <= 4 ? PERIOD_SECONDS : OT_SECONDS;
  return before + (len - rem);
}

/**
 * Reconstruct one player's stints from substitution events.
 * @param {object} pbp cached playbyplayv3 subset
 * @param {number|string} personId
 * @param {boolean} started whether he was in the opening lineup
 */
/**
 * Last name as the PBP description writes it. Descriptions use surnames only ("SUB: Lin FOR
 * Prince"), while rosters carry full names, so entries can only be matched on the surname.
 */
/**
 * Roster-aware deterministic name resolution.
 *
 * Play-by-play descriptions identify the INCOMING player by surname only ("SUB: Morris Sr. FOR
 * Rozier"), while rosters carry full names. Three separate bugs came from handling that per-case:
 * suffixes stripped from the roster but present in descriptions, diacritics present in the roster
 * but absent from descriptions, and names taken from the player's own events (which fail entirely
 * for anyone never substituted out).
 *
 * This normalizes systematically rather than patching individuals:
 *   - Unicode/diacritic folding      Doncic  == Doncic
 *   - punctuation and spacing        O'Neal  == ONeal, Hollis-Jefferson == Hollis Jefferson
 *   - generational suffixes          BOTH "morris" and "morris sr." are accepted
 *
 * COLLISIONS ARE NEVER GUESSED. If two roster players on the same team normalize to the same
 * surname, the mapping is ambiguous and is reported as unresolved rather than resolved by
 * plausibility. A wrong confident match corrupts two players' stints at once.
 */
export function normalizeName(x) {
  return String(x || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // fold accents
    .toLowerCase()
    .replace(/[.'`\u2019]/g, '')                          // drop punctuation
    .replace(/[-_]/g, ' ')                                // hyphens behave as spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/** Surname forms a description might use for this roster name. */
export function descName(fullName) {
  // Split on WHITESPACE only. Normalizing hyphens to spaces first would split a hyphenated surname
  // into two tokens and reduce "Finney-Smith" to "smith" — which silently mismatched thirteen
  // players including Gilgeous-Alexander, Caldwell-Pope and Kidd-Gilchrist.
  const raw = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return null;
  const lastRaw = raw[raw.length - 1];
  const hasSuffix = /^(jr|sr|ii|iii|iv|v)\.?$/i.test(lastRaw) && raw.length > 1;
  const surnameRaw = hasSuffix ? raw[raw.length - 2] : lastRaw;
  const bare = normalizeName(surnameRaw);
  const withSuffix = hasSuffix ? normalizeName(`${surnameRaw} ${lastRaw}`) : bare;
  // Sources disagree on whether a compound surname is hyphenated, spaced or joined.
  const joined = bare.replace(/ /g, '');
  const hyphenated = normalizeName(surnameRaw).replace(/ /g, '-');
  return { bare, withSuffix, all: [...new Set([bare, withSuffix, joined, hyphenated])] };
}

/**
 * Build a surname -> playerId map for one team-game, flagging ambiguity instead of guessing.
 * @param {Array<{playerId:number, playerName:string}>} roster
 */
export function resolveRoster(roster) {
  const byForm = new Map();
  for (const p of roster) {
    const dn = descName(p.playerName);
    if (!dn) continue;
    for (const form of dn.all) {
      if (!byForm.has(form)) byForm.set(form, new Set());
      byForm.get(form).add(p.playerId);
    }
  }
  const resolved = new Map(), ambiguous = [];
  for (const [form, ids] of byForm) {
    if (ids.size === 1) resolved.set(form, [...ids][0]);
    else ambiguous.push({ form, playerIds: [...ids] });
  }
  return { resolved, ambiguous };
}

export function stints(pbp, personId, started, playerName) {
  const pid = String(personId);
  // DIRECTION. subType is empty on v3 substitution events. What identifies direction is:
  //   personId / playerName  -> the player going OUT
  //   description            -> "SUB: {incoming} FOR {outgoing}"
  // so an ENTRY is found by matching this player's name against the incoming half of the
  // description, and an EXIT by matching personId directly. Assuming subType carried "in"/"out"
  // produced zero usable stints.
  const nameOf = (d) => {
    const m = /SUB:\s*(.+?)\s+FOR\s+/i.exec(String(d || ''));
    return m ? normalizeName(m[1]) : null;
  };
  // NAME SOURCE. Deriving this from the player's own substitution events only works if he was
  // subbed OUT at least once. A player who checks in and stays until a period ends never appears as
  // a substitution personId, so his name came back undefined and NO stint was ever opened for him —
  // 49% of all reconstruction errors. The name must come from the roster, not from the events being
  // parsed.
  const dn = descName(playerName);
  const myNames = (dn ? dn.all : [normalizeName(playerName)]).filter(Boolean);
  const matchesMe = (d) => { const n = nameOf(d); return n !== null && myNames.includes(n); };
  const myName = myNames[0];
  const all = (pbp.actions || [])
    .filter((a) => /substitution/i.test(a.type || ''))
    .map((a) => ({ ...a, t: elapsed(a.p, a.clock) }))
    .filter((a) => fin(a.t))
    .sort((a, b) => a.t - b.t);

  // PERIOD STARTS ARE NOT SUBSTITUTIONS. A player who sits late in one quarter and returns to open
  // the next produces no substitution event, because between-period lineups are set off the clock.
  // Reconstructing from substitutions alone therefore loses every one of those re-entries and
  // systematically UNDER-counts minutes — measured at 8.17 minutes mean error, 72% of players off
  // by more than three.
  //
  // Inference: within a period, if this player's FIRST substitution event is an EXIT, he must have
  // been on the floor when the period began. That is the same principle lineup-tracking libraries
  // use, and it needs no data beyond what is already cached.
  const periodStart = (per) => (per <= 4 ? (per - 1) * PERIOD_SECONDS
    : 4 * PERIOD_SECONDS + (per - 5) * OT_SECONDS);
  const onFloorAtPeriodStart = new Set();
  for (let per = 1; per <= (pbp.periods || 4); per++) {
    const inPeriod = all.filter((a) => a.p === per);
    const firstMine = inPeriod.find((a) => String(a.personId) === pid || matchesMe(a.description));
    if (firstMine && String(firstMine.personId) === pid) onFloorAtPeriodStart.add(per);
  }
  if (started) onFloorAtPeriodStart.add(1);

  const periodEnd = (per) => (per < 4 ? per * PERIOD_SECONDS
    : 4 * PERIOD_SECONDS + Math.max(0, per - 4) * OT_SECONDS);

  const out = [];
  let openAt = null;
  for (let per = 1; per <= (pbp.periods || 4); per++) {
    if (onFloorAtPeriodStart.has(per) && openAt === null) openAt = periodStart(per);
    for (const s of all.filter((a) => a.p === per)) {
      const isExit = String(s.personId) === pid;
      const isEntry = matchesMe(s.description);
      if (isEntry && openAt === null) openAt = s.t;
      else if (isExit && openAt !== null) { out.push({ start: openAt, end: s.t }); openAt = null; }
    }
    // PERIOD BOUNDARY. Closing whenever he is not DETECTED at the next period start was wrong: a
    // player who plays straight through a period generates no events in it, so he looked absent and
    // his stint was cut short. That was 54% of remaining errors.
    //
    // The deterministic test is his NEXT event, not his presence in the next period. If the next
    // event after this boundary is an EXIT, he must have been on the floor continuously to be
    // substituted out — so the stint continues. If it is an ENTRY, he left at the boundary and must
    // re-enter. If he has no further events, fall back to whether he was detected at the next
    // period start.
    if (openAt !== null) {
      const boundary = periodEnd(per);
      const next = all.find((a) => a.t >= boundary
        && (String(a.personId) === pid || matchesMe(a.description)));
      let staysOn;
      // A player leaves the floor ONLY via a substitution or the final buzzer. So if he has no
      // further substitution events at all, he was never taken off and played to the end. The
      // previous fallback assumed the opposite and cut such players short — Terry Rozier lost all
      // of Q4 (25.1 true minutes reconstructed as 13.1).
      if (!next) staysOn = true;
      else staysOn = String(next.personId) === pid;   // next event is his exit -> he never left
      if (!staysOn) { out.push({ start: openAt, end: boundary }); openAt = null; }
    }
  }
  const gameEnd = (pbp.periods <= 4 ? 4 * PERIOD_SECONDS : 4 * PERIOD_SECONDS + (pbp.periods - 4) * OT_SECONDS);
  if (openAt !== null) out.push({ start: openAt, end: gameEnd });
  return out;
}

const REGULATION = 4 * PERIOD_SECONDS;
const FIRST_HALF = 2 * PERIOD_SECONDS;

/**
 * Rotation features describing the role a team OPENED for a player, taken from the part of the
 * game least contaminated by outcome. Overtime is excluded throughout: nobody plans it.
 */
export function assignedWorkloadFeatures(pbp, personId, started, playerName) {
  const st = stints(pbp, personId, started, playerName);
  if (!st.length) return null;
  const clip = (s, lo, hi) => Math.max(0, Math.min(s.end, hi) - Math.max(s.start, lo));
  const firstHalfSec = st.reduce((a, s) => a + clip(s, 0, FIRST_HALF), 0);
  const regulationSec = st.reduce((a, s) => a + clip(s, 0, REGULATION), 0);
  const first = st[0];
  // Did he take the floor to open the second half? A strong signal of intended role.
  const opensSecondHalf = st.some((s) => s.start <= FIRST_HALF + 5 && s.end > FIRST_HALF + 5);
  return {
    startedOpener: started ? 1 : 0,
    firstEntrySec: first.start,
    firstStintSec: first.end - first.start,
    firstHalfMin: firstHalfSec / 60,
    regulationMin: regulationSec / 60,
    firstHalfStints: st.filter((s) => s.start < FIRST_HALF).length,
    stintCount: st.length,
    opensSecondHalf: opensSecondHalf ? 1 : 0,
    // Doubling first-half minutes is the crudest possible extrapolation of intent; it is exposed
    // as a FEATURE for the model to weigh, never used directly as the assigned workload.
    firstHalfDoubled: (firstHalfSec / 60) * 2,
  };
}

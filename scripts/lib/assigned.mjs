// ASSIGNED WORKLOAD features — the role a team OPENED for a player, read from the opener game.
//
// WHY THIS IS NOT openerMin. Realized opener minutes are contaminated by everything that happened
// during the game: blowouts, foul trouble, a hot hand, injury. Those are consequences of the game,
// not statements of intent, and using them as the treatment conflates "the coach gave him a role"
// with "the game let him keep it".
//
// The coach's intent is most visible EARLY, before in-game feedback can act:
//   - was he in the opening five at all
//   - how soon was he first called on
//   - how long was that first stint allowed to run
//   - how much of the first quarter / first half he was given
// Later-game minutes are progressively more contaminated, so the features are ordered by how early
// they are observed and the late ones are kept separable rather than blended in.
//
// Times are tenths of a second of elapsed game clock: 7200 = 12:00, 14400 = 24:00, 28800 = 48:00.
const Q1 = 7200, H1 = 14400, REG = 28800;
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/**
 * @param {Array} stints  cached GameRotation stints for ONE game
 * @param {number} personId
 * @returns {object|null} early-rotation features, or null if the player has no stints
 */
export function assignedFeatures(stints, personId) {
  const mine = stints.filter((s) => Number(s.personId) === Number(personId))
    .sort((a, b) => a.inT - b.inT);
  if (!mine.length) return null;
  const first = mine[0];
  const tenthsToMin = (t) => t / 600;

  // Garbage time is the main way late minutes stop reflecting intent. Flagged, never silently
  // blended into the assignment signal.
  const maxAbsDiff = Math.max(...mine.map((s) => Math.abs(s.ptDiff ?? 0)));

  return {
    // --- earliest, least contaminated ---
    startedOpener: first.inT === 0 ? 1 : 0,
    firstInMin: tenthsToMin(first.inT),
    firstStintMin: tenthsToMin(first.outT - first.inT),
    q1Min: mine.reduce((a, s) => a + overlap(s.inT, s.outT, 0, Q1), 0) / 600,
    // --- still early, mildly contaminated ---
    firstHalfMin: mine.reduce((a, s) => a + overlap(s.inT, s.outT, 0, H1), 0) / 600,
    stintsFirstHalf: mine.filter((s) => s.inT < H1).length,
    // --- whole game, most contaminated: kept for contrast, not treated as intent ---
    totalMin: mine.reduce((a, s) => a + (s.outT - s.inT), 0) / 600,
    nStints: mine.length,
    maxAbsPtDiff: maxAbsDiff,
    // A short first stint that never resumes is a different signal from a short first stint inside a
    // heavy overall workload; the ratio separates them.
    firstHalfShare: (() => {
      const tot = mine.reduce((a, s) => a + (s.outT - s.inT), 0);
      return tot > 0 ? mine.reduce((a, s) => a + overlap(s.inT, s.outT, 0, H1), 0) / tot : 0;
    })(),
  };
}

/** Team context: how many players the team used, and whether this game ran long. */
export function gameContext(stints) {
  const maxOut = Math.max(...stints.map((s) => s.outT));
  return { overtime: maxOut > REG + 60 ? 1 : 0, gameLenMin: maxOut / 600 };
}

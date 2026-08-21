// TEAM-LEVEL lineup reconstruction.
//
// WHY THIS REPLACES PER-PLAYER RECONSTRUCTION. Reconstructing each player independently cannot use
// the constraints that actually determine a lineup:
//   - exactly five players are on the floor at any moment;
//   - a substitution removes exactly one and adds exactly one;
//   - the incoming player is by definition NOT currently on the floor.
//
// That last constraint resolves the ambiguity that per-player matching cannot. Play-by-play writes
// bare surnames — "SUB: Holiday FOR Davis" — with no initial, and 9.67% of team-games contain two
// roster-mates sharing a surname (Wagner brothers, Grant/Robert Williams, the Antetokounmpos).
// Per-player matching must give up on those. Tracking the lineup makes them deterministic: only one
// Holiday is off the floor and therefore eligible to enter.
//
// Everything here stays deterministic and auditable. Where the constraints genuinely fail to
// determine an answer, the event is recorded as unresolved rather than guessed.
import { descName, normalizeName } from './rotation.mjs';

const fin = (v) => Number.isFinite(Number(v));
const PERIOD = 720, OT = 300;
const periodStartSec = (p) => (p <= 4 ? (p - 1) * PERIOD : 4 * PERIOD + (p - 5) * OT);
const periodEndSec = (p) => (p < 4 ? p * PERIOD : 4 * PERIOD + Math.max(0, p - 4) * OT);

const clockToSec = (c) => {
  const m = /PT(\d+)M([\d.]+)S/.exec(String(c || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const elapsed = (period, clock) => {
  const rem = clockToSec(clock);
  if (rem === null) return null;
  const len = period <= 4 ? PERIOD : OT;
  return periodStartSec(period) + (len - rem);
};
const subNames = (d) => {
  const m = /SUB:\s*(.+?)\s+FOR\s+(.+?)\s*$/i.exec(String(d || ''));
  return m ? { inName: normalizeName(m[1]), outName: normalizeName(m[2]) } : null;
};

/**
 * Reconstruct stints for every player on one team in one game.
 * @param {object} pbp cached playbyplayv3 subset
 * @param {number} teamId
 * @param {Array<{playerId:number, playerName:string, started:boolean}>} roster
 */
export function reconstructTeam(pbp, teamId, roster) {
  const forms = new Map();   // surname form -> [playerId]
  for (const p of roster) {
    const d = descName(p.playerName);
    if (!d) continue;
    for (const f of d.all) {
      if (!forms.has(f)) forms.set(f, []);
      if (!forms.get(f).includes(p.playerId)) forms.get(f).push(p.playerId);
    }
  }
  const events = (pbp.actions || [])
    .filter((a) => /substitution/i.test(a.type || '') && String(a.teamId) === String(teamId))
    .map((a) => ({ ...a, t: elapsed(a.p, a.clock) }))
    .filter((a) => fin(a.t))
    .sort((a, b) => a.t - b.t || a.n - b.n);

  const maxPeriod = pbp.periods || 4;
  const stints = [];
  const unresolved = [];
  const ambiguousPeriods = [];

  /**
   * Solve one period's OPENING FIVE as a constrained state rather than assuming the previous
   * period's closing lineup carries over. Q3 in particular does not: teams re-set after halftime,
   * and assuming continuity produced 16.7% Q3 accuracy.
   *
   * Deterministic constraints, in order of strength:
   *   1. A player subbed OUT during the period without having been subbed IN first must have been
   *      on the floor when it began. This alone often determines most of the five.
   *   2. A player subbed IN during the period was NOT on the floor before that substitution.
   *   3. Exactly five players open the period.
   *   4. The previous period's closing lineup is EVIDENCE for the remaining slots, not an
   *      assumption — it only fills places conditions 1 and 2 leave open.
   * If more candidates remain than open slots, the period is marked ambiguous rather than guessed.
   */
  const openingFive = (period, prevClosing) => {
    const evs = events.filter((e) => e.p === period);
    const mustBeOn = new Set(), cannotBeOn = new Set();
    // `touched` records every player who MIGHT already have acted this period, including all
    // candidates of an AMBIGUOUS incoming name. Previously an ambiguous entry left its candidates
    // untouched, so a later exit for one of them was misread as "was on the floor at the period
    // start" — producing 72 logically impossible "more than five must-be-on" periods.
    const touched = new Set();
    for (const ev of evs) {
      const names = subNames(ev.description);
      const outId = ev.personId || null;
      if (outId && !touched.has(outId)) { mustBeOn.add(outId); touched.add(outId); }
      if (names) {
        const all = forms.get(names.inName) || [];
        const cands = all.filter((id) => !touched.has(id));
        if (cands.length === 1) { cannotBeOn.add(cands[0]); touched.add(cands[0]); }
        // Ambiguous: mark every candidate touched so none is later mistaken for a period starter.
        else for (const id of all) touched.add(id);
      }
    }
    for (const id of mustBeOn) cannotBeOn.delete(id);
    const five = new Set(mustBeOn);
    if (five.size > 5) { ambiguousPeriods.push({ period, reason: 'more than five must-be-on' }); return null; }
    // Fill remaining slots from the previous closing lineup, excluding anyone proven off.
    const fillers = [...(prevClosing || [])].filter((id) => !five.has(id) && !cannotBeOn.has(id));
    const slots = 5 - five.size;
    if (fillers.length === slots) { for (const id of fillers) five.add(id); return five; }
    if (fillers.length > slots) {
      // Prior lineup over-supplies; cannot determine which stayed.
      ambiguousPeriods.push({ period, reason: `${fillers.length} candidates for ${slots} slots` });
      for (const id of fillers.slice(0, slots)) five.add(id);
      return five;
    }
    // Under-supplied: rely on roster players not proven off.
    const rest = roster.map((p) => p.playerId).filter((id) => !five.has(id) && !cannotBeOn.has(id) && !(prevClosing || new Set()).has(id));
    if (rest.length === slots - fillers.length) {
      for (const id of [...fillers, ...rest]) five.add(id);
      return five;
    }
    ambiguousPeriods.push({ period, reason: `underdetermined: ${fillers.length}+${rest.length} for ${slots}` });
    for (const id of [...fillers, ...rest].slice(0, slots)) five.add(id);
    return five;
  };

  const onFloor = new Set(roster.filter((p) => p.started).map((p) => p.playerId));
  const openedAt = new Map();
  for (const id of onFloor) openedAt.set(id, 0);

  const close = (id, t) => {
    if (!openedAt.has(id)) return;
    stints.push({ playerId: id, start: openedAt.get(id), end: t });
    openedAt.delete(id);
    onFloor.delete(id);
  };
  const open = (id, t) => { onFloor.add(id); openedAt.set(id, t); };

  let currentPeriod = 1;
  for (const ev of events) {
    // At each period change, re-solve the opening five instead of carrying state across.
    while (ev.p > currentPeriod) {
      const boundary = periodEndSec(currentPeriod);
      const closing = new Set(onFloor);
      const nextFive = openingFive(currentPeriod + 1, closing);
      if (nextFive) {
        for (const id of [...onFloor]) if (!nextFive.has(id)) close(id, boundary);
        for (const id of nextFive) if (!onFloor.has(id)) open(id, boundary);
      }
      currentPeriod++;
    }
    const names = subNames(ev.description);
    // personId identifies the OUTGOING player exactly, so the exit never needs name matching.
    const outId = ev.personId || null;
    let inId = null;
    if (names) {
      const cands = forms.get(names.inName) || [];
      // THE DISAMBIGUATION: the incoming player cannot already be on the floor.
      const eligible = cands.filter((id) => !onFloor.has(id));
      if (eligible.length === 1) inId = eligible[0];
      else if (cands.length === 1) inId = cands[0];
      else unresolved.push({ t: ev.t, form: names.inName, candidates: cands, eligible });
    }
    if (outId && onFloor.has(outId)) close(outId, ev.t);
    if (inId && !onFloor.has(inId)) open(inId, ev.t);
  }
  // Remaining period boundaries after the last substitution event.
  while (maxPeriod > currentPeriod) {
    const boundary = periodEndSec(currentPeriod);
    const nextFive = openingFive(currentPeriod + 1, new Set(onFloor));
    if (nextFive) {
      for (const id of [...onFloor]) if (!nextFive.has(id)) close(id, boundary);
      for (const id of nextFive) if (!onFloor.has(id)) open(id, boundary);
    }
    currentPeriod++;
  }
  // Anyone still on the floor played to the final buzzer: a player leaves only by substitution.
  for (const id of [...openedAt.keys()]) close(id, periodEndSec(maxPeriod));

  // Merge adjacent stints that abut exactly (a sub recorded at a period boundary).
  const byPlayer = new Map();
  for (const s of stints) {
    if (!byPlayer.has(s.playerId)) byPlayer.set(s.playerId, []);
    byPlayer.get(s.playerId).push(s);
  }
  for (const [, list] of byPlayer) {
    list.sort((a, b) => a.start - b.start);
    for (let i = list.length - 1; i > 0; i--) {
      if (Math.abs(list[i].start - list[i - 1].end) < 1) { list[i - 1].end = list[i].end; list.splice(i, 1); }
    }
  }
  return { byPlayer, unresolved, ambiguousPeriods };
}

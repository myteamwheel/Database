// Precedence rules for combining starter sources. Enforced in code, not by convention, because
// a silent overwrite of an observed value by a derived one is unrecoverable after the fact.
//
//   1. DIRECT_NBA    direct semantic source, validated for that season-phase
//   2. DIRECT_ESPN   direct semantic source, validated for that season-phase
//   3. RECONSTRUCTED derived; may fill ONLY rows that are still UNKNOWN
//   4. UNKNOWN       null; never inferred bench
//
// The solver may never overwrite a direct source. Where two DIRECT sources disagree the conflict
// is surfaced, never silently resolved by precedence.
export const PRECEDENCE = ['DIRECT_NBA', 'DIRECT_ESPN', 'RECONSTRUCTED_V1', 'UNKNOWN'];
export const rank = (s) => {
  const i = PRECEDENCE.indexOf(s);
  return i === -1 ? PRECEDENCE.length : i;
};

/**
 * @param {object} base      current row {starter, starterSource, ...} or null
 * @param {object} incoming  candidate row
 * @returns {{row:object, action:'kept'|'filled'|'rejected'|'conflict'}}
 */
export function mergeStarter(base, incoming) {
  if (!base || base.starterSource === 'UNKNOWN') return { row: incoming, action: 'filled' };
  if (incoming.starterSource === 'UNKNOWN') return { row: base, action: 'kept' };

  const isDirect = (s) => s === 'DIRECT_NBA' || s === 'DIRECT_ESPN';
  if (isDirect(base.starterSource) && incoming.starterSource === 'RECONSTRUCTED_V1') {
    // The hard rule: derived values never displace observed ones.
    return { row: base, action: 'rejected' };
  }
  if (isDirect(base.starterSource) && isDirect(incoming.starterSource)) {
    if (base.starter !== incoming.starter) {
      return { row: { ...base, starterConflict: incoming.starterSource }, action: 'conflict' };
    }
    return { row: base, action: 'kept' };
  }
  if (rank(incoming.starterSource) < rank(base.starterSource)) return { row: incoming, action: 'filled' };
  return { row: base, action: 'kept' };
}

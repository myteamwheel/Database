// Combine the two halves of a G League season (Showcase Cup + Regular Season)
// into one full-season line.
//
// Why this exists: stats.nba.com splits the G League year into SeasonType
// "Showcase" (the Tip-Off Tournament) and "Regular Season". Neither half alone is
// the player's season. Basketball-Reference's season table is Regular Season for
// almost everyone but silently folds in Showcase-only players, so it is neither
// one thing nor the other. Combining is both more complete and a materially better
// sample: median games played goes from 20 to 29.
//
// Counting stats are summed exactly. Possession-rate statistics that cannot be
// re-derived without team context are blended on the denominator that actually
// produced them (minutes, points, field-goal attempts or makes) and are flagged
// `blended` so the interface can say so rather than implying an exact figure.
import { num } from './sources.mjs';

/** Totals that are exactly additive across the two halves. */
export const SUMMABLE = ['GP', 'W', 'L', 'MIN', 'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA',
  'OREB', 'DREB', 'REB', 'AST', 'TOV', 'STL', 'BLK', 'BLKA', 'PF', 'PFD', 'PTS',
  'PLUS_MINUS', 'DD2', 'TD3', 'NBA_FANTASY_PTS'];

export function sumTotals(a, b) {
  const out = {};
  for (const f of SUMMABLE) {
    const x = num(a?.[f]), y = num(b?.[f]);
    if (x === null && y === null) { out[f] = null; continue; }
    out[f] = (x || 0) + (y || 0);
  }
  return out;
}

/** Weighted mean of one field across the two halves. */
export function blend(a, b, field, wa, wb) {
  const x = num(a?.[field]), y = num(b?.[field]);
  if (x === null && y === null) return null;
  if (x === null) return y;
  if (y === null) return x;
  const wA = wa || 0, wB = wb || 0;
  if (wA + wB === 0) return (x + y) / 2;
  return (x * wA + y * wB) / (wA + wB);
}

export function blendFields(a, b, fields, wa, wb) {
  const out = {};
  for (const f of fields) out[f] = blend(a, b, f, wa, wb);
  return out;
}

/** Per-game fields recombine exactly when weighted by games played. */
export function blendPerGame(a, b, fields, gpA, gpB) {
  return blendFields(a, b, fields, gpA, gpB);
}

export const ADVANCED_RATE_FIELDS = ['E_OFF_RATING', 'OFF_RATING', 'E_DEF_RATING', 'DEF_RATING',
  'E_NET_RATING', 'NET_RATING', 'AST_PCT', 'AST_TO', 'AST_RATIO', 'OREB_PCT', 'DREB_PCT',
  'REB_PCT', 'TM_TOV_PCT', 'E_TOV_PCT', 'EFG_PCT', 'TS_PCT', 'USG_PCT', 'E_USG_PCT',
  'E_PACE', 'PACE', 'PACE_PER40', 'PIE'];

export const MISC_PER_GAME_FIELDS = ['PTS_OFF_TOV', 'PTS_2ND_CHANCE', 'PTS_FB', 'PTS_PAINT',
  'OPP_PTS_OFF_TOV', 'OPP_PTS_2ND_CHANCE', 'OPP_PTS_FB', 'OPP_PTS_PAINT'];

/** Share-of-team-total fields: blended on minutes, the denominator of team share. */
export const USAGE_SHARE_FIELDS = ['PCT_FGM', 'PCT_FGA', 'PCT_FG3M', 'PCT_FG3A', 'PCT_FTM',
  'PCT_FTA', 'PCT_OREB', 'PCT_DREB', 'PCT_REB', 'PCT_AST', 'PCT_TOV', 'PCT_STL', 'PCT_BLK',
  'PCT_BLKA', 'PCT_PF', 'PCT_PFD', 'PCT_PTS'];

/** Scoring-profile shares, grouped by the denominator each one is a share of. */
export const SCORING_BY_PTS = ['PCT_PTS_2PT', 'PCT_PTS_2PT_MR', 'PCT_PTS_3PT', 'PCT_PTS_FB',
  'PCT_PTS_FT', 'PCT_PTS_OFF_TOV', 'PCT_PTS_PAINT'];
export const SCORING_BY_FGA = ['PCT_FGA_2PT', 'PCT_FGA_3PT'];
export const SCORING_BY_FGM = ['PCT_AST_2PM', 'PCT_UAST_2PM', 'PCT_AST_3PM', 'PCT_UAST_3PM',
  'PCT_AST_FGM', 'PCT_UAST_FGM'];

/**
 * Build one combined official line for a player from their two half-season rows.
 * `half.X` holds the raw rows for one SeasonType; either half may be missing.
 */
export function combineHalves(rs, sc) {
  const t = sumTotals(rs.totals, sc.totals);
  const minA = num(rs.totals?.MIN) || 0, minB = num(sc.totals?.MIN) || 0;
  const gpA = num(rs.totals?.GP) || 0, gpB = num(sc.totals?.GP) || 0;
  const ptsA = num(rs.totals?.PTS) || 0, ptsB = num(sc.totals?.PTS) || 0;
  const fgaA = num(rs.totals?.FGA) || 0, fgaB = num(sc.totals?.FGA) || 0;
  const fgmA = num(rs.totals?.FGM) || 0, fgmB = num(sc.totals?.FGM) || 0;

  const adv = blendFields(rs.advanced, sc.advanced, ADVANCED_RATE_FIELDS, minA, minB);
  // POSS is a count, not a rate.
  adv.POSS = (num(rs.advanced?.POSS) || 0) + (num(sc.advanced?.POSS) || 0) || null;

  const misc = blendPerGame(rs.misc, sc.misc, MISC_PER_GAME_FIELDS, gpA, gpB);
  const usage = blendFields(rs.usage, sc.usage, USAGE_SHARE_FIELDS, minA, minB);
  const scoring = {
    ...blendFields(rs.scoring, sc.scoring, SCORING_BY_PTS, ptsA, ptsB),
    ...blendFields(rs.scoring, sc.scoring, SCORING_BY_FGA, fgaA, fgaB),
    ...blendFields(rs.scoring, sc.scoring, SCORING_BY_FGM, fgmA, fgmB),
  };
  const defense = {
    DEF_RATING: blend(rs.defense, sc.defense, 'DEF_RATING', minA, minB),
    DEF_WS: (num(rs.defense?.DEF_WS) || 0) + (num(sc.defense?.DEF_WS) || 0),
    PCT_DREB: blend(rs.defense, sc.defense, 'PCT_DREB', minA, minB),
    PCT_STL: blend(rs.defense, sc.defense, 'PCT_STL', minA, minB),
    PCT_BLK: blend(rs.defense, sc.defense, 'PCT_BLK', minA, minB),
  };

  // Percentages recomputed exactly from the summed totals rather than blended.
  const fg2m = (t.FGM ?? 0) - (t.FG3M ?? 0);
  const fg2a = (t.FGA ?? 0) - (t.FG3A ?? 0);
  const exact = {
    FG_PCT: t.FGA ? t.FGM / t.FGA : null,
    FG3_PCT: t.FG3A ? t.FG3M / t.FG3A : null,
    FG2_PCT: fg2a ? fg2m / fg2a : null,
    FT_PCT: t.FTA ? t.FTM / t.FTA : null,
    EFG_PCT: t.FGA ? (t.FGM + 0.5 * t.FG3M) / t.FGA : null,
    TS_PCT: (t.FGA || t.FTA) ? t.PTS / (2 * (t.FGA + 0.44 * t.FTA)) : null,
    FG2M: fg2m, FG2A: fg2a,
    AST_TO: t.TOV ? t.AST / t.TOV : null,
  };

  return {
    totals: t,
    advanced: adv,
    misc,
    usage,
    scoring,
    defense,
    exact,
    split: { regularGP: gpA, showcaseGP: gpB, regularMIN: minA, showcaseMIN: minB },
    blended: gpA > 0 && gpB > 0,
  };
}

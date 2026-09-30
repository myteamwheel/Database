import { combineForecastTimeframes } from '../scripts/lib/forecast-timeframes.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail='') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(String(e.message || e)) : true; } };

const actual = {
  teamGamesElapsed: 20,
  gp: 18,
  totals: {
    min: 540, pts: 360, reb: 108, oreb: 18, dreb: 90, ast: 90, stl: 18, blk: 9, tov: 45,
    fgm: 126, fga: 270, fg3m: 36, fg3a: 99, ftm: 72, fta: 90,
  },
};
const remaining = {
  gp: 50,
  perGame: {
    mpg: 32, pts: 22, reb: 6.5, oreb: 1, dreb: 5.5, ast: 5.5, stl: 1.1, blk: 0.5, tov: 2.6,
    fgm: 7.8, fga: 16.2, fg3m: 2.2, fg3a: 6.1, ftm: 4.2, fta: 5.1,
  },
};

const out = combineForecastTimeframes({
  season: '2026-27',
  asOf: '2026-12-01',
  scheduledGames: 82,
  actual,
  remaining,
});

check('timeframe output labels interim target explicitly',
  out.season === '2026-27' && out.status === 'interim' && out.asOf === '2026-12-01');
check('actual totals are preserved exactly',
  out.actualToDate.totals.pts === 360 && out.actualToDate.totals.fga === 270 && out.actualToDate.gp === 18);
check('remaining team games are explicit',
  out.remainingSeason.teamGamesRemaining === 62 && out.remainingSeason.gp === 50);
check('remaining totals derive from per-game forecast',
  Math.abs(out.remainingSeason.totals.pts - 1100) < 1e-9
    && Math.abs(out.remainingSeason.totals.fga - 810) < 1e-9);
check('combined totals equal actual plus remaining',
  Math.abs(out.fullSeason.totals.pts - 1460) < 1e-9
    && Math.abs(out.fullSeason.totals.fga - 1080) < 1e-9
    && out.fullSeason.gp === 68);
check('combined per-game values use combined player games',
  Math.abs(out.fullSeason.perGame.pts - 1460 / 68) < 1e-12);
check('combined percentages pool makes and attempts rather than averaging percentages',
  Math.abs(out.fullSeason.perGame.fgPct - ((126 + 7.8*50) / (270 + 16.2*50))) < 1e-12
    && Math.abs(out.fullSeason.perGame.fg3Pct - ((36 + 2.2*50) / (99 + 6.1*50))) < 1e-12
    && Math.abs(out.fullSeason.perGame.ftPct - ((72 + 4.2*50) / (90 + 5.1*50))) < 1e-12);
check('actual-to-date percentages derive from actual totals',
  Math.abs(out.actualToDate.perGame.fgPct - 126/270) < 1e-12);

const finalOut = combineForecastTimeframes({
  season: '2026-27', asOf: '2027-04-12', scheduledGames: 82,
  actual: { ...actual, teamGamesElapsed: 82, gp: 70 },
  remaining: { gp: 0, perGame: remaining.perGame },
});
check('zero remaining team games produces a final view',
  finalOut.status === 'final' && finalOut.remainingSeason.teamGamesRemaining === 0 && finalOut.fullSeason.gp === 70);
check('zero-attempt percentages stay unavailable',
  combineForecastTimeframes({
    season:'2026-27', asOf:'2026-10-25', scheduledGames:82,
    actual:{teamGamesElapsed:2,gp:1,totals:{min:5,pts:0,reb:0,oreb:0,dreb:0,ast:0,stl:0,blk:0,tov:0,fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0}},
    remaining:{gp:0,perGame:{mpg:0,pts:0,reb:0,oreb:0,dreb:0,ast:0,stl:0,blk:0,tov:0,fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0}}
  }).fullSeason.perGame.fgPct === null);
check('player actual games cannot exceed team games elapsed',
  throws(() => combineForecastTimeframes({season:'2026-27',asOf:'2026-11-01',scheduledGames:82,actual:{...actual,gp:21},remaining}), /games|elapsed/i));
check('team games elapsed cannot exceed scheduled games',
  throws(() => combineForecastTimeframes({season:'2026-27',asOf:'2026-11-01',scheduledGames:82,actual:{...actual,teamGamesElapsed:83},remaining}), /scheduled/i));
check('projected remaining player games cannot exceed remaining team games',
  throws(() => combineForecastTimeframes({season:'2026-27',asOf:'2026-11-01',scheduledGames:82,actual:{...actual,teamGamesElapsed:70},remaining:{...remaining,gp:13}}), /remaining.*games/i));
check('negative totals are rejected',
  throws(() => combineForecastTimeframes({season:'2026-27',asOf:'2026-11-01',scheduledGames:82,actual:{...actual,totals:{...actual.totals,pts:-1}},remaining}), /negative|pts/i));

const combine = (overrides={}) => combineForecastTimeframes({season:'2026-27',asOf:'2026-12-01',scheduledGames:82,actual,remaining,...overrides});
let fractional; try { fractional=combine({remaining:{...remaining,gp:49.5}}); } catch {}
check('expected remaining games may be fractional', fractional?.fullSeason.gp===67.5);
check('zero actual games cannot have positive totals', throws(()=>combine({actual:{...actual,gp:0}}), /zero|games/i));
check('actual points must reconcile with makes', throws(()=>combine({actual:{...actual,totals:{...actual.totals,pts:999}}}), /points|pts/i));
check('three attempts cannot exceed all attempts', throws(()=>combine({actual:{...actual,totals:{...actual.totals,fg3a:300}}}), /attempt|3pa/i));
check('two-point makes cannot exceed two-point attempts', throws(()=>combine({actual:{...actual,totals:{...actual.totals,fg3a:250}}}), /two.point/i));
console.log(`${fail?'FAILED':'ALL PASS'} · timeframes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

const DEFAULT_TOL = 1e-6;

const finite = (v) => Number.isFinite(v);
const near = (a,b,t=DEFAULT_TOL) => finite(a) && finite(b) && Math.abs(a-b) <= t;

function fail(msg){ throw new Error(msg); }

export function validateProjectionAccounting(proj,{league='NBA',scheduledGames=null,tolerance=DEFAULT_TOL}={}) {
  if (!['NBA','GLEAGUE'].includes(league)) fail('Unsupported projection league');
  if (!finite(tolerance) || tolerance < 0) fail('Accounting tolerance must be finite and non-negative');
  if (!proj || typeof proj !== 'object') fail('projection is required');
  const a = proj.accounting;
  if (!a || typeof a !== 'object') fail('projection accounting is required');

  const games = scheduledGames ?? (league === 'NBA' ? 82 : league === 'GLEAGUE' ? 50 : null);
  if (!Number.isInteger(games) || games <= 0) fail('scheduled games must be a positive integer');
  if (!(finite(proj.gp) && proj.gp >= 0 && proj.gp <= games + tolerance)) fail('GP exceeds league schedule or is invalid');
  const maxMpg = league === 'NBA' ? 42 : 44;
  if (!(finite(proj.mpg) && proj.mpg >= 0 && proj.mpg <= maxMpg + tolerance)) fail('MPG/minutes outside league bound');
  if (!(finite(a.mpg) && a.mpg >= 0 && a.mpg <= maxMpg + tolerance)) fail('Accounting MPG/minutes outside league bound');

  for (const k of ['pts','reb','oreb','dreb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta']) {
    if (!finite(a[k]) || a[k] < -tolerance) fail(`accounting ${k} is invalid`);
  }
  if (a.fgm > a.fga + tolerance) fail('FGM exceeds FGA');
  if (a.fg3m > a.fg3a + tolerance) fail('FG3M/3PM exceeds FG3A/3PA');
  if (a.fg3m > a.fgm + tolerance) fail('FG3M/3PM exceeds FGM');
  if (a.fg3a > a.fga + tolerance) fail('FG3A/3PA exceeds all field-goal attempts');
  if (a.fgm-a.fg3m > a.fga-a.fg3a + tolerance) fail('Two-point makes exceed two-point attempts');
  if (a.ftm > a.fta + tolerance) fail('FTM exceeds FTA');
  if (!near(a.reb,a.oreb+a.dreb,tolerance)) fail('REB must equal OREB + DREB');

  const ftValue = a.ftValue;
  // NBA attempts are always worth one point. G League pooled trip values can
  // differ, but must be explicitly supplied rather than silently defaulted.
  if (!finite(ftValue) || ftValue < 1 || ftValue > 3) fail('Free throw value must be explicit and between one and three');
  if (league === 'NBA' && ftValue !== 1) fail('NBA free throw value must equal one');
  const pts = 2*(a.fgm-a.fg3m)+3*a.fg3m+a.ftm*ftValue;
  if (!near(a.pts,pts,tolerance)) fail('PTS/points accounting mismatch');

  const pctChecks = [
    ['fgPct', a.fga > 0 ? a.fgm/a.fga : null, 'FG percentage'],
    ['fg3Pct', a.fg3a > 0 ? a.fg3m/a.fg3a : null, '3-point percentage'],
    ['ftPct', a.fta > 0 ? a.ftm/a.fta : null, 'free throw percentage'],
  ];
  for (const [field,expected,label] of pctChecks) {
    if (expected === null) {
      if (proj[field] !== null && proj[field] !== undefined) fail(`${label} must be unavailable with zero attempts`);
    } else if (!near(proj[field],expected,1e-3 + tolerance)) fail(`${label}/${field} does not derive from accounting`);
  }
  const tsDen = 2*(a.fga + 0.44*a.fta);
  const expectedTs = tsDen > 0 ? a.pts/tsDen : null;
  if (expectedTs === null) {
    if (proj.ts !== null && proj.ts !== undefined) fail('true shooting/TS must be unavailable with zero attempts');
  } else if (!near(proj.ts,expectedTs,1e-3 + tolerance)) fail('true shooting/TS does not derive from accounting');

  if (finite(a.gp) && (a.gp < 0 || a.gp > games + tolerance)) fail('accounting GP exceeds league schedule or is invalid');
  if (!near(a.gp,proj.gp,tolerance)) fail('Accounting GP must equal published GP');
  for (const k of ['mpg','pts','reb','oreb','dreb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta']) {
    // Published rates are rounded to one decimal; accounting preserves precision.
    if (!near(proj[k],a[k],0.050001)) fail(`Published ${k} disagrees with accounting`);
  }
  if (!a.totals || typeof a.totals !== 'object' || Array.isArray(a.totals)) fail('Season accounting totals are required');
  {
    const accountingGp = finite(a.gp) ? a.gp : proj.gp;
    for (const k of ['pts','reb','oreb','dreb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta']) {
      if (!finite(a.totals[k])) fail(`total ${k} is invalid`);
      const expected = a[k]*accountingGp;
      if (!near(a.totals[k],expected,Math.max(1e-5,tolerance*Math.max(1,Math.abs(expected))))) {
        fail(`total ${k} does not equal per-game accounting x accounting GP`);
      }
    }
  }
  return true;
}

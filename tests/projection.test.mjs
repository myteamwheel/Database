// 2026-27 projection: data and formula checks. No browser.
//   node tests/projection.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildProjections } from '../scripts/build-projections.mjs';
import { perGameLine, ageLookup, projectRates, seasonPriors, prepare, AGE_MIN, RATE_STATS } from '../scripts/lib/projection.mjs';
import { reconcileMinutes, reconciliationBudget, historicalFallbackEvidence, rookieInputCoverage, summarizeRookieCoverage } from '../scripts/lib/projection-context.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawInputs = fs.readFileSync(path.join(ROOT, 'scripts/data/projection/inputs.json'));
const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'PROJECTION_2026_27.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

let pass = 0, fail = 0;
let rebuiltData;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

// 1. The card was fitted on exactly the committed inputs.
check('card matches the committed inputs file',
  card.builtFrom.sha256 === crypto.createHash('sha256').update(rawInputs).digest('hex'));

// 2. Rebuilding from inputs + card reproduces every committed projection, value for value.
{
  const copy = JSON.parse(JSON.stringify(data));
  buildProjections(copy, rawInputs, card);
  rebuiltData = copy;
  let diff = 0, first = '';
  const examples = [];
  const fieldDiffs = new Map();
  const collectDiffs = (a, b, prefix = '') => {
    if (Object.is(a, b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object'
        && !Array.isArray(a) && !Array.isArray(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      return [...keys].flatMap(k => collectDiffs(a[k], b[k], prefix ? `${prefix}.${k}` : k));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length), out = [];
      for (let i = 0; i < n; i++) out.push(...collectDiffs(a[i], b[i], `${prefix}[${i}]`));
      return out;
    }
    return [{ path: prefix, committed: a, rebuilt: b }];
  };
  for (const lg of ['NBA', 'GLEAGUE']) {
    data.leagues[lg].forEach((p, i) => {
      const rebuilt = copy.leagues[lg][i].proj;
      if (JSON.stringify(p.proj) !== JSON.stringify(rebuilt)) {
        diff++; first ||= `${lg} ${p.name}`;
        const changes = collectDiffs(p.proj, rebuilt);
        for (const c of changes) fieldDiffs.set(c.path, (fieldDiffs.get(c.path) || 0) + 1);
        if (examples.length < 8) examples.push({ player: `${lg} ${p.name}`, changes: changes.slice(0, 8) });
      }
    });
  }
  const fields = [...fieldDiffs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}:${n}`).join(', ');
  check('rebuild reproduces the committed projections exactly', diff === 0,
    `${diff} differ, first ${first}; fields ${fields}; examples ${JSON.stringify(examples)}`);
}

// 3. Every player has a projection or an explicit, explained abstention. Never silently missing.
for (const lg of ['NBA', 'GLEAGUE']) {
  const missing = data.leagues[lg].filter((p) => !p.proj || (p.proj.abstain && !p.proj.reason));
  check(`${lg}: every player has a projection or a stated reason`, missing.length === 0, missing.slice(0, 3).map((p) => p.name).join(', '));
  const played = data.leagues[lg].filter((p) => p.appeared && p.minutes > 0);
  const abst = played.filter((p) => p.proj?.abstain);
  check(`${lg}: everyone who played in 2025-26 is projected`, abst.length === 0, abst.slice(0, 3).map((p) => p.name).join(', '));
}

// 4. Every projected line is physically possible and internally consistent.
for (const lg of ['NBA', 'GLEAGUE']) {
  const games = lg === 'NBA' ? 82 : 50;
  const bad = [];
  for (const p of data.leagues[lg]) {
    const c = p.proj;
    if (!c || c.abstain) continue;
    const probs = [];
    if (!(c.gp > 0 && c.gp <= games)) probs.push(`gp ${c.gp}`);
    if (!(c.mpg >= 1 && c.mpg <= 42)) probs.push(`mpg ${c.mpg}`);
    for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']) if (!(c[k] >= 0)) probs.push(`${k} ${c[k]}`);
    for (const k of ['fgPct', 'fg3Pct', 'ftPct', 'ts']) if (!(c[k] > 0 && c[k] < 1)) probs.push(`${k} ${c[k]}`);
    if (!(c.ptsLo <= c.pts + 0.05 && c.pts <= c.ptsHi + 0.05)) probs.push(`pts range ${c.ptsLo}-${c.ptsHi} vs ${c.pts}`);
    if (Math.abs(c.reb - c.oreb - c.dreb) > 0.15) probs.push('reb != oreb + dreb');
    if (c.fg3m > c.fg3a * 1.0 + 0.05) probs.push('3PM > 3PA');
    if (probs.length) bad.push(`${p.name}: ${probs.join('; ')}`);
  }
  check(`${lg}: every projected line is possible and consistent`, bad.length === 0, bad.slice(0, 3).join(' | '));
}

// 5. The formula's points identity, including the G League's single free throw worth the trip.
{
  const rate = { fga: 20, fg3a: 8, fta: 6, oreb: 1, dreb: 4, ast: 5, stl: 1, blk: 0.5, tov: 2, pf: 2 };
  const pct = { fg2: 0.55, fg3: 0.36, ft: 0.8 };
  const nba = perGameLine(rate, pct, 36, 70, 100, 1);
  const f = (36 * 100) / 48 / 100;
  const expect = (2 * 12 * 0.55 + 3 * 8 * 0.36 + 6 * 0.8) * f;
  check('per-game points = 2 x 2PM + 3 x 3PM + FTM', Math.abs(nba.pts - expect) < 1e-9);
  const gl = perGameLine(rate, pct, 36, 40, 100, 1.67);
  check('G League free throws count at the league points-per-make', Math.abs(gl.pts - nba.pts - 6 * 0.8 * f * 0.67) < 1e-9);
}

// 6. With no possessions of his own a player's rate is exactly the (scaled) position norm.
{
  const D = prepare(JSON.parse(rawInputs));
  const pri = seasonPriors(D.nba.seasons.get('2025-26'), D.bio);
  const P = card.nba.params;
  const empty = { pid: -1, poss: 0, min: 0, gp: 0, age: 26 };
  for (const k of RATE_STATS) empty[k] = 0;
  Object.assign(empty, { fg2m: 0, fg2a: 0, fg3m: 0, ftm: 0 });
  const zeroAge = { ...P, age: Object.fromEntries(Object.keys(P.age).map((k) => [k, null])), exp: {}, trendShare: 0 };
  const pr = projectRates([empty, null, null], '2026-27', { big: 1 }, pri, zeroAge, null);
  const ok = RATE_STATS.every((k) => Math.abs(pr.rate[k] - pri.at(1)[k] * P.m[k]) < 1e-9);
  check('zero history returns the position norm (x its fitted scale)', ok);
  check('age table interpolates between whole ages',
    Math.abs(ageLookup([0, 0.1, 0.2], AGE_MIN + 0.5) - 0.05) < 1e-12 && ageLookup(null, 30) === 0);
}

// 7. The frozen card still beats simply repeating last season on the test season. A refit that
//    stops doing so should fail loudly rather than ship.
{
  const m = card.backtest.nba.all.mae;
  for (const k of ['pts', 'reb', 'ast', 'mpg', 'gp']) {
    check(`backtest ${card.backtest.nba.season}: ${k} beats repeating last season`, m[k].model < m[k].repeat, `${m[k].model} vs ${m[k].repeat}`);
  }
  check('projection metadata is published with the data', data.projectionMeta?.id === card.id && !!data.projectionMeta?.rostersAsOf);
  const ledgers = Object.entries(rebuiltData.projectionMeta?.teamBudgets || {});
  check('every listed NBA roster has an explicit 240-minute budget', ledgers.length === 30 && ledgers.every(([, x]) => x.allocated === 240 && x.excessFloor === 0), `${ledgers.length} teams`);
  const uneven = ledgers.map(([team]) => rebuiltData.leagues.NBA.filter(p => p.proj?.team === team && p.proj?.status !== 'unsigned')
    .reduce((sum, p) => sum + p.proj.effectiveMpg, 0));
  check('published effective minutes reconcile after rounding', uneven.every(x => Math.abs(x - 240) <= 0.15), `${uneven.filter(x => Math.abs(x - 240) > 0.15).slice(0, 3)}`);
  check('roster players without a recent line receive explicit fallback or abstention',
    rebuiltData.leagues.NBA.filter(p => p.currentRoster && (!p.proj || (!p.proj.abstain && !['rookie-cohort-fallback', 'older-history-fallback', 'multi-year-history'].includes(p.proj.basis)))).length === 0);
  const badAccounting = rebuiltData.leagues.NBA.filter(p => p.proj && !p.proj.abstain
    && (Math.abs(p.proj.accounting.reb - p.proj.oreb - p.proj.dreb) > 0.11
      || Math.abs(p.proj.accounting.pts - (2 * (p.proj.accounting.fgm - p.proj.accounting.fg3m) + 3 * p.proj.accounting.fg3m + p.proj.accounting.ftm)) > 0.11));
  check('published points and rebound identities reconcile before rounding', badAccounting.length === 0, `${badAccounting.length} rows`);
}

// 8. Minute allocation respects the budget, boxes every player in, and responds monotonically to
//    role priors without claiming that this allocation itself predicts an accurate rotation.
{
  const roster = Array.from({ length: 8 }, (_, i) => ({ pid: i, mpg: i < 5 ? 32 : 8, share: 1, pr: { baseMin: 900 } }));
  const result = reconcileMinutes(roster, 240);
  check('minute reconciliation exactly satisfies its budget', Math.abs(result.allocated - 240) < 1e-8
    && Math.abs(roster.reduce((s, r) => s + r.effectiveMpg, 0) - 240) < 1e-6);
  check('minutes stay inside feasible player bounds', roster.every(r => r.mpg >= 1 && r.mpg <= 40));
  const unchanged = roster.map(r => r.mpg);
  const raised = roster.map(r => ({ pid:r.pid, mpg:r.mpg, share:1, pr:{baseMin:900} }));
  raised[0].mpg += 4;
  reconcileMinutes(raised, 240);
  check('adding role demand shifts minutes away from the rest of the team', raised[0].mpg > unchanged[0]
    && raised.slice(1).reduce((s,r)=>s+r.mpg,0) < unchanged.slice(1).reduce((s,v)=>s+v,0));
}


// 9. Returner and rookie fallbacks expose machine-readable support/coverage without pretending
//    unavailable evidence exists.
{
  const ret = historicalFallbackEvidence([
    null, null, null,
    { season:'2022-23', gp:60, min:1500 },
    { season:'2021-22', gp:40, min:800 },
  ], '2026-27', 42, 42/(42+40));
  check('older-history fallback records its last observed season and blank-season gap',
    ret.lastObservedSeason === '2022-23' && ret.blankSeasonGapCount === 3);
  check('older-history fallback records weighted exposure and reliability',
    Math.abs(ret.weightedHistoricalExposure - 42) < 1e-12 && Math.abs(ret.reliability - 42/82) < 1e-12);
  check('older-history fallback support stays explicitly low',
    ret.support === 'low' && /return-to-play|injury clearance/i.test(ret.note));

  const veryLow = historicalFallbackEvidence([{season:'2022-23',gp:5,min:50}], '2026-27', 5, 5/45);
  check('weak returner evidence is classified very-low rather than promoted',
    veryLow.support === 'very-low');
  const unavailable = historicalFallbackEvidence([], '2026-27', 0, 0);
  check('no historical returner exposure is unavailable',
    unavailable.support === 'unavailable' && unavailable.lastObservedSeason === null);

  const cov = rookieInputCoverage({
    draftPick: 12, position:'F', age:20, peers:45,
    preNbaStats:'unavailable'
  });
  check('rookie input coverage distinguishes known and unavailable inputs',
    cov.draftSlot.available === true
      && cov.position.available === true
      && cov.entryAge.available === true
      && cov.historicalCohort.available === true
      && cov.preNbaProduction.available === false
      && cov.contractSecurity.available === false
      && cov.currentInjuryClearance.available === false);

  const summary = summarizeRookieCoverage([
    cov,
    rookieInputCoverage({draftPick:null,position:null,age:null,peers:30,preNbaStats:'unavailable'})
  ]);
  check('rookie coverage summary reports counts by input without filling gaps',
    summary.players === 2
      && summary.draftSlot.available === 1
      && summary.position.available === 1
      && summary.entryAge.available === 1
      && summary.historicalCohort.available === 2
      && summary.preNbaProduction.available === 0
      && summary.contractSecurity.available === 0
      && summary.currentInjuryClearance.available === 0);

  const rookies = rebuiltData.leagues.NBA.filter((p) => p.proj?.basis === 'rookie-cohort-fallback');
  check('published rookie fallbacks carry the machine-readable coverage block',
    rookies.length > 0 && rookies.every((p) => p.proj.why?.rookie?.coverage
      && p.proj.why.rookie.coverage.preNbaProduction.available === false
      && p.proj.why.rookie.coverage.contractSecurity.available === false
      && p.proj.why.rookie.coverage.currentInjuryClearance.available === false),
    `${rookies.length} rookies`);
  const metaCov = rebuiltData.projectionMeta?.rookieInputCoverage;
  check('projection metadata aggregates rookie input coverage',
    metaCov?.players === rookies.length
      && metaCov?.historicalCohort?.available === rookies.length
      && metaCov?.preNbaProduction?.available === 0
      && metaCov?.contractSecurity?.available === 0
      && metaCov?.currentInjuryClearance?.available === 0);

  const returners = rebuiltData.leagues.NBA.filter((p) => p.proj?.basis === 'older-history-fallback');
  check('published older-history fallbacks expose explicit support metadata',
    returners.every((p) => ['low','very-low','unavailable'].includes(p.proj.why?.fallback?.support)
      && p.proj.why.fallback.returnToPlayPredicted === false
      && /injury clearance|return-to-play/i.test(p.proj.why.fallback.note || '')),
    `${returners.length} returners`);
}


// 10. Minute reconciliation sensitivity: controlled input changes must produce coherent,
//     bounded responses while conserving the team budget.
{
  const mk = (mpg=30, share=1, baseMin=900) => ({ mpg, share, pr:{baseMin} });
  const base = Array.from({length:8},()=>mk());
  reconcileMinutes(base,240);
  const baseEff = base.map(r=>r.effectiveMpg);

  const roleUp = Array.from({length:8},()=>mk());
  roleUp[0].mpg += 1;
  reconcileMinutes(roleUp,240);
  check('role-demand increase moves the targeted effective minutes upward',
    roleUp[0].effectiveMpg > baseEff[0]);
  check('role-demand perturbation preserves the team budget',
    Math.abs(roleUp.reduce((s,r)=>s+r.effectiveMpg,0)-240) < 1e-6);

  const avail = Array.from({length:8},()=>mk());
  avail[0].share = 0.5;
  reconcileMinutes(avail,240);
  check('availability reduction lowers the targeted effective minutes',
    avail[0].effectiveMpg < baseEff[0]);
  check('availability reduction reallocates released effective minutes to teammates',
    avail.slice(1).reduce((s,r)=>s+r.effectiveMpg,0) > baseEff.slice(1).reduce((s,v)=>s+v,0));
  check('availability perturbation preserves the team budget',
    Math.abs(avail.reduce((s,r)=>s+r.effectiveMpg,0)-240) < 1e-6);

  const sample = Array.from({length:8},(_,i)=>mk(25,1,i===0?2400:i===1?100:900));
  const before = sample.map(r=>r.mpg*r.share);
  reconcileMinutes(sample,240);
  const highSampleMove = Math.abs(sample[0].effectiveMpg-before[0]);
  const lowSampleMove = Math.abs(sample[1].effectiveMpg-before[1]);
  check('lower-sample roles are more mobile than established roles under identical pressure',
    lowSampleMove > highSampleMove + 1e-6,
    `low ${lowSampleMove.toFixed(3)} vs high ${highSampleMove.toFixed(3)}`);

  const tiny = Array.from({length:8},()=>mk());
  tiny[0].mpg += 0.2;
  reconcileMinutes(tiny,240);
  const unrelatedJump = Math.max(...tiny.slice(1).map((r,i)=>Math.abs(r.effectiveMpg-baseEff[i+1])));
  check('small role perturbations do not create multi-MPG jumps in unrelated players',
    unrelatedJump < 0.25, `largest unrelated jump ${unrelatedJump}`);
  check('all sensitivity scenarios remain inside feasible player bounds',
    [...roleUp,...avail,...sample,...tiny].every(r=>r.mpg>=1-1e-9 && r.mpg<=40+1e-9));
  const incompleteBudget = reconciliationBudget(
    Array.from({length:8},()=>({mpg:25,share:1})), {rosterPlayers:10, fullBudget:240});
  check('incomplete roster coverage does not force projected players upward to fill unknown minutes',
    incompleteBudget.requestedBudget === 200
      && incompleteBudget.unprojectedRosterPlayers === 2
      && incompleteBudget.unmodeledReserve === 40);
  const completeBudget = reconciliationBudget(
    Array.from({length:8},()=>({mpg:25,share:1})), {rosterPlayers:8, fullBudget:240});
  check('complete roster coverage still reconciles to the full team budget',
    completeBudget.requestedBudget === 240
      && completeBudget.unprojectedRosterPlayers === 0
      && completeBudget.unmodeledReserve === 0);

}


{
  const cv = rebuiltData.projectionMeta?.contextReconciliation;
  const cardCv = CARD.backtest?.nba?.contextReconciliation;
  check('published context reconciliation report matches the frozen model card',
    cv && cardCv && JSON.stringify(cv) === JSON.stringify(cardCv));
  check('context reconciliation report does not overclaim held-out improvement',
    /history-eligible/i.test(cv?.population || '')
      && /not scored|not validated|held fixed|proxy/i.test(cv?.limitations || '')
      && Number.isFinite(cv?.mae?.delta?.mpg));
  check('held-out context report records complete team-budget coverage explicitly',
    cv?.teamBudgetCoverage?.exact === cv?.teamBudgetCoverage?.teams
      && cv?.openingRosterCoverage?.completeTeams === cv?.teams
      && cv?.openingRosterCoverage?.excludedTeams >= 0);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

// Projection sensitivity regression tests. Node-only, deterministic.
import { loadSensitivityReport } from '../scripts/projection-sensitivity.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

const r = loadSensitivityReport();
const team = r.controlled.teamContext;
const role = r.controlled.roleDemand;
const availability = r.controlled.availability;
const sample = r.controlled.sampleSize;
const thresholds = r.controlled.thresholds;
const ablation = r.heldoutAblation;

check('usage pressure moves the synthetic crowded-roster scoring rate downward',
  team.rosterBalance > 1 && team.usageFactor < 1 && team.points.full < team.points.noUsage,
  JSON.stringify(team));

check('moved-team usage adjustment is active and directionally coherent',
  team.parameters.movedUsage < 0 && team.movedFactor < 1 && team.points.full < team.points.noMoved,
  JSON.stringify(team));

if (team.parameters.roleGamma === 0) {
  check('inactive frozen role-rate driver is reported honestly',
    r.observations.roleRateDriverActive === false
      && team.roleFactor === 1
      && Math.abs(team.points.full - team.points.noRole) < 1e-9,
    JSON.stringify(team));
} else {
  check('active frozen role-rate driver changes the controlled scenario',
    r.observations.roleRateDriverActive === true && Math.abs(team.points.full - team.points.noRole) > 1e-9,
    JSON.stringify(team));
}

check('role-demand increase raises the targeted effective minutes and offsets teammates',
  role.targetRaised > role.targetBase && role.teammatesRaised < role.teammatesBase
    && Math.abs(role.raisedTotal - 240) < 1e-6,
  JSON.stringify(role));

check('availability reduction lowers target effective minutes and redistributes them',
  availability.targetEffectiveReduced < availability.targetEffectiveBase
    && availability.teammateEffectiveReduced > availability.teammateEffectiveBase,
  JSON.stringify(availability));
check('availability perturbation preserves the 240-minute effective budget',
  Math.abs(availability.baseTotal - 240) < 1e-6 && Math.abs(availability.reducedTotal - 240) < 1e-6,
  JSON.stringify(availability));

check('larger historical samples increase own-data weight rather than prior weight',
  sample.highPossessions > sample.lowPossessions
    && sample.astOwnWeightHigh > sample.astOwnWeightLow
    && sample.fgaOwnWeightHigh > sample.fgaOwnWeightLow,
  JSON.stringify(sample));

check('role thresholds are explicit and only change labels at 10/18/28 MPG',
  thresholds.exposure['10'].below === 'limited role' && thresholds.exposure['10'].at === 'reserve rotation'
    && thresholds.exposure['18'].below === 'reserve rotation' && thresholds.exposure['18'].at === 'regular rotation'
    && thresholds.exposure['28'].below === 'regular rotation' && thresholds.exposure['28'].at === 'core rotation',
  JSON.stringify(thresholds.exposure));
check('threshold-churn report includes exposure counts for every boundary',
  [10,18,28].every((x) => ['within025','within050','within100'].every((k) => Number.isInteger(thresholds.exposure[String(x)][k]))));

check('frozen held-out driver ablations are finite and retained',
  ['noUsage','noRole','noMoved','noPace','noTeamContext'].every((name) =>
    ['pts','mpg','reb','ast'].every((metric) => Number.isFinite(ablation[name]?.[metric]?.mae)
      && Number.isFinite(ablation[name]?.[metric]?.deltaVsFull))));
check('combined team-context ablation does not silently outperform the frozen full model on points',
  ablation.noTeamContext.pts.deltaVsFull >= 0,
  JSON.stringify(ablation.noTeamContext));
check('availability limitation remains explicit',
  r.observations.actualAvailabilityVerified === false && /not verified/i.test(r.observations.actualAvailabilityNote));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

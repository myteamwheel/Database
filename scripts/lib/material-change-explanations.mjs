export const MATERIAL_CHANGE_THRESHOLDS = Object.freeze({
  grade: 0.25,
  rateGrade: 0.25,
  magnitudeGrade: 0.35,
  projection: Object.freeze({ mpg: 1.0, gp: 3.0, pts: 1.0, reb: 0.5, ast: 0.5, usage: 0.02 }),
  tulipBetaMpg: 1.0,
  projectedRoleMpg: 1.0,
  teamFit: 5.0,
  compConfidence: 5.0,
});

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const num = (v) => fin(v) ? Number(v) : null;
const same = (a, b) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const absDelta = (a, b) => (fin(a) && fin(b) ? Math.abs(Number(b) - Number(a)) : Infinity);
const delta = (a, b) => (fin(a) && fin(b) ? Number(b) - Number(a) : null);
const materialNumberChange = (a, b, threshold) => fin(a) !== fin(b) || (fin(a) && fin(b) && absDelta(a, b) >= threshold);
const numberOutput = (field, before, after) => ({ field, before: num(before), after: num(after), delta: delta(before, after) });
const playerKey = (league, row) => `${league}:${String(row?.nbaPersonId ?? row?.playerId ?? '')}`;
const clean = (v) => v === undefined ? null : v;

function leagueRows(data, league) {
  const raw = data?.leagues?.[league];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.players)) return raw.players;
  if (Array.isArray(raw?.rows)) return raw.rows;
  return [];
}

function playerIndex(data) {
  const out = new Map();
  for (const league of ['NBA', 'GLEAGUE']) {
    for (const row of leagueRows(data, league)) {
      const key = playerKey(league, row);
      if (!key.endsWith(':')) out.set(key, { league, row });
    }
  }
  return out;
}

function driver(label, before, after, extra = {}) {
  if (same(before, after)) return null;
  return { label, before: clean(before), after: clean(after), delta: delta(before, after), ...extra };
}

function pushDriver(list, label, before, after, extra = {}) {
  const d = driver(label, before, after, extra);
  if (d) list.push(d);
}

function objectDeltaDrivers(before = {}, after = {}, prefix = '', limit = 4) {
  const rows = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key], b = after?.[key];
    if (same(a, b)) continue;
    rows.push({ label: prefix ? `${prefix}.${key}` : key, before: clean(a), after: clean(b), delta: delta(a, b), score: fin(a) && fin(b) ? Math.abs(Number(b) - Number(a)) : Infinity });
  }
  return rows.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit)
    .map(({ score, ...x }) => x);
}

function explanation(drivers, { legacy = false, boundary = null } = {}) {
  if (drivers.length) {
    return {
      status: legacy ? 'legacy-trace-limited' : 'explained',
      drivers: drivers.slice(0, 8),
      boundary: boundary || (legacy ? 'The prior artifact predates this explanation trace; current drivers are preserved, but exact before/after attribution is limited.' : null),
    };
  }
  return {
    status: 'unexplained',
    drivers: [],
    boundary: boundary || 'A material output changed without a changed player-level driver or model/version boundary in the compared artifacts.',
  };
}

function gradeChange(before, after, field, threshold, beforeData, afterData) {
  if (!materialNumberChange(before?.[field], after?.[field], threshold)) return null;
  const compKey = field === 'rateGrade' ? 'rateComponents' : field === 'magnitudeGrade' ? 'magnitudeComponents' : 'components';
  const drivers = objectDeltaDrivers(before?.[compKey], after?.[compKey], compKey, 4);
  pushDriver(drivers, 'reliabilityWeight', before?.reliabilityWeight, after?.reliabilityWeight);
  pushDriver(drivers, 'gradeCoverage', before?.gradeCoverage, after?.gradeCoverage);
  pushDriver(drivers, 'minutes', before?.minutes, after?.minutes);
  pushDriver(drivers, 'gamesPlayed', before?.gp, after?.gp);
  pushDriver(drivers, 'gradeModelVersion', beforeData?.gradeModel?.version ?? beforeData?.provenance?.gradeModelVersion, afterData?.gradeModel?.version ?? afterData?.provenance?.gradeModelVersion, { kind: 'model-version' });
  return {
    family: 'performance-grade',
    outputs: [numberOutput(field, before?.[field], after?.[field])],
    explanation: explanation(drivers),
  };
}

function projectionChange(beforeRow, afterRow) {
  const before = beforeRow?.proj, after = afterRow?.proj;
  const outputs = [];
  if (!!before?.abstain !== !!after?.abstain) outputs.push({ field: 'abstain', before: !!before?.abstain, after: !!after?.abstain });
  for (const field of ['team','status','basis','role','modelVersion']) {
    if (!same(before?.[field], after?.[field])) outputs.push({ field, before: clean(before?.[field]), after: clean(after?.[field]) });
  }
  for (const [field, threshold] of Object.entries(MATERIAL_CHANGE_THRESHOLDS.projection)) {
    if (materialNumberChange(before?.[field], after?.[field], threshold)) {
      outputs.push(numberOutput(field, before?.[field], after?.[field]));
    }
  }
  if (!outputs.length) return null;
  const drivers = [];
  pushDriver(drivers, 'projection.modelVersion', before?.modelVersion, after?.modelVersion, { kind: 'model-version' });
  pushDriver(drivers, 'projection.basis', before?.basis, after?.basis);
  pushDriver(drivers, 'projection.team', before?.team, after?.team);
  pushDriver(drivers, 'projection.status', before?.status, after?.status);
  pushDriver(drivers, 'why.minutes.beforeTeamBudget', before?.why?.minutes?.beforeTeamBudget, after?.why?.minutes?.beforeTeamBudget);
  pushDriver(drivers, 'why.minutes.teamBudgetAdjustment', before?.why?.minutes?.teamBudgetAdjustment, after?.why?.minutes?.teamBudgetAdjustment);
  pushDriver(drivers, 'projection.accounting.mpg', before?.accounting?.mpg, after?.accounting?.mpg);
  drivers.push(...objectDeltaDrivers(before?.why?.minutes?.effects, after?.why?.minutes?.effects, 'why.minutes.effects', 3));
  pushDriver(drivers, 'why.minutes.depth', before?.why?.minutes?.depth, after?.why?.minutes?.depth);
  pushDriver(drivers, 'why.games.projectedShare', before?.why?.games?.projectedShare, after?.why?.games?.projectedShare);
  drivers.push(...objectDeltaDrivers(before?.why?.team, after?.why?.team, 'why.team', 4));
  drivers.push(...objectDeltaDrivers(before?.why?.pts100, after?.why?.pts100, 'why.pts100', 3));
  pushDriver(drivers, 'why.fallback.support', before?.why?.fallback?.support, after?.why?.fallback?.support);
  pushDriver(drivers, 'why.fallback.lastObservedSeason', before?.why?.fallback?.lastObservedSeason, after?.why?.fallback?.lastObservedSeason);
  if (!same(before?.why?.seasons, after?.why?.seasons)) drivers.push({ label: 'why.seasons', before: clean(before?.why?.seasons), after: clean(after?.why?.seasons), delta: null });
  if (!same(before?.why?.rookie, after?.why?.rookie)) drivers.push({ label: 'why.rookieEvidence', before: clean(before?.why?.rookie), after: clean(after?.why?.rookie), delta: null });
  const legacy = !before?.why && !!after?.why;
  return { family: 'projection', outputs, explanation: explanation(drivers, { legacy }) };
}

function tulipBetaChange(beforeRow, afterRow, beforeData, afterData) {
  const before = beforeRow?.tulipBeta, after = afterRow?.tulipBeta;
  if (!before && !after) return null;
  const outputs = [];
  if (!!before?.abstain !== !!after?.abstain) outputs.push({ field: 'abstain', before: !!before?.abstain, after: !!after?.abstain });
  for (const field of ['confidence','evidenceTier','status','reason']) if (!same(before?.[field], after?.[field])) outputs.push({ field, before: clean(before?.[field]), after: clean(after?.[field]) });
  for (const field of ['tulip','recommendedMpg']) {
    if (materialNumberChange(before?.[field], after?.[field], MATERIAL_CHANGE_THRESHOLDS.tulipBetaMpg)) {
      outputs.push(numberOutput(field, before?.[field], after?.[field]));
    }
  }
  if (fin(before?.tulip) && fin(after?.tulip) && Math.sign(Number(before.tulip)) !== Math.sign(Number(after.tulip))) {
    if (!outputs.some((x) => x.field === 'tulip')) outputs.push({ field: 'tulipSign', before: Math.sign(Number(before.tulip)), after: Math.sign(Number(after.tulip)) });
  }
  if (!outputs.length) return null;
  const drivers = [];
  pushDriver(drivers, 'currentTeam', beforeRow?.currentTeam, afterRow?.currentTeam);
  pushDriver(drivers, 'currentRoster', beforeRow?.currentRoster, afterRow?.currentRoster);
  for (const field of ['currentMpg','shrunkBpm','valueGap','valueGapSd','rawSignalDelta','supportedCeiling','evidenceFactor','constrainedDelta','rosterBalanceFactor']) {
    pushDriver(drivers, `tulipBeta.${field}`, before?.[field], after?.[field]);
  }
  if (!same(beforeData?.tulipBetaMeta?.config, afterData?.tulipBetaMeta?.config)) {
    drivers.push({ label: 'tulipBeta.config', before: clean(beforeData?.tulipBetaMeta?.config), after: clean(afterData?.tulipBetaMeta?.config), delta: null, kind: 'model-config' });
  }
  const legacy = !fin(before?.rawSignalDelta) && fin(after?.rawSignalDelta);
  return { family: 'tulip-beta', outputs, explanation: explanation(drivers, { legacy }) };
}

function projectedRoleChange(beforeRow, afterRow) {
  const before = beforeRow?.tulipCapacity, after = afterRow?.tulipCapacity;
  if (!before && !after) return null;
  const outputs = [];
  if (!!before?.abstain !== !!after?.abstain) outputs.push({ field: 'abstain', before: !!before?.abstain, after: !!after?.abstain });
  for (const field of ['evidenceGrade','reason','scope','version']) if (!same(before?.[field], after?.[field])) outputs.push({ field, before: clean(before?.[field]), after: clean(after?.[field]) });
  for (const field of ['capacityMpg','headroom']) {
    if (materialNumberChange(before?.[field], after?.[field], MATERIAL_CHANGE_THRESHOLDS.projectedRoleMpg)) {
      outputs.push(numberOutput(field, before?.[field], after?.[field]));
    }
  }
  if (!outputs.length) return null;
  const drivers = [];
  pushDriver(drivers, 'projectedRole.version', before?.version, after?.version, { kind: 'model-version' });
  pushDriver(drivers, 'projectedRole.teamASeasonMpg', before?.teamASeasonMpg, after?.teamASeasonMpg);
  pushDriver(drivers, 'projectedRole.supportCount', before?.supportCount, after?.supportCount);
  const bTop = before?.why?.topDrivers || [], aTop = after?.why?.topDrivers || [];
  const bBy = new Map(bTop.map((x) => [x.feature, x]));
  const aBy = new Map(aTop.map((x) => [x.feature, x]));
  for (const feature of new Set([...bBy.keys(), ...aBy.keys()])) {
    const b = bBy.get(feature), a = aBy.get(feature);
    if (!same(b?.input, a?.input) || !same(b?.contribution, a?.contribution)) {
      drivers.push({ label: `projectedRole.driver.${feature}`, before: b || null, after: a || null, delta: delta(b?.contribution, a?.contribution) });
    }
  }
  if (!same(before?.why?.defaultsUsed, after?.why?.defaultsUsed)) drivers.push({ label: 'projectedRole.defaultsUsed', before: clean(before?.why?.defaultsUsed), after: clean(after?.why?.defaultsUsed), delta: null });
  const legacy = !before?.why && !!after?.why;
  return { family: 'projected-role-mpg', outputs, explanation: explanation(drivers, { legacy }) };
}

function comparisonFor(data, league, row) {
  const id = String(row?.playerId ?? row?.nbaPersonId ?? '');
  return data?.analysis?.playerComps?.[league]?.[id] || null;
}

function compKey(x) {
  if (!x) return null;
  return `${x.playerId ?? x.name ?? ''}|${x.season ?? ''}`;
}

function playerCompChange(beforeData, afterData, league, beforeRow, afterRow) {
  const before = comparisonFor(beforeData, league, beforeRow), after = comparisonFor(afterData, league, afterRow);
  if (!before && !after) return null;
  const outputs = [];
  const bLead = compKey(before?.top3?.[0]), aLead = compKey(after?.top3?.[0]);
  if (bLead !== aLead) outputs.push({ field: 'leadBlendPlayer', before: bLead, after: aLead });
  const bMembers = (before?.blend || []).map((x) => `${x.playerId ?? x.name}|${x.season ?? ''}`).sort();
  const aMembers = (after?.blend || []).map((x) => `${x.playerId ?? x.name}|${x.season ?? ''}`).sort();
  if (!same(bMembers, aMembers)) outputs.push({ field: 'blendMembers', before: bMembers, after: aMembers });
  if (materialNumberChange(before?.blendConfidence, after?.blendConfidence, MATERIAL_CHANGE_THRESHOLDS.compConfidence)) {
    outputs.push(numberOutput('blendConfidence', before?.blendConfidence, after?.blendConfidence));
  }
  if (!outputs.length) return null;
  const drivers = [];
  drivers.push(...objectDeltaDrivers(before?.targetStats, after?.targetStats, 'targetStats', 5));
  drivers.push(...objectDeltaDrivers(before?.targetPhysical, after?.targetPhysical, 'targetPhysical', 3));
  pushDriver(drivers, 'targetBasis', before?.targetBasis, after?.targetBasis);
  if (!same(before?.targetSourceSeasons, after?.targetSourceSeasons)) drivers.push({ label: 'targetSourceSeasons', before: clean(before?.targetSourceSeasons), after: clean(after?.targetSourceSeasons), delta: null });
  pushDriver(drivers, 'comparisonModelVersion', beforeData?.analysis?.playerCompsMeta?.version, afterData?.analysis?.playerCompsMeta?.version, { kind: 'model-version' });
  pushDriver(drivers, 'comparisonHistory.NBA', beforeData?.analysis?.playerCompsMeta?.nbaHistory, afterData?.analysis?.playerCompsMeta?.nbaHistory);
  pushDriver(drivers, 'comparisonHistory.GLEAGUE', beforeData?.analysis?.playerCompsMeta?.gleagueHistory, afterData?.analysis?.playerCompsMeta?.gleagueHistory);
  return { family: 'player-comparison', outputs, explanation: explanation(drivers) };
}

function teamFitChange(beforeData, afterData, league, beforeRow, afterRow) {
  const before = beforeRow?.ownTeamFit, after = afterRow?.ownTeamFit;
  if (!materialNumberChange(before?.score, after?.score, MATERIAL_CHANGE_THRESHOLDS.teamFit)) return null;
  const drivers = [];
  drivers.push(...objectDeltaDrivers(beforeRow?.skillProfile, afterRow?.skillProfile, 'skillProfile', 4));
  const beforeTeam = beforeRow?.currentTeam || beforeRow?.team || null;
  const afterTeam = afterRow?.currentTeam || afterRow?.team || null;
  pushDriver(drivers, 'team', beforeTeam, afterTeam);
  const bNeeds = beforeData?.analysis?.teams?.[league]?.[beforeTeam]?.needs || {};
  const aNeeds = afterData?.analysis?.teams?.[league]?.[afterTeam]?.needs || {};
  const bn = Object.fromEntries(Object.entries(bNeeds).map(([k,v]) => [k, v?.need]));
  const an = Object.fromEntries(Object.entries(aNeeds).map(([k,v]) => [k, v?.need]));
  drivers.push(...objectDeltaDrivers(bn, an, 'teamNeed', 4));
  return {
    family: 'team-fit',
    outputs: [numberOutput('ownTeamFit.score', before?.score, after?.score)],
    explanation: explanation(drivers),
  };
}

function presenceChange(before, after) {
  if (!!before === !!after) return null;
  const row = after?.row || before?.row;
  return {
    family: 'roster-membership',
    outputs: [{ field: 'recordPresence', before: !!before, after: !!after }],
    explanation: explanation([{ label: 'recordPresence', before: !!before, after: !!after, delta: null },
      { label: 'currentRoster', before: clean(before?.row?.currentRoster), after: clean(after?.row?.currentRoster), delta: null },
      { label: 'team', before: clean(before?.row?.currentTeam || before?.row?.team), after: clean(after?.row?.currentTeam || after?.row?.team), delta: null }]),
    row,
  };
}

export function buildMaterialChangeReport(beforeData, afterData) {
  if (!beforeData || !afterData) throw new Error('Material-change report requires before and after public data.');
  const before = playerIndex(beforeData), after = playerIndex(afterData);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const b = before.get(key), a = after.get(key);
    const presence = presenceChange(b, a);
    if (presence) {
      changes.push({ key, league: (a || b).league, playerId: String(presence.row?.nbaPersonId ?? presence.row?.playerId ?? ''), name: presence.row?.name || null, ...presence });
      continue;
    }
    const league = a.league, beforeRow = b.row, afterRow = a.row;
    const parts = [];
    for (const [field, threshold] of [['grade', MATERIAL_CHANGE_THRESHOLDS.grade], ['rateGrade', MATERIAL_CHANGE_THRESHOLDS.rateGrade], ['magnitudeGrade', MATERIAL_CHANGE_THRESHOLDS.magnitudeGrade]]) {
      const x = gradeChange(beforeRow, afterRow, field, threshold, beforeData, afterData); if (x) parts.push(x);
    }
    for (const x of [projectionChange(beforeRow, afterRow), tulipBetaChange(beforeRow, afterRow, beforeData, afterData), projectedRoleChange(beforeRow, afterRow), playerCompChange(beforeData, afterData, league, beforeRow, afterRow), teamFitChange(beforeData, afterData, league, beforeRow, afterRow)]) if (x) parts.push(x);
    for (const part of parts) changes.push({ key, league, playerId: String(afterRow?.nbaPersonId ?? afterRow?.playerId ?? ''), name: afterRow?.name || beforeRow?.name || null, ...part });
  }
  const summary = { materialChanges: changes.length, explained: 0, legacyTraceLimited: 0, unexplained: 0, byFamily: {} };
  for (const c of changes) {
    summary.byFamily[c.family] = (summary.byFamily[c.family] || 0) + 1;
    if (c.explanation.status === 'explained') summary.explained++;
    else if (c.explanation.status === 'legacy-trace-limited') summary.legacyTraceLimited++;
    else summary.unexplained++;
  }
  return {
    schemaVersion: 1,
    policy: 'Material player-level model outputs must be accompanied by changed player-level drivers, explicit model/version boundaries, or an explicit legacy-trace limitation. Rank-only churn is excluded because it is population-relative.',
    thresholds: MATERIAL_CHANGE_THRESHOLDS,
    summary,
    changes,
  };
}

export function validateMaterialChangeReport(report) {
  if (!report || report.schemaVersion !== 1 || !report.policy || !report.summary || !Array.isArray(report.changes)) {
    throw new Error('Material-change explanation report schema is invalid.');
  }
  for (const change of report.changes) {
    if (!change.key || !change.league || !change.family || !Array.isArray(change.outputs) || !change.outputs.length) {
      throw new Error('Material-change report contains an invalid player change.');
    }
    if (!change.explanation || !['explained','legacy-trace-limited','unexplained'].includes(change.explanation.status)) {
      throw new Error(`Material-change explanation status is invalid for ${change.key}/${change.family}.`);
    }
  }
  const unexplained = report.changes.filter((x) => x.explanation.status === 'unexplained');
  if (unexplained.length) {
    const sample = unexplained.slice(0, 5).map((x) => `${x.key}/${x.family}`).join(', ');
    throw new Error(`Material player-level changes lack explanation traces: ${sample}${unexplained.length > 5 ? '…' : ''}`);
  }
  return true;
}

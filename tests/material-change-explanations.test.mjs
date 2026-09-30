import assert from 'node:assert/strict';
import { buildMaterialChangeReport, validateMaterialChangeReport } from '../scripts/lib/material-change-explanations.mjs';
import { scoreCapacity } from '../scripts/lib/tulip-capacity-v1.mjs';

const basePlayer = (id, name) => ({
  playerId: String(id), nbaPersonId: id, name, appeared: true, currentRoster: true, currentTeam: 'AAA', team: 'AAA', gp: 60, minutes: 1800,
  grade: 7.0, rateGrade: 7.2, magnitudeGrade: 6.8, reliabilityWeight: 0.7, gradeCoverage: 95,
  components: { scoring: 70, playmaking: 60, defense: 55 }, rateComponents: { scoring: 72, playmaking: 61 }, magnitudeComponents: { scoring: 1.1, playmaking: 0.6 },
  skillProfile: { shootingEff: 60, playmaking: 55, steals: 50 },
  ownTeamFit: { score: 60, strengths: [], weaknesses: [] },
  proj: {
    modelVersion: 'PROJECTION_2026_27+context-1', team: 'AAA', status: 'same', basis: 'multi-year-history', role: 'regular rotation', mpg: 24, gp: 65, pts: 12, reb: 4, ast: 3, usage: 0.20,
    why: { minutes: { beforeTeamBudget: 23, teamBudgetAdjustment: 1, effects: { age: 0.2, depth: -0.5 }, depth: 0.1 }, games: { projectedShare: 0.79 }, team: { usage: 0.01, newTeam: 0, pace: 100, rosterBalance: 1.0 }, pts100: { final: 25 }, seasons: [{season:'2025-26'}], fallback: null },
  },
  tulipBeta: { abstain: false, tulip: 2, recommendedMpg: 26, currentMpg: 24, shrunkBpm: 1, valueGap: 0.5, valueGapSd: 0.4, rawSignalDelta: 4, supportedCeiling: 30, evidenceFactor: 0.8, constrainedDelta: 3.2, rosterBalanceFactor: 0.625, confidence: 'MEDIUM', evidenceTier: 'B' },
  tulipCapacity: { abstain: false, version: 'TULIP_CAPACITY_V1', capacityMpg: 26, teamASeasonMpg: 24, headroom: 2, supportCount: 180, evidenceGrade: 'B', scope: 'offseason_acquisition', why: { topDrivers: [{feature:'aRecent10',input:25,contribution:1.2}], defaultsUsed: [] } },
});

const dataset = (player) => ({
  season: '2025-26',
  leagues: { NBA: [player], GLEAGUE: [] },
  tulipBetaMeta: { config: { minutesPerSd: 10 } },
  analysis: {
    teams: { NBA: { AAA: { needs: { shootingEff: {need: 40}, playmaking: {need: 50}, steals: {need: 50} } } }, GLEAGUE: {} },
    playerCompsMeta: { version: '4.1.0', nbaHistory: '2009-10 through 2025-26', gleagueHistory: '2014-15 through 2025-26' },
    playerComps: { NBA: { [player.playerId]: { top3: [{playerId:'c1',name:'Comp One',season:'2024-25'}], blend: [{playerId:'c1',name:'Comp One',season:'2024-25',share:100}], blendConfidence: 70, targetBasis:'current-season', targetSourceSeasons:['2025-26'], targetStats:{mpg:24,pts36:18,ast36:4}, targetPhysical:{heightInches:78,weight:210} } }, GLEAGUE: {} },
  },
});

function clone(x) { return JSON.parse(JSON.stringify(x)); }

{
  const before = dataset(basePlayer(1, 'Alpha'));
  const after = clone(before);
  const p = after.leagues.NBA[0];
  p.grade = 7.4; p.components.scoring = 78;
  p.proj.mpg = 26; p.proj.pts = 13.2; p.proj.why.minutes.beforeTeamBudget = 25; p.proj.why.minutes.teamBudgetAdjustment = 1;
  p.tulipBeta.tulip = 4; p.tulipBeta.recommendedMpg = 28; p.tulipBeta.rawSignalDelta = 6; p.tulipBeta.constrainedDelta = 5;
  p.tulipCapacity.capacityMpg = 28; p.tulipCapacity.headroom = 4; p.tulipCapacity.why.topDrivers[0] = {feature:'aRecent10',input:28,contribution:2.0};
  p.ownTeamFit.score = 67; p.skillProfile.shootingEff = 70;
  after.analysis.playerComps.NBA['1'].top3[0] = {playerId:'c2',name:'Comp Two',season:'2023-24'};
  after.analysis.playerComps.NBA['1'].blend = [{playerId:'c2',name:'Comp Two',season:'2023-24',share:100}];
  after.analysis.playerComps.NBA['1'].targetStats.pts36 = 20;
  const report = buildMaterialChangeReport(before, after);
  assert.equal(report.summary.unexplained, 0);
  assert.ok(report.changes.some((x) => x.family === 'performance-grade' && x.explanation.drivers.some((d) => d.label === 'components.scoring')));
  assert.ok(report.changes.some((x) => x.family === 'projection' && x.explanation.drivers.some((d) => d.label === 'why.minutes.beforeTeamBudget')));
  assert.ok(report.changes.some((x) => x.family === 'tulip-beta' && x.explanation.drivers.some((d) => d.label === 'tulipBeta.rawSignalDelta')));
  assert.ok(report.changes.some((x) => x.family === 'projected-role-mpg' && x.explanation.drivers.some((d) => d.label.includes('aRecent10'))));
  assert.ok(report.changes.some((x) => x.family === 'player-comparison' && x.explanation.drivers.some((d) => d.label === 'targetStats.pts36')));
  assert.ok(report.changes.some((x) => x.family === 'team-fit' && x.explanation.drivers.some((d) => d.label === 'skillProfile.shootingEff')));
  assert.equal(validateMaterialChangeReport(report), true);
}

{
  const before = dataset(basePlayer(2, 'Beta'));
  const after = clone(before);
  after.leagues.NBA[0].grade += 0.05;
  after.leagues.NBA[0].proj.pts += 0.2;
  after.leagues.NBA[0].tulipBeta.tulip += 0.2;
  const report = buildMaterialChangeReport(before, after);
  assert.equal(report.summary.materialChanges, 0, 'sub-threshold churn should be ignored');
}

{
  const before = dataset(basePlayer(3, 'Gamma'));
  const after = clone(before);
  delete before.leagues.NBA[0].tulipCapacity.why;
  after.leagues.NBA[0].tulipCapacity.capacityMpg = 28;
  after.leagues.NBA[0].tulipCapacity.headroom = 4;
  after.leagues.NBA[0].tulipCapacity.why.topDrivers[0] = {feature:'aRecent10',input:28,contribution:2.1};
  const report = buildMaterialChangeReport(before, after);
  const c = report.changes.find((x) => x.family === 'projected-role-mpg');
  assert.equal(c.explanation.status, 'legacy-trace-limited');
  assert.equal(validateMaterialChangeReport(report), true);
}

{
  const before = dataset(basePlayer(4, 'Delta'));
  const after = clone(before);
  after.leagues.NBA[0].proj.pts = 14;
  // Strip the explanation trace and keep the model/version stable: this must fail closed.
  delete before.leagues.NBA[0].proj.why;
  delete after.leagues.NBA[0].proj.why;
  const report = buildMaterialChangeReport(before, after);
  assert.equal(report.summary.unexplained, 1);
  assert.throws(() => validateMaterialChangeReport(report), /lack explanation traces/i);
}

{
  const before = dataset(basePlayer(5, 'Epsilon'));
  const after = dataset(basePlayer(5, 'Epsilon'));
  after.leagues.NBA.push(basePlayer(6, 'New Player'));
  const report = buildMaterialChangeReport(before, after);
  const c = report.changes.find((x) => x.playerId === '6');
  assert.equal(c.family, 'roster-membership');
  assert.equal(c.explanation.status, 'explained');
}

{
  const before = dataset(basePlayer(7, 'Missing Transition'));
  const after = clone(before);
  after.leagues.NBA[0].grade = null;
  after.leagues.NBA[0].proj.pts = null;
  after.leagues.NBA[0].ownTeamFit.score = null;
  const report = buildMaterialChangeReport(before, after);
  assert.ok(report.changes.some((x) => x.family === 'performance-grade' && x.outputs.some((o) => o.field === 'grade' && o.after === null)));
  assert.ok(report.changes.some((x) => x.family === 'projection' && x.outputs.some((o) => o.field === 'pts' && o.after === null)));
  assert.ok(report.changes.some((x) => x.family === 'team-fit' && x.outputs.some((o) => o.field === 'ownTeamFit.score' && o.after === null)));
  assert.ok(report.summary.unexplained >= 3, 'finite-to-missing outputs must be treated as material and fail closed without an explanation');
  assert.throws(() => validateMaterialChangeReport(report), /lack explanation traces/i);
}

{
  const before = dataset(basePlayer(8, 'Role Boundary'));
  const after = clone(before);
  before.leagues.NBA[0].proj.role = 'core rotation';
  before.leagues.NBA[0].proj.accounting = { mpg: 28.01 };
  after.leagues.NBA[0].proj.role = 'regular rotation';
  after.leagues.NBA[0].proj.accounting = { mpg: 27.99 };
  const report = buildMaterialChangeReport(before, after);
  const change = report.changes.find((x) => x.family === 'projection');
  assert.ok(change.explanation.drivers.some((d) => d.label === 'projection.accounting.mpg'));
  assert.equal(validateMaterialChangeReport(report), true, 'a role-label threshold crossing must carry its exact MPG driver');
}

console.log('material change explanation tests passed');

{
  const featureNames = ['aSeasonMpg','aRecent10','aRecent5','aTrend','aStartRate','aGames','aSeasons','aCareerHighMpg','aGsPer36','aTs','aFgaPer36','aAstPer36','aRebPer36','aPfPer36','age'];
  const standardization = Object.fromEntries(featureNames.map((k) => [k,{mean:0,sd:1}]));
  const coefficients = Object.fromEntries(featureNames.map((k,i) => [k, 0.01 * (i + 1)]));
  const card = { version:'TULIP_CAPACITY_V1', features:featureNames, productionModel:{intercept:5,standardization,coefficients,residualQuantiles:{q10:-5,q25:-2,q75:2,q90:5}}, evidenceGrade:{thresholds:{}} };
  const f = { aSeasonMpg:20,aRecent10:21,aRecent5:22,aTrend:1,aStartRate:0.5,aGames:60,aSeasons:3,aCareerHighMpg:30,aGsPer36:12,aTs:0.58,aFgaPer36:14,aAstPer36:5,aRebPer36:6,aPfPer36:2 };
  const training = Array.from({length:180},()=>({aSeasonMpg:20}));
  const scored = scoreCapacity(f,{card,training});
  assert.equal(scored.abstain,false);
  assert.ok(Array.isArray(scored.why.topDrivers) && scored.why.topDrivers.length > 0);
  assert.ok(scored.why.defaultsUsed.includes('age'), 'missing attribute defaults must be disclosed');
  const withDefaults = { ...f, age:26, heightIn:78, weight:210, draftPick:61, undrafted:1 };
  const expectedRaw = card.productionModel.intercept + featureNames.reduce((sum,k) => sum + coefficients[k] * ((withDefaults[k] - standardization[k].mean) / standardization[k].sd), 0);
  const expected = Math.round(expectedRaw * 10) / 10;
  assert.equal(scored.capacityMpg, expected, 'explanation trace must not alter the frozen numeric score');
}

console.log('Projected Role MPG explanation trace test passed');

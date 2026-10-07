import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Independently specified synthetic profiles exercise the production solver without rebuilding data.
const source=fs.readFileSync(new URL('../scripts/build-player-comps.mjs',import.meta.url),'utf8');
const solverSource=source.slice(source.indexOf('function optimizeBlend('),source.indexOf('\nconst result = { NBA:'));
const context=vm.createContext({
  fin:v=>v!=null&&Number.isFinite(v), clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
  r1:v=>v,r2:v=>v,similarityFromDistance:v=>100/(1+v),integerShares:w=>w.map(v=>v*100),
  blendAxes:t=>t.vector.map((_,i)=>({key:String(i),weight:1})),blendVector:r=>r.vector,
});
vm.runInContext(solverSource+';this.solve=optimizeBlend;',context);
const candidate=(vector,id,physical=100)=>({cand:{vector,features:Object.fromEntries(vector.map((v,i)=>[String(i),v])),playerId:id,name:id},m:{score:100,blockScores:{physical}}});
const shares=r=>Object.fromEntries(r.blend.map(x=>[x.playerId,x.share]));
const penalized=shares(context.solve({vector:[0.5]},[candidate([0],'a',0),candidate([1],'b')]));
assert.ok(Math.abs(penalized.a-47.5)<1e-8,'linear physical penalty must affect optimized weight');
const edge=shares(context.solve({vector:[0.4]},[candidate([0],'a'),candidate([10],'b')]));
assert.ok(Math.abs(edge.b-6)<1e-8,'pair solution must include the 6% boundary');
const triple=shares(context.solve({vector:[0.4,4]},[candidate([0,0],'a'),candidate([10,0],'b'),candidate([0,10],'c')]));
assert.ok(Math.abs(triple.b-6)<1e-8&&Math.abs(triple.c-40)<1e-8,'triple edge must be optimized, not discarded');

const data = JSON.parse(fs.readFileSync(new URL('../public/data.json', import.meta.url), 'utf8'));
const meta = data.analysis.playerCompsMeta;
const inputs = JSON.parse(fs.readFileSync(new URL('../scripts/data/projection/inputs.json', import.meta.url), 'utf8'));
const finite = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

assert.equal(meta.version, '4.3.0');
assert.match(meta.targetEligibility, /only players with a 2025-26 appearance/i);
assert.equal(meta.physicalWeight, 0.20);
assert.match(meta.blendMethod, /one to three distinct players/i);
assert.match(meta.blendMethod, /non-negative convex reconstruction/i);
assert.match(meta.referenceMethod, /fixed representative profile/i);
assert.match(meta.styleMethod, /independent trait-specific search/i);
assert.doesNotMatch(meta.blendMethod, /softmax/i);

let checked = 0;
let sparse = 0;
let physicalDominanceTraps = 0;
const patterns = new Set();

for (const league of ['NBA', 'GLEAGUE']) {
  const sets = data.analysis.playerComps[league];
  const expected = data.leagues[league].filter((p) => p.appeared && Number(p.minutes) > 0);
  const adv = inputs[league === 'NBA' ? 'nba' : 'gleague']['2025-26'].adv;
  const pidIndex = adv.headers.indexOf('PLAYER_ID'), tsIndex = adv.headers.indexOf('TS_PCT');
  const sourceTs = new Map(adv.rows.map((row) => [String(row[pidIndex]), row[tsIndex]]));
  assert.equal(Object.keys(sets).length, expected.length, `${league}: comparisons must exist only for players with current-season appearances`);
  for (const p of data.leagues[league].filter((player) => !player.appeared || !(player.minutes > 0))) {
    assert.equal(sets[String(p.playerId)], undefined, `${p.name}: no-appearance player must not receive an invented comparison`);
  }

  for (const p of expected) {
    const set = sets[String(p.playerId)];
    assert.ok(set, `${league}: missing ${p.name}`);
    assert.ok(set.top3.length >= 1 && set.top3.length <= 3, `${p.name}: component count`);
    assert.equal(set.blend.length, set.top3.length, `${p.name}: cards and weights disagree`);
    assert.equal(new Set(set.top3.map((x) => String(x.playerId))).size, set.top3.length, `${p.name}: duplicate player`);
    assert.ok(set.top3.every((x) => /[A-Za-z]/.test(String(x.name || ''))), `${p.name}: unresolved numeric comp name`);
    assert.equal(set.blend.reduce((sum, x) => sum + x.share, 0), 100, `${p.name}: shares`);
    assert.ok(set.blend.every((x) => x.share > 0), `${p.name}: zero-share card`);
    assert.ok(set.profileRead?.text?.includes(p.name), `${p.name}: missing individualized profile description`);
    assert.ok(set.profileRead.text.trim().split(/\s+/).length <= 60, `${p.name}: profile read is too long`);
    assert.doesNotMatch(set.profileRead.text, /\b(?:19|20)\d{2}-\d{2}\b/, `${p.name}: profile prose should not repeat comp seasons`);
    assert.doesNotMatch(set.profileRead.text, /\bin the fitted blend\b/i, `${p.name}: profile should read like a player description`);
    assert.ok(Array.isArray(set.profileRead.components), `${p.name}: missing blueprint components`);
    assert.ok(set.profileRead.components.length <= 3, `${p.name}: too many trait references`);
    assert.ok(set.profileRead.components.every((x) => typeof x.phrase === 'string' && x.phrase.trim()),
      `${p.name}: blueprint reference is missing a readable trait`);
    assert.ok(set.profileRead.components.every((x) => !/\b(?:box-score|shot profile|listed frame)\b/i.test(x.phrase)),
      `${p.name}: blueprint uses a raw statistical label instead of a basketball trait`);
    assert.ok(set.profileRead?.caveat, `${p.name}: missing analogy limitation`);
    for (const part of set.profileRead.components) {
      assert.ok(part.referencePeriod?.seasonCount >= 2, `${p.name}: style reference should cover multiple seasons`);
      assert.ok(set.profileRead.references && Object.keys(set.profileRead.references).length > 0,
        `${p.name}: independent references lack trait evidence`);
      assert.doesNotMatch(part.phrase, /ball.pressure|on-ball creation|efficient line pressure/, `${p.name}: unsupported scouting inference`);
    }
    assert.equal(set.profileRead.blend, set.blend.map((x) => `${x.name} ${x.share}%`).join(', '), `${p.name}: prose blend disagrees with optimized weights`);
    assert.ok(Object.values(set.profileRead.references || {}).every((ref) =>
      finite(ref.fit) && ref.fit >= 55 && ref.referencePeriod?.seasonCount >= 2),
    `${p.name}: trait reference must have a documented multi-year fit`);
    assert.ok(set.nearestOverall?.length <= 3, `${p.name}: too many independent overall matches`);
    assert.ok(set.nearestOverall.every((x) => x.referenceProfile?.seasonCount >= 1
      && (x.referenceProfile.seasonCount > 1 || x.referenceProfile.limited === true)), `${p.name}: overall comp lacks a disclosed reference period`);
    assert.equal(new Set(set.nearestOverall.map(x=>String(x.playerId))).size, set.nearestOverall.length, `${p.name}: duplicate holistic comps`);
    assert.ok(set.blendConfidence >= 0 && set.blendConfidence <= 100, `${p.name}: confidence`);
    assert.ok(set.blendReconstructionScore >= 0 && set.blendReconstructionScore <= 100, `${p.name}: reconstruction`);
    assert.ok(set.blendAxesUsed >= 14, `${p.name}: too little common evidence`);
    assert.deepEqual(set.top3.map((x) => String(x.playerId)), set.blend.map((x) => String(x.playerId)), `${p.name}: order mismatch`);
    assert.ok(set.top3.every((x) => x.league === league), `${p.name}: cross-league comp`);
    assert.ok(set.top3.every((x) => String(x.playerId) !== String(p.playerId)), `${p.name}: self comp`);
    const ts = sourceTs.get(String(p.nbaPersonId ?? p.playerId));
    if (typeof ts === 'number') assert.ok(Math.abs(set.targetStats.ts - ts) <= 0.000501,
      `${p.name}: comparison percentage lost its displayed decimal precision`);
    for (const comp of set.top3.filter((x) => !x.referenceProfile?.seasons?.includes('2025-26'))) {
      assert.equal(comp.currentSeasonDetailed, false, `${comp.name}: historical profile flagged as current`);
      assert.ok(Object.values(comp.style || {}).every((x) => x === null),
        `${comp.name} ${comp.season}: current tracking leaked into historical profile`);
    }

    for (let i = 0; i < set.top3.length; i++) {
      const comp = set.top3[i];
      assert.ok(Object.keys(comp.blockDetails || {}).length > 0, `${comp.name}: missing trait-level evidence`);
      const b = comp.blockScores || {};
      if (set.blend.length === 1 && b.physical > 90 && b.role < 60 && b.scoring < 60
        && set.blendConfidence > 35) physicalDominanceTraps++;
    }
    patterns.add(set.blend.map((x) => x.share).join('/'));
    if (set.blend.length < 3) sparse++;
    checked++;
  }
}

assert.equal(physicalDominanceTraps, 0, 'a body-only single comp must not receive confident-match treatment');
assert.ok(sparse > 0, 'complexity penalty should allow one- or two-player explanations');
assert.ok(patterns.size > 100, 'blend percentages should be meaningfully differentiated');


{
  const cfg = JSON.parse(fs.readFileSync(new URL('../scripts/data/player_comp_targets.json', import.meta.url), 'utf8'));
  const expectedNames = [
    'Dain Dainja','Dwight Murray Jr','Aaron Scott','Isaiah Wong','Nick Pringle','Dion Brown',
    'Ben Humrichous','Tidjiane Dioumassi','DJ Rodman','Jonathan Pierre','Cedric Nga Mbiaba',
    'Jeriah Coleman','Jordan Dingle','Wooga Poplar','Chaney Johnson','Grant Nelson','Tyler Bilodeau',
    'Ben Saraf','Drake Powell','Joshua Jefferson','Nolan Traore','Danny Wolf',
  ];
  const expectedNbaExperienced = new Set([
    'Isaiah Wong','Chaney Johnson','Grant Nelson','Ben Saraf','Drake Powell','Nolan Traore','Danny Wolf',
  ]);
  const expectedPreNba = new Set(expectedNames.filter((name) => !expectedNbaExperienced.has(name)));
  assert.equal(cfg.targets.length, 22, 'requested target config must contain exactly 22 players');
  assert.deepEqual(cfg.targets.map(x=>x.name), expectedNames, 'requested target list changed or reordered');
  assert.equal(data.analysis.playerCompTargets?.length, 22, 'all requested targets must be searchable');
  assert.equal(Object.keys(data.analysis.playerCompsTargeted || {}).length, 22, 'all requested targets must receive comps');
  assert.equal(meta.targetedComparisons?.count, 22, 'metadata target count');
  assert.deepEqual(new Set(meta.targetedComparisons?.sourceModes), new Set(['gleague','pre-nba']));

  for (const spec of cfg.targets) {
    const set = data.analysis.playerCompsTargeted[spec.targetId];
    const catalog = data.analysis.playerCompTargets.find(x=>x.targetId===spec.targetId);
    assert.ok(set, spec.name + ': missing requested comparison');
    assert.ok(catalog, spec.name + ': missing from Player Comps picker');
    assert.equal(catalog.name, spec.name, spec.name + ': picker identity');
    assert.equal(set.targetName, spec.name, spec.name + ': target identity');
    assert.equal(spec.nbaExperienced, expectedNbaExperienced.has(spec.name), spec.name + ': NBA-experience classification');
    assert.equal(spec.sourceMode, spec.nbaExperienced ? 'gleague' : 'pre-nba', spec.name + ': config violates NBA-experience source rule');
    assert.equal(set.sourceMode, spec.nbaExperienced ? 'gleague' : 'pre-nba', spec.name + ': wrong source family');
    assert.equal(set.targetBasis, spec.nbaExperienced ? 'targeted-gleague-to-nba-equivalent' : 'pre-nba-to-nba-style',
      spec.name + ': wrong target basis');
    assert.equal(set.targetStats.mpg, null, spec.name + ': source minutes/role must not become an NBA MPG comp axis');
    assert.ok(set.top3.length >= 1 && set.top3.length <= 3, spec.name + ': component count');
    assert.ok(set.top3.every(x=>x.league==='NBA'), spec.name + ': comparison pool must be NBA');
    assert.equal(new Set(set.top3.map(x=>String(x.playerId))).size, set.top3.length, spec.name + ': duplicate comp');
    if (spec.nbaPersonId != null) {
      assert.ok(set.top3.every(x=>String(x.playerId)!==String(spec.nbaPersonId)), spec.name + ': self-comparison');
    }
    assert.equal(set.blend.reduce((sum,x)=>sum+Number(x.share||0),0),100,spec.name + ': blend shares');
    assert.equal(set.blend.length,set.top3.length,spec.name + ': blend/card mismatch');
    assert.ok(finite(set.blendConfidence),spec.name + ': blend confidence');
    assert.ok(finite(set.sourceOriginalMinutes) && set.sourceOriginalMinutes > 0,spec.name + ': missing source exposure');
    assert.ok(['low','moderate','high'].includes(set.sourceConfidence),spec.name + ': source confidence disclosure');
    assert.ok(set.profileRead?.text?.includes(spec.name),spec.name + ': missing style narrative');
    if (expectedPreNba.has(spec.name)) {
      assert.ok(set.sourceUrl,spec.name + ': pre-NBA source provenance');
      assert.doesNotMatch(set.targetHistoryNote || '', /NBA statistics? (?:are|is) used/i, spec.name + ': NBA production leaked into description');
    } else {
      assert.match(set.targetHistoryNote || '', /G League production only/i, spec.name + ': must disclose G League-only target');
    }
  }
  const wolf = data.analysis.playerCompsTargeted['target:danny-wolf'];
  assert.equal(wolf.sourceMode,'gleague','Danny Wolf has NBA experience and must use G League production');
  assert.ok(wolf.top3.every(x=>String(x.playerId)!=='1642874'),'Danny Wolf self-comparison');
  const dainja = data.analysis.playerCompsTargeted['target:dain-dainja'];
  assert.equal(dainja.sourceMode,'pre-nba','Dain Dainja has no NBA regular-season experience and must use pre-NBA production');
  assert.match(dainja.sourceTeam || '',/Memphis/i,'Dain Dainja source team');
  assert.ok(dainja.top3.every(x=>String(x.playerId)!=='1643120'),'Dain Dainja self-comparison');
  const cedric = data.analysis.playerCompsTargeted['target:cedric-nga-mbiaba'];
  assert.equal(cedric.sourceConfidence,'low','Cedric Nga Mbiaba limited sample must be labeled low confidence');
  const nolan = data.analysis.playerCompsTargeted['target:nolan-traore'];
  const drake = data.analysis.playerCompsTargeted['target:drake-powell'];
  assert.equal(nolan.sourceMode,'gleague','Nolan Traore must use his G League appearance');
  assert.equal(drake.sourceMode,'gleague','Drake Powell must use his G League appearance');
  assert.ok(nolan.sourceOriginalMinutes >= 300,'Nolan Traore should use his substantial G League sample');
  assert.equal(nolan.sourceConfidence,'high','Nolan Traore source confidence');
  assert.ok(drake.sourceOriginalMinutes > 0,'Drake Powell must use a real G League sample');
  const expectedDrakeConfidence = drake.sourceOriginalMinutes < 100 ? 'low'
    : drake.sourceOriginalMinutes < 300 ? 'moderate' : 'high';
  assert.equal(drake.sourceConfidence, expectedDrakeConfidence, 'Drake Powell source confidence must track actual G League exposure');
}

assert.equal(meta.nbaEquivalentAvailableForGLeague, true, 'G League NBA-equivalent comp mode must be published');
assert.equal(meta.nbaEquivalent?.comparisonPool, 'NBA historical reference profiles');
assert.equal(meta.nbaEquivalent?.trainingThrough, '2024-25', 'current season must not train the cross-league translator');
assert.equal(meta.nbaEquivalent?.mpgExcluded, true, 'G League MPG must not be treated as an NBA role forecast');
assert.ok(Number(meta.nbaEquivalent?.pairedPlayerSeasons) >= 10, 'cross-league translation needs a non-trivial historical crossover sample');

{
  const sets = data.analysis.playerCompsNbaEquivalent?.GLEAGUE || {};
  const expected = data.leagues.GLEAGUE.filter((p) => p.appeared && Number(p.minutes) > 0);
  assert.equal(Object.keys(sets).length, expected.length, 'every played G League target needs an NBA-equivalent comp');
  for (const p of expected) {
    const set = sets[String(p.playerId)];
    assert.ok(set, `${p.name}: missing NBA-equivalent comp`);
    assert.equal(set.targetBasis, 'gleague-to-nba-equivalent', `${p.name}: wrong cross-league target basis`);
    assert.equal(set.targetStats.mpg, null, `${p.name}: G League MPG leaked into NBA-equivalent matching`);
    assert.ok(set.top3.length >= 1 && set.top3.length <= 3, `${p.name}: NBA-equivalent component count`);
    assert.ok(set.top3.every((x) => x.league === 'NBA'), `${p.name}: NBA-equivalent pool contains a non-NBA reference`);
    assert.ok(set.top3.every((x) => String(x.playerId) !== String(p.playerId)), `${p.name}: self NBA reference`);
    assert.equal(set.blend.reduce((sum, x) => sum + x.share, 0), 100, `${p.name}: NBA-equivalent shares`);
    assert.ok(set.blendAxesUsed >= 10, `${p.name}: NBA-equivalent blend has too little shared evidence`);
    assert.equal(set.translationEvidence?.trainingThrough, '2024-25', `${p.name}: translation leakage`);
    assert.equal(set.translationEvidence?.mpgExcluded, true, `${p.name}: MPG exclusion missing`);
  }
}

// Regression example from the audit screenshots: the old model promoted a physical-profile
// neighbor above Reed Sheppard's stronger basketball-role blend. Ja's historical references are
// intentionally not hard-coded: the revised pace/season-normalized formula can legitimately change
// those analogues as its feature scales and exposure shrinkage change.
const nba = data.leagues.NBA;
const setFor = (name) => {
  const p = nba.find((x) => x.name === name);
  assert.ok(p, `missing regression player ${name}`);
  return data.analysis.playerComps.NBA[String(p.playerId)];
};
assert.notEqual(setFor('Reed Sheppard').blend[0].name, 'Patrick Beverley');

console.log(`player comps passed: ${checked} players, ${sparse} sparse blends, ${patterns.size} share patterns`);

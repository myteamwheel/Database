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

assert.equal(meta.version, '4.0.0');
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
  assert.ok(Object.keys(sets).length >= expected.length, `${league}: appeared players and eligible historical targets need coverage`);

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

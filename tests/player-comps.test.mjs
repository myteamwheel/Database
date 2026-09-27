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
assert.ok(Math.abs(penalized.a-45)<1e-8,'linear physical penalty must affect optimized weight');
const edge=shares(context.solve({vector:[0.4]},[candidate([0],'a'),candidate([10],'b')]));
assert.ok(Math.abs(edge.b-6)<1e-8,'pair solution must include the 6% boundary');
const triple=shares(context.solve({vector:[0.4,4]},[candidate([0,0],'a'),candidate([10,0],'b'),candidate([0,10],'c')]));
assert.ok(Math.abs(triple.b-6)<1e-8&&Math.abs(triple.c-40)<1e-8,'triple edge must be optimized, not discarded');

const data = JSON.parse(fs.readFileSync(new URL('../public/data.json', import.meta.url), 'utf8'));
const meta = data.analysis.playerCompsMeta;
const inputs = JSON.parse(fs.readFileSync(new URL('../scripts/data/projection/inputs.json', import.meta.url), 'utf8'));

assert.equal(meta.version, '2.0.0');
assert.equal(meta.physicalWeight, 0.20);
assert.match(meta.blendMethod, /one to three distinct players/i);
assert.match(meta.blendMethod, /non-negative convex reconstruction/i);
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
  assert.equal(Object.keys(sets).length, expected.length, `${league}: every appeared player needs a comp`);

  for (const p of expected) {
    const set = sets[String(p.playerId)];
    assert.ok(set, `${league}: missing ${p.name}`);
    assert.ok(set.top3.length >= 1 && set.top3.length <= 3, `${p.name}: component count`);
    assert.equal(set.blend.length, set.top3.length, `${p.name}: cards and weights disagree`);
    assert.equal(new Set(set.top3.map((x) => String(x.playerId))).size, set.top3.length, `${p.name}: duplicate player`);
    assert.equal(set.blend.reduce((sum, x) => sum + x.share, 0), 100, `${p.name}: shares`);
    assert.ok(set.blend.every((x) => x.share > 0), `${p.name}: zero-share card`);
    assert.ok(set.blendConfidence >= 0 && set.blendConfidence <= 100, `${p.name}: confidence`);
    assert.ok(set.blendReconstructionScore >= 0 && set.blendReconstructionScore <= 100, `${p.name}: reconstruction`);
    assert.ok(set.blendAxesUsed >= 14, `${p.name}: too little common evidence`);
    assert.deepEqual(set.top3.map((x) => String(x.playerId)), set.blend.map((x) => String(x.playerId)), `${p.name}: order mismatch`);
    assert.ok(set.top3.every((x) => x.league === league), `${p.name}: cross-league comp`);
    assert.ok(set.top3.every((x) => String(x.playerId) !== String(p.playerId)), `${p.name}: self comp`);
    const ts = sourceTs.get(String(p.nbaPersonId ?? p.playerId));
    if (typeof ts === 'number') assert.ok(Math.abs(set.targetStats.ts - ts) <= 0.000501,
      `${p.name}: comparison percentage lost its displayed decimal precision`);
    for (const comp of set.top3.filter((x) => x.season !== '2025-26')) {
      assert.equal(comp.currentSeasonDetailed, false, `${comp.name}: historical season flagged as current`);
      assert.ok(Object.values(comp.style || {}).every((x) => x === null),
        `${comp.name} ${comp.season}: current tracking leaked into historical season`);
    }

    for (let i = 0; i < set.top3.length; i++) {
      const comp = set.top3[i], share = set.blend[i].share;
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

// Regression examples supplied with the audit request: the old model promoted these size-led
// nearest neighbours despite a weaker basketball-role explanation.
const nba = data.leagues.NBA;
const setFor = (name) => {
  const p = nba.find((x) => x.name === name);
  assert.ok(p, `missing regression player ${name}`);
  return data.analysis.playerComps.NBA[String(p.playerId)];
};
assert.notEqual(setFor('Reed Sheppard').blend[0].name, 'Patrick Beverley');
assert.ok(!setFor('Ja Morant').blend.some((x) => x.name === 'Dennis Schröder'));

console.log(`player comps passed: ${checked} players, ${sparse} sparse blends, ${patterns.size} share patterns`);

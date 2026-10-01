import assert from 'node:assert/strict';
import {num,safeDiv} from '../scripts/lib/sources.mjs';
import {percentiles as gradePercentiles,robustZ} from '../scripts/lib/grades.mjs';
import {percentiles as metricPercentiles,normalize,stabilize} from '../scripts/lib/metrics.mjs';
for(const value of [true,false,'',' ',[],[0],{},NaN,Infinity,-Infinity,'Infinity','0x10','39%',null,undefined])assert.equal(num(value),null,`Not a measured number: ${String(value)}`);
for(const [input,expected]of [[0,0],['0',0],[' 1.25 ',1.25],['-2e2',-200],['.5',.5]])assert.equal(num(input),expected);
assert.equal(safeDiv(false,1),null);assert.equal(safeDiv(0,1),0);assert.equal(safeDiv(1,0),null);
for(const percentile of [gradePercentiles,metricPercentiles]){
  const out=percentile([0,'0',false,' ',1]);
  assert.equal(out[0],out[1],'Equivalent numeric representations share one tied rank');
  assert.equal(out[2],null);assert.equal(out[3],null);assert.equal(out[4],100);
}
assert.deepEqual(robustZ([false,' ',0,1,2]).slice(0,2),[null,null]);
const shrunk=stabilize([false,' ',0,1,2],[100,100,100,100,100],80);
assert.deepEqual(shrunk.slice(0,2),[null,null]);assert.ok(Number.isFinite(shrunk[2]));
const fixture={totals:{GP:10,MIN:100,PTS:0},advanced:{},exact:{},misc:{},defense:{},scoring:{},usage:{}};
assert.equal(normalize(fixture).ptsPG,0);
assert.equal(normalize({...fixture,totals:{...fixture.totals,PTS:false}}).ptsPG,null);
assert.equal(normalize({...fixture,totals:{...fixture.totals,PTS:' '}}).pts36,null);
for(const value of [false,' ',Infinity,-1])for(const key of ['GP','MIN'])assert.throws(()=>normalize({...fixture,totals:{...fixture.totals,[key]:value}}),/exposure/);
console.log('Model number semantics passed: blank/boolean/container/nonfinite rejection, real zeros, decimal strings, tied ranks and fail-closed exposure');

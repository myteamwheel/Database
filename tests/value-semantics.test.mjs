import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

for (const [key, phrase] of Object.entries({
  zero: '0 is a real numeric value',
  missing: '— means missing or unavailable',
  notApplicable: 'N/A means not applicable',
  estimate: 'Estimate means a model or translation output',
  fallback: 'Fallback means lower-specificity evidence',
  smallSample: 'Small sample means the value exists but rests on limited evidence',
})) {
  assert.ok(app.includes(phrase), 'app.js missing ' + key + ' value meaning');
}

assert.match(app, /function fmt\(v,type\)[\s\S]*finite\(v\).*['\"']—['\"']/,
  'formatter must keep missing values distinct from numeric zero');
assert.match(app, /Blank means TULIP abstained[\s\S]*Blank is NOT zero/i,
  'TULIP abstention must remain explicitly distinct from zero');
assert.match(app, /NOT PROBABILITY OF CORRECTNESS/i,
  'support must be labeled as evidence strength, not probability');

console.log('value semantics source contract passed');

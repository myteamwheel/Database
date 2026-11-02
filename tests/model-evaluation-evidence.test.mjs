import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const report=read('docs/FULL_FORECAST_EVALUATION.json'),ranges=read('FORECAST_REFERENCE_RANGES.json');
assert.equal(report.sourceSha256,hash(fs.readFileSync('scripts/data/projection/inputs.json')));
const files=['scripts/build-projections.mjs','scripts/build-season-progress.mjs','scripts/lib/projection.mjs','scripts/lib/projection-context.mjs','scripts/lib/entry-production.mjs','scripts/lib/forecast-timeframes.mjs'];
assert.equal(report.implementationSha256,hash(Buffer.concat(files.map(f=>fs.readFileSync(f)))),'Recompute the shared-code replay after model changes');
assert.equal(ranges.evaluationReportSha256,hash(fs.readFileSync('docs/FULL_FORECAST_EVALUATION.json')));
assert.ok(report.calibration.throughSeason<report.test.season);
assert.ok(report.test.zeroFutureAppearances>0,'Preserve future nonappearance outcomes');
assert.ok(report.test.unmodeledFuturePlayers>0,'Do not hide later entrants outside the as-of cohort');
assert.equal(report.sourceManifest.records.length,8);
for(const entry of report.sourceManifest.records){const bytes=fs.readFileSync(entry.path),decoded=zlib.gunzipSync(bytes);assert.equal(hash(bytes),entry.sha256);assert.equal(hash(decoded),entry.decodedSha256);assert.equal(JSON.parse(decoded).length,entry.rows);}
for(const metric of Object.values(report.stats)){assert.equal(metric.cohorts.all.n,metric.cohorts.all.n|0);for(const key of ['all','rookies','returners','movers','olderFallback']){assert.ok(metric.cohorts[key]);assert.ok(metric.cohortCalibration[key]);}}
const rotation=read('docs/ROTATION_PLAN_EVALUATION.json');assert.equal(rotation.results.length,60);
assert.ok(rotation.results.reduce((s,r)=>s+r.plannedMae,0)>rotation.results.reduce((s,r)=>s+r.baselineMae,0),'Preserve the measured negative allocator result, not a fabricated gain');
console.log('Frozen evaluation evidence: shared-code/input fingerprints, eight independent source hashes, cohorts, future nonappearances and negative rotation result passed.');

import assert from 'node:assert/strict';import fs from 'node:fs';
import {forecastReferenceRanges} from '../scripts/lib/forecast-reference.mjs';
const card=JSON.parse(fs.readFileSync(new URL('../FORECAST_REFERENCE_RANGES.json',import.meta.url)));
const f={remainingSeason:{gp:70,teamGamesRemaining:75,perGame:{mpg:25,pts:10,reb:4,ast:2},totals:{pts:700,min:1750}}};
const r=forecastReferenceRanges(f,card,{cohort:'rookies'});assert.equal(r.cohort,'rookies');assert.ok(r.ranges.gp.high<=75);assert.ok(r.ranges.pts.low>=0);assert.equal(r.ranges.pts.point,10);assert.deepEqual(r.ranges.pts.testCoverage,card.testCoverage.pts.rookies);
const bad=structuredClone(card);bad.bands.pts[0].p10=Infinity;if(bad.cohortBands)bad.cohortBands.pts.all[0].p10=Infinity;assert.throws(()=>forecastReferenceRanges(f,bad),/bands/);
const wrong=structuredClone(card);wrong.calibration.throughSeason=card.test.season;assert.throws(()=>forecastReferenceRanges(f,wrong),/card/);
console.log('Full-model reference ranges preserve points, cohort coverage, nonnegative and schedule bounds; malformed/future calibration is rejected.');

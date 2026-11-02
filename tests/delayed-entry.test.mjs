import assert from 'node:assert/strict';
import {eligibleEntryFallback} from '../scripts/lib/projection-context.mjs';
assert.equal(eligibleEntryFallback({draftYear:2025,fromYear:2025},[null,null,null],'2026-27'),true);
assert.equal(eligibleEntryFallback({draftYear:2026},[],'2026-27'),true);
assert.equal(eligibleEntryFallback({draftYear:2025},[{gp:1,min:2}],'2026-27'),false);
assert.equal(eligibleEntryFallback({draftYear:2027},[],'2026-27'),false);
assert.equal(eligibleEntryFallback(null,[],'2026-27'),false);
assert.equal(eligibleEntryFallback({draftYear:2008},[],'2026-27'),false);
console.log('Delayed entry is based on recorded appearances, not draft-year equality.');

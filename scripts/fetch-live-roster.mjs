import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshLiveRoster } from './lib/live-roster.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'scripts/data/live/roster.json');
const result = await refreshLiveRoster({ file });
console.log(`Verified official ${result.season} roster: ${result.rows.length} active players, fetched ${result.fetchedAt}`);

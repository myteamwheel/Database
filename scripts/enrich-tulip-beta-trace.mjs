// Add explanation-only TULIP Beta trace fields to an existing canonical artifact.
//
// This is deliberately defensive: it recomputes the frozen Beta path, asserts every previously
// shipped output is byte-for-byte equivalent at the field level, and writes ONLY the three trace
// values needed by the UI. It lets a UI-only release preserve other frozen generated products when
// their private build caches are unavailable in a fresh clone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tulipBetaForTeam } from './lib/tulip-beta.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.resolve(process.argv[2] || path.join(ROOT, 'public/data.json'));
const data = JSON.parse(fs.readFileSync(artifact, 'utf8'));
const nba = data.leagues?.NBA || [];
const meta = data.tulipBetaMeta || {};
if (!Number.isFinite(meta.leagueBpm) || !Number.isFinite(meta.leagueGapSd)) {
  throw new Error('canonical artifact is missing TULIP Beta league parameters');
}

const stableKeys = [
  'tulip', 'currentMpg', 'recommendedMpg', 'valueGap', 'valueGapSd', 'shrunkBpm',
  'supportedCeiling', 'evidenceTier', 'evidenceFactor', 'confidence', 'abstain', 'status', 'reason',
];
const traceKeys = ['rawSignalDelta', 'constrainedDelta', 'rosterBalanceFactor'];
const same = (a, b) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const byTeam = new Map();
for (const p of nba) {
  if (!byTeam.has(p.team)) byTeam.set(p.team, []);
  byTeam.get(p.team).push(p);
}

let enriched = 0;
for (const [team, roster] of byTeam) {
  const recomputed = tulipBetaForTeam(roster, { leagueBpm: meta.leagueBpm, leagueGapSd: meta.leagueGapSd });
  for (const p of roster) {
    const current = p.tulipBeta;
    if (!current || current.abstain) continue;
    const next = recomputed.get(p.playerId);
    if (!next) throw new Error(`${team}/${p.name}: recomputation unexpectedly abstained`);
    for (const key of stableKeys) {
      if (!same(current[key], next[key])) {
        throw new Error(`${team}/${p.name}: frozen ${key} changed (${current[key]} -> ${next[key]})`);
      }
    }
    for (const key of traceKeys) {
      if (!Number.isFinite(next[key])) throw new Error(`${team}/${p.name}: missing finite ${key}`);
      current[key] = next[key];
    }
    enriched++;
  }
}

if (process.env.BUILD_COMMIT) {
  data.provenance = { ...(data.provenance || {}), buildCommit: process.env.BUILD_COMMIT };
}
fs.writeFileSync(artifact, JSON.stringify(data));
console.log(`TULIP Beta trace: enriched ${enriched} scored NBA rows; frozen outputs unchanged`);

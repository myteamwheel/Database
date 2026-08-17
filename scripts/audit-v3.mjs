// Coverage + sanity audit for the v3 build. Non-zero exit on a build-blocking failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const empty = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
const fails = [];
const warn = [];

console.log(`season ${d.season}`);
console.log(`seasonType ${d.seasonType}`);
console.log(`counts NBA=${d.counts.NBA} GLEAGUE=${d.counts.GLEAGUE} both=${d.counts.both}\n`);

const CORE = ['name', 'team', 'position', 'age', 'gp', 'mpg', 'pts', 'reb', 'ast', 'stl', 'blk',
  'tov', 'ts', 'efg', 'usg', 'astPct', 'orebPct', 'drebPct', 'rebPct', 'offRtg', 'defRtg',
  'netRtg', 'pie', 'poss', 'grade', 'sampleConfidence', 'height', 'weight', 'country'];
const CUSTOM = ['selfCreatedPts36', 'chaosPts36', 'possessionSwing36', 'whistleDiff36',
  'disruptionPerFoul', 'creationLoad36', 'paintPts36', 'efficiencyOverExpected',
  'shotDietIndex', 'versatilityIndex', 'twoWayIndex', 'selfSufficiencyIndex',
  'defensiveDisruptionIndex', 'roleAdjustedImpact'];

for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = d.leagues[lg];
  console.log(`===== ${lg} (${arr.length}) =====`);
  const nStats = new Set(); arr.forEach((p) => Object.keys(p.stats || {}).forEach((k) => nStats.add(k)));
  console.log(`  distinct stats fields: ${nStats.size}`);

  console.log('  -- core field coverage --');
  for (const f of CORE) {
    const miss = arr.filter((p) => empty(p[f])).length;
    const pctMiss = (100 * miss / arr.length);
    const flag = pctMiss === 0 ? 'OK  ' : pctMiss < 5 ? 'ok  ' : pctMiss < 25 ? 'WARN' : 'GAP ';
    if (pctMiss > 0) console.log(`     ${flag} ${f.padEnd(20)} missing ${String(miss).padStart(4)} (${pctMiss.toFixed(1)}%)`);
    if (pctMiss >= 25 && !['gs'].includes(f)) warn.push(`${lg}.${f} ${pctMiss.toFixed(1)}% missing`);
  }
  const allCore = CORE.every((f) => arr.every((p) => !empty(p[f])));
  if (allCore) console.log('     all core fields fully populated');

  console.log('  -- custom metric coverage --');
  for (const f of CUSTOM) {
    const miss = arr.filter((p) => empty(p.custom?.[f])).length;
    if (miss > 0) console.log(`     ${f.padEnd(26)} missing ${miss} (${(100 * miss / arr.length).toFixed(1)}%)`);
  }

  // grade sanity
  const grades = arr.map((p) => p.grade);
  const bad = grades.filter((g) => !(g >= 0 && g <= 9.9999));
  if (bad.length) fails.push(`${lg}: ${bad.length} grades outside 0-9.9999`);
  console.log(`  grade range: ${Math.min(...grades).toFixed(4)} .. ${Math.max(...grades).toFixed(4)}`);

  // small-sample sanity: nobody in the top 25 should be under 10 games
  const top25 = [...arr].sort((a, b) => b.grade - a.grade).slice(0, 25);
  const thin = top25.filter((p) => p.gp < 10);
  console.log(`  top-25 minimum games played: ${Math.min(...top25.map((p) => p.gp))}`);
  if (thin.length) { warn.push(`${lg}: ${thin.length} of top 25 under 10 GP (${thin.map((p) => `${p.name} ${p.gp}gp`).join(', ')})`); }

  // duplicates
  const ids = arr.map((p) => p.playerId);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupIds.length) fails.push(`${lg}: duplicate playerIds ${[...new Set(dupIds)].join(',')}`);
  const names = arr.map((p) => p.name);
  const dupNames = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
  if (dupNames.length) console.log(`  duplicate NAMES (distinct people, allowed): ${dupNames.join(', ')}`);

  // position provenance
  const bySrc = {};
  arr.forEach((p) => { bySrc[p.positionSource || 'none'] = (bySrc[p.positionSource || 'none'] || 0) + 1; });
  console.log(`  position source: ${Object.entries(bySrc).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (bySrc.inferred) fails.push(`${lg}: ${bySrc.inferred} inferred positions still present`);

  if (lg === 'GLEAGUE') {
    const blended = arr.filter((p) => p.blendedSeason).length;
    console.log(`  season halves: ${blended} players have both Regular Season and Showcase games`);
    console.log(`  regular-only: ${arr.filter((p) => p.regularGP > 0 && p.showcaseGP === 0).length}` +
      ` · showcase-only: ${arr.filter((p) => p.showcaseGP > 0 && p.regularGP === 0).length}`);
    const fabricated = arr.filter((p) => !empty(p.bpm) || !empty(p.vorp)).length;
    console.log(`  rows carrying a BPM/VORP value: ${fabricated} (expected 0 — the G League publishes none)`);
    if (fabricated) fails.push(`GLEAGUE: ${fabricated} rows carry fabricated BPM/VORP`);
  }
  console.log('');
}

// crossover integrity
const nbaIds = new Set(d.leagues.NBA.map((p) => p.nbaPersonId));
const glIds = new Set(d.leagues.GLEAGUE.map((p) => p.nbaPersonId));
const inter = [...nbaIds].filter((i) => glIds.has(i));
console.log(`crossover players (exact NBA person id in both panels): ${inter.length}`);
if (inter.length !== d.counts.both) fails.push('crossover count mismatch');
const flaggedN = d.leagues.NBA.filter((p) => p.bothLeagues).length;
const flaggedG = d.leagues.GLEAGUE.filter((p) => p.bothLeagues).length;
console.log(`  flagged in NBA panel: ${flaggedN} · flagged in G League panel: ${flaggedG}`);
if (flaggedN !== inter.length || flaggedG !== inter.length) fails.push('bothLeagues flag inconsistent');

console.log('\n--- warnings ---');
warn.length ? warn.forEach((w) => console.log('  ! ' + w)) : console.log('  none');
console.log('--- failures ---');
fails.length ? fails.forEach((f) => console.log('  X ' + f)) : console.log('  none');
process.exit(fails.length ? 1 : 0);

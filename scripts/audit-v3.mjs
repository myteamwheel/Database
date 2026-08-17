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
  'netRtg', 'pie', 'poss', 'grade', 'reliabilityWeight', 'height', 'weight', 'country', 'positionFamily'];
const CUSTOM = ['selfCreatedPts36', 'possessionSwing36', 'whistleDiff36',
  'disruptionPerFoul', 'creationLoad36', 'paintPts36', 'efficiencyOverExpected',
  'shotLocationValue', 'versatilityIndex', 'twoWayIndex', 'selfSufficiencyIndex',
  'defensiveDisruptionIndex', 'impactOverExpected', 'situationalPts36', 'defensiveSwing36'];

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

// Regression guards for the defects a previous audit found.
for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = d.leagues[lg];
  const g = arr.map((p) => p.grade).sort((a, b) => b - a);
  const gaps = g.slice(1).map((v, i) => +(g[i] - v).toFixed(4));
  const distinct = new Set(gaps).size;
  console.log(`${lg}: ${distinct} distinct adjacent grade gaps out of ${gaps.length}`);
  if (distinct < gaps.length * 0.2)
    fails.push(`${lg}: grade is evenly spaced (${distinct} distinct gaps) - it encodes rank, not magnitude`);

  // No custom metric should be topped by a player with a negligible sample.
  for (const key of CUSTOM) {
    const top = [...arr].filter((p) => empty(p.custom?.[key]) === false)
      .sort((a, b) => b.custom[key] - a.custom[key])[0];
    if (top && top.gp <= 2) warn.push(`${lg}.${key} is led by ${top.name} on ${top.gp} game(s)`);
  }

  const noFamily = arr.filter((p) => p.position && !p.positionFamily).length;
  if (noFamily) fails.push(`${lg}: ${noFamily} players have a position but no canonical family`);

  const stintless = arr.filter((p) => (p.teamCount || 1) > 1 && (p.teams || []).length < 2).length;
  if (stintless) warn.push(`${lg}: ${stintless} multi-team players have no per-team stint breakdown`);
}
{
  const gl = d.leagues.GLEAGUE;
  const mismatch = gl.filter((p) => p.showcaseGP > 0 && p.brefGP && p.brefScope !== 'regular-season-only').length;
  if (mismatch) fails.push(`GLEAGUE: ${mismatch} rows carry a Basketball-Reference line without the regular-season-only scope label`);
  const trackScope = gl.filter((p) => p.showcaseGP > 0 && p.stats.trk_catchshoot_GP && p.stats.trk_catchshoot_GP < p.gp * 0.8).length;
  console.log(`GLEAGUE: ${trackScope} rows where combined tracking still trails the season line`);
}

// Stint totals must reconcile against the season aggregate, not merely on games played.
for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = d.leagues[lg];
  const multi = arr.filter((p) => (p.teamCount || 1) > 1 && (p.teams || []).length);
  let bad = 0;
  for (const p of multi) {
    const sum = (f) => p.teams.reduce((a, s) => a + (s[f] || 0), 0);
    const gpOk = Math.abs(sum('gp') - p.gp) <= 1;
    // per-game stint values re-multiplied by stint games must recover season totals
    const ptsTotal = p.teams.reduce((a, s) => a + (s.pts || 0) * (s.gp || 0), 0);
    const ptsOk = p.pts == null || Math.abs(ptsTotal - p.pts * p.gp) <= Math.max(2, 0.02 * p.pts * p.gp);
    const minOk = Math.abs(sum('min') - (p.minutes || 0)) <= Math.max(2, 0.02 * (p.minutes || 0));
    if (!gpOk || !ptsOk || !minOk) { bad++; if (bad <= 3) warn.push(`${lg}: ${p.name} stints do not reconcile (gp ${gpOk} pts ${ptsOk} min ${minOk})`); }
  }
  console.log(`${lg}: ${multi.length - bad}/${multi.length} multi-team players reconcile on games, points and minutes`);
  if (bad > multi.length * 0.05) fails.push(`${lg}: ${bad} multi-team players fail stint reconciliation`);
}

// Positional bias, tracked so a metric change cannot quietly worsen it.
for (const lg of ['NBA', 'GLEAGUE']) {
  const bias = d.gradeModel?.shrinkage?.[lg]?.positionalBias || {};
  const pure = Object.entries(bias).filter(([k]) => k.length === 1);
  if (!pure.length) continue;
  const means = pure.map(([, v]) => v.meanGrade);
  const spread = Math.max(...means) - Math.min(...means);
  console.log(`${lg}: positional grade spread ${spread.toFixed(2)} (${pure.map(([k, v]) => `${k}=${v.meanGrade}`).join(' ')})`);
  if (spread > 1.0) fails.push(`${lg}: positional bias ${spread.toFixed(2)} exceeds 1.00 grade points`);
  else if (spread > 0.5) warn.push(`${lg}: positional grade spread is ${spread.toFixed(2)}`);
}

console.log('\n--- warnings ---');
warn.length ? warn.forEach((w) => console.log('  ! ' + w)) : console.log('  none');
console.log('--- failures ---');
fails.length ? fails.forEach((f) => console.log('  X ' + f)) : console.log('  none');
process.exit(fails.length ? 1 : 0);

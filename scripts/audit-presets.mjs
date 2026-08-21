// Assert every field a UI preset declares actually resolves to populated data.
//
// The table silently drops columns whose key matches nothing, so a typo — or a casing mismatch
// against the build's lowercasing — looks exactly like "the source doesn't publish that", and a
// programming error hides as a data limitation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

/** Pull the PRESETS object literal and read every key it declares, per preset. */
function presets() {
  const start = app.indexOf('const PRESETS = {');
  const end = app.indexOf('const PRESET_LABELS');
  const block = app.slice(start, end);
  const out = {};
  const re = /^\s{2}([A-Za-z]+):\s*\[([\s\S]*?)\],\s*$/gm;
  let m;
  while ((m = re.exec(block))) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

/** Every key BASE_COLS declares, so labels for absent fields are caught too. */
function baseColKeys() {
  const start = app.indexOf('const BASE_COLS = {');
  const end = app.indexOf('const CUSTOM_KEYS');
  return [...app.slice(start, end).matchAll(/'(stats\.[^']+)'/g)].map((x) => x[1]);
}

const PSEUDO = new Set(['select', 'viewRank', 'labScore']);
const fails = [];
const warn = [];
const P = presets();
console.log(`parsed ${Object.keys(P).length} presets: ${Object.keys(P).join(', ')}\n`);
if (Object.keys(P).length < 8) fails.push('preset parsing looks wrong — fewer presets found than expected');

for (const league of ['NBA', 'GLEAGUE']) {
  const records = d.leagues[league].filter((p) => p.appeared);
  const statKeys = new Set(records.flatMap((p) => Object.keys(p.stats || {})));
  const topKeys = new Set(records.flatMap((p) => Object.keys(p)));
  const customKeys = new Set(records.flatMap((p) => Object.keys(p.custom || {})));
  const compKeys = new Set(records.flatMap((p) => Object.keys(p.components || {})));

  // Which tulip.* scalars are actually populated for at least one non-abstaining player.
  const tulipKeys = new Set();
  for (const p of d.leagues[league]) {
    const c = p.tulip?.card;
    if (!c || c.abstain === true) continue;
    if (Number.isFinite(c.rotation?.leagueReferencedDelta)) tulipKeys.add('leagueDelta');
    if (Number.isFinite(c.rotation?.neutralRotationDelta)) tulipKeys.add('neutralDelta');
    if (Number.isFinite(c.projection?.projectedImpact)) tulipKeys.add('projectedImpact');
    if (Number.isFinite(c.projection?.support)) tulipKeys.add('support');
    if (c.evidenceTier?.tier) tulipKeys.add('tier');
    if (c.rotation?.verdict) tulipKeys.add('verdict');
    if (Number.isFinite(c.targetMpg)) tulipKeys.add('targetMpg');
  }

  // TULIP Capacity V1 lives on p.tulipCapacity and is legitimately absent wherever V1 abstains —
  // notably the ENTIRE G League, which V1 is not validated for. Same bar as every other field:
  // at least one player in this league must carry a real value.
  const capKeys = new Set();
  for (const p of d.leagues[league]) {
    const c = p.tulipCapacity;
    if (!c || c.abstain) continue;
    for (const [k, v] of Object.entries(c)) if (v !== null && v !== undefined && k !== 'abstain') capKeys.add(k);
    if (Number.isFinite(c.supportCount)) capKeys.add('evidence');
  }

  // Cross-league derived fields live on nested objects rather than as top-level keys.
  const derived = { opt: new Set(), rb: new Set(), p36: new Set(), p36n: new Set() };
  for (const p of d.leagues[league]) {
    for (const [bag, obj] of [['opt', p.optimal], ['rb', p.readinessBlocks], ['p36', p.per36], ['p36n', p.per36Nba]]) {
      for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined) derived[bag].add(k);
    }
  }

  const resolves = (key) => {
    if (PSEUDO.has(key)) return true;
    if (key.startsWith('stats.')) return statKeys.has(key.slice(6));
    if (key.startsWith('custom.')) return customKeys.has(key.slice(7));
    if (key.startsWith('components.')) return compKeys.has(key.slice(11));
    // TULIP fields are derived from the per-player tulip.card object rather than being top-level
    // keys, and they are legitimately null for every player TULIP abstains on. "Resolves" here
    // means at least one player carries a real value, which is the same bar as every other field.
    if (key.startsWith('tc.')) return capKeys.has(key.slice(3));
    if (key.startsWith('tulip.')) return tulipKeys.has(key.slice(6));
    if (key.startsWith('opt.')) return derived.opt.has(key.slice(4));
    if (key.startsWith('rb.')) return derived.rb.has(key.slice(3));
    if (key.startsWith('p36.')) return derived.p36.has(key.slice(4));
    if (key.startsWith('p36n.')) return derived.p36n.has(key.slice(5));
    if (key === 'nbaReadiness') return d.leagues[league].some((p) => Number.isFinite(p.nbaReadiness));
    return topKeys.has(key);
  };
  // A field may legitimately be absent in one league (tracking in the G League) as long as the
  // preset itself is hidden there. These are the presets each league actually offers.
  const leagueOnly = { tracking: 'NBA', splits: 'GLEAGUE', nbaready: 'GLEAGUE', per36nba: 'GLEAGUE',
    capacity: 'NBA' };

  const otherLeague = league === 'NBA' ? 'GLEAGUE' : 'NBA';
  const otherStats = new Set(d.leagues[otherLeague].filter((p) => p.appeared)
    .flatMap((p) => Object.keys(p.stats || {})));
  const otherHasCapacity = d.leagues[otherLeague].some((p) => p.tulipCapacity && p.tulipCapacity.abstain !== true);
  const existsSomewhere = (k) => resolves(k)
    || (k.startsWith('stats.') && otherStats.has(k.slice(6)))
    || (k.startsWith('tc.') && otherHasCapacity);

  const dead = [], leagueAbsent = [];
  for (const [name, keys] of Object.entries(P)) {
    if (leagueOnly[name] && leagueOnly[name] !== league) continue;
    for (const k of keys) {
      if (resolves(k)) continue;
      (existsSomewhere(k) ? leagueAbsent : dead).push(`${name} -> ${k}`);
    }
  }
  console.log(`${league}: ${dead.length} preset field(s) exist in NEITHER league` +
    `, ${leagueAbsent.length} absent here but present in ${otherLeague} (column is dropped, fine)`);
  dead.forEach((x) => console.log('   X ' + x));
  leagueAbsent.forEach((x) => console.log('   - ' + x));
  if (dead.length) fails.push(`${league}: ${dead.length} preset fields resolve to no data anywhere (${dead.slice(0, 4).join('; ')})`);

  const deadLabels = baseColKeys().filter((k) => !statKeys.has(k.slice(6)));
  if (deadLabels.length) {
    console.log(`${league}: ${deadLabels.length} BASE_COLS label(s) name a field that does not exist here`);
    // Only a failure if it exists in NEITHER league.
    const other = league === 'NBA' ? 'GLEAGUE' : 'NBA';
    const otherKeys = new Set(d.leagues[other].flatMap((p) => Object.keys(p.stats || {})));
    const nowhere = deadLabels.filter((k) => !otherKeys.has(k.slice(6)));
    nowhere.forEach((k) => console.log('   X ' + k + ' (exists in neither league)'));
    if (nowhere.length) fails.push(`${nowhere.length} BASE_COLS entries name fields absent from both leagues: ${nowhere.slice(0, 4).join(', ')}`);
  }
  console.log('');
}

console.log('--- warnings ---');
warn.length ? warn.forEach((w) => console.log('  ! ' + w)) : console.log('  none');
console.log('--- failures ---');
fails.length ? fails.forEach((f) => console.log('  X ' + f)) : console.log('  none');
process.exit(fails.length ? 1 : 0);

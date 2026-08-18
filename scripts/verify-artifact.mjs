// Prove the published standalone page is byte-equivalent in DATA to the canonical build.
//
// The standalone uses columnar-v1 plus gzip/base64 transport. This verifier decodes both layers
// independently of the browser and deep-compares every field/value, including null-vs-missing,
// zero, false, arrays, nested objects and Unicode names.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public/standalone.html'), 'utf8');

const m = html.match(/<script type="application\/octet-stream" id="db-gz">([A-Za-z0-9+/=\s]+)<\/script>/);
if (!m) { console.error('X no gzip/base64 payload found in standalone.html'); process.exit(1); }
let packed;
try {
  packed = JSON.parse(zlib.gunzipSync(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).toString('utf8'));
} catch (e) {
  console.error('X standalone compressed payload does not decode:', e.message);
  process.exit(1);
}
const hm = html.match(/<script type="application\/octet-stream" id="history-db-gz">([A-Za-z0-9+/=\s]+)<\/script>/);
const historyFile = path.join(ROOT, 'public/history-games.json.gz');
if (fs.existsSync(historyFile)) {
  if (!hm) { console.error('X standalone is missing embedded history game payload'); process.exit(1); }
  const embeddedHistory = Buffer.from(hm[1].replace(/\s+/g, ''), 'base64');
  const sourceHistory = fs.readFileSync(historyFile);
  if (!embeddedHistory.equals(sourceHistory)) { console.error('X embedded history game payload differs from public/history-games.json.gz'); process.exit(1); }
  console.log(`history game payload embedded byte-for-byte: ${embeddedHistory.length.toLocaleString()} bytes`);
}

/** Identical logical decode to rehydrate() in app.js. */
function rehydrate(d) {
  if (!d || d.encoding !== 'columnar-v1') return d;
  const ABSENT = d.absent ?? '\u0000~';
  const out = { ...d, encoding: 'rehydrated', leagues: {} };
  for (const lg of Object.keys(d.leagues)) {
    const { flatKeys, statKeys, customKeys, compKeys, rows } = d.leagues[lg];
    const put = (target, keys, vals) => {
      keys.forEach((k, i) => { if (vals[i] !== ABSENT) target[k] = vals[i]; });
    };
    out.leagues[lg] = rows.map(([flat, stats, custom, comps, teams]) => {
      const p = {};
      put(p, flatKeys, flat);
      p.stats = {}; put(p.stats, statKeys, stats);
      p.custom = {}; put(p.custom, customKeys, custom);
      p.components = {}; put(p.components, compKeys, comps);
      p.teams = teams || [];
      return p;
    });
  }
  return out;
}

const decoded = rehydrate(packed);
const problems = [];
let compared = 0;

function deepEq(a, b, trail) {
  compared++;
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    problems.push(`${trail}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { problems.push(`${trail}: array/object mismatch`); return false; }
  const ka = Object.keys(a), kb = Object.keys(b);
  for (const k of new Set([...ka, ...kb])) {
    if (!(k in a)) { problems.push(`${trail}.${k}: missing in canonical`); continue; }
    if (!(k in b)) { problems.push(`${trail}.${k}: LOST in artifact`); continue; }
    if (problems.length > 40) return false;
    deepEq(a[k], b[k], `${trail}.${k}`);
  }
  return true;
}

for (const lg of ['NBA', 'GLEAGUE']) {
  const A = canonical.leagues[lg], B = decoded.leagues[lg];
  if (!B) { problems.push(`${lg}: missing from artifact`); continue; }
  if (A.length !== B.length) problems.push(`${lg}: ${A.length} players canonical vs ${B.length} decoded`);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    deepEq(A[i], B[i], `${lg}[${i}] ${A[i].name}`);
    if (problems.length > 40) break;
  }
  const aFields = new Set(A.flatMap((p) => Object.keys(p.stats || {})));
  const bFields = new Set(B.flatMap((p) => Object.keys(p.stats || {})));
  const lost = [...aFields].filter((f) => !bFields.has(f));
  console.log(`${lg}: ${A.length} players, ${aFields.size} raw fields canonical -> ${bFields.size} decoded` +
    (lost.length ? `  LOST ${lost.length}` : '  (complete)'));
  if (lost.length) problems.push(`${lg}: ${lost.length} raw fields dropped: ${lost.slice(0, 8).join(', ')}`);
}

const probe = canonical.leagues.NBA.find((p) => /[^\x00-\x7F]/.test(p.name));
const dprobe = decoded.leagues.NBA.find((p) => p.nbaPersonId === probe?.nbaPersonId);
console.log(`unicode name round-trip: ${JSON.stringify(probe?.name)} -> ${JSON.stringify(dprobe?.name)}` +
  (probe?.name === dprobe?.name ? '  ok' : '  MISMATCH'));
if (probe?.name !== dprobe?.name) problems.push('unicode player name did not survive');

const multi = canonical.leagues.NBA.find((p) => (p.teams || []).length > 1);
const dmulti = decoded.leagues.NBA.find((p) => p.nbaPersonId === multi?.nbaPersonId);
console.log(`stint array round-trip: ${multi?.teams.length} stints -> ${dmulti?.teams.length}`);

const zeros = canonical.leagues.NBA.filter((p) => p.pts === 0).length;
const dzeros = decoded.leagues.NBA.filter((p) => p.pts === 0).length;
console.log(`zero-valued fields preserved: ${zeros} -> ${dzeros}${zeros === dzeros ? '  ok' : '  MISMATCH'}`);
if (zeros !== dzeros) problems.push('zero values were dropped as if missing');

console.log(`\n${compared.toLocaleString()} value comparisons`);
if (problems.length) {
  console.log('--- FAILURES ---');
  problems.slice(0, 40).forEach((p) => console.log('  X ' + p));
  process.exit(1);
}
console.log('artifact is a lossless encoding of public/data.json');

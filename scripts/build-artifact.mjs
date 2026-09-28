// Produce a single self-contained HTML file carrying the COMPLETE dataset.
//
// The canonical browser payload stays lossless. Player rows are first columnar-encoded to remove
// repeated key names, then the packed JSON is gzip-compressed and base64-embedded. Modern browsers
// decode it with the native DecompressionStream API before app initialization. This gives the
// standalone artifact enough headroom for historical/product growth without dropping fields.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const data = JSON.parse(R('public/data.json'));
const NESTED = ['stats', 'custom', 'components', 'teams'];

/** Sentinel for "this key was not present", distinct from a present null value. */
const ABSENT = '\u0000~';
const enc = (obj, k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : ABSENT);

function columnar(arr) {
  const flatKeys = [...new Set(arr.flatMap((p) => Object.keys(p)))].filter((k) => !NESTED.includes(k));
  const statKeys = [...new Set(arr.flatMap((p) => Object.keys(p.stats || {})))];
  const customKeys = [...new Set(arr.flatMap((p) => Object.keys(p.custom || {})))];
  const compKeys = [...new Set(arr.flatMap((p) => Object.keys(p.components || {})))];
  return {
    absent: ABSENT,
    flatKeys, statKeys, customKeys, compKeys,
    rows: arr.map((p) => [
      flatKeys.map((k) => enc(p, k)),
      statKeys.map((k) => enc(p.stats, k)),
      customKeys.map((k) => enc(p.custom, k)),
      compKeys.map((k) => enc(p.components, k)),
      p.teams || [],
    ]),
  };
}

const packed = {
  ...data,
  encoding: 'columnar-v1',
  leagues: { NBA: columnar(data.leagues.NBA), GLEAGUE: columnar(data.leagues.GLEAGUE) },
};

/** Escape non-ASCII source text so the file is host-charset-independent. */
function escapeNonAscii(s, mode) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 128) { out += ch; continue; }
    out += mode === 'js'
      ? [...ch].map((u) => '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0')).join('')
      : '&#' + code + ';';
  }
  return out;
}

const packedJson = JSON.stringify(packed);
const gz = zlib.gzipSync(Buffer.from(packedJson, 'utf8'), { level: 9 });
const payload64 = gz.toString('base64');
const historyGzPath = path.join(ROOT, 'public/history-games.json.gz');
const historyPayload64 = fs.existsSync(historyGzPath) ? fs.readFileSync(historyGzPath).toString('base64') : '';
const css = escapeNonAscii(R('styles.css'), 'html');

const standaloneLoader = `const payload=document.getElementById('db-gz').textContent.trim();
    if(typeof DecompressionStream!=='function') throw new Error('Standalone file requires a modern browser with DecompressionStream support');
    const bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0));
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    DATA=rehydrate(JSON.parse(await new Response(stream).text())); window.DATA=DATA;`;

const app = escapeNonAscii(
  R('app.js').replace(
    "const r=await fetch('./public/data.json',{cache:'no-cache'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();",
    standaloneLoader
  ),
  'js'
);
if (app.includes("fetch('./public/data.json'")) throw new Error('data-loading patch did not apply');
if (!app.includes("document.getElementById('db-gz')")) throw new Error('standalone compressed-loader patch did not apply');

const workspace = escapeNonAscii(R('workspace.js'), 'js');
const body = escapeNonAscii(
  R('index.html')
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
    .replace(/<link rel="stylesheet" href="styles\.css(?:\?[^\"]*)?"\s*\/?>/, '')
    .replace(/<script src="app\.js(?:\?[^\"]*)?"><\/script>/, '')
    .replace(/<script src="workspace\.js(?:\?[^\"]*)?"><\/script>/, ''),
  'html'
);

const html = `<title>Pro Basketball Database — 2025-26 Player Stats</title>
<base href="../">
<style>
${css}
</style>
${body}
<script type="application/octet-stream" id="db-gz">${payload64}</script>
${historyPayload64 ? `<script type="application/octet-stream" id="history-db-gz">${historyPayload64}</script>` : ''}
<script>
${app}
</script>
<script>
${workspace}
</script>
`;

for (const ch of html) if (ch.codePointAt(0) > 127) throw new Error('non-ASCII survived escaping');

const out = path.join(ROOT, 'public/standalone.html');
fs.writeFileSync(out, html, 'ascii');
const mb = (s) => (s / 1e6).toFixed(2) + ' MB';
const bytes = fs.statSync(out).size;
const MAX_STANDALONE_BYTES = 16_000_000;
if (bytes > MAX_STANDALONE_BYTES) {
  throw new Error(`standalone artifact ${mb(bytes)} exceeds ${mb(MAX_STANDALONE_BYTES)} publish ceiling`);
}
const nbaFields = packed.leagues.NBA.statKeys.length, glFields = packed.leagues.GLEAGUE.statKeys.length;
console.log(`raw fields carried: NBA ${nbaFields}, G League ${glFields} (complete - nothing dropped)`);
console.log(`packed JSON ${mb(Buffer.byteLength(packedJson))} -> gzip ${mb(gz.length)} -> base64 ${mb(payload64.length)}`);
if (historyPayload64) console.log(`embedded history game log: ${mb(fs.statSync(historyGzPath).size)} gzip -> ${mb(historyPayload64.length)} base64`);
console.log(`page ${mb(bytes)} -> public/standalone.html (${(MAX_STANDALONE_BYTES - bytes).toLocaleString()} bytes headroom)`);

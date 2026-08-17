// Produce a single self-contained HTML file carrying the COMPLETE dataset.
//
// The previous version stripped ~75% of the raw fields to keep the page small, which broke the
// whole point of the database and made the interface's "600+ fields" claim false. Columnar
// encoding — one shared key table per league, each player a positional array — removes the
// repeated key names that dominated the payload and shrinks 15.6 MB to ~3.6 MB, so nothing
// has to be dropped. `rehydrate()` in app.js reverses it at load.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const data = JSON.parse(R('public/data.json'));

const NESTED = ['stats', 'custom', 'components', 'teams'];
function columnar(arr) {
  const flatKeys = [...new Set(arr.flatMap((p) => Object.keys(p)))].filter((k) => !NESTED.includes(k));
  const statKeys = [...new Set(arr.flatMap((p) => Object.keys(p.stats || {})))];
  const customKeys = [...new Set(arr.flatMap((p) => Object.keys(p.custom || {})))];
  const compKeys = [...new Set(arr.flatMap((p) => Object.keys(p.components || {})))];
  return {
    flatKeys, statKeys, customKeys, compKeys,
    rows: arr.map((p) => [
      flatKeys.map((k) => (p[k] === undefined ? null : p[k])),
      statKeys.map((k) => (p.stats?.[k] === undefined ? null : p.stats[k])),
      customKeys.map((k) => (p.custom?.[k] === undefined ? null : p.custom[k])),
      compKeys.map((k) => (p.components?.[k] === undefined ? null : p.components[k])),
      p.teams || [],
    ]),
  };
}

const packed = {
  ...data,
  encoding: 'columnar-v1',
  leagues: { NBA: columnar(data.leagues.NBA), GLEAGUE: columnar(data.leagues.GLEAGUE) },
};

/** Escape non-ASCII so the page renders correctly whatever charset the host serves. */
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

const json = escapeNonAscii(JSON.stringify(packed), 'js');
const css = escapeNonAscii(R('styles.css'), 'html');
const app = escapeNonAscii(
  R('app.js').replace(
    "const r=await fetch('./public/data.json',{cache:'no-store'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();",
    "DATA=rehydrate(JSON.parse(document.getElementById('db').textContent));"
  ),
  'js'
);
if (app.includes("fetch('./public/data.json'")) throw new Error('data-loading patch did not apply');

const body = escapeNonAscii(
  R('index.html')
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
    .replace('<link rel="stylesheet" href="styles.css" />', '')
    .replace('<script src="app.js"></script>', ''),
  'html'
);

const html = `<title>Two-League Grade Book</title>
<style>
${css}
</style>
${body}
<script type="application/json" id="db">${json.replace(/<\//g, '<\\/')}</script>
<script>
${app}
</script>
`;

for (const ch of html) if (ch.codePointAt(0) > 127) throw new Error('non-ASCII survived escaping');

const out = path.join(ROOT, 'public/standalone.html');
fs.writeFileSync(out, html, 'ascii');
const mb = (s) => (s / 1e6).toFixed(2) + ' MB';
const nbaFields = packed.leagues.NBA.statKeys.length, glFields = packed.leagues.GLEAGUE.statKeys.length;
console.log(`raw fields carried: NBA ${nbaFields}, G League ${glFields} (complete - nothing dropped)`);
console.log(`inlined ${mb(json.length)} - page ${mb(fs.statSync(out).size)} -> public/standalone.html`);

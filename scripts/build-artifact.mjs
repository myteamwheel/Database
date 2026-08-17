// Produce a single self-contained HTML file: the same app, with CSS, JS and a trimmed
// dataset inlined, for hosting somewhere that cannot fetch a 13.8 MB sidecar JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const data = JSON.parse(R('public/data.json'));

// Raw-stat groups worth carrying online. The Basketball-Reference bag (`bref_`, 228 fields)
// and the bulk player-tracking bag are dropped: everything the interface actually reads from
// them is already promoted to a top-level field.
const KEEP_PREFIX = ['oadv_', 'oscore_', 'omisc_', 'ousage_', 'odef_', 'split_'];
const KEEP_EXACT = new Set([
  'trk_drives_drives', 'trk_drives_drive_pts', 'trk_passing_passes_made',
  'trk_passing_potential_ast', 'trk_passing_ast_points_created', 'trk_touches_touches',
  'trk_touches_time_of_poss', 'trk_touches_paint_touches', 'trk_rebounding_reb_contest_pct',
  'trk_defense_def_rim_fg_pct', 'trk_catchshoot_catch_shoot_pts', 'trk_catchshoot_catch_shoot_fga',
  'trk_pullup_pull_up_pts', 'trk_pullup_pull_up_fga',
  'hustle_contested_shots', 'hustle_deflections', 'hustle_charges_drawn',
  'hustle_screen_assists', 'hustle_loose_balls_recovered', 'hustle_box_outs',
]);

let kept = 0, dropped = 0;
const slim = { ...data, leagues: {} };
for (const lg of ['NBA', 'GLEAGUE']) {
  slim.leagues[lg] = data.leagues[lg].map((p) => {
    const q = { ...p };
    delete q.sourceIds;
    q.stats = {};
    for (const [k, v] of Object.entries(p.stats || {})) {
      if (KEEP_PREFIX.some((pre) => k.startsWith(pre)) || KEEP_EXACT.has(k)) { q.stats[k] = v; kept++; }
      else dropped++;
    }
    return q;
  });
}
slim.bundleNote = 'Online build: raw Basketball-Reference and bulk tracking field bags are dropped to keep the page loadable. Every field the interface reads is present, and the full 540/277-field dataset is in the local build.';

/**
 * Escape every non-ASCII character so the file is pure ASCII and renders correctly no matter
 * what charset the host serves it as. Without this, "Nikola Jokic" (with its acute c) arrives
 * as mojibake wherever the response omits `charset=utf-8`.
 */
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

const json = escapeNonAscii(JSON.stringify(slim), 'js');
const css = escapeNonAscii(R('styles.css'), 'html');
const app = escapeNonAscii(
  R('app.js').replace(
    "const r=await fetch('./public/data.json',{cache:'no-store'}); if(!r.ok)throw new Error(`data.json returned ${r.status}`); DATA=await r.json();",
    "DATA=JSON.parse(document.getElementById('db').textContent);"
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

for (const ch of html) {
  if (ch.codePointAt(0) > 127) throw new Error('non-ASCII survived escaping: ' + ch);
}

const out = path.join(ROOT, 'public/standalone.html');
fs.writeFileSync(out, html, 'ascii');
const mb = (s) => (s / 1e6).toFixed(2) + ' MB';
console.log(`stats fields kept ${kept}, dropped ${dropped}`);
console.log(`data inlined ${mb(json.length)} - page ${mb(fs.statSync(out).size)} -> public/standalone.html`);

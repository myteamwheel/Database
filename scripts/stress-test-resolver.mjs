// Stress-test the name resolver across every roster in the historical universe.
//
// The resolver must be GENERIC. Three separate reconstruction bugs came from per-case name
// handling, and a fourth came from a "systematic" fix that split compound surnames. This exercises
// the whole player universe rather than the handful of names that happened to surface in debugging.
//
// FAIL CLOSED: any normalization that makes two roster-mates indistinguishable is reported as
// ambiguous, never resolved by plausibility. A confident wrong match corrupts two players' stints
// simultaneously and is worse than an unresolved one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { descName, normalizeName, resolveRoster } from './lib/rotation.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const players = new Map();          // playerId -> name
const teamGameRosters = new Map();  // gameId|teamId -> [{playerId, playerName}]
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()) {
  for (const f of ['gamelog.json', 'gamelog_playoffs.json']) {
    const p = path.join(HIST, s, f);
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) {
      players.set(r.playerId, r.playerName);
      const k = `${r.gameId}|${r.teamId}`;
      if (!teamGameRosters.has(k)) teamGameRosters.set(k, []);
      teamGameRosters.get(k).push({ playerId: r.playerId, playerName: r.playerName });
    }
  }
}
console.log(`ROSTER UNIVERSE: ${players.size} distinct players, ${teamGameRosters.size} team-games\n`);

// 1. Character-class coverage — does every awkward name still yield a usable surname?
const classes = {
  diacritics: /[^\x00-\x7F]/,
  apostrophe: /['’]/,
  period: /\./,
  hyphen: /-/,
  suffix: /\b(jr|sr|ii|iii|iv|v)\.?$/i,
  multiWordSurname: /\s\w+\s\w+$/,
};
console.log('character-class coverage:');
for (const [label, re] of Object.entries(classes)) {
  const hits = [...players.values()].filter((n) => re.test(String(n)));
  const failed = hits.filter((n) => { const d = descName(n); return !d || !d.bare; });
  console.log(`  ${label.padEnd(18)} ${String(hits.length).padStart(4)} players · ${failed.length} produce no surname`);
  if (failed.length) console.log(`      e.g. ${failed.slice(0, 3).map((x) => JSON.stringify(x)).join(', ')}`);
}

// 2. Ambiguity within actual team-games — the only place a collision can do damage.
let ambiguousTeamGames = 0, totalAmbiguous = 0;
const examples = new Map();
for (const [k, roster] of teamGameRosters) {
  const { ambiguous } = resolveRoster(roster);
  if (!ambiguous.length) continue;
  ambiguousTeamGames++;
  totalAmbiguous += ambiguous.length;
  for (const a of ambiguous) {
    const names = a.playerIds.map((id) => players.get(id)).sort().join(' / ');
    if (!examples.has(names)) examples.set(names, { form: a.form, n: 0 });
    examples.get(names).n++;
  }
}
console.log(`\nambiguous surname collisions:`);
console.log(`  team-games affected  ${ambiguousTeamGames} of ${teamGameRosters.size} (${(100 * ambiguousTeamGames / teamGameRosters.size).toFixed(2)}%)`);
console.log(`  distinct collisions  ${examples.size}`);
for (const [names, info] of [...examples.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
  console.log(`    "${info.form}" <- ${names}  (${info.n} team-games)`);
}
console.log('\n  These are logged as UNRESOLVED, never guessed. A wrong confident match would corrupt');
console.log('  two players at once, which is worse than leaving one unresolved.');

// 3. Normalization sanity: forms must be non-empty, lowercase and free of stray punctuation.
const bad = [];
for (const [id, n] of players) {
  const d = descName(n);
  if (!d) { bad.push({ id, n, why: 'no surname' }); continue; }
  for (const form of d.all) {
    if (!form || /[A-Z.'’]/.test(form)) bad.push({ id, n, why: `unclean form ${JSON.stringify(form)}` });
  }
}
console.log(`\nnormalization defects: ${bad.length}`);
for (const b of bad.slice(0, 5)) console.log(`  ${JSON.stringify(b.n)} -> ${b.why}`);

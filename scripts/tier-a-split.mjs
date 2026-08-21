// Tier A evaluation split, assigned BEFORE any disagreement is inspected.
//
// WHY THIS EXISTS. Reconstruction rules were written by looking at disagreements on nine
// GameRotation games. Those nine are DEVELOPMENT evidence — 90.5% exact there is not validation,
// because the rules were shaped by those very errors. Reporting a figure as "held out" after
// inspecting its failures is the mistake this file prevents.
//
// Assignment is deterministic (hash of the game id), so it is stable across runs and cannot drift
// as games arrive. Whole seasons are reserved untouched where the sample allows, because an era
// audit is far stronger evidence than a random split — feeds and rotation conventions change.
//
// RULE: once a VALIDATION game's disagreement is inspected to write a rule, it moves permanently to
// development and a fresh untouched game takes its place in the audit set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SPLIT = path.join(HIST, 'tier_a_split.json');
const rotDir = path.join(HIST, 'rotation');

// Seasons held back entirely as an era audit, chosen up front rather than after seeing results.
const RESERVED_SEASONS = ['2021-22'];

const seasonOf = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) seasonOf.set(r.gameId, s);
}
const prior = fs.existsSync(SPLIT) ? JSON.parse(fs.readFileSync(SPLIT, 'utf8')) : { development: [], validation: [], eraAudit: [], inspected: [] };
const known = new Set([...prior.development, ...prior.validation, ...prior.eraAudit]);

// The nine games already inspected are development by construction, whatever a hash would say.
const alreadyInspected = new Set(prior.inspected);
const games = fs.existsSync(rotDir) ? fs.readdirSync(rotDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : [];
for (const g of games) {
  if (known.has(g)) continue;
  const season = seasonOf.get(g) || '?';
  if (RESERVED_SEASONS.includes(season)) { prior.eraAudit.push(g); continue; }
  if (alreadyInspected.has(g)) { prior.development.push(g); continue; }
  // Deterministic 60/40 split by game id.
  const h = parseInt(crypto.createHash('sha1').update(g).digest('hex').slice(0, 8), 16) % 100;
  (h < 60 ? prior.development : prior.validation).push(g);
}
fs.writeFileSync(SPLIT, JSON.stringify(prior, null, 1));
console.log('TIER A SPLIT');
console.log(`  development (rules may be written from these)  ${prior.development.length}`);
console.log(`  validation  (untouched until rules frozen)     ${prior.validation.length}`);
console.log(`  era audit   (${RESERVED_SEASONS.join(', ')}, fully reserved)        ${prior.eraAudit.length}`);
console.log(`  previously inspected -> forced to development  ${prior.inspected.length}`);
console.log(`\n-> ${path.relative(path.join(HIST, '../..'), SPLIT)}`);

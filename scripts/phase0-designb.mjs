// PHASE 0, stage 4 — Design B feasibility. Outcome-blind.
//
// Design B claimed "restriction to structurally forced vacancies removes discretion by construction".
// That claim must be EARNED, not asserted: it holds only if, historically, a starter vacancy really
// does produce a near-deterministic replacement. This measures the determinism directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const S = '/private/tmp/claude-501/-Users-bretttulip-Claude/96101310-d02d-4357-80f4-1d15c74ad9a7/scratchpad';
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
const shocks = JSON.parse(fs.readFileSync(`${S}/shocks.json`, 'utf8'));

// starter tables
const startersOf = new Map();   // gameId|teamId -> Set(playerId)
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'starters_regular.json');
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arr = Array.isArray(j) ? j : [];
  for (const r of arr) {
    if (r.started !== true) continue;
    const k = `${r.gameId}|${r.teamId}`;
    if (!startersOf.has(k)) startersOf.set(k, new Set());
    startersOf.get(k).add(String(r.playerId));
  }
}
const rows = [];
for (const s of SEASONS) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(f)) for (const r of JSON.parse(fs.readFileSync(f, 'utf8')))
    rows.push({ season: s, gameId: r.gameId, gameDate: String(r.gameDate), playerId: String(r.playerId), teamId: String(r.teamId), min: r.min ?? 0 });
}
const teamGames = new Map();
for (const r of rows) {
  const k = `${r.season}|${r.teamId}`;
  if (!teamGames.has(k)) teamGames.set(k, new Map());
  teamGames.get(k).set(r.gameId, r.gameDate);
}
for (const [k, m] of teamGames) teamGames.set(k, [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([g]) => g));

// A shock is a STARTER vacancy if the absent player started >=70% of the prior 10 team games.
let starterVacancies = 0;
const replacementSets = new Map();   // season|team|absent -> [replacement playerId per occurrence]
for (const sh of shocks) {
  const tk = `${sh.season}|${sh.teamId}`;
  const games = teamGames.get(tk) || [];
  const i = games.indexOf(sh.gameId);
  if (i < 10) continue;
  const prior = games.slice(i - 10, i);
  const startedPrior = prior.filter((g) => (startersOf.get(`${g}|${sh.teamId}`) || new Set()).has(sh.playerId)).length;
  if (startedPrior < 7) continue;
  starterVacancies++;
  // who started this game who did NOT usually start?
  const now = startersOf.get(`${sh.gameId}|${sh.teamId}`) || new Set();
  const usual = new Set();
  for (const g of prior) for (const p of (startersOf.get(`${g}|${sh.teamId}`) || new Set())) {
    const c = (usual.get?.(p) || 0);
    usual.add(p);
  }
  const priorStartCount = new Map();
  for (const g of prior) for (const p of (startersOf.get(`${g}|${sh.teamId}`) || new Set())) priorStartCount.set(p, (priorStartCount.get(p) || 0) + 1);
  const newStarters = [...now].filter((p) => (priorStartCount.get(p) || 0) < 5);
  const key = `${sh.season}|${sh.teamId}|${sh.playerId}`;
  if (!replacementSets.has(key)) replacementSets.set(key, []);
  replacementSets.get(key).push(newStarters.length === 1 ? newStarters[0] : (newStarters.length === 0 ? '__NONE__' : '__MULTI__'));
}
console.log('================ PHASE 0, STAGE 4 — DESIGN B FEASIBILITY ================\n');
console.log(`starter vacancies (absent player started >=7 of prior 10): ${starterVacancies}`);
console.log(`distinct (team-season, absent starter) cells: ${replacementSets.size}`);

let single = 0, none = 0, multi = 0, repeat = 0, deterministic = 0;
const detail = [];
for (const [k, arr] of replacementSets) {
  for (const v of arr) { if (v === '__NONE__') none++; else if (v === '__MULTI__') multi++; else single++; }
  if (arr.length >= 2) {
    repeat++;
    const named = arr.filter((v) => v !== '__NONE__' && v !== '__MULTI__');
    if (named.length >= 2) {
      const c = new Map();
      for (const v of named) c.set(v, (c.get(v) || 0) + 1);
      const top = Math.max(...c.values());
      detail.push(top / named.length);
      if (top === named.length) deterministic++;
    }
  }
}
console.log(`\n--- replacement structure per vacancy occurrence ---`);
console.log(`  exactly one new starter: ${single}   no new starter (lineup reshuffled): ${none}   multiple new starters: ${multi}`);
console.log(`  => share of vacancies with a single clean replacement: ${(100 * single / (single + none + multi)).toFixed(1)}%`);
console.log(`\n--- DETERMINISM across repeat vacancies of the SAME absent starter ---`);
console.log(`  cells with >=2 occurrences: ${repeat}`);
console.log(`  cells where the same player replaced him EVERY time: ${deterministic} of ${detail.length} measurable (${detail.length ? (100 * deterministic / detail.length).toFixed(1) : '0'}%)`);
if (detail.length) {
  const d = detail.sort((a, b) => a - b);
  console.log(`  top-replacement share: p25 ${d[Math.floor(0.25 * d.length)].toFixed(2)}  p50 ${d[Math.floor(0.5 * d.length)].toFixed(2)}  p75 ${d[Math.floor(0.75 * d.length)].toFixed(2)}`);
}
console.log('\nVERDICT INPUT: Design B is a clean anchor ONLY if replacement is near-deterministic.');

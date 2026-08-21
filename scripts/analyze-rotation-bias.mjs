// Is GameRotation availability BIASED?
//
// If only a fraction of games return usable rotation data, those games are not automatically a
// random sample. They could cluster by season, era, game type, overtime, event volume or feed
// schema. Training a PBP fallback only on them would then look excellent there and fail precisely
// on the games where GameRotation is missing — which are the games the fallback exists to cover.
//
// So before treating the available set as ground truth, compare available vs unavailable games on
// everything observable. Structured missingness does not disqualify the sample, but it must be
// known so the validation design can account for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const CACHE = path.join(HIST, 'rotation');
const have = new Set(fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')) : []);
const attempted = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Observable characteristics from data we already hold, requiring no further fetching.
const meta = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()) {
  for (const [file, phase] of [['gamelog.json', 'RS'], ['gamelog_playoffs.json', 'PO']]) {
    const f = path.join(HIST, s, file);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      let m = meta.get(r.gameId);
      if (!m) { m = { season: s, phase, date: r.gameDate, players: 0, totalMin: 0, teams: new Set() }; meta.set(r.gameId, m); }
      m.players++; m.totalMin += r.min || 0; m.teams.add(r.team);
    }
  }
}
// Starter-data availability and PBP presence are themselves candidate correlates.
const starterGames = new Set();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  for (const slug of ['regular', 'playoffs']) {
    const f = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) if (r.starterSourceStatus === 'VALID') starterGames.add(r.gameId);
  }
}
const pbpDir = path.join(HIST, 'pbp');
const havePbp = new Set(fs.existsSync(pbpDir) ? fs.readdirSync(pbpDir).map((f) => f.replace('.json', '')) : []);

const rows = attempted.map((g) => {
  const m = meta.get(g) || {};
  return {
    gameId: g, available: have.has(g) ? 1 : 0,
    season: m.season || '?', phase: m.phase || '?',
    // Total player-minutes distinguishes overtime games (>480) from regulation.
    overtime: (m.totalMin || 0) > 490 ? 1 : 0,
    players: m.players || 0,
    hasStarters: starterGames.has(g) ? 1 : 0,
    hasPbp: havePbp.has(g) ? 1 : 0,
    month: (m.date || '').slice(5, 7),
  };
});
const n = rows.length, avail = rows.filter((r) => r.available).length;
console.log(`ROTATION AVAILABILITY BIAS — ${avail}/${n} attempted games available (${(100 * avail / n).toFixed(1)}%)\n`);

const rateBy = (key) => {
  const g = new Map();
  for (const r of rows) {
    const k = r[key];
    const b = g.get(k) || { n: 0, a: 0 };
    b.n++; b.a += r.available; g.set(k, b);
  }
  return [...g.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
};
for (const key of ['season', 'phase', 'overtime', 'hasStarters', 'hasPbp', 'month']) {
  console.log(`by ${key}:`);
  for (const [k, b] of rateBy(key)) {
    if (b.n < 3) continue;
    const pct = 100 * b.a / b.n;
    console.log(`  ${String(k).padEnd(10)} ${String(b.a).padStart(4)}/${String(b.n).padEnd(5)} ${pct.toFixed(0).padStart(4)}%  ${'#'.repeat(Math.round(pct / 5))}`);
  }
  console.log('');
}
// A crude spread test: if availability varies wildly across a category, missingness is structured.
const spread = (key) => {
  const r = rateBy(key).filter(([, b]) => b.n >= 5).map(([, b]) => 100 * b.a / b.n);
  return r.length > 1 ? Math.max(...r) - Math.min(...r) : 0;
};
// Spread is reported as a MAGNITUDE with its sample counts, not as a pass/fail gate. A 29-point
// spread is not meaningfully different from 31, and treating one as acceptable and the other as
// disqualifying would repeat the arbitrary-threshold mistake this project already made twice.
console.log('availability spread (max - min percentage points, cells with n>=5):');
for (const key of ['season', 'phase', 'overtime', 'hasStarters', 'month']) {
  const cells = rateBy(key).filter(([, b]) => b.n >= 5);
  const sp = spread(key);
  const smallest = Math.min(...cells.map(([, b]) => b.n));
  console.log(`  ${key.padEnd(12)} ${sp.toFixed(0).padStart(4)} pts across ${cells.length} cells (smallest n=${smallest})`);
}
console.log('  Interpret with the counts above; no threshold here is a pass/fail rule.');

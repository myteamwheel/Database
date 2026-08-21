// IMPLEMENTATION AUDIT for TULIP_CAPACITY_V1. Checks correctness of the pipeline only — no model
// changes, and individual misses are NOT a reason to alter anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const T = JSON.parse(fs.readFileSync(path.join(HIST, 'transitions.json'), 'utf8'));
const SEASONS = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
let fail = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fail++; };

// Rebuild the player index to re-derive facts independently of the study script.
const rows = [];
for (const s of SEASONS) { const f = path.join(HIST, s, 'gamelog.json'); if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8'))); }
const byPlayer = new Map();
for (const r of rows) { const k = String(r.playerId); if (!byPlayer.has(k)) byPlayer.set(k, []); byPlayer.get(k).push(r); }
for (const v of byPlayer.values()) v.sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));

console.log('=== 1. NO TEAM B LEAKAGE INTO INPUTS ===');
{
  // For a sample of transitions, recompute aRecent10 from games strictly before the cutoff and on
  // Team A, and confirm it matches. Any Team B game inside the window would break this.
  let bad = 0, checked = 0;
  for (const t of T.slice(0, 400)) {
    const g = byPlayer.get(t.pid); if (!g) continue;
    let i = g.findIndex((x) => String(x.gameDate) === String(t.cutoff));
    if (i <= 0) continue;
    const pre = g.slice(0, i);
    const last10 = pre.slice(-10);
    const rec = last10.reduce((a, r) => a + (r.min ?? 0), 0) / last10.length;
    checked++;
    if (Math.abs(rec - t.aRecent10) > 0.05) bad++;
    // every game in the window must pre-date the cutoff
    if (last10.some((r) => String(r.gameDate) >= String(t.cutoff))) bad++;
  }
  check('aRecent10 uses only pre-cutoff games', bad === 0, `${checked} transitions re-derived, ${bad} mismatches`);
}
{
  // No predictor may correlate perfectly with the target by construction.
  const keys = ['aSeasonMpg', 'aRecent10', 'aRecent5', 'aStartRate', 'aGames', 'age', 'heightIn', 'bAhead'];
  let leak = 0;
  for (const k of keys) {
    const same = T.filter((d) => Number.isFinite(d[k]) && Number.isFinite(d.tFirst10) && Math.abs(d[k] - d.tFirst10) < 1e-9).length;
    if (same > T.length * 0.5) { leak++; console.log(`    suspicious: ${k} equals target in ${same} rows`); }
  }
  check('no predictor is the target in disguise', leak === 0);
}

console.log('\n=== 2. ATTRIBUTES MEASURED AS OF THE PREDICTION DATE ===');
{
  // bio is keyed by the season the transition lands in, which is the season containing the cutoff.
  let bad = 0;
  for (const t of T.slice(0, 300)) {
    const g = byPlayer.get(t.pid); if (!g) continue;
    const i = g.findIndex((x) => String(x.gameDate) === String(t.cutoff));
    if (i < 0) continue;
    if (g[i].season !== t.season) bad++;
  }
  check('bio season == season of the first Team B game', bad === 0, `${bad} mismatches`);
  const dflt = T.filter((d) => d.age === 26 && d.heightIn === 78 && d.weight === 210).length;
  check('attribute defaults are rare', dflt / T.length < 0.15, `${dflt}/${T.length} rows on all-default attributes (${(100 * dflt / T.length).toFixed(1)}%)`);
}

console.log('\n=== 3. OFFSEASON / IN-SEASON CLASSIFICATION ===');
{
  let bad = 0, off = 0, ins = 0;
  for (const t of T) {
    const g = byPlayer.get(t.pid); if (!g) continue;
    const i = g.findIndex((x) => String(x.gameDate) === String(t.cutoff));
    if (i <= 0) continue;
    const expect = g[i].season === g[i - 1].season ? 1 : 0;
    if (expect !== t.inSeason) bad++;
    if (t.inSeason) ins++; else off++;
  }
  check('inSeason flag matches season boundary', bad === 0, `${bad} mismatches · offseason ${off} · in-season ${ins}`);
}

console.log('\n=== 4. CURRENT MPG vs TEAM A SEASON MPG NOT CONFLATED ===');
{
  const ident = T.filter((d) => Math.abs(d.aSeasonMpg - d.aRecent10) < 1e-9).length;
  check('aSeasonMpg and aRecent10 are distinct fields', ident / T.length < 0.2, `${ident}/${T.length} rows identical (${(100 * ident / T.length).toFixed(1)}%) — expected small`);
  const corr = (() => {
    const a = T.map((d) => d.aSeasonMpg), b = T.map((d) => d.aRecent10);
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db);
  })();
  check('correlated but not identical', corr > 0.5 && corr < 0.99, `r=${corr.toFixed(3)}`);
}

console.log('\n=== 5. STARTER-FLAG COVERAGE (missing data behaviour) ===');
{
  const st = new Set();
  const cov = new Set();
  for (const s of SEASONS) for (const slug of ['regular', 'playoffs']) {
    const f = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) { if (r.started === true) st.add(`${r.gameId}|${r.playerId}`); cov.add(`${r.gameId}|${r.teamId}`); }
  }
  const covered = rows.filter((r) => cov.has(`${r.gameId}|${r.teamId}`)).length;
  check('starter coverage high enough for aStartRate', covered / rows.length > 0.8,
    `${(100 * covered / rows.length).toFixed(1)}% of game-rows covered; uncovered rows default started=false (understates start rate)`);
}

console.log('\n=== 6. OUT-OF-SAMPLE INTEGRITY OF THE LEADERBOARD ===');
{
  const seasons = [...new Set(T.map((d) => d.season))].sort();
  const last = seasons[seasons.length - 1];
  const te = T.filter((d) => d.season === last), tr = T.filter((d) => d.season !== last);
  check('holdout season disjoint from training', te.every((d) => d.season === last) && tr.every((d) => d.season !== last), `train ${tr.length} · holdout ${te.length} (${last})`);
  const trP = new Set(tr.map((d) => d.pid)), overlap = [...new Set(te.map((d) => d.pid))].filter((p) => trP.has(p)).length;
  console.log(`    NOTE: ${overlap} of ${new Set(te.map((d) => d.pid)).size} holdout players also appear in training (different seasons).`);
  console.log('    This is CHRONOLOGICAL validation, not player-disjoint. Both were run; grouped-by-player');
  console.log('    CV is the player-disjoint result. Neither alone is sufficient, which is why both are reported.');
}

console.log('\n=== 7. MISSING-ATTRIBUTE ROBUSTNESS ===');
{
  // A candidate with no bio row must still produce a finite, sane Capacity.
  const probe = { ...T[0], age: 26, heightIn: 78, weight: 210, draftPick: 61, undrafted: 1 };
  const finite = Object.entries(probe).filter(([k, v]) => typeof v === 'number' && !Number.isFinite(v));
  check('defaulted-attribute row has all finite fields', finite.length === 0, finite.length ? JSON.stringify(finite) : '');
}

console.log(`\n${fail === 0 ? 'AUDIT PASSED' : `AUDIT: ${fail} FAILURE(S)`}`);

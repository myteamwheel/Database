// TULIP CAPACITY LEADERBOARD — untouched chronological holdout (2024-25).
//
// MODEL: P0 — baseline MPG + recent-10 MPG, plus the distributional machinery. The 22 extra
// features (age, height, weight, draft slot, career history, foul rate, availability, team blockage)
// were acquired and tested; they move held-out MAE by 0.016 and the pairwise ranking by 0.0pp, so
// they are NOT carried. Simplest model that preserves held-out performance.
//
// HONEST SCOPE: the pairwise ranking this produces is, to three significant figures, the ranking you
// get from recent-10 MPG alone (64.8% either way). What the model adds is a calibrated MAGNITUDE and
// an uncertainty interval, not a better ordering.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAbsences, buildEpisodes } from './lib/opportunity.mjs';
import { attachStarterFlags } from './lib/starter-flags.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const SEASONS = ['2018-19', '2021-22', '2022-23', '2023-24', '2024-25'];
const ALPHA = 0.5;
const rows = [];
for (const s of SEASONS) { const f = path.join(HIST, s, 'gamelog.json'); if (fs.existsSync(f)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8'))); }
attachStarterFlags(rows, HIST);
const nameOf = new Map(); const byPlayer = new Map();
for (const r of rows) {
  nameOf.set(String(r.playerId), r.playerName);
  const k = String(r.playerId);
  if (!byPlayer.has(k)) byPlayer.set(k, []);
  byPlayer.get(k).push(r);
}
for (const v of byPlayer.values()) v.sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));
function priorMpg(pk, date, n, season) {
  const g = byPlayer.get(pk); if (!g) return null;
  const prior = [];
  for (let i = g.length - 1; i >= 0; i--) {
    if (String(g[i].gameDate) >= String(date)) continue;
    if (season && g[i].season !== season) continue;
    prior.push(g[i]); if (prior.length >= n) break;
  }
  return prior.length ? prior.reduce((a, x) => a + (x.min ?? 0), 0) / prior.length : null;
}
const data = [];
for (const e of buildEpisodes(detectAbsences(rows))) {
  if (!Number.isFinite(e.pre?.preGsPer36)) continue;
  let num = 0, den = 0, w = 1;
  for (let i = e.outcomeRows.length - 1; i >= 0; i--) { num += w * (e.outcomeRows[i].min ?? 0); den += w; w *= 1 - ALPHA; }
  if (!(den > 0)) continue;
  const pk = String(e.playerId);
  const rm = priorMpg(pk, e.openerRow.gameDate, 10, e.season);
  if (rm === null) continue;
  data.push({ baselineMpg: e.baselineMpg, recentMpg: rm, y: num / den, pid: pk,
    season: e.season, nFollow: e.outcomeRows.length, date: e.openerRow.gameDate });
}
const FE = ['baselineMpg', 'recentMpg'];
function fit(train) {
  const m = FE.length + 1; const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const d of train) { const v = [1, ...FE.map((k) => d[k] ?? 0)];
    for (let a = 0; a < m; a++) { for (let b = 0; b < m; b++) A[a][b] += v[a] * v[b]; A[a][m] += v[a] * d.y; } }
  for (let c = 0; c < m; c++) { let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < m; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
  const wts = A.map((r, i) => r[m] / A[i][i]);
  return (d) => wts[0] + FE.reduce((s, k, i) => s + wts[i + 1] * (d[k] ?? 0), 0);
}
const seasons = [...new Set(data.map((d) => d.season))].sort();
const last = seasons[seasons.length - 1];
const tr = data.filter((d) => d.season !== last), te = data.filter((d) => d.season === last);
const f = fit(tr);
const resid = tr.map((d) => d.y - f(d)).sort((a, b) => a - b);
const q = (p) => resid[Math.min(resid.length - 1, Math.max(0, Math.floor(p * resid.length)))];
for (const d of te) { d.cap = f(d); d.hr = d.cap - d.baselineMpg; }

console.log(`TULIP CAPACITY LEADERBOARD — trained ${seasons.slice(0, -1).join(', ')} · UNTOUCHED holdout ${last}`);
console.log(`model: baseline MPG + recent-10 MPG · n=${te.length} episodes\n`);

// Selection rule fixed before inspecting outcomes: >=5 follow-up games so the outcome is measurable.
const U = te.filter((d) => d.nFollow >= 5);
const line = (d) => `  ${(nameOf.get(d.pid) || d.pid).slice(0, 21).padEnd(21)} ${d.baselineMpg.toFixed(1).padStart(5)} ${d.recentMpg.toFixed(1).padStart(6)} ${d.cap.toFixed(1).padStart(6)} ${((d.hr >= 0 ? '+' : '') + d.hr.toFixed(1)).padStart(7)}   ${(d.cap + q(0.25)).toFixed(0)}-${(d.cap + q(0.75)).toFixed(0)}    ${d.y.toFixed(1).padStart(5)} ${((d.y - d.cap >= 0 ? '+' : '') + (d.y - d.cap).toFixed(1)).padStart(6)}`;
const head = '  player                current recent  TULIP headroom   50% int   ACTUAL    err';

console.log('=== TOP HIDDEN-CAPACITY CALLS (largest predicted headroom) ===');
console.log(head);
for (const d of [...U].sort((a, b) => b.hr - a.hr).slice(0, 10)) console.log(line(d));

console.log('\n=== LOW-CAPACITY CALLS (current role at or above capacity) ===');
console.log(head);
for (const d of [...U].sort((a, b) => a.hr - b.hr).slice(0, 10)) console.log(line(d));

console.log('\n=== MAJOR MISSES — TULIP too LOW ===');
console.log(head);
for (const d of [...U].sort((a, b) => (b.y - b.cap) - (a.y - a.cap)).slice(0, 5)) console.log(line(d));
console.log('\n=== MAJOR MISSES — TULIP too HIGH ===');
console.log(head);
for (const d of [...U].sort((a, b) => (a.y - a.cap) - (b.y - b.cap)).slice(0, 5)) console.log(line(d));

console.log('\n=== HEADROOM DECILE CALIBRATION (does the flagged group actually gain?) ===');
{
  const s = [...U].sort((a, b) => b.hr - a.hr);
  const k = Math.floor(s.length / 10);
  const m = (g, fn) => g.reduce((a, x) => a + fn(x), 0) / g.length;
  console.log('  decile   n    current   TULIP   ACTUAL   actual-current');
  for (let i = 0; i < 10; i++) {
    const g = s.slice(i * k, (i + 1) * k);
    if (g.length < 5) continue;
    console.log(`  ${String(i + 1).padStart(4)}  ${String(g.length).padStart(4)}    ${m(g, (x) => x.baselineMpg).toFixed(1).padStart(5)}   ${m(g, (x) => x.cap).toFixed(1).padStart(5)}   ${m(g, (x) => x.y).toFixed(1).padStart(5)}   ${((m(g, (x) => x.y) - m(g, (x) => x.baselineMpg) >= 0 ? '+' : '') + (m(g, (x) => x.y) - m(g, (x) => x.baselineMpg)).toFixed(1)).padStart(6)}`);
  }
}

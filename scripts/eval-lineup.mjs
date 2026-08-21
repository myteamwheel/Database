// Evaluate the team-level reconstructor against GameRotation ground truth.
//
// Reports the DOWNSTREAM FEATURES separately rather than collapsing everything into one minute
// error. A parser can be off on totals while reconstructing early rotation perfectly, or nail
// totals and get the timing wrong — and Assigned Workload depends on the timing.
//
// Development and validation sets are honoured strictly: `--set validation` must only be run on a
// frozen rule version, and any validation game whose disagreement is inspected moves permanently to
// development.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconstructTeam } from './lib/lineup.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const which = (process.argv.find((a) => a.startsWith('--set=')) || '--set=development').split('=')[1];
const split = JSON.parse(fs.readFileSync(path.join(HIST, 'tier_a_split.json'), 'utf8'));
const target = new Set(which === 'validation' ? split.validation : which === 'era' ? split.eraAudit : split.development);

const roster = new Map();   // gameId|teamId -> [{playerId, playerName, started}]
const box = new Map();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()) {
  const gl = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(gl)) for (const r of JSON.parse(fs.readFileSync(gl, 'utf8'))) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!roster.has(k)) roster.set(k, []);
    roster.get(k).push({ playerId: r.playerId, playerName: r.playerName, started: false });
    if (r.min > 0) box.set(`${r.gameId}|${r.playerId}`, r.min);
  }
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) {
      if (r.started !== true) continue;
      const list = roster.get(`${r.gameId}|${r.teamId}`) || [];
      const p = list.find((x) => x.playerId === r.playerId);
      if (p) p.started = true;
    }
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const acc = {
  openingFive: [0, 0], q2Open: [0, 0], q3Open: [0, 0], secondHalfOpen: [0, 0],
  firstEntry: [], firstExit: [], firstStintLen: [], firstHalfMin: [], stintCount: [0, 0],
  totalMin: [], otHandled: [0, 0],
};
let games = 0, unresolvedTotal = 0, players = 0;
for (const fn of fs.readdirSync(path.join(HIST, 'rotation')).filter((f) => f.endsWith('.json'))) {
  const gid = fn.replace('.json', '');
  if (!target.has(gid)) continue;
  const pbpFile = path.join(HIST, 'pbp', `${gid}.json`);
  if (!fs.existsSync(pbpFile)) continue;
  const rot = JSON.parse(fs.readFileSync(path.join(HIST, 'rotation', fn), 'utf8'));
  const pbp = JSON.parse(fs.readFileSync(pbpFile, 'utf8'));
  games++;
  const truthByTeam = new Map();
  for (const s of rot.stints) {
    const k = `${s.teamId}`;
    if (!truthByTeam.has(k)) truthByTeam.set(k, new Map());
    const m = truthByTeam.get(k);
    if (!m.has(s.personId)) m.set(s.personId, []);
    m.get(s.personId).push({ start: s.inT / 10, end: s.outT / 10 });   // tenths -> seconds
  }
  for (const [teamId, truth] of truthByTeam) {
    const list = roster.get(`${gid}|${teamId}`);
    if (!list) continue;
    const { byPlayer, unresolved } = reconstructTeam(pbp, teamId, list);
    unresolvedTotal += unresolved.length;

    const truthOpen = [...truth.entries()].filter(([, ss]) => ss.some((s) => s.start < 1)).map(([id]) => id).sort();
    const reconOpen = [...byPlayer.entries()].filter(([, ss]) => ss.some((s) => s.start < 1)).map(([id]) => id).sort();
    acc.openingFive[1]++; if (JSON.stringify(truthOpen) === JSON.stringify(reconOpen)) acc.openingFive[0]++;

    for (const [label, at] of [['q2Open', 720], ['q3Open', 1440], ['secondHalfOpen', 1440]]) {
      const T = [...truth.entries()].filter(([, ss]) => ss.some((s) => s.start <= at + 2 && s.end > at + 2)).map(([id]) => id).sort();
      const R = [...byPlayer.entries()].filter(([, ss]) => ss.some((s) => s.start <= at + 2 && s.end > at + 2)).map(([id]) => id).sort();
      acc[label][1]++; if (JSON.stringify(T) === JSON.stringify(R)) acc[label][0]++;
    }
    for (const [pid, ts] of truth) {
      const rs = byPlayer.get(pid) || [];
      if (!rs.length) continue;
      players++;
      ts.sort((a, b) => a.start - b.start); rs.sort((a, b) => a.start - b.start);
      acc.firstEntry.push(Math.abs(ts[0].start - rs[0].start) / 60);
      acc.firstExit.push(Math.abs(ts[0].end - rs[0].end) / 60);
      acc.firstStintLen.push(Math.abs((ts[0].end - ts[0].start) - (rs[0].end - rs[0].start)) / 60);
      const half = (ss) => ss.reduce((a, s) => a + Math.max(0, Math.min(s.end, 1440) - Math.min(s.start, 1440)), 0) / 60;
      acc.firstHalfMin.push(Math.abs(half(ts) - half(rs)));
      acc.stintCount[1]++; if (ts.length === rs.length) acc.stintCount[0]++;
      const tot = (ss) => ss.reduce((a, s) => a + (s.end - s.start), 0) / 60;
      acc.totalMin.push(Math.abs(tot(ts) - tot(rs)));
      if ((rot.stints.some((s) => s.outT / 10 > 2880))) { acc.otHandled[1]++; if (Math.abs(tot(ts) - tot(rs)) < 1) acc.otHandled[0]++; }
    }
  }
}
const pct = ([a, b]) => (b ? `${(100 * a / b).toFixed(1)}% (${a}/${b})` : 'n/a');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const within = (a, t) => (a.length ? `${(100 * a.filter((x) => x <= t).length / a.length).toFixed(1)}%` : 'n/a');
console.log(`TEAM-LEVEL RECONSTRUCTION — set=${which} · ${games} games · ${players} player-games`);
console.log(`unresolved substitution events: ${unresolvedTotal}\n`);
console.log('feature                     accuracy / error');
console.log(`  opening five              ${pct(acc.openingFive)}`);
console.log(`  Q2 opening lineup         ${pct(acc.q2Open)}`);
console.log(`  Q3 opening lineup         ${pct(acc.q3Open)}`);
console.log(`  second-half opening       ${pct(acc.secondHalfOpen)}`);
console.log(`  stint count exact         ${pct(acc.stintCount)}`);
console.log(`  OT games total within 1m  ${pct(acc.otHandled)}`);
console.log(`  first entry   mean ${mean(acc.firstEntry).toFixed(2)}m · within 0.5m ${within(acc.firstEntry, 0.5)}`);
console.log(`  first exit    mean ${mean(acc.firstExit).toFixed(2)}m · within 0.5m ${within(acc.firstExit, 0.5)}`);
console.log(`  first stint   mean ${mean(acc.firstStintLen).toFixed(2)}m · within 0.5m ${within(acc.firstStintLen, 0.5)}`);
console.log(`  first-half min mean ${mean(acc.firstHalfMin).toFixed(2)}m · within 0.5m ${within(acc.firstHalfMin, 0.5)}`);
console.log(`  total minutes mean ${mean(acc.totalMin).toFixed(2)}m · within 1m ${within(acc.totalMin, 1)}`);

// Stratified re-read of the SAME frozen-v1 evaluation, split by whether official starter data exists.
//
// The headline 61.8% opening-five accuracy was not a reconstruction failure. lineup.mjs seeds the
// opening lineup from roster `started` flags; where starters_*.json has no rows for a team-game that
// seed is EMPTY, so the opening five cannot be right. A wrong opening lineup then mechanically
// corrupts first-entry and first-half timing for that team-game.
//
// No rules change here. This only reports the existing frozen result against a stratum that was
// being pooled.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconstructTeam } from './lib/lineup.mjs';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const split = JSON.parse(fs.readFileSync(path.join(HIST, 'tier_a_split.json'), 'utf8'));
const games = split[process.argv[2]?.replace('--set=', '') || 'validation'] || [];

const roster = new Map(), hasOfficial = new Set();
for (const s of fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
  const gf = path.join(HIST, s, 'gamelog.json');
  if (fs.existsSync(gf)) for (const r of JSON.parse(fs.readFileSync(gf, 'utf8'))) {
    const k = `${r.gameId}|${r.teamId}`;
    if (!roster.has(k)) roster.set(k, []);
    roster.get(k).push({ playerId: r.playerId, playerName: r.playerName, started: false });
  }
  for (const slug of ['regular', 'playoffs']) {
    const sf = path.join(HIST, s, `starters_${slug}.json`);
    if (!fs.existsSync(sf)) continue;
    for (const r of JSON.parse(fs.readFileSync(sf, 'utf8'))) {
      if (r.started !== true) continue;
      const k = `${r.gameId}|${r.teamId}`;
      hasOfficial.add(k);
      const p = (roster.get(k) || []).find((x) => x.playerId === r.playerId);
      if (p) p.started = true;
    }
  }
}

const mk = () => ({ openFive: [0, 0], q2: [0, 0], firstEntry: [], firstExit: [], firstStint: [], firstHalf: [], total: [] });
const strat = { withStarters: mk(), withoutStarters: mk() };

for (const gid of games) {
  const rf = path.join(HIST, 'rotation', `${gid}.json`), pf = path.join(HIST, 'pbp', `${gid}.json`);
  if (!fs.existsSync(rf) || !fs.existsSync(pf)) continue;
  const rot = JSON.parse(fs.readFileSync(rf, 'utf8'));
  const pbp = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const truthByTeam = new Map();
  for (const s of rot.stints) {
    if (!truthByTeam.has(`${s.teamId}`)) truthByTeam.set(`${s.teamId}`, new Map());
    const m = truthByTeam.get(`${s.teamId}`);
    if (!m.has(s.personId)) m.set(s.personId, []);
    m.get(s.personId).push({ start: s.inT / 10, end: s.outT / 10 });
  }
  for (const [teamId, truth] of truthByTeam) {
    const key = `${gid}|${teamId}`;
    const list = roster.get(key);
    if (!list) continue;
    const a = hasOfficial.has(key) ? strat.withStarters : strat.withoutStarters;
    const { byPlayer } = reconstructTeam(pbp, teamId, list);
    const T0 = [...truth.entries()].filter(([, ss]) => ss.some((s) => s.start < 1)).map(([id]) => id).sort();
    const R0 = [...byPlayer.entries()].filter(([, ss]) => ss.some((s) => s.start < 1)).map(([id]) => id).sort();
    a.openFive[1]++; if (JSON.stringify(T0) === JSON.stringify(R0)) a.openFive[0]++;
    const T2 = [...truth.entries()].filter(([, ss]) => ss.some((s) => s.start <= 722 && s.end > 722)).map(([id]) => id).sort();
    const R2 = [...byPlayer.entries()].filter(([, ss]) => ss.some((s) => s.start <= 722 && s.end > 722)).map(([id]) => id).sort();
    a.q2[1]++; if (JSON.stringify(T2) === JSON.stringify(R2)) a.q2[0]++;
    for (const [pid, ts] of truth) {
      const rs = byPlayer.get(pid) || [];
      if (!rs.length) continue;
      ts.sort((x, y) => x.start - y.start); rs.sort((x, y) => x.start - y.start);
      a.firstEntry.push(Math.abs(ts[0].start - rs[0].start) / 60);
      a.firstExit.push(Math.abs(ts[0].end - rs[0].end) / 60);
      a.firstStint.push(Math.abs((ts[0].end - ts[0].start) - (rs[0].end - rs[0].start)) / 60);
      const half = (ss) => ss.reduce((x, s) => x + Math.max(0, Math.min(s.end, 1440) - Math.min(s.start, 1440)), 0) / 60;
      a.firstHalf.push(Math.abs(half(ts) - half(rs)));
      const tot = (ss) => ss.reduce((x, s) => x + (s.end - s.start), 0) / 60;
      a.total.push(Math.abs(tot(ts) - tot(rs)));
    }
  }
}
const pct = ([a, b]) => (b ? `${(100 * a / b).toFixed(1)}% (${a}/${b})` : 'n/a');
const mean = (x) => (x.length ? (x.reduce((a, b) => a + b, 0) / x.length).toFixed(2) : 'n/a');
const within = (x, t) => (x.length ? `${(100 * x.filter((v) => v <= t).length / x.length).toFixed(1)}%` : 'n/a');
for (const [name, a] of Object.entries(strat)) {
  console.log(`\n=== ${name} · ${a.openFive[1]} team-games · ${a.firstEntry.length} player-games ===`);
  console.log(`  opening five      ${pct(a.openFive)}`);
  console.log(`  Q2 opening        ${pct(a.q2)}`);
  console.log(`  first entry       mean ${mean(a.firstEntry)}m · within 0.5m ${within(a.firstEntry, 0.5)}`);
  console.log(`  first exit        mean ${mean(a.firstExit)}m · within 0.5m ${within(a.firstExit, 0.5)}`);
  console.log(`  first stint       mean ${mean(a.firstStint)}m · within 0.5m ${within(a.firstStint, 0.5)}`);
  console.log(`  first-half min    mean ${mean(a.firstHalf)}m · within 0.5m ${within(a.firstHalf, 0.5)}`);
  console.log(`  total minutes     mean ${mean(a.total)}m · within 1m ${within(a.total, 1)}`);
}

// Deep sanity check of the v3.4 grade. Explains the diagnostics rather than optimising them:
// a per-game grade SHOULD correlate with minutes, and big men SHOULD out-rebound guards. The
// question is whether any of it is accidental role bias on top of the expected signal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INGREDIENTS, COMPONENT_WEIGHTS, MIN_COVERAGE, buildGrade } from './lib/grades.mjs';
import { normalize } from './lib/metrics.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const prev = process.argv[2] && fs.existsSync(process.argv[2])
  ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) : 0; };
function pearson(xs, ys) {
  const p = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => fin(a) && fin(b));
  if (p.length < 3) return null;
  const xa = p.map((q) => q[0]), ya = p.map((q) => q[1]);
  const mx = mean(xa), my = mean(ya), s = sd(xa) * sd(ya);
  return s ? mean(p.map(([a, b]) => (a - mx) * (b - my))) / s : null;
}
/** Correlation of x and y after linearly removing z from both. */
function partial(xs, ys, zs) {
  const rxy = pearson(xs, ys), rxz = pearson(xs, zs), ryz = pearson(ys, zs);
  if ([rxy, rxz, ryz].some((v) => v === null)) return null;
  const den = Math.sqrt((1 - rxz ** 2) * (1 - ryz ** 2));
  return den ? (rxy - rxz * ryz) / den : null;
}

console.log('='.repeat(80));
console.log('v3.4 MODEL SANITY CHECK — explain, do not optimise');
console.log('='.repeat(80));

for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = d.leagues[lg].filter((p) => p.appeared);
  console.log(`\n${'#'.repeat(80)}\n${lg}  n=${arr.length}\n${'#'.repeat(80)}`);

  const grade = arr.map((p) => p.grade);
  const mpg = arr.map((p) => p.mpg);
  const minutes = arr.map((p) => p.minutes);
  const gp = arr.map((p) => p.gp);
  const pts = arr.map((p) => p.pts);
  const rel = arr.map((p) => p.reliabilityWeight);

  console.log('\n--- 1. minutes correlation, decomposed ---');
  console.log(`  grade ~ MPG            r = ${pearson(mpg, grade).toFixed(3)}`);
  console.log(`  grade ~ total minutes  r = ${pearson(minutes, grade).toFixed(3)}`);
  console.log(`  grade ~ games played   r = ${pearson(gp, grade).toFixed(3)}`);
  console.log(`  rateGrade ~ MPG        r = ${pearson(mpg, arr.map((p) => p.rateGrade)).toFixed(3)}`);
  console.log(`  magnitude ~ MPG        r = ${pearson(mpg, arr.map((p) => p.magnitudeGrade)).toFixed(3)}`);
  console.log(`  PTS ~ MPG              r = ${pearson(mpg, pts).toFixed(3)}   <- the production/opportunity link itself`);
  console.log(`  grade ~ MPG | PTS      partial r = ${partial(mpg, grade, pts).toFixed(3)}   <- minutes effect NOT explained by scoring`);
  console.log(`  grade ~ total min | MPG partial r = ${partial(minutes, grade, mpg).toFixed(3)}   <- durability effect beyond role size`);
  console.log(`  grade ~ reliability    r = ${pearson(rel, grade).toFixed(3)}`);
  console.log(`  grade ~ reliability | MPG partial r = ${partial(rel, grade, mpg).toFixed(3)}   <- shrinkage effect beyond role`);

  // Same correlation measured on the raw per-game composite BEFORE shrinkage.
  console.log(`  pre-shrinkage composite ~ MPG r = ${pearson(mpg, arr.map((p) => p.gradeRaw)).toFixed(3)}`);
  console.log(`  post-shrinkage grade    ~ MPG r = ${pearson(mpg, grade).toFixed(3)}`);

  console.log('\n--- 2. position ---');
  const byFam = {}, byPrimary = {};
  arr.forEach((p) => {
    if (p.positionFamily) (byFam[p.positionFamily] = byFam[p.positionFamily] || []).push(p);
    const prim = (p.position || '').split('-')[0];
    if (prim) (byPrimary[prim] = byPrimary[prim] || []).push(p);
  });
  const show = (obj, label) => {
    console.log(`  by ${label}:`);
    Object.entries(obj).filter(([, v]) => v.length >= 8)
      .map(([k, v]) => [k, v.length, mean(v.map((p) => p.grade)), mean(v.map((p) => p.mpg))])
      .sort((a, b) => b[2] - a[2])
      .forEach(([k, n, g, m]) => console.log(`     ${k.padEnd(6)} n=${String(n).padStart(3)}  grade ${g.toFixed(2)}  mpg ${m.toFixed(1)}`));
  };
  show(byFam, 'G/F/C eligibility');
  show(byPrimary, 'primary listed position');
  // Which component drives the gap?
  console.log('  component means by family:');
  const comps = Object.keys(COMPONENT_WEIGHTS);
  console.log('           ' + comps.map((c) => c.slice(0, 6).padStart(8)).join(''));
  for (const [fam, list] of Object.entries(byFam)) {
    if (list.length < 8) continue;
    console.log('    ' + fam.padEnd(6) + comps.map((c) =>
      (mean(list.map((p) => p.components?.[c]).filter(fin)) ?? 0).toFixed(1).padStart(8)).join(''));
  }
  // Same check with minutes held constant.
  const famDummy = (f) => arr.map((p) => (p.positionFamily === f ? 1 : 0));
  for (const f of ['C', 'G']) {
    const r = pearson(famDummy(f), grade), rp = partial(famDummy(f), grade, mpg);
    console.log(`  being ${f}: r with grade ${r.toFixed(3)}, holding MPG constant ${rp.toFixed(3)}`);
  }

  console.log('\n--- 3. age, year by year ---');
  const byAge = {};
  arr.forEach((p) => { const a = p.ageOpeningNight ?? p.age; if (a != null) (byAge[a] = byAge[a] || []).push(p); });
  Object.keys(byAge).map(Number).sort((a, b) => a - b).forEach((a) => {
    const l = byAge[a];
    if (l.length < 5) return;
    console.log(`     age ${String(a).padStart(2)}  n=${String(l.length).padStart(3)}  grade ${mean(l.map((p) => p.grade)).toFixed(2)}  mpg ${mean(l.map((p) => p.mpg)).toFixed(1)}`);
  });
  console.log(`  grade ~ age            r = ${pearson(arr.map((p) => p.ageOpeningNight ?? p.age), grade).toFixed(3)}`);
  console.log(`  grade ~ age | MPG      partial r = ${partial(arr.map((p) => p.ageOpeningNight ?? p.age), grade, mpg).toFixed(3)}`);

  console.log('\n--- 4. ingredient-weight sensitivity (+/-20% on each component) ---');
  const base = new Map(arr.map((p) => [p.playerId, p.grade]));
  const rank = (m) => { const s = [...m.entries()].sort((a, b) => b[1] - a[1]); const r = new Map();
    s.forEach(([id], i) => r.set(id, i + 1)); return r; };
  const baseRank = rank(base);
  const norm = arr.map((p) => p._normCache).filter(Boolean);
  console.log('    component      +20% rho   -20% rho   max rank move');
  for (const comp of comps) {
    const results = [];
    for (const mult of [1.2, 0.8]) {
      const w = { ...COMPONENT_WEIGHTS, [comp]: COMPONENT_WEIGHTS[comp] * mult };
      const tot = Object.values(w).reduce((a, v) => a + v, 0);
      const nw = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / tot]));
      // The baseline grade is SHRUNK, so the alternative must be shrunk with the same K and the
      // same minutes-weighted prior. Comparing a shrunk baseline against an unshrunk alternative
      // measures the shrinkage, not the weight change — an earlier version of this test did
      // exactly that and reported a misleadingly low rho.
      const rawAlt = arr.map((p) => {
        let acc = 0, ws = 0;
        for (const [c, weight] of Object.entries(nw)) {
          const v = p.components?.[c];
          if (!fin(v)) continue;
          acc += v * weight; ws += weight;
        }
        return ws ? acc / ws : null;
      });
      const K = d.gradeModel.shrinkage[lg].K;
      const mins = arr.map((p) => p.minutes || 0);
      const totMin = mins.reduce((a, v) => a + v, 0);
      const prior = totMin ? rawAlt.reduce((a, v, i) => a + (fin(v) ? v * mins[i] : 0), 0) / totMin : 50;
      const alt = new Map(arr.map((p, i) => [p.playerId,
        fin(rawAlt[i]) ? (mins[i] * rawAlt[i] + K * prior) / (mins[i] + K) : -Infinity]));
      const ar = rank(alt);
      const ids = [...base.keys()];
      let d2 = 0, maxMove = 0;
      for (const id of ids) {
        const delta = baseRank.get(id) - ar.get(id);
        d2 += delta * delta; maxMove = Math.max(maxMove, Math.abs(delta));
      }
      const n = ids.length;
      results.push({ rho: 1 - (6 * d2) / (n * (n * n - 1)), maxMove });
    }
    console.log(`    ${comp.padEnd(13)} ${results[0].rho.toFixed(4)}    ${results[1].rho.toFixed(4)}    ${Math.max(results[0].maxMove, results[1].maxMove)}`);
  }

  if (prev && prev.leagues?.[lg]) {
    console.log('\n--- 5. largest movers, component by component ---');
    const old = new Map(prev.leagues[lg].filter((p) => fin(p.grade)).map((p) => [p.playerId, p]));
    const both = arr.filter((p) => old.has(p.playerId));
    const oldRank = new Map([...old.values()].filter((p) => fin(p.grade))
      .sort((a, b) => b.grade - a.grade).map((p, i) => [p.playerId, i + 1]));
    const newRank = new Map(both.slice().sort((a, b) => b.grade - a.grade).map((p, i) => [p.playerId, i + 1]));
    const moves = both.map((p) => ({ p, o: old.get(p.playerId), delta: oldRank.get(p.playerId) - newRank.get(p.playerId) }))
      .filter((m) => fin(m.delta));
    const explain = (m) => {
      const diffs = comps.map((c) => ({ c, now: m.p.components?.[c], was: m.o.components?.[c] }))
        .filter((x) => fin(x.now) && fin(x.was))
        .map((x) => ({ ...x, d: x.now - x.was }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      return diffs.slice(0, 3).map((x) => `${x.c} ${x.was.toFixed(0)}->${x.now.toFixed(0)}`).join('  ');
    };
    const line = (m) => `    ${(m.delta > 0 ? '+' : '') + String(m.delta).padStart(5)}  ${m.p.name.padEnd(23)}` +
      `${String(m.p.gp).padStart(3)}gp ${String(m.p.mpg).padStart(5)}mpg  ${explain(m)}`;
    console.log('  RISERS');
    moves.sort((a, b) => b.delta - a.delta).slice(0, 15).forEach((m) => console.log(line(m)));
    console.log('  FALLERS');
    moves.sort((a, b) => a.delta - b.delta).slice(0, 15).forEach((m) => console.log(line(m)));

    if (lg === 'NBA') {
      const cam = moves.find((m) => /Camara/.test(m.p.name));
      if (cam) {
        console.log('\n--- 6. Toumani Camara, in detail ---');
        console.log(`  rank ${oldRank.get(cam.p.playerId)} -> ${newRank.get(cam.p.playerId)}  (${cam.delta > 0 ? '+' : ''}${cam.delta})`);
        console.log(`  grade ${cam.o.grade} -> ${cam.p.grade}   ${cam.p.gp}gp ${cam.p.mpg}mpg`);
        console.log('  component  was -> now');
        comps.forEach((c) => {
          const w = cam.o.components?.[c], n = cam.p.components?.[c];
          if (fin(w) && fin(n)) console.log(`    ${c.padEnd(12)} ${w.toFixed(1).padStart(6)} -> ${n.toFixed(1).padStart(6)}   (${(n - w >= 0 ? '+' : '') + (n - w).toFixed(1)})`);
        });
        console.log(`  his line: ${cam.p.pts} pts, ${cam.p.reb} reb, ${cam.p.ast} ast, ${cam.p.stl} stl, ${cam.p.blk} blk, TS ${cam.p.ts}, USG ${cam.p.usg}`);
      }
    }
  }
}
console.log('');

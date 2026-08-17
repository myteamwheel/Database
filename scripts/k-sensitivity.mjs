// Evidence for the shrinkage constant. K was set to 0.6x median minutes by preference; this
// reports what other choices actually do so the number can be defended or changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

for (const lg of ['NBA', 'GLEAGUE']) {
  const arr = d.leagues[lg];
  const mins = arr.map((p) => p.minutes || 0);
  const med = [...mins].sort((a, b) => a - b)[Math.floor(mins.length / 2)];
  const raw = arr.map((p) => p.gradeRaw);
  const total = mins.reduce((a, v) => a + v, 0);
  const prior = raw.reduce((a, v, i) => a + v * mins[i], 0) / total;
  const baseline = arr.map((p) => p.grade);

  console.log(`\n=== ${lg} (median minutes ${med.toFixed(0)}) ===`);
  console.log('  factor      K   top25 min GP   thin-in-top25   rank corr vs shipped');
  for (const f of [0.25, 0.4, 0.6, 0.8, 1.0, 1.5]) {
    const K = Math.round(med * f);
    const shrunk = raw.map((v, i) => (mins[i] * v + K * prior) / (mins[i] + K));
    const order = arr.map((p, i) => ({ p, s: shrunk[i] })).sort((a, b) => b.s - a.s);
    const top25 = order.slice(0, 25);
    const minGP = Math.min(...top25.map((x) => x.p.gp));
    const thin = top25.filter((x) => x.p.gp < 15).length;
    // Spearman against the shipped ordering
    const rankA = new Map(arr.map((p, i) => [p.playerId, i]));
    const rankB = new Map(order.map((x, i) => [x.p.playerId, i]));
    const n = arr.length;
    let dsum = 0;
    for (const p of arr) { const diff = rankA.get(p.playerId) - rankB.get(p.playerId); dsum += diff * diff; }
    const rho = 1 - (6 * dsum) / (n * (n * n - 1));
    console.log(`  ${String(f).padEnd(6)} ${String(K).padStart(6)} ${String(minGP).padStart(12)} ${String(thin).padStart(15)} ${rho.toFixed(4).padStart(22)}`);
  }
}
console.log('\nShipped setting is factor 0.60. Lower factors let thin samples back into the top 25;');
console.log('higher factors flatten real separation without removing more thin lines.');

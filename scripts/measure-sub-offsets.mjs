// Empirical timestamp offsets for simultaneous substitutions.
//
// Replaces the arbitrary 3-second slack in the five-on-floor conservation check. When several
// players change together the feed records them microseconds or tenths apart, and the validator
// must tolerate exactly that much — no more. A gate that knowingly permits three seconds of
// impossible 4- or 6-man lineups is not a gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const dir = path.join(HIST, 'rotation');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!files.length) { console.log('no rotation games cached yet'); process.exit(0); }

const spans = [];
for (const fn of files) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
  for (const t of new Set(rec.stints.map((s) => s.teamId))) {
    const ev = [];
    for (const s of rec.stints.filter((x) => x.teamId === t)) { ev.push([s.inT, 1]); ev.push([s.outT, -1]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let on = 0, prev = null;
    for (const [tt, d] of ev) {
      if (prev !== null && tt > prev && on !== 5 && on !== 0) spans.push({ len: tt - prev, on });
      on += d; prev = tt;
    }
  }
}
spans.sort((a, b) => a.len - b.len);
const q = (p) => spans[Math.floor((spans.length - 1) * p)]?.len ?? 0;
console.log(`SIMULTANEOUS-SUBSTITUTION OFFSETS — ${files.length} games, ${spans.length} off-five spans\n`);
console.log('percentile   tenths   seconds');
for (const p of [0.5, 0.9, 0.99, 0.999, 1]) {
  console.log(`  ${String(p * 100).padStart(6)}%   ${String(q(p)).padStart(6)}   ${(q(p) / 10).toFixed(2)}`);
}
const hist = {};
for (const s of spans) {
  const k = s.len <= 1 ? '<=0.1s' : s.len <= 5 ? '0.2-0.5s' : s.len <= 10 ? '0.6-1.0s' : s.len <= 30 ? '1-3s' : '>3s';
  hist[k] = (hist[k] || 0) + 1;
}
console.log('\ndistribution:', JSON.stringify(hist));
console.log(`\nSuggested tolerance = 99.9th percentile = ${q(0.999)} tenths (${(q(0.999) / 10).toFixed(2)}s),`);
console.log('derived from the data rather than chosen. Spans beyond it are real lineup gaps,');
console.log('not recording artefacts, and should fail the conservation check.');

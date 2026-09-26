// 2026-27 projection: data and formula checks. No browser.
//   node tests/projection.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildProjections } from '../scripts/build-projections.mjs';
import { perGameLine, ageLookup, projectRates, seasonPriors, prepare, AGE_MIN, RATE_STATS } from '../scripts/lib/projection.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawInputs = fs.readFileSync(path.join(ROOT, 'scripts/data/projection/inputs.json'));
const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'PROJECTION_2026_27.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

// 1. The card was fitted on exactly the committed inputs.
check('card matches the committed inputs file',
  card.builtFrom.sha256 === crypto.createHash('sha256').update(rawInputs).digest('hex'));

// 2. Rebuilding from inputs + card reproduces every committed projection, value for value.
{
  const copy = JSON.parse(JSON.stringify(data));
  buildProjections(copy, rawInputs, card);
  let diff = 0, first = '';
  for (const lg of ['NBA', 'GLEAGUE']) {
    data.leagues[lg].forEach((p, i) => {
      if (JSON.stringify(p.proj) !== JSON.stringify(copy.leagues[lg][i].proj)) { diff++; first ||= `${lg} ${p.name}`; }
    });
  }
  check('rebuild reproduces the committed projections exactly', diff === 0, `${diff} differ, first ${first}`);
}

// 3. Every player has a projection or an explicit, explained abstention. Never silently missing.
for (const lg of ['NBA', 'GLEAGUE']) {
  const missing = data.leagues[lg].filter((p) => !p.proj || (p.proj.abstain && !p.proj.reason));
  check(`${lg}: every player has a projection or a stated reason`, missing.length === 0, missing.slice(0, 3).map((p) => p.name).join(', '));
  const played = data.leagues[lg].filter((p) => p.appeared && p.minutes > 0);
  const abst = played.filter((p) => p.proj?.abstain);
  check(`${lg}: everyone who played in 2025-26 is projected`, abst.length === 0, abst.slice(0, 3).map((p) => p.name).join(', '));
}

// 4. Every projected line is physically possible and internally consistent.
for (const lg of ['NBA', 'GLEAGUE']) {
  const games = lg === 'NBA' ? 82 : 50;
  const bad = [];
  for (const p of data.leagues[lg]) {
    const c = p.proj;
    if (!c || c.abstain) continue;
    const probs = [];
    if (!(c.gp > 0 && c.gp <= games)) probs.push(`gp ${c.gp}`);
    if (!(c.mpg >= 1 && c.mpg <= 42)) probs.push(`mpg ${c.mpg}`);
    for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fg3m']) if (!(c[k] >= 0)) probs.push(`${k} ${c[k]}`);
    for (const k of ['fgPct', 'fg3Pct', 'ftPct', 'ts']) if (!(c[k] > 0 && c[k] < 1)) probs.push(`${k} ${c[k]}`);
    if (!(c.ptsLo <= c.pts + 0.05 && c.pts <= c.ptsHi + 0.05)) probs.push(`pts range ${c.ptsLo}-${c.ptsHi} vs ${c.pts}`);
    if (Math.abs(c.reb - c.oreb - c.dreb) > 0.15) probs.push('reb != oreb + dreb');
    if (c.fg3m > c.fg3a * 1.0 + 0.05) probs.push('3PM > 3PA');
    if (probs.length) bad.push(`${p.name}: ${probs.join('; ')}`);
  }
  check(`${lg}: every projected line is possible and consistent`, bad.length === 0, bad.slice(0, 3).join(' | '));
}

// 5. The formula's points identity, including the G League's single free throw worth the trip.
{
  const rate = { fga: 20, fg3a: 8, fta: 6, oreb: 1, dreb: 4, ast: 5, stl: 1, blk: 0.5, tov: 2, pf: 2 };
  const pct = { fg2: 0.55, fg3: 0.36, ft: 0.8 };
  const nba = perGameLine(rate, pct, 36, 70, 100, 1);
  const f = (36 * 100) / 48 / 100;
  const expect = (2 * 12 * 0.55 + 3 * 8 * 0.36 + 6 * 0.8) * f;
  check('per-game points = 2 x 2PM + 3 x 3PM + FTM', Math.abs(nba.pts - expect) < 1e-9);
  const gl = perGameLine(rate, pct, 36, 40, 100, 1.67);
  check('G League free throws count at the league points-per-make', Math.abs(gl.pts - nba.pts - 6 * 0.8 * f * 0.67) < 1e-9);
}

// 6. With no possessions of his own a player's rate is exactly the (scaled) position norm.
{
  const D = prepare(JSON.parse(rawInputs));
  const pri = seasonPriors(D.nba.seasons.get('2025-26'), D.bio);
  const P = card.nba.params;
  const empty = { pid: -1, poss: 0, min: 0, gp: 0, age: 26 };
  for (const k of RATE_STATS) empty[k] = 0;
  Object.assign(empty, { fg2m: 0, fg2a: 0, fg3m: 0, ftm: 0 });
  const zeroAge = { ...P, age: Object.fromEntries(Object.keys(P.age).map((k) => [k, null])), exp: {}, trendShare: 0 };
  const pr = projectRates([empty, null, null], '2026-27', { big: 1 }, pri, zeroAge, null);
  const ok = RATE_STATS.every((k) => Math.abs(pr.rate[k] - pri.at(1)[k] * P.m[k]) < 1e-9);
  check('zero history returns the position norm (x its fitted scale)', ok);
  check('age table interpolates between whole ages',
    Math.abs(ageLookup([0, 0.1, 0.2], AGE_MIN + 0.5) - 0.05) < 1e-12 && ageLookup(null, 30) === 0);
}

// 7. The frozen card still beats simply repeating last season on the test season. A refit that
//    stops doing so should fail loudly rather than ship.
{
  const m = card.backtest.nba.all.mae;
  for (const k of ['pts', 'reb', 'ast', 'mpg', 'gp']) {
    check(`backtest ${card.backtest.nba.season}: ${k} beats repeating last season`, m[k].model < m[k].repeat, `${m[k].model} vs ${m[k].repeat}`);
  }
  check('projection metadata is published with the data', data.projectionMeta?.id === card.id && !!data.projectionMeta?.rostersAsOf);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} · ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);

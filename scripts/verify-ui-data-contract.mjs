import fs from 'node:fs';
import zlib from 'node:zlib';

const d = JSON.parse(fs.readFileSync('./public/data.json', 'utf8'));
const problems = [];
if (!d.leagues?.NBA?.length || !d.leagues?.GLEAGUE?.length) problems.push('missing league arrays');

const appeared = (lg) => d.leagues[lg].filter((p) => p.appeared).length;
if (d.counts.NBA !== appeared('NBA')) problems.push('NBA count does not match appeared players');
if (d.counts.GLEAGUE !== appeared('GLEAGUE')) problems.push('G League count does not match appeared players');
if (!/^3\./.test(d.gradeModel?.version || '')) problems.push(`unexpected grade model version ${d.gradeModel?.version}`);

const h = d.analysis?.history;
if (!h?.available) problems.push('historical player-season product metadata missing');
if (!h?.gameLog?.available) problems.push('historical game-log product metadata missing');
if (h?.gameLog?.transport !== 'gzip-json-on-demand') problems.push(`unexpected history game-log transport ${h?.gameLog?.transport}`);
if (h?.gameLog?.path !== './public/history-games.json.gz') problems.push(`unexpected history game-log path ${h?.gameLog?.path}`);
if (!fs.existsSync('./public/history-games.json.gz')) problems.push('public/history-games.json.gz missing');
if (!fs.existsSync('./public/history-role-features.json.gz')) problems.push('public/history-role-features.json.gz missing');
else {
  const rf = JSON.parse(zlib.gunzipSync(fs.readFileSync('./public/history-role-features.json.gz')));
  if (!/strictly earlier/i.test(rf.featureTiming || '')) problems.push('role feature product lacks strict timing contract');
  if (!(rf.inventory?.featureRows > 100000)) problems.push('role feature product unexpectedly small');
}

for (const lg of ['NBA', 'GLEAGUE']) {
  const p = d.leagues[lg][0];
  for (const k of ['playerId', 'name', 'team', 'position', 'grade', 'custom', 'components', 'stats']) {
    if (p[k] === undefined) problems.push(`${lg} records missing ${k}`);
  }
  const graded = d.leagues[lg].filter((x) => x.appeared && x.grade !== null);
  if (graded.some((x) => !(x.grade >= 0 && x.grade <= 9.9999))) problems.push(`${lg} has a grade outside 0.0000-9.9999`);
  const ranks = graded.map((x) => x.rank).sort((a, b) => a - b);
  if (ranks[0] !== 1 || ranks[ranks.length - 1] !== graded.length) problems.push(`${lg} graded ranks are not a dense 1..n sequence`);
  if (d.leagues[lg].some((x) => x.rosterOnly && (x.grade !== null || x.rank !== null))) problems.push(`${lg} roster-only rows carry a grade or rank`);
}

if (d.leagues.GLEAGUE.some((p) => p.bpm != null || p.vorp != null)) problems.push('G League rows carry fabricated BPM/VORP');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`UI data contract ok · NBA ${d.counts.NBA} · G League ${d.counts.GLEAGUE} · crossovers ${d.counts.both}`);

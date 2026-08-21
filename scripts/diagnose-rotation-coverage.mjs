// Is GameRotation sparse, or are our SHOCK games disproportionately missing?
//
// A low success rate alone cannot distinguish "this endpoint has poor historical coverage" from
// "something about the game-ID sample is wrong" from "the endpoint is unstable right now". This
// runs three interleaved streams so the explanations separate:
//
//   CONTROL  known-good games spanning several eras, repeated throughout the run. If controls fail
//            too, the problem is the endpoint or the request pattern, not coverage.
//   SHOCK    games drawn from our opportunity-episode list — the ones we actually need.
//   RANDOM   ordinary games from the same seasons. If RANDOM succeeds where SHOCK fails, the
//            sample is biased; if both fail equally, coverage is genuinely thin.
//
// Every request records status, byte size, elapsed time, whether both team datasets are present,
// and whether the controls on either side of it succeeded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/history');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
  Accept: 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SPACING = Number(process.env.SPACING || 4000);

// Controls verified by hand across eras, so season-specific endpoint behaviour is visible.
const CONTROLS = ['0021500616', '0021800268', '0022100001', '0022400001'];
const shock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seasons = fs.readdirSync(HIST).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();

// Random ordinary games, same seasons, excluding anything in the shock list.
const shockSet = new Set(shock);
const random = [];
for (const s of seasons) {
  const f = path.join(HIST, s, 'gamelog.json');
  if (!fs.existsSync(f)) continue;
  const ids = [...new Set(JSON.parse(fs.readFileSync(f, 'utf8')).map((r) => r.gameId))].filter((g) => !shockSet.has(g)).sort();
  const step = Math.max(1, Math.floor(ids.length / 12));
  for (let i = 0, c = 0; i < ids.length && c < 12; i += step, c++) random.push({ gid: ids[i], season: s, kind: 'RANDOM' });
}
const shockSample = [];
for (const s of seasons) {
  const inSeason = shock.filter((g) => {
    const f = path.join(HIST, s, 'gamelog.json');
    return fs.existsSync(f) && g.startsWith(`002${s.slice(2, 4)}`);
  });
  for (const g of inSeason.slice(0, 12)) shockSample.push({ gid: g, season: s, kind: 'SHOCK' });
}

// Interleave: control every 8th request.
const queue = [];
const mixed = [...shockSample, ...random].sort(() => 0.5 - Math.random());
let ci = 0;
mixed.forEach((item, i) => {
  if (i % 8 === 0) queue.push({ gid: CONTROLS[ci++ % CONTROLS.length], season: 'control', kind: 'CONTROL' });
  queue.push(item);
});

const log = [];
for (const item of queue) {
  const t0 = Date.now();
  let status = 0, bytes = 0, teams = 0, err = null;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
    const r = await fetch(`https://stats.nba.com/stats/gamerotation?GameID=${item.gid}&LeagueID=00&RotationType=`, { headers: H, signal: c.signal });
    clearTimeout(t);
    status = r.status;
    if (r.ok) {
      const txt = await r.text();
      bytes = txt.length;
      try {
        const j = JSON.parse(txt);
        teams = (j.resultSets || []).filter((rs) => rs.rowSet.length > 0).length;
      } catch { err = 'unparseable'; }
    }
  } catch (e) { err = e.message.slice(0, 30); }
  log.push({ ...item, status, bytes, teams, ms: Date.now() - t0, ok: status === 200 && teams === 2, err });
  await wait(SPACING);
}

const by = (kind) => log.filter((l) => l.kind === kind);
console.log(`spacing ${SPACING}ms · ${log.length} requests\n`);
console.log('stream    n     ok    ok%     HTTP500  other');
for (const k of ['CONTROL', 'SHOCK', 'RANDOM']) {
  const l = by(k);
  if (!l.length) continue;
  const ok = l.filter((x) => x.ok).length;
  console.log(`${k.padEnd(9)} ${String(l.length).padStart(4)} ${String(ok).padStart(6)} ${(100 * ok / l.length).toFixed(1).padStart(6)}%  ${String(l.filter((x) => x.status === 500).length).padStart(7)}  ${l.filter((x) => x.status !== 200 && x.status !== 500).length}`);
}
console.log('\nby season (SHOCK vs RANDOM):');
console.log('season     shock ok%   random ok%');
for (const s of seasons) {
  const sh = by('SHOCK').filter((l) => l.season === s), rd = by('RANDOM').filter((l) => l.season === s);
  if (!sh.length && !rd.length) continue;
  const p = (l) => (l.length ? (100 * l.filter((x) => x.ok).length / l.length).toFixed(0) + '%' : '  -');
  console.log(`${s.padEnd(10)} ${p(sh).padStart(9)}   ${p(rd).padStart(10)}`);
}
// Did controls hold up throughout? If they degrade, the endpoint is the problem, not coverage.
const cl = by('CONTROL');
console.log(`\ncontrols: ${cl.filter((x) => x.ok).length}/${cl.length} ok`);
if (cl.some((x) => !x.ok)) console.log('  CONTROL FAILURES PRESENT — endpoint/request instability, not purely coverage');
else console.log('  all controls held — failures are game-specific, not endpoint instability');
fs.writeFileSync(path.join(HIST, 'rotation_coverage_diagnostic.json'), JSON.stringify(log, null, 1));

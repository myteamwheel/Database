// Backfill height/weight/birthdate for players missing from the bulk bio dashboards
// by asking stats.nba.com for each one individually. Writes scripts/data/player_bios.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/player_bios.json');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const need = new Map();
for (const lg of ['NBA', 'GLEAGUE']) {
  for (const p of d.leagues[lg]) {
    if (!p.height || !p.weight) need.set(p.nbaPersonId, p.name);
  }
}
console.log(`${need.size} players need an individual bio lookup`);

const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let got = 0, failed = 0;
for (const [id, name] of need) {
  if (store[id]) continue;
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    try {
      // Players who never appeared in the NBA return {} unless LeagueID=20 is supplied.
      let j = null;
      for (const lid of ['', '20']) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 30000);
        const r = await fetch(`https://stats.nba.com/stats/commonplayerinfo?PlayerID=${id}&LeagueID=${lid}`, { headers: H, signal: c.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.json();
        if (body && body.resultSets) { j = body; break; }
        await wait(500);
      }
      if (!j) throw new Error('no bio record in either league');
      const rs = j.resultSets.find((s) => s.name === 'CommonPlayerInfo');
      const row = Object.fromEntries(rs.headers.map((h, k) => [h, rs.rowSet[0]?.[k]]));
      store[id] = {
        name, height: row.HEIGHT || null, weight: row.WEIGHT || null,
        position: row.POSITION || null, birthdate: row.BIRTHDATE || null,
        country: row.COUNTRY || null, school: row.SCHOOL || null,
        draftYear: row.DRAFT_YEAR || null, draftRound: row.DRAFT_ROUND || null,
        draftNumber: row.DRAFT_NUMBER || null,
      };
      got++; ok = true;
    } catch (e) {
      if (i === 2) { console.log(`  FAILED ${name} (${id}): ${e.message}`); failed++; }
      else await wait(2000 * (i + 1));
    }
  }
  await wait(700);
}
fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
console.log(`fetched ${got}, failed ${failed}, stored ${Object.keys(store).length} total -> ${path.relative(ROOT, OUT)}`);

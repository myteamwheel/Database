// Birthdate for every person in the database, so age can be stated against a fixed reference
// date rather than inherited from whichever source happened to list one.
//
// NBA.com's listed age and Basketball-Reference's 1-February season age disagree for 246 of 580
// NBA players, and the G League has no season age at all for 213. A real birthdate makes
// "age 22 season" unambiguous.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data/birthdates.json');
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
  'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const people = new Map();
for (const lg of ['NBA', 'GLEAGUE']) for (const p of d.leagues[lg]) people.set(p.nbaPersonId, p.name);

const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
// Seed from the individual bio lookups already on disk.
const patchPath = path.join(ROOT, 'scripts/data/player_bios.json');
if (fs.existsSync(patchPath)) {
  for (const [id, b] of Object.entries(JSON.parse(fs.readFileSync(patchPath, 'utf8')))) {
    if (b.birthdate && !store[id]) store[id] = { name: b.name, birthdate: b.birthdate };
  }
}

const todo = [...people].filter(([id]) => !store[String(id)]);
console.log(`${people.size} people, ${store && Object.keys(store).length} already known, ${todo.length} to fetch`);

let got = 0, failed = 0, n = 0;
for (const [id, name] of todo) {
  n++;
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    try {
      let j = null;
      for (const lid of ['', '20']) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 25000);
        const r = await fetch(`https://stats.nba.com/stats/commonplayerinfo?PlayerID=${id}&LeagueID=${lid}`, { headers: H, signal: c.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.json();
        if (body && body.resultSets) { j = body; break; }
      }
      if (!j) throw new Error('no record');
      const rs = j.resultSets.find((s) => s.name === 'CommonPlayerInfo');
      const row = Object.fromEntries(rs.headers.map((h, k) => [h, rs.rowSet[0]?.[k]]));
      store[String(id)] = { name, birthdate: row.BIRTHDATE || null };
      got++; ok = true;
    } catch (e) {
      if (i === 2) { failed++; store[String(id)] = { name, birthdate: null }; }
      else await wait(1500 * (i + 1));
    }
  }
  if (n % 100 === 0) {
    fs.writeFileSync(OUT, JSON.stringify(store));
    console.log(`  ${n}/${todo.length} (${got} ok, ${failed} failed)`);
  }
  await wait(450);
}
fs.writeFileSync(OUT, JSON.stringify(store));
const withDate = Object.values(store).filter((x) => x.birthdate).length;
console.log(`done: ${withDate}/${Object.keys(store).length} have a birthdate`);

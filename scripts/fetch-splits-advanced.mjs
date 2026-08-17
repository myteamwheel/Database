// Advanced measure per situational split. The Base-only version gave PTS/REB/AST/TS but not
// USG%, AST%, REB%, PIE, OffRtg, DefRtg, NetRtg, pace or possessions. Splits that the endpoint
// does not serve are skipped, never written empty.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts/data');
const H = {'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36','Referer':'https://www.nba.com/','Origin':'https://www.nba.com','Accept':'application/json','x-nba-stats-origin':'stats','x-nba-stats-token':'true'};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, l, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(u, { headers: H, signal: c.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json();
    } catch (e) { if (i === tries) { console.log(`    give up ${l}: ${e.message}`); return null; } await wait(2000 * i); }
  }
}
const rows = (j) => { if (!j) return []; const rs = Array.isArray(j.resultSets) ? j.resultSets[0] : j.resultSets;
  return rs && rs.rowSet ? rs.rowSet.map((r) => Object.fromEntries(rs.headers.map((h, i) => [h, r[i]]))) : []; };
const dash = (lid, st, extra) => 'https://stats.nba.com/stats/leaguedashplayerstats?' + new URLSearchParams({
  College:'',Conference:'',Country:'',DateFrom:'',DateTo:'',Division:'',DraftPick:'',DraftYear:'',
  GameScope:'',GameSegment:'',Height:'',LastNGames:'0',LeagueID:lid,Location:'',MeasureType:'Advanced',
  Month:'0',OpponentTeamID:'0',Outcome:'',PORound:'0',PaceAdjust:'N',PerMode:'PerGame',Period:'0',
  PlayerExperience:'',PlayerPosition:'',PlusMinus:'N',Rank:'N',Season:'2025-26',SeasonSegment:'',
  SeasonType:st,ShotClockRange:'',StarterBench:'',TeamID:'0',TwoWay:'0',VsConference:'',VsDivision:'',Weight:'',...extra,
}).toString();
const clutchAdv = (lid, st) => 'https://stats.nba.com/stats/leaguedashplayerclutch?' + new URLSearchParams({
  AheadBehind:'Ahead or Behind',ClutchTime:'Last 5 Minutes',College:'',Conference:'',Country:'',
  DateFrom:'',DateTo:'',Division:'',DraftPick:'',DraftYear:'',GameScope:'',GameSegment:'',Height:'',
  LastNGames:'0',LeagueID:lid,Location:'',MeasureType:'Advanced',Month:'0',OpponentTeamID:'0',Outcome:'',
  PORound:'0',PaceAdjust:'N',PerMode:'PerGame',Period:'0',PlayerExperience:'',PlayerPosition:'',
  PlusMinus:'N',PointDiff:'5',Rank:'N',Season:'2025-26',SeasonSegment:'',SeasonType:st,ShotClockRange:'',
  StarterBench:'',TeamID:'0',TwoWay:'0',VsConference:'',VsDivision:'',Weight:'',
}).toString();

const SPLITS = [['home',{Location:'Home'}],['road',{Location:'Road'}],['wins',{Outcome:'W'}],
  ['losses',{Outcome:'L'}],['starter',{StarterBench:'Starters'}],['bench',{StarterBench:'Bench'}],
  ['preallstar',{SeasonSegment:'Pre All-Star'}],['postallstar',{SeasonSegment:'Post All-Star'}]];
for (let m = 1; m <= 12; m++) SPLITS.push([`month${m}`, { Month: String(m) }]);

const LEAGUES = [
  { id:'00', st:'Regular Season', dir:'splits_nba' },
  { id:'20', st:'Regular Season', dir:'splits_gleague_regular' },
  { id:'20', st:'Showcase',       dir:'splits_gleague_showcase' },
];
const report = [];
for (const lg of LEAGUES) {
  const dir = path.join(OUT, lg.dir);
  fs.mkdirSync(dir, { recursive: true });
  console.log(lg.dir + ':');
  for (const [name, extra] of SPLITS) {
    const r = rows(await get(dash(lg.id, lg.st, extra), `${lg.dir}/adv_${name}`));
    if (r.length) {
      fs.writeFileSync(path.join(dir, `adv_${name}.json`), JSON.stringify({ resultSets: [{ headers: Object.keys(r[0]), rowSet: r.map((x) => Object.values(x)) }] }));
      console.log(`  adv_${name.padEnd(12)} ${r.length}`);
      report.push({ dataset: `${lg.dir}/adv_${name}`, rows: r.length });
    }
    await wait(800);
  }
  const cr = rows(await get(clutchAdv(lg.id, lg.st), `${lg.dir}/adv_clutch`));
  if (cr.length) {
    fs.writeFileSync(path.join(dir, 'adv_clutch.json'), JSON.stringify({ resultSets: [{ headers: Object.keys(cr[0]), rowSet: cr.map((x) => Object.values(x)) }] }));
    console.log(`  adv_clutch     ${cr.length}`);
    report.push({ dataset: `${lg.dir}/adv_clutch`, rows: cr.length });
  }
  await wait(800);
}
fs.writeFileSync(path.join(OUT, 'provenance_splits_advanced.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), datasets: report }, null, 1));
console.log('advanced splits done: ' + report.length + ' datasets');

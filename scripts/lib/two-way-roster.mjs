import {verifyLiveRosterSnapshot} from './live-roster.mjs';
export const TWO_WAY_URL='https://gleague.nba.com/twowayplayers';
const TEAM_NAMES=['Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls','Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons','Golden State Warriors','Houston Rockets','Indiana Pacers','LA Clippers','Los Angeles Lakers','Memphis Grizzlies','Miami Heat','Milwaukee Bucks','Minnesota Timberwolves','New Orleans Pelicans','New York Knicks','Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns','Portland Trail Blazers','Sacramento Kings','San Antonio Spurs','Toronto Raptors','Utah Jazz','Washington Wizards'];
const ABBRS='ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split(' ');
const teams=new Map(TEAM_NAMES.map((name,i)=>[name,ABBRS[i]]));
const text=s=>s.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g,' ').trim();
const nameKey=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');

export function parseTwoWayTable(html,{season='2026-27',fetchedAt}={}) {
  if(typeof html!=='string')throw new Error('Two-way tracker season missing or stale');
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  if(!html.includes(`Two-Way Players from the ${season} season`)) throw new Error('Two-way tracker season missing or stale');
  if(!Number.isFinite(Date.parse(fetchedAt)))throw new Error('Invalid two-way fetch date');
  const table=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].map(m=>m[0]).find(t=>t.includes('Player Name')&&t.includes('NBA Team')&&t.includes('G League Team'));
  if(!table)throw new Error('Two-way table unavailable');
  const rows=[],counts=new Map();
  for(const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells=[...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m=>text(m[1]));
    if(cells[0]==='Player Name')continue;
    if(cells.length!==3 || !teams.has(cells[1]) || !cells[2])throw new Error('Malformed two-way table row');
    const team=teams.get(cells[1]);counts.set(team,(counts.get(team)||0)+1);
    if(cells[0])rows.push({name:cells[0],team,affiliate:cells[2]});
  }
  if(counts.size!==30 || [...counts.values()].some(n=>n!==3))throw new Error('Incomplete two-way team inventory');
  return {season,fetchedAt,source:TWO_WAY_URL,rows};
}

export function reconcileTwoWayRoster(tracker,roster) {
  const verified=verifyLiveRosterSnapshot(roster);
  if(tracker.season!==verified.season)throw new Error('Two-way/roster season mismatch');
  const ix=Object.fromEntries(verified.headers.map((h,i)=>[h,i]));
  const lookup=new Map();
  for(const row of verified.rows) {
    const key=nameKey(`${row[ix.PLAYER_FIRST_NAME]} ${row[ix.PLAYER_LAST_NAME]}`);
    const list=lookup.get(key)||[];list.push(row);lookup.set(key,list);
  }
  const confirmed=[],unresolved=[],seen=new Set();
  for(const p of tracker.rows) {
    const found=(lookup.get(nameKey(p.name))||[]).filter(r=>r[ix.TEAM_ABBREVIATION]===p.team);
    if(found.length!==1){unresolved.push({...p,reason:'No unique current NBA roster match'});continue;}
    const playerId=found[0][ix.PERSON_ID];
    if(seen.has(playerId))throw new Error('Duplicate two-way identity');
    seen.add(playerId);confirmed.push({...p,playerId});
  }
  return {season:tracker.season,fetchedAt:tracker.fetchedAt,rosterFetchedAt:verified.fetchedAt,source:TWO_WAY_URL,confirmed,unresolved};
}

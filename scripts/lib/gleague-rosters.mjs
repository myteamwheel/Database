import fs from 'node:fs';
import path from 'node:path';
export const GLEAGUE_ROSTER_SOURCE='https://stats.gleague.nba.com/stats/commonteamroster';
export function parseGLeagueTeamRoster(payload,{teamId,team,season='2026-27'}={}){
  if(!Number.isSafeInteger(teamId)||teamId<=0||!/^[A-Z]{3}$/.test(team||'')||(!/^20\d{2}-\d{2}$/.test(season)||season.slice(5)!==String(Number(season.slice(0,4))+1).slice(-2)))throw new Error('Invalid G League roster scope');
  if(Number(payload?.parameters?.TeamID)!==teamId||String(payload?.parameters?.LeagueID)!=='20'||payload?.parameters?.Season!==season)throw new Error('G League roster source scope mismatch');
  const t=payload.resultSets?.find(t=>t.name==='CommonTeamRoster'),required=['TeamID','SEASON','LeagueID','PLAYER','PLAYER_ID','POSITION','HOW_ACQUIRED'];
  if(!Array.isArray(t?.headers)||!Array.isArray(t.rowSet)||new Set(t.headers).size!==t.headers.length||required.some(k=>!t.headers.includes(k)))throw new Error('Invalid official team roster schema');
  const ix=Object.fromEntries(t.headers.map((k,i)=>[k,i])),seen=new Set();
  if(t.rowSet.length<5||t.rowSet.length>30)throw new Error('Incomplete/unexpected official team roster');
  return t.rowSet.map(r=>{
    const id=r[ix.PLAYER_ID];
    if(r.length!==t.headers.length||!Number.isSafeInteger(id)||id<=0||seen.has(id)||r[ix.TeamID]!==teamId||String(r[ix.LeagueID])!=='20'||String(r[ix.SEASON])!==season.slice(0,4)||typeof r[ix.PLAYER]!=='string'||!r[ix.PLAYER].trim())throw new Error('Invalid official team roster identity');
    seen.add(id);
    return {playerId:id,name:r[ix.PLAYER].trim(),team,teamId,position:r[ix.POSITION]||null,height:r[ix.HEIGHT]||null,weight:r[ix.WEIGHT]||null,birthdate:r[ix.BIRTH_DATE]||null,school:r[ix.SCHOOL]||null,howAcquired:r[ix.HOW_ACQUIRED]||null,
      // SUPPLEMENTAL_STATUS is not documented as an assignment/recall status.
      assignmentStatus:'unverified',status:'official-team-roster-listed'};
  });
}
export function verifyGLeagueRosters(snapshot){
  if(snapshot?.version!==1||snapshot.source!==GLEAGUE_ROSTER_SOURCE||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.teams)||snapshot.teams.length!==31)throw new Error('Invalid G League roster snapshot');
  const teams=new Set(),ids=new Set(),players=[];
  for(const entry of snapshot.teams){
    if(teams.has(entry.team))throw new Error('Duplicate G League roster team');teams.add(entry.team);
    for(const p of parseGLeagueTeamRoster(entry.payload,{...entry,season:snapshot.season})){
      if(ids.has(p.playerId))throw new Error('Player listed on multiple G League team rosters');ids.add(p.playerId);players.push(p);
    }
  }
  return {season:snapshot.season,fetchedAt:snapshot.fetchedAt,source:snapshot.source,players,
    scope:'official-team-roster-listing',note:'Team-level roster listing, which may include training-camp players before opening rosters are finalized. A roster listing is not an NBA assignment, medical clearance or proof of contract terms.'};
}
export async function refreshGLeagueRosters({file,index,fetchJson,now=()=>new Date().toISOString()}){
  if(!file||!fetchJson||!index?.rows)throw new Error('G League roster refresh inputs missing');
  const ix=Object.fromEntries(index.headers.map((k,i)=>[k,i]));
  const teams=[...new Map(index.rows.map(r=>[r[ix.TEAM_ABBREVIATION],r[ix.TEAM_ID]])).entries()].sort(([a],[b])=>a.localeCompare(b));
  if(teams.length!==31)throw new Error('Expected all 31 official G League teams');
  const entries=[];
  for(const [team,teamId] of teams){const url=GLEAGUE_ROSTER_SOURCE+'?'+new URLSearchParams({LeagueID:'20',Season:index.season,TeamID:String(teamId)});entries.push({team,teamId,payload:await fetchJson(url)});}
  const snapshot={version:1,season:index.season,source:GLEAGUE_ROSTER_SOURCE,fetchedAt:now(),teams:entries};
  const checked=verifyGLeagueRosters(snapshot);
  if(fs.existsSync(file)){const previous=verifyGLeagueRosters(JSON.parse(fs.readFileSync(file)));if(previous.fetchedAt>snapshot.fetchedAt)throw new Error('G League roster fetch moved backwards');}
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;
  try{fs.writeFileSync(tmp,JSON.stringify(snapshot)+'\n');fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.rmSync(tmp);}
  return checked;
}

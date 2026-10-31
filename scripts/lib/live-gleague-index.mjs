import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = ['PERSON_ID','PLAYER_FIRST_NAME','PLAYER_LAST_NAME','TEAM_ID','TEAM_ABBREVIATION','POSITION','ROSTER_STATUS'];
const TEAMS = new Set('AUS CCG CLC CPS CVL DEL GBO GRG IWA LIN LTN MCC MHU MNE MXC NOB OKL OSC RAP RCR RGV SCW SDC SLC STO SXF TEX VAL WCB WES WIS'.split(' '));

export function parseGLeagueIndex(payload, { season = '2026-27', fetchedAt, minRows = 300 } = {}) {
  if (season !== '2026-27' || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid G League index season or fetch time');
  const table = payload?.resultSets?.[0];
  if (!Array.isArray(table?.headers) || !Array.isArray(table?.rowSet) ||
      new Set(table.headers).size !== table.headers.length || REQUIRED.some(k => !table.headers.includes(k)))
    throw new Error('Invalid G League player-index schema');
  const ix = Object.fromEntries(table.headers.map((k,i) => [k,i]));
  const rows = [], seen = new Set(), teams = new Set();
  for (const row of table.rowSet) {
    if (!Array.isArray(row) || row.length !== table.headers.length) throw new Error('Invalid G League player-index row width');
    if (![0,1].includes(row[ix.ROSTER_STATUS])) throw new Error('Invalid G League index status');
    if (row[ix.ROSTER_STATUS] === 0) continue;
    const id = row[ix.PERSON_ID], team = row[ix.TEAM_ABBREVIATION];
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !TEAMS.has(team) ||
        !Number.isSafeInteger(row[ix.TEAM_ID]) || row[ix.TEAM_ID] <= 0 ||
        !String(row[ix.PLAYER_FIRST_NAME] || '').trim() || !String(row[ix.PLAYER_LAST_NAME] || '').trim())
      throw new Error('Invalid, duplicate or unassigned G League index identity');
    seen.add(id); teams.add(team);
    rows.push([id,String(row[ix.PLAYER_FIRST_NAME]).trim(),String(row[ix.PLAYER_LAST_NAME]).trim(),team,row[ix.TEAM_ID],row[ix.POSITION] || null]);
  }
  if (rows.length < minRows || teams.size !== 31) throw new Error('Incomplete G League index: player or team coverage');
  return {season,fetchedAt,source:'stats.gleague.nba.com/stats/playerindex',scope:'provisional-index-listing',
    note:'Index-listed team is provisional until official November 5 opening rosters; it does not establish an NBA assignment or signed contract.',
    headers:['PERSON_ID','PLAYER_FIRST_NAME','PLAYER_LAST_NAME','TEAM_ABBREVIATION','TEAM_ID','POSITION'],rows};
}

export function verifyGLeagueIndex(snapshot) {
  if (snapshot?.source !== 'stats.gleague.nba.com/stats/playerindex' || snapshot?.scope !== 'provisional-index-listing')
    throw new Error('Unrecognized G League index source or scope');
  const ix=Object.fromEntries((snapshot.headers||[]).map((k,i)=>[k,i]));
  if (snapshot.headers?.length !== 6 || REQUIRED.filter(k=>k!=='ROSTER_STATUS').some(k=>!(k in ix)))
    throw new Error('Invalid compact G League index schema');
  const payload={resultSets:[{headers:[...snapshot.headers,'ROSTER_STATUS'],rowSet:snapshot.rows.map(r=>[...r,1])}]};
  const parsed=parseGLeagueIndex(payload,{season:snapshot.season,fetchedAt:snapshot.fetchedAt});
  if (parsed.rows.length!==snapshot.rows.length || JSON.stringify(parsed.rows)!==JSON.stringify(snapshot.rows)) throw new Error('G League index snapshot mismatch');
  return parsed;
}

export async function refreshGLeagueIndex({file,now=()=>new Date().toISOString(),fetchJson=fetchOfficial}={}) {
  if (!file) throw new Error('G League index destination required');
  const params=new URLSearchParams({College:'',Country:'',DraftPick:'',DraftRound:'',DraftYear:'',Height:'',Historical:'0',LeagueID:'20',Season:'2026-27',SeasonType:'Regular Season',TeamID:'0',Weight:''});
  const snapshot=parseGLeagueIndex(await fetchJson(`https://stats.gleague.nba.com/stats/playerindex?${params}`),{fetchedAt:now()});
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${process.pid}`;
  try {fs.writeFileSync(temp,JSON.stringify(snapshot)+'\n');fs.renameSync(temp,file);}
  finally {if(fs.existsSync(temp))fs.rmSync(temp);}
  return snapshot;
}

async function fetchOfficial(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',Referer:'https://stats.gleague.nba.com/',Origin:'https://stats.gleague.nba.com',Accept:'application/json','x-nba-stats-origin':'stats','x-nba-stats-token':'true'}});
  if(!response.ok)throw new Error(`Official G League index request failed: HTTP ${response.status}`);
  return response.json();
}

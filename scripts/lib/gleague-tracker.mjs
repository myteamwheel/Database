import {verifyGLeagueRosters,GLEAGUE_ROSTER_SOURCE} from './gleague-rosters.mjs';
export const normalizeTrackerName=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g,'').replace(/[^a-z0-9]/g,'');

export function reconcileGLeagueTracker(source,snapshot,{nbaPlayers=[]}={}){
 if(source?.version!==1||source.season!==snapshot.season||!Array.isArray(source.records)||source.teams?.length!==31)throw new Error('Invalid tracker source');
 if(!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/.test(source.spreadsheetUrl)||new Set(source.teams.map(t=>t.team)).size!==31||source.teams.some(t=>!/^\w{3}$/.test(t.team)||!t.name))throw new Error('Invalid tracker identity or spreadsheet URL');
 const roster=verifyGLeagueRosters(snapshot),byName=new Map(),teamNames=new Map(source.teams.map(t=>[t.team,t]));
 for(const p of roster.players){const key=normalizeTrackerName(p.name);byName.set(key,[...(byName.get(key)||[]),p]);}
 const twoWay=new Map(nbaPlayers.filter(p=>p.rosterContext?.contract==='two-way').map(p=>[Number(p.nbaPersonId),p.rosterContext.nbaTeam]));
 const seen=new Set(),ids=new Set(),records=[];
 for(const old of source.records){
  if(!old.trackerId||ids.has(old.trackerId))throw new Error('Duplicate/missing tracker ID');ids.add(old.trackerId);
  if(old.source&&!/^https:\/\//i.test(old.source))throw new Error('Invalid tracker source URL');
  const choices=byName.get(normalizeTrackerName(old.name))||[],own=choices.filter(p=>teamNames.get(p.team)?.name===old.teamName);
  const match=own.length===1?own[0]:choices.length===1?choices[0]:null;
  if(match&&seen.has(match.playerId))throw new Error('Tracker records collide on official identity');
  if(match)seen.add(match.playerId);
  records.push({...old,originalName:old.name,...(match?official(match):{playerId:null,currentTeam:null,currentTeamName:null,listed:false,currentStatus:'Not on the current official team listing; prior evidence retained'}),checkedAt:roster.fetchedAt});
 }
 for(const p of roster.players)if(!seen.has(p.playerId))records.push({trackerId:'GL26-OFFICIAL-'+p.playerId,teamName:teamNames.get(p.team)?.name,affiliate:teamNames.get(p.team)?.affiliate,name:p.name,campDate:null,source:sourceUrl(p),notes:'Added from the official 2026-27 team roster. Camp announcement date and contract terms are not inferred.',...official(p),checkedAt:roster.fetchedAt});
 function sourceUrl(p){return GLEAGUE_ROSTER_SOURCE+'?'+new URLSearchParams({LeagueID:'20',Season:roster.season,TeamID:String(p.teamId)});}
 function official(p){const e=snapshot.teams.find(t=>t.team===p.team),t=e.payload.resultSets.find(t=>t.name==='CommonTeamRoster'),row=t.rowSet.find(r=>r[t.headers.indexOf('PLAYER_ID')]===p.playerId);return {playerId:p.playerId,name:p.name,currentTeam:p.team,currentTeamName:teamNames.get(p.team)?.name,affiliate:teamNames.get(p.team)?.affiliate,listed:true,currentStatus:'Official team roster listing (camp period)',jersey:row[t.headers.indexOf('NUM')]??null,position:p.position,height:p.height,weight:p.weight,birthdate:p.birthdate,school:p.school,currentAcquisition:p.howAcquired,twoWayNbaTeam:twoWay.get(p.playerId)||null,currentSource:sourceUrl(p)};}
 const teams=source.teams.map(t=>({...t,listed:records.filter(p=>p.listed&&p.currentTeam===t.team).length,leads:records.filter(p=>!p.listed&&p.teamName===t.name).length,source:GLEAGUE_ROSTER_SOURCE+'?'+new URLSearchParams({LeagueID:'20',Season:roster.season,TeamID:String(snapshot.teams.find(e=>e.team===t.team)?.teamId)})}));
 if(teams.some(t=>!t.listed)||records.filter(r=>r.listed).length!==roster.players.length)throw new Error('Tracker roster reconciliation failed');
 return {version:1,season:source.season,spreadsheetUrl:source.spreadsheetUrl,asOf:roster.fetchedAt,source:GLEAGUE_ROSTER_SOURCE,scope:roster.note,teams,records,summary:{listed:roster.players.length,tracked:records.length,unlisted:records.filter(r=>!r.listed).length,added:records.length-source.records.length}};
}

export function attachGLeagueTracker(data,source,snapshot){
 const tracker=reconcileGLeagueTracker(source,snapshot,{nbaPlayers:data.leagues.NBA});
 // Detailed historical notes remain in the workbook and tracked source. The
 // browser carries only the fields its roster panel uses, keeping the daily
 // standalone artifact within its publication size limit.
 const keys=['trackerId','playerId','name','teamName','currentTeam','currentTeamName','listed','position','jersey','height','weight','school','twoWayNbaTeam','acquisition','source'];
 data.gLeagueTracker={...tracker,records:tracker.records.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]??null])))};
 const byId=new Map(tracker.records.filter(p=>p.listed).map(p=>[p.playerId,p]));
 for(const p of data.leagues.GLEAGUE){const r=byId.get(Number(p.nbaPersonId??p.playerId));p.currentGLeagueBio=r?{jersey:r.jersey,height:r.height,weight:r.weight,birthdate:r.birthdate,school:r.school}:null;}
 return tracker;
}

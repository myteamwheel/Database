// A rookie can play and be waived before a roster refresh. Keep every measured
// participant discoverable even when neither historical rows nor today's roster contain him.
export function appendCurrentParticipants(data,snapshots){
 for(const [league,tables] of Object.entries(snapshots)){
  const ids=new Set(data.leagues[league].map(p=>Number(p.nbaPersonId||p.playerId)));
  for(const t of tables){const ix=Object.fromEntries(t.headers.map((k,i)=>[k,i]));if(ix.PLAYER_ID===undefined||ix.PLAYER_NAME===undefined)throw new Error('Current participants need source identities');
   for(const r of t.rowSet){const id=r[ix.PLAYER_ID];if(ids.has(id))continue;if(!Number.isSafeInteger(id)||id<=0||!r[ix.PLAYER_NAME])throw new Error('Invalid current participant');
    data.leagues[league].push({league,leagueLabel:league==='NBA'?'NBA':'NBA G League',playerId:String(id),nbaPersonId:id,name:r[ix.PLAYER_NAME],season:'2025-26',team:null,seasonTeam:null,currentTeam:null,currentRoster:false,currentGLeagueRosterTeam:null,teamCount:0,teams:[],position:null,positionFamily:null,age:null,gp:0,minutes:0,mpg:null,appeared:false,rosterOnly:true,currentParticipantOnly:true,grade:null,rateGrade:null,magnitudeGrade:null,gradeRaw:null,gradeShrunk:null,gradeCoverage:null,reliabilityWeight:0,rank:null,viewRank:null,components:{},rateComponents:{},componentsBelowMinimum:[],custom:{},stats:{},skillProfile:null,archetypes:[],sourceIds:{nbaStats:id}});ids.add(id);
   }
  }
 }
 return data;
}

// Some official G League dashboards split one person's totals into multiple
// same-team rows. Only combine them when completed-game exposure reconciles.
const additive=new Set('GP G W L MIN POSS FGM FGA FG3M FG3A FTM FTA OREB DREB REB AST TOV STL BLK BLKA PF PFD PTS PLUS_MINUS DD2 TD3 NBA_FANTASY_PTS WNBA_FANTASY_PTS'.split(' '));
const identity=new Set('PLAYER_ID PLAYER_NAME NICKNAME TEAM_ID TEAM_ABBREVIATION TEAM_COUNT AGE'.split(' '));
export function reconcileDashboardSegments(payload,logged){
 const table=payload?.resultSets?.[0],ix=Object.fromEntries((table?.headers||[]).map((k,i)=>[k,i]));
 if(!table?.rowSet||ix.PLAYER_ID==null)return payload;
 const groups=new Map();for(const row of table.rowSet){const id=row[ix.PLAYER_ID];groups.set(id,[...(groups.get(id)||[]),row]);}
 if([...groups.values()].every(rows=>rows.length===1))return payload;
 if(payload.parameters?.PerMode!=='Totals'||String(payload.parameters?.LeagueID)!=='20'||!logged)throw Error('Cannot verify split dashboard rows');
 const corrections=[];
 const rows=[...groups].map(([id,parts])=>{
  if(parts.length===1)return parts[0];
  const first=parts[0],expected=logged.get(id)?.GP;
  if(parts.some(r=>r.length!==table.headers.length||!Number.isSafeInteger(r[ix.GP])||r[ix.GP]<=0)||!Number.isSafeInteger(expected)||parts.reduce((sum,r)=>sum+r[ix.GP],0)!==expected)throw Error('Split dashboard exposure does not match completed games: '+id);
  for(const key of ['PLAYER_NAME','TEAM_ID','TEAM_ABBREVIATION','AGE'])if(ix[key]!=null&&parts.some(r=>r[ix[key]]!==first[ix[key]]))throw Error('Split dashboard identity/team mismatch: '+id);
  const merged=table.headers.map((key,i)=>identity.has(key)?first[i]:additive.has(key)&&parts.every(r=>Number.isFinite(r[i]))?parts.reduce((sum,r)=>sum+r[i],0):null);
  // Rates and ranks cannot be summed or simply averaged. Recompute only those
  // with published count denominators; leave unsupported advanced rates missing.
  for(const [rate,numerator,denominator] of [['FG_PCT','FGM','FGA'],['FG3_PCT','FG3M','FG3A'],['FT_PCT','FTM','FTA'],['W_PCT','W','GP']]){
   if(ix[rate]!=null&&ix[numerator]!=null&&ix[denominator]!=null)merged[ix[rate]]=merged[ix[denominator]]>0?merged[ix[numerator]]/merged[ix[denominator]]:null;
  }
  corrections.push({playerId:id,sourceRows:parts.length,games:expected,reason:'Same-player, same-team segments reconciled to completed-game appearances; unsupported rates omitted'});
  return merged;
 });
 return {...payload,resultSets:[{...table,rowSet:rows},...payload.resultSets.slice(1)],segmentCorrections:corrections};
}

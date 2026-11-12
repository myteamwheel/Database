// Westchester's 2026 opening roster names Amir “Primo” Spears. The final
// game logs use 1643964 for both appearances. The dashboards split them.
// https://westchester.gleague.nba.com/news/westchester-knicks-announce-2026-27-opening-night-roster
const canonical=1643964, alias=196700078, westchester=1612709919;
const additive=new Set('GP G W L MIN POSS FGM FGA FG3M FG3A FTM FTA OREB DREB REB AST TOV STL BLK BLKA PF PFD PTS PLUS_MINUS DD2 TD3 NBA_FANTASY_PTS'.split(' '));
export function reconcileSpears(payload){
  const p=payload?.parameters;
  if(String(p?.LeagueID)!=='20'||(p.Season??p.SeasonYear)!=='2026-27')return payload;
  const table=payload.resultSets?.[0];
  if(!table?.headers||!Array.isArray(table.rowSet))return payload;
  const index=key=>table.headers.indexOf(key), id=index('PLAYER_ID'), name=index('PLAYER_NAME'), team=index('TEAM_ID');
  const extra=table.rowSet.find(r=>r[id]===alias);
  if(!extra)return payload;
  const main=table.rowSet.find(r=>r[id]===canonical);
  if(extra[name]!=='Primo Spears'||extra[team]!==westchester||(main&&(main[name]!=='Amir Spears'||main[team]!==westchester)))throw Error('Unexpected Spears source identity');
  const merged=[...(main||extra)];
  if(main)for(const [i,k] of table.headers.entries()){
    if(['PLAYER_ID','PLAYER_NAME','NICKNAME','TEAM_ID','TEAM_ABBREVIATION','AGE'].includes(k))continue;
    const total=additive.has(k)&&(p.PerMode==='Totals'||['GP','G','W','L'].includes(k));
    merged[i]=total&&Number.isFinite(main[i])&&Number.isFinite(extra[i])?main[i]+extra[i]:null;
  }
  merged[id]=canonical;merged[name]='Amir Spears';
  table.rowSet=table.rowSet.filter(r=>r!==main&&r!==extra).concat([merged]);
  payload.identityCorrection={sourceIds:main?[alias,canonical]:[alias],canonicalId:canonical,reason:'Westchester split identity; final game logs verify combined appearances'};
  return payload;
}

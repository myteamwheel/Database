import crypto from 'node:crypto';
import {prepare,seasonName,actualLine,projectionHistory} from './projection.mjs';
import {buildProjections} from '../build-projections.mjs';
import {buildSeasonForecasts} from '../build-season-progress.mjs';
import {fitEntryCard} from './entry-production.mjs';
const stats={min:'MIN',pts:'PTS',reb:'REB',oreb:'OREB',dreb:'DREB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'};
/** Reconstruct an *observed* roster and known results at a calendar cutoff.
 * Membership uses appearances through the cutoff, not target-season final teams.
 * Unknown signed nonappearers and future entrants remain outside this observed cohort.
 */
export function historicalSnapshot(games,season,cutoff){
  const all=new Map(),current=new Map(),totals=new Map();
  for(const r of games){
    if(r.season!==season||r.seasonType!=='Regular Season'||!Number.isFinite(r.min))throw new Error('Historical game scope mismatch');
    const game=all.get(r.gameId)||{date:r.gameDate,teams:new Map()};
    const t=game.teams.get(r.team)||{points:0,isHome:r.isHome};t.points+=r.pts;game.teams.set(r.team,t);all.set(r.gameId,game);
  }
  const observed=games.filter(r=>r.gameDate<=cutoff).sort((a,b)=>a.gameDate.localeCompare(b.gameDate)||a.gameId.localeCompare(b.gameId));
  for(const r of observed){
    current.set(r.playerId,r.team);
    const t=totals.get(r.playerId)||{gp:0,...Object.fromEntries(Object.keys(stats).map(k=>[k,0]))};t.gp++;for(const k of Object.keys(stats))t[k]+=r[k];totals.set(r.playerId,t);
  }
  const gameDates=new Map();
  for(const [gameId,g] of all){
    if(g.teams.size!==2)throw new Error('Historical schedule game lacks two sides');
    const sides=[...g.teams].sort(([a],[b])=>a.localeCompare(b));
    const home=sides.find(([,t])=>t.isHome)||sides[0],away=sides.find(([team])=>team!==home[0]);
    const list=gameDates.get(g.date)||[];
    list.push({gameId,gameStatus:g.date<=cutoff?3:1,gameDateEst:g.date+'T00:00:00',gameDateTimeUTC:g.date+'T12:00:00Z',homeTeam:{teamTricode:home[0],score:g.date<=cutoff?home[1].points:0},awayTeam:{teamTricode:away[0],score:g.date<=cutoff?away[1].points:0}});gameDates.set(g.date,list);
  }
  const headers=['PLAYER_ID','GP',...Object.values(stats)];
  const rows=[...totals].sort(([a],[b])=>a-b).map(([id,t])=>[id,t.gp,...Object.keys(stats).map(k=>t[k])]);
  const gameHeaders=['PLAYER_ID','TEAM_ABBREVIATION','GAME_ID',...Object.values(stats)];
  return {current,raw:{season,fetchedAt:cutoff+'T23:59:59.999Z',schedule:{leagueSchedule:{seasonYear:season,leagueId:'00',gameDates:[...gameDates].sort(([a],[b])=>a.localeCompare(b)).map(([date,games])=>({gameDate:date,games}))}},stats:{resultSets:[{name:'LeagueDashPlayerStats',headers,rowSet:rows}]},gameLog:{resultSets:[{headers:gameHeaders,rowSet:observed.map(r=>[r.playerId,r.team,r.gameId,...Object.keys(stats).map(k=>r[k])])}]}}};
}
export function replayForecast({rawInputs,templateCard,entrySource,birthdates,fit,games,season,cutoff}){
  const year=Number(season.slice(0,4)),D=prepare(JSON.parse(rawInputs));
  if(fit.inputsSha256!==crypto.createHash('sha256').update(rawInputs).digest('hex')||fit.season!==season||Number(fit.trainedThrough.slice(0,4))>=year||!fit.evaluationFit)throw new Error('Replay fit violates chronological boundary');
  const {current,raw}=historicalSnapshot(games,season,cutoff);
  const base=JSON.parse(rawInputs),headers=base.playerIndex.headers;
  const teamIds=new Map(base.playerIndex.rows.map(r=>[r[headers.indexOf('TEAM_ABBREVIATION')],r[headers.indexOf('TEAM_ID')]]));
  const sourceById=new Map(base.playerIndex.rows.map(r=>[r[headers.indexOf('PERSON_ID')],r]));
  const roster={season,fetchedAt:raw.fetchedAt,headers,rows:[...current].sort(([a],[b])=>a-b).map(([pid,team])=>{
    const original=sourceById.get(pid);if(!original)throw new Error('Historical roster identity absent from preserved player index');const row=[...original];row[headers.indexOf('TEAM_ABBREVIATION')]=team;row[headers.indexOf('TEAM_ID')]=teamIds.get(team);row[headers.indexOf('ROSTER_STATUS')]=1;return row;
  })};
  const previous=D.nba.seasons.get(seasonName(year-1));
  const data={leagues:{NBA:[...current].map(([pid,team])=>({playerId:String(pid),nbaPersonId:pid,name:D.bio.get(pid).name,position:D.bio.get(pid).position,birthdate:birthdates[String(pid)]?.birthdate||null,currentTeam:team,currentRoster:true,appeared:!!previous.get(pid),seasonTeam:previous.get(pid)?.team||null})),GLEAGUE:[]}};
  const card=structuredClone(templateCard);
  card.nba={...card.nba,...JSON.parse(JSON.stringify(fit.evaluationFit,(k,v)=>typeof v==='number'?Math.round(v*1e4)/1e4:v))};
  // Historical forecasts never consume the later card's test-year residuals or claims.
  card.backtest={protocol:'Chronological shared-code replay',development:'Explicit reconstructed-source boundaries in the evaluation report',nba:{all:{n:0,mae:{}},rotation1000:null,contextReconciliation:null,gainVsBaselines:null,ablation:null,residualBands:null},gleague:{n:0,mae:{},residualBands:null}};
  buildProjections(data,rawInputs,card,{roster,birthdates,targetSeason:season,entryProduction:entrySource,entryCard:fitEntryCard(D,entrySource,year)});
  buildSeasonForecasts(data,raw);
  const future=games.filter(r=>r.gameDate>cutoff),actuals=new Map();
  for(const r of future){const t=actuals.get(r.playerId)||{gp:0,...Object.fromEntries(Object.keys(stats).map(k=>[k,0]))};t.gp++;for(const k of Object.keys(stats))t[k]+=r[k];actuals.set(r.playerId,t);}
  const rows=data.leagues.NBA.map(p=>{
    const c=p.seasonForecast?.remainingSeason,actual=actuals.get(Number(p.playerId))||{gp:0,...Object.fromEntries(Object.keys(stats).map(k=>[k,0]))};
    const hist=projectionHistory(D.nba,Number(p.playerId),season).hist,last=hist.find(Boolean);
    const repeat=last?actualLine(last):null;
    const weights=[1,0.8,0.6];let weight=0;const avg={};
    hist.slice(0,3).forEach((h,i)=>{if(!h?.gp)return;const w=weights[i]*h.min;weight+=w;const line=actualLine(h);for(const k of ['mpg','pts','reb','ast','stl','blk','tov','fg3m'])avg[k]=(avg[k]||0)+w*line[k];});
    if(weight)for(const k of Object.keys(avg))avg[k]/=weight;
    return {playerId:p.playerId,name:p.name,team:p.currentTeam,abstain:!c||p.proj.abstain,
      cohort:{rookie:!!p.proj.why?.rookie,returner:!hist[0]&&!!last,moved:!!last&&last.team!==p.currentTeam,olderFallback:p.proj.basis==='older-history-fallback'},
      model:c?{gp:c.gp,...c.perGame}:null,actual:{gp:actual.gp,mpg:actual.gp?actual.min/actual.gp:null,...Object.fromEntries(['pts','reb','ast','stl','blk','tov','fg3m'].map(k=>[k,actual.gp?actual[k]/actual.gp:null]))},
      repeat:repeat?{...repeat,gp:c?c.teamGamesRemaining*Math.min(1,last.gp/D.nba.teamGames(last.season,last.team)):null}:null,avg3:weight?{...avg,gp:c?c.teamGamesRemaining*Math.min(1,hist.filter(Boolean).slice(0,3).reduce((s,h,i)=>s+weights[i]*h.gp/D.nba.teamGames(h.season,h.team),0)/hist.filter(Boolean).slice(0,3).reduce((s,h,i)=>s+weights[i],0)):null}:null,
      projectedTotals:c?.totals||null,actualTotals:actual};
  });
  return {season,cutoff,rosterPlayers:current.size,unmodeledFuturePlayers:[...actuals.keys()].filter(id=>!current.has(id)).length,rows};
}

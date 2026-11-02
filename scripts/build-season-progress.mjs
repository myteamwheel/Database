import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {forecastReferenceRanges} from './lib/forecast-reference.mjs';
import {parseSeasonProgress} from './lib/season-progress.mjs';
import {adaptRemainingPerGame,combineForecastTimeframes,observedSampleForTeam,perGameFromTotals} from './lib/forecast-timeframes.mjs';
export function buildSeasonForecasts(data,raw,{sourceSha256=null,referenceCard=null}={}){
const progress=parseSeasonProgress(raw.schedule,raw.stats,raw);
const asOf=[progress.fetchedAt,data.injuryMeta?.asOf,data.twoWayRosterMeta?.rosterAsOf].filter(Boolean).sort().at(-1);
const keys=['min','pts','reb','oreb','dreb','ast','stl','blk','tov','fgm','fga','fg3m','fg3a','ftm','fta'];
for(const p of data.leagues.NBA) {
  const actual=progress.players[p.nbaPersonId||p.playerId] || {gp:0,totals:Object.fromEntries(keys.map(k=>[k,0]))};
  p.seasonActual={...actual,perGame:perGameFromTotals(actual.totals,actual.gp),season:progress.season,asOf:progress.fetchedAt};
  const team=progress.teams[p.proj?.team];
  if(!team || !p.currentRoster || !p.proj?.accounting || p.proj.abstain) {
    p.seasonForecast={status:'unavailable',reason:'A verified current NBA team and a statistical forecast are required.',actual};
    continue;
  }
  const a=p.proj.accounting;
  // Stored rates are rounded to nine decimals; reconstruct identities before
  // multiplying by expected games so rounding noise cannot accumulate.
  const observed=observedSampleForTeam(actual,p.proj.team);
  const update=adaptRemainingPerGame({...a,reb:a.oreb+a.dreb,pts:2*a.fgm+a.fg3m+a.ftm},observed.totals,observed.gp);
  const perGame=update.perGame;
  const futureOut=(p.reportedAvailability||[]).filter(entry=>entry.status==='Out'&&
    raw.schedule.leagueSchedule.gameDates.some(day=>day.games.some(game=>game.gameId.startsWith('002'+progress.season.slice(2,4))&&game.gameStatus!==3&&game.gameDateEst?.slice(0,10)===entry.gameDate&&`${game.awayTeam.teamTricode}@${game.homeTeam.teamTricode}`===entry.matchup)));
  const missedGames=new Set(futureOut.map(entry=>`${entry.gameDate}:${entry.matchup}`)).size;
  const appearanceRate=Math.min(1,a.gp/82);
  const contractRemaining=p.rosterContext?.contract==='two-way'?Math.max(0,50-actual.gp):Infinity;
  const remainingGp=Math.min(contractRemaining,Math.max(0,(82-team.completed-missedGames)*appearanceRate));
  p.seasonForecast=combineForecastTimeframes({season:progress.season,asOf,scheduledGames:82,
    actual:{...actual,teamGamesElapsed:team.completed,playerGamesAvailable:Math.max(actual.gp,team.completed)},
    remaining:{gp:remainingGp,perGame}});
  if(referenceCard)p.seasonForecast.referenceRanges=forecastReferenceRanges(p.seasonForecast,referenceCard,{cohort:p.proj.why?.rookie?'rookies':p.proj.basis==='older-history-fallback'?'olderFallback':p.proj.why?.minutes?.last===null?'returners':p.proj.status==='new'?'movers':'all'});
  p.seasonForecast.availability={reportedOutGames:missedGames,expectedGamesReduction:missedGames*appearanceRate,source:data.injuryMeta?.source||null};
  p.seasonForecast.roleUpdate={method:'observed-rate-shrinkage-v1',observedGames:update.observedGames,observedScope:observed.scope,volumeWeight:update.weight,
    priorStrengthGames:{minutes:10,assists:10,turnovers:10,otherCounts:20},
    prior:'preseason statistical projection',observed:'official current-season player totals',
    limitation:'Only games with the projected team update future per-game rate after a trade. This does not verify future usage, lineup, medical clearance or recovery duration.'};
  const plays=perGame.fga+0.44*perGame.fta+perGame.tov,teamPace=p.proj.why?.team?.pace,leaguePlays=p.proj.why?.team?.leaguePlaysPer100;
  const onCourtTeamPlays=perGame.mpg*teamPace/48*leaguePlays*5/100;
  p.seasonForecast.roleUpdate.projectedUsage=onCourtTeamPlays>0?Math.max(0,Math.min(1,plays/onCourtTeamPlays)):null;
  p.seasonForecast.roleUpdate.projectedRole=perGame.mpg>=28?'core rotation':perGame.mpg>=18?'regular rotation':perGame.mpg>=10?'reserve rotation':'limited role';
  p.seasonForecast.roleUpdate.usageDefinition='Estimated share of on-court team shooting possessions ending in a field-goal attempt, free-throw trip or turnover; blends own observed current-team counts with the preseason team-context prior. This is a model estimate, not verified future coach intent.';
  p.seasonForecast.assumption='Remaining games use the preseason appearance rate, exclude upcoming games officially listed Out, and apply a two-way ceiling when verified. Active-but-unused two-way games are unavailable, so the true remaining eligibility may be lower. Per-game rates blend the preseason forecast with official current-season performance, using stronger shrinkage for noisy shooting and rebounds. This does not establish a future role or recovery date.';
}
data.seasonProgress={version:progress.version,season:progress.season,asOf:progress.fetchedAt,status:progress.status,completedGames:progress.completedGames,teams:progress.teams,sourceSha256,sources:[progress.scheduleSource,progress.statsSource,progress.gameLogSource].filter(Boolean),sourceCorrections:progress.sourceCorrections};
return data;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
  const file=path.join(root,'public/data.json'),bytes=fs.readFileSync(path.join(root,'scripts/data/live/season-progress.json'));
  const data=JSON.parse(fs.readFileSync(file)),raw=JSON.parse(bytes);
  buildSeasonForecasts(data,raw,{sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),referenceCard:JSON.parse(fs.readFileSync(path.join(root,'FORECAST_REFERENCE_RANGES.json')))});
  fs.writeFileSync(file,JSON.stringify(data));
  console.log(`Built ${data.seasonProgress.season} actual/remaining/combined views; ${data.seasonProgress.completedGames} completed regular-season games.`);
}

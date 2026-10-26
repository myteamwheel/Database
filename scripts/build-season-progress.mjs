import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseSeasonProgress} from './lib/season-progress.mjs';
import {combineForecastTimeframes,perGameFromTotals} from './lib/forecast-timeframes.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'scripts/data/live/season-progress.json');
const bytes=fs.readFileSync(source);
const raw=JSON.parse(bytes);
const progress=parseSeasonProgress(raw.schedule,raw.stats,raw);
const file=path.join(root,'public/data.json');
const data=JSON.parse(fs.readFileSync(file,'utf8'));
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
  const perGame={...a,reb:a.oreb+a.dreb,pts:2*a.fgm+a.fg3m+a.ftm};
  const futureOut=(p.reportedAvailability||[]).filter(entry=>entry.status==='Out'&&
    raw.schedule.leagueSchedule.gameDates.some(day=>day.games.some(game=>game.gameId.startsWith('00226')&&game.gameStatus!==3&&game.gameDateEst?.slice(0,10)===entry.gameDate&&`${game.awayTeam.teamTricode}@${game.homeTeam.teamTricode}`===entry.matchup)));
  const missedGames=new Set(futureOut.map(entry=>`${entry.gameDate}:${entry.matchup}`)).size;
  const appearanceRate=Math.min(1,a.gp/82);
  const contractRemaining=p.rosterContext?.contract==='two-way'?Math.max(0,50-actual.gp):Infinity;
  const remainingGp=Math.min(contractRemaining,Math.max(0,(82-team.completed-missedGames)*appearanceRate));
  p.seasonForecast=combineForecastTimeframes({season:progress.season,asOf,scheduledGames:82,
    actual:{...actual,teamGamesElapsed:team.completed,playerGamesAvailable:Math.max(actual.gp,team.completed)},
    remaining:{gp:remainingGp,perGame}});
  p.seasonForecast.availability={reportedOutGames:missedGames,expectedGamesReduction:missedGames*appearanceRate,source:data.injuryMeta?.source||null};
  p.seasonForecast.assumption='Remaining games use the preseason appearance rate, exclude upcoming games officially listed Out, and apply a two-way ceiling when verified. Active-but-unused two-way games are unavailable, so the true remaining eligibility may be lower. Per-game estimates retain the preseason model; the report does not establish a longer-term recovery date.';
}
data.seasonProgress={version:progress.version,season:progress.season,asOf:progress.fetchedAt,status:progress.status,completedGames:progress.completedGames,teams:progress.teams,sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),sources:[progress.scheduleSource,progress.statsSource]};
fs.writeFileSync(file,JSON.stringify(data));
console.log(`Built ${progress.season} actual/remaining/combined views; ${progress.completedGames} completed regular-season games.`);

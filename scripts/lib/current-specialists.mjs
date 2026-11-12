import {officialJobs} from '../fetch-official.mjs';
import {officialRows} from './official-table.mjs';
import {windowedUrl,apiDate} from './completed-window.mjs';
export const SPECIALIST_SCOPES=[['00','Regular Season'],['20','Showcase'],['20','Regular Season']];
export function specialistJobs(leagueId,seasonType,cutoff){
  const jobs=officialJobs(leagueId,'2026-27',seasonType).filter(j=>['misc','scoring','usage','defense','fourfactors','base_per100','hustle'].includes(j.name)||j.name.startsWith('pt_'));
  const base=officialJobs(leagueId,'2026-27',seasonType).find(j=>j.name==='base_totals');
  const clutch=new URL(base.url);clutch.pathname='/stats/leaguedashplayerclutch';for(const [k,v]of Object.entries({AheadBehind:'Ahead or Behind',ClutchTime:'Last 5 Minutes',PointDiff:'5',PerMode:'Totals'}))clutch.searchParams.set(k,v);jobs.push({name:'sit_clutch',url:clutch.href});
  for(const [name,extra]of [['home',{Location:'Home'}],['road',{Location:'Road'}],['wins',{Outcome:'W'}],['losses',{Outcome:'L'}],['starter',{StarterBench:'Starters'}],['bench',{StarterBench:'Bench'}],['preallstar',{SeasonSegment:'Pre All-Star'}],['postallstar',{SeasonSegment:'Post All-Star'}],...Array.from({length:12},(_,i)=>['month'+(i+1),{Month:String(i+1)}])]){const u=new URL(base.url);for(const [k,v]of Object.entries(extra))u.searchParams.set(k,v);jobs.push({name:'sit_'+name,url:u.href});}
  for(const name of ['clutch','home','road','wins','losses']){const j=jobs.find(j=>j.name==='sit_'+name),u=new URL(j.url);u.searchParams.set('MeasureType','Advanced');jobs.push({name:'sita_'+name,url:u.href});}
  return jobs.map(j=>{const u=new URL(windowedUrl(j.url,cutoff));u.hostname='stats.gleague.nba.com';if(j.name==='defense')u.searchParams.set('PerMode','Totals');return {name:j.name,url:u.href,leagueId,seasonType};});
}
export function validateSpecialist(payload,job,cutoff){
  const p=payload?.parameters,u=new URL(job.url);
  if(u.hostname!=='stats.gleague.nba.com'||u.searchParams.get('Season')!=='2026-27'||u.searchParams.get('DateTo')!==apiDate(cutoff)||!p||String(p.LeagueID)!==job.leagueId||(p.Season??p.SeasonYear)!=='2026-27'||p.SeasonType!==job.seasonType||p.DateTo!==apiDate(cutoff))throw Error('Specialist source season/league/window mismatch');
  const rows=officialRows(payload),seen=new Set();for(const row of rows){if(seen.has(row.PLAYER_ID))throw Error('Duplicate specialist player');seen.add(row.PLAYER_ID);if(row.GP!=null&&(!Number.isFinite(row.GP)||row.GP<0))throw Error('Invalid specialist exposure');}
  return rows;
}
export function specialistMaps(snapshot,leagueId,seasonType,cutoff){
  if(!snapshot)return {};
  if(snapshot.season!=='2026-27'||snapshot.completedThrough!==cutoff)throw Error('Specialist statistics do not share the completed-game cutoff');
  return Object.fromEntries(snapshot.records.filter(r=>r.leagueId===leagueId&&r.seasonType===seasonType&&r.status==='available').map(r=>{const map=new Map(validateSpecialist(r.payload,r,cutoff).map(p=>[p.PLAYER_ID,p]));map.perMode=new URL(r.url).searchParams.get('PerMode');return [r.name,map];}));
}
export function specialistStats(maps,id,league='NBA'){
  const out={};const identity=new Set(['PLAYER_ID','PLAYER_NAME','TEAM_ID','TEAM_ABBREVIATION','NICKNAME','CFID','CFPARAMS']);
  for(const [name,rows]of Object.entries(maps)){const row=rows.get(id);if(!row)continue;const prefix={misc:'omisc',scoring:'oscore',usage:'ousage',defense:'odef'}[name]||name.replace(/^pt_/,'trk_').replace(/^sita_/,'sit_');for(const [k,v]of Object.entries(row))if(!identity.has(k)&&!k.endsWith('_RANK'))out[prefix+'_'+k.toLowerCase()]=v;
    if(name.startsWith('sit_')){const gp=row.GP,divisor=rows.perMode==='Totals'?gp:1;for(const k of ['PTS','REB','AST','STL','BLK','TOV','FGA','FGM','FG3M','FG3A','FTM','FTA'])out[prefix+'_'+k.toLowerCase()]=gp>0&&Number.isFinite(row[k])?row[k]/divisor:null;out[prefix+'_mpg']=gp>0?row.MIN/divisor:null;out[prefix+'_plusminus']=gp>0&&Number.isFinite(row.PLUS_MINUS)?row.PLUS_MINUS/divisor:null;out[prefix+'_ts']=league==='NBA'&&row.FGA+0.44*row.FTA>0?row.PTS/(2*(row.FGA+0.44*row.FTA)):null;}
    if(name.startsWith('sita_'))out[prefix+'_ts']=row.TS_PCT??null;
  }
  return out;
}

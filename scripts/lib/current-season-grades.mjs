import {buildGrade,GRADE_MODEL_VERSION} from './grades.mjs';
import {normalize} from './metrics.mjs';
export function advancedTable(payload,{leagueId,seasonType,season='2026-27'}){
 const p=payload?.parameters;
 if(!p||String(p.LeagueID)!==leagueId||p.Season!==season||p.SeasonType!==seasonType||p.MeasureType!=='Advanced'||p.PerMode!=='Totals')throw new Error('Current advanced source scope mismatch');
 const t=payload.resultSets?.find(t=>t.name==='LeagueDashPlayerStats');
 const needed=['PLAYER_ID','GP','MIN','USG_PCT','AST_PCT','AST_RATIO','OREB_PCT','DREB_PCT','DEF_RATING','NET_RATING','PIE'];
 if(!Array.isArray(t?.rowSet)||!Array.isArray(t?.headers)||new Set(t.headers).size!==t.headers.length||needed.some(k=>!t.headers.includes(k)))throw new Error('Current advanced schema mismatch');
 const out=new Map();for(const row of t.rowSet){const r=Object.fromEntries(t.headers.map((k,i)=>[k,row[i]]));if(row.length!==t.headers.length||!Number.isSafeInteger(r.PLAYER_ID)||r.PLAYER_ID<=0||out.has(r.PLAYER_ID)||!Number.isSafeInteger(r.GP)||r.GP<1||!Number.isFinite(r.MIN)||r.MIN<0||needed.slice(3).some(k=>r[k]!==null&&!Number.isFinite(r[k])))throw new Error('Invalid current advanced identity/value');out.set(r.PLAYER_ID,r);}return out;
}
export function gradeCurrentRows(players,actualById,baseTable,advanced){
 const ix=Object.fromEntries(baseTable.headers.map((k,i)=>[k,i]));
 const base=new Map(baseTable.rowSet.map(r=>[r[ix.PLAYER_ID],Object.fromEntries(baseTable.headers.map((k,i)=>[k,r[i]]))]));
 const publishedIds=new Set(players.map(p=>Number(p.nbaPersonId||p.playerId)));if(Object.keys(actualById).some(id=>!publishedIds.has(Number(id))))throw new Error('Measured participant missing from database');
 const eligible=players.filter(p=>actualById[p.nbaPersonId||p.playerId]?.gp>0),norm=[];
 for(const p of eligible){const id=Number(p.nbaPersonId||p.playerId),a=actualById[id],b=base.get(id),v=advanced.get(id);if(!b||!v||v.GP!==a.gp)throw new Error('Current grade base/advanced exposure mismatch');
  const t={...b,...Object.fromEntries(Object.entries(a.totals).map(([k,v])=>[{min:'MIN',pts:'PTS',oreb:'OREB',dreb:'DREB',reb:'REB',ast:'AST',stl:'STL',blk:'BLK',tov:'TOV',fgm:'FGM',fga:'FGA',fg3m:'FG3M',fg3a:'FG3A',ftm:'FTM',fta:'FTA'}[k]||k,v])),GP:a.gp};
  const ratio=(n,d)=>d>0?n/d:null;
  const ex={FG2M:t.FGM-t.FG3M,FG2A:t.FGA-t.FG3A,TS_PCT:p.league==='GLEAGUE'?v.TS_PCT:ratio(t.PTS,2*(t.FGA+0.44*t.FTA)),EFG_PCT:ratio(t.FGM+0.5*t.FG3M,t.FGA),FG_PCT:ratio(t.FGM,t.FGA),FG3_PCT:ratio(t.FG3M,t.FG3A),FT_PCT:ratio(t.FTM,t.FTA),AST_TO:ratio(t.AST,t.TOV)};
  norm.push(normalize({totals:t,advanced:v,exact:ex,defense:{},scoring:{},misc:{},usage:{}}));
 }
 if(!eligible.length)return new Map();
 const g=buildGrade(eligible,norm),r=buildGrade(eligible,norm,{basis:'per36'}),m=buildGrade(eligible,norm,{mode:'robust'});
 return new Map(eligible.map((p,i)=>[String(p.playerId),{version:GRADE_MODEL_VERSION,grade:g.grade[i],rateGrade:r.grade[i],magnitudeGrade:m.grade[i],reliability:g.reliability[i],components:g.components[i],coverage:g.overallCoverage[i],componentCoverage:g.coverage[i],K:g.model.K,usg:norm[i].usg,pie:norm[i].pie,netRtg:norm[i].netRtg,ts:norm[i].ts,fgPct:norm[i].fgPct,fg3Pct:norm[i].fg3Pct,ftPct:norm[i].ftPct}]));
}

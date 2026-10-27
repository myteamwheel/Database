import {verifyLiveRosterSnapshot} from './live-roster.mjs';
export const INJURY_PAGE='https://official.nba.com/nba-injury-report-2026-27-season/';
const TEAMS={'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN','Charlotte Hornets':'CHA','Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE','Dallas Mavericks':'DAL','Denver Nuggets':'DEN','Detroit Pistons':'DET','Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND','LA Clippers':'LAC','Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM','Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN','New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC','Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX','Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS','Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WAS'};
const normalized=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const join=items=>items.sort((a,b)=>b.y-a.y||a.x-b.x).map(i=>i.text.trim()).filter(Boolean).join(' ');
const eastParts=ms=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));

export function injuryReportTimestamp(url) {
  const m=/^https:\/\/ak-static\.cms\.nba\.com\/referee\/injury\/Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf$/.exec(url);
  if(!m)throw new Error('Invalid official injury report URL');
  const [year,month,day,hour12,minute]=m.slice(1,6).map(Number),hour=hour12%12+(m[6]==='PM'?12:0);
  if(hour12<1||hour12>12||minute>59)throw new Error('Invalid injury report time');
  const wall=Date.UTC(year,month-1,day,hour,minute);
  let utc=wall;
  for(let i=0;i<3;i++){const p=eastParts(utc);utc+=wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);}
  const p=eastParts(utc);
  if(p.year!==year||p.month!==month||p.day!==day||p.hour!==hour||p.minute!==minute)throw new Error('Invalid injury report date');
  return new Date(utc).toISOString();
}

export function latestInjuryReport(html,asOf) {
  const now=Date.parse(asOf);if(!Number.isFinite(now))throw new Error('Invalid report fetch date');
  const links=[...new Set([...html.matchAll(/https:\/\/ak-static\.cms\.nba\.com\/referee\/injury\/Injury-Report_[^"<>\s]+\.pdf/g)].map(m=>m[0]))];
  const valid=links.map(url=>({url,at:injuryReportTimestamp(url)})).filter(r=>Date.parse(r.at)<=now).sort((a,b)=>b.at.localeCompare(a.at));
  if(!valid.length || now-Date.parse(valid[0].at)>48*3600000)throw new Error('Current official injury report unavailable or stale');
  return valid[0];
}

/** Parse columns by their printed headers, then attach reason lines to the
 * nearest status row. PDF pages retain inherited game/team context. */
export function parseInjuryReportPages(pages,{source,asOf}) {
  const reportAt=injuryReportTimestamp(source);
  if(!Number.isFinite(Date.parse(asOf))||!Array.isArray(pages)||!pages.length)throw new Error('Invalid injury report snapshot');
  if(Date.parse(reportAt)>Date.parse(asOf)||Date.parse(asOf)-Date.parse(reportAt)>48*3600000)throw new Error('Future or stale injury report');
  const stamp=/_(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf$/.exec(source);
  const expectedBanner=`InjuryReport:${stamp[2]}/${stamp[3]}/${stamp[1].slice(2)}${stamp[4]}:${stamp[5]}${stamp[6]}`;
  let team=null,gameDate=null,matchup=null,columns=null;
  const rows=[],notSubmitted=[];
  for(const page of pages) {
    const items=page.filter(i=>typeof i.text==='string'&&i.text.trim());
    if(items.some(i=>!Number.isFinite(i.x)||!Number.isFinite(i.y)))throw new Error('Invalid PDF coordinates');
    const printedPlayer=items.find(i=>i.text.trim()==='Player');
    if(printedPlayer)columns={playerHeader:printedPlayer,statusHeader:items.find(i=>i.text.trim()==='Current'),reasonHeader:items.find(i=>i.text.trim()==='Reason'),teamHeader:items.find(i=>i.text.trim()==='Team'),matchHeader:items.find(i=>i.text.trim()==='Matchup')};
    if(!columns||Object.values(columns).some(v=>!v))throw new Error('Injury table headers unavailable');
    const {playerHeader,statusHeader,reasonHeader,teamHeader,matchHeader}=columns;
    const banner=items.find(i=>i.text.trim()==='Injury');
    if(!banner)throw new Error('Missing injury report page banner');
    if(!join(items.filter(i=>i.y>=banner.y-1)).replace(/\s/g,'').includes(expectedBanner))throw new Error('Injury report banner does not match source timestamp');
    const ceiling=printedPlayer?printedPlayer.y-2:banner.y-15;
    const body=items.filter(i=>i.y<ceiling&&i.y>65);
    const anchors=body.filter(i=>(i.x>=statusHeader.x-2&&i.x<reasonHeader.x-2&&/^(Out|Doubtful|Questionable|Probable|Available)$/.test(i.text.trim()))||(i.x>=reasonHeader.x-2&&i.text.trim()==='NOT'));
    anchors.sort((a,b)=>b.y-a.y);
    const contexts=body.filter(i=>i.x<playerHeader.x-2).sort((a,b)=>b.y-a.y||a.x-b.x);
    let cursor=0;
    for(let j=0;j<anchors.length;j++) {
      const anchor=anchors[j],upper=j?(anchors[j-1].y+anchor.y)/2:ceiling,lower=j<anchors.length-1?(anchor.y+anchors[j+1].y)/2:65;
      while(cursor<contexts.length&&contexts[cursor].y>=anchor.y-1) {
        const lineY=contexts[cursor].y,line=[];
        while(cursor<contexts.length&&Math.abs(contexts[cursor].y-lineY)<1)line.push(contexts[cursor++]);
        const t=join(line.filter(i=>i.x>=teamHeader.x-2));if(t){if(!TEAMS[t])throw new Error(`Unknown injury team: ${t}`);team=TEAMS[t];}
        const date=join(line.filter(i=>i.x<matchHeader.x-2)).match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);if(date)gameDate=`${date[3]}-${date[1]}-${date[2]}`;
        const m=join(line.filter(i=>i.x>=matchHeader.x-2&&i.x<teamHeader.x-2));if(m)matchup=m;
      }
      if(!team||!gameDate||!matchup)throw new Error('Injury row lacks game/team context');
      const band=body.filter(i=>i.y<upper&&i.y>lower);
      const reason=join(band.filter(i=>i.x>=reasonHeader.x-2));
      if(anchor.text.trim()==='NOT'){if(!reason.includes('NOT YET SUBMITTED'))throw new Error('Unknown team report state');notSubmitted.push({team,gameDate,matchup});continue;}
      const name=join(band.filter(i=>i.x>=playerHeader.x-2&&i.x<statusHeader.x-2));
      if(!name||!reason)throw new Error('Injury row missing name/reason');
      rows.push({team,gameDate,matchup,name,status:anchor.text.trim(),reason});
    }
  }
  if(!rows.length&&!notSubmitted.length)throw new Error('Empty injury report');
  return {source,asOf,reportAt:injuryReportTimestamp(source),rows,notSubmitted};
}

export function reconcileInjuries(report,roster) {
  const verified=verifyLiveRosterSnapshot(roster),ix=Object.fromEntries(verified.headers.map((h,i)=>[h,i]));
  const byName=new Map();
  for(const row of verified.rows){const key=normalized(`${row[ix.PLAYER_FIRST_NAME]} ${row[ix.PLAYER_LAST_NAME]}`);const list=byName.get(key)||[];list.push(row);byName.set(key,list);}
  const confirmed=[],unresolved=[];
  for(const entry of report.rows){
    const parts=entry.name.split(',').map(x=>x.trim());
    const name=parts.length>1?[parts.at(-1),...parts.slice(0,-1)].join(' '):entry.name;
    const matches=(byName.get(normalized(name))||[]).filter(r=>r[ix.TEAM_ABBREVIATION]===entry.team);
    if(matches.length!==1){unresolved.push(entry);continue;}
    confirmed.push({...entry,playerId:matches[0][ix.PERSON_ID]});
  }
  return {...report,confirmed,unresolved,rosterAsOf:verified.fetchedAt};
}

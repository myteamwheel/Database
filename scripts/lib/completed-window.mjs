// All endpoints share one New York basketball-day boundary. A live game must
// never mix into one player's base totals but not his advanced/ tracking inputs.
export function previousDay(date){return new Date(Date.parse(date+'T12:00:00Z')-86400000).toISOString().slice(0,10);}
export function completedDay({now=new Date(),schedule=null,gameLogs=[]}={}){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  let cutoff=previousDay(`${parts.year}-${parts.month}-${parts.day}`);
  for(const day of schedule?.leagueSchedule?.gameDates||[])for(const g of day.games||[]){const date=(g.gameDateEst||g.gameDateTimeEst||'').slice(0,10);if(g.gameStatus===2&&date&&date<=cutoff)cutoff=previousDay(date);}
  for(const payload of gameLogs){const t=payload?.resultSets?.[0];if(!t)throw Error('Missing completed-window team game log');const date=t.headers.indexOf('GAME_DATE'),wl=t.headers.indexOf('WL');if(date<0||wl<0)throw Error('Missing completed-window game status');for(const row of t.rowSet){const d=String(row[date]).slice(0,10);if(!['W','L'].includes(row[wl])&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<=cutoff)cutoff=previousDay(d);}}
  return cutoff;
}
export function apiDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Invalid statistics cutoff');const [y,m,d]=date.split('-');return `${m}/${d}/${y}`;}
export function gameInWindow(game,cutoff){return !cutoff||String(game.gameDateEst||game.gameDateTimeEst||game.gameDateTimeUTC).slice(0,10)<=cutoff;}
export function windowedUrl(value,cutoff){const u=new URL(value);u.searchParams.set('DateTo',apiDate(cutoff));return u.href;}

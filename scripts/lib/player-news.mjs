export const NEWS_URL='https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=100';
export const newsNameKey=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function parsePlayerNews(payload,{asOf}={}) {
  const now=Date.parse(asOf);
  if(!Number.isFinite(now)||!Array.isArray(payload?.articles)||!payload.articles.length)throw new Error('Invalid/empty news source');
  const seen=new Set(),articles=[];
  for(const a of payload.articles) {
    if(!Number.isSafeInteger(a.id)||seen.has(a.id))throw new Error('Invalid/duplicate news ID');
    seen.add(a.id);
    if(typeof a.headline!=='string'||!a.headline.trim()||typeof a.published!=='string'||!Number.isFinite(Date.parse(a.published))||Date.parse(a.published)>now)throw new Error('Invalid news date/headline');
    const url=new URL(a.links?.web?.href);
    if(url.protocol==='http:'&&['www.espn.com','www.espn.co.uk'].includes(url.hostname))url.protocol='https:';
    if(url.protocol!=='https:'||!['www.espn.com','www.espn.co.uk'].includes(url.hostname)||url.username||url.password)throw new Error('Invalid news attribution URL');
    const names=(a.categories||[]).filter(c=>c.type==='athlete'&&c.sportId===46).map(c=>c.athlete?.description||c.description);
    if(names.some(n=>typeof n!=='string'||!n.trim()))throw new Error('Invalid news athlete');
    articles.push({id:a.id,headline:a.headline,published:a.published,url:url.href,athletes:[...new Set(names)]});
  }
  articles.sort((a,b)=>b.published.localeCompare(a.published)||a.id-b.id);
  if(now-Date.parse(articles[0].published)>7*86400000)throw new Error('News source is stale');
  return {source:NEWS_URL,asOf,articles};
}

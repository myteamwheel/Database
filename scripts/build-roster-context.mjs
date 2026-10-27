import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseTwoWayTable,reconcileTwoWayRoster} from './lib/two-way-roster.mjs';
import {parseInjuryReportPages,reconcileInjuries} from './lib/injury-report.mjs';
import {parsePlayerNews,newsNameKey} from './lib/player-news.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const raw=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/live/two-way-roster.json'),'utf8'));
const roster=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/live/roster.json'),'utf8'));
const result=reconcileTwoWayRoster(parseTwoWayTable(raw.html,raw),roster);
const file=path.join(root,'public/data.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));
const byId=new Map(result.confirmed.map(p=>[String(p.playerId),p]));
for(const p of [...data.leagues.NBA,...data.leagues.GLEAGUE]) {
  const match=byId.get(String(p.nbaPersonId));
  p.rosterContext=match?{contract:'two-way',nbaTeam:match.team,gLeagueAffiliate:match.affiliate,assignmentStatus:'unverified',source:result.source,asOf:result.fetchedAt,rosterAsOf:result.rosterFetchedAt}:null;
}
data.twoWayRosterMeta={season:result.season,asOf:result.fetchedAt,rosterAsOf:result.rosterFetchedAt,confirmed:result.confirmed.length,unresolved:result.unresolved,source:result.source};
data.twoWayRosterMeta.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'scripts/data/live/two-way-roster.json'))).digest('hex');
const newsFile=path.join(root,'scripts/data/live/news.json');
if(fs.existsSync(newsFile)) {
  const snapshot=JSON.parse(fs.readFileSync(newsFile,'utf8')),news=parsePlayerNews(snapshot.payload,snapshot);
  for(const p of [...data.leagues.NBA,...data.leagues.GLEAGUE])p.recentNews=news.articles.filter(a=>a.athletes.some(n=>newsNameKey(n)===newsNameKey(p.name))).slice(0,3);
  data.newsMeta={source:news.source,asOf:news.asOf,articles:news.articles.length,newestPublished:news.articles[0].published,scope:'Latest ESPN NBA feed, up to 50 articles. Only explicitly tagged athlete names are joined; no article is not evidence that no news exists.'};
  data.newsMeta.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(newsFile)).digest('hex');
}
const injuryFile=path.join(root,'scripts/data/live/injuries.json');
if(fs.existsSync(injuryFile)) {
  const snapshot=JSON.parse(fs.readFileSync(injuryFile,'utf8'));
  if(crypto.createHash('sha256').update(Buffer.from(snapshot.pdfBase64,'base64')).digest('hex')!==snapshot.pdfSha256)throw new Error('Injury PDF hash mismatch');
  const injuries=reconcileInjuries(parseInjuryReportPages(snapshot.pages,snapshot),roster);
  const index=new Map();
  for(const entry of injuries.confirmed){const list=index.get(String(entry.playerId))||[];list.push(entry);index.set(String(entry.playerId),list);}
  for(const p of [...data.leagues.NBA,...data.leagues.GLEAGUE])p.reportedAvailability=(index.get(String(p.nbaPersonId))||[]).map(entry=>({...entry,asOf:injuries.asOf,reportAt:injuries.reportAt,source:injuries.source}));
  data.injuryMeta={source:injuries.source,asOf:injuries.asOf,reportAt:injuries.reportAt,confirmed:injuries.confirmed.length,unresolved:injuries.unresolved,notSubmitted:injuries.notSubmitted,pdfSha256:snapshot.pdfSha256};
  data.injuryMeta.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(injuryFile)).digest('hex');
}
fs.writeFileSync(file,JSON.stringify(data));
console.log(`Confirmed ${result.confirmed.length} two-way contracts; ${result.unresolved.length} source discrepancies remain explicit.`);

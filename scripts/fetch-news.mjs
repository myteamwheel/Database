import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NEWS_URL,parsePlayerNews} from './lib/player-news.mjs';
const response=await fetch(NEWS_URL,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error(`News HTTP ${response.status}`);
const payload=await response.json(),asOf=new Date().toISOString();
const parsed=parsePlayerNews(payload,{asOf});
const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'data/live/news.json'),temp=`${file}.tmp-${process.pid}`;
try{fs.writeFileSync(temp,JSON.stringify({asOf,payload})+'\n');fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.rmSync(temp);}
console.log(`Fetched ${parsed.articles.length} ESPN news links; player joins use tagged athlete names.`);

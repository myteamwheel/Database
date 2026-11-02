import {runDailyRefresh} from './lib/daily-refresh.mjs';
const r=await runDailyRefresh({root:new URL('..',import.meta.url).pathname});console.log(JSON.stringify(r,null,2));if(r.state!=='verified-ready-to-publish')process.exit(1);

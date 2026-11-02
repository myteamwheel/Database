import fs from 'node:fs';import {verifyDailyFreshness} from './lib/daily-refresh.mjs';
console.log('Daily source freshness and current-grade coverage verified',verifyDailyFreshness(JSON.parse(fs.readFileSync('public/data.json'))));

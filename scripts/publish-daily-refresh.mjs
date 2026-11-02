import fs from 'node:fs';import {execFileSync} from 'node:child_process';
import {DAILY_SOURCE_FILES,DAILY_ARTIFACT_FILES,verifyDailyFreshness} from './lib/daily-refresh.mjs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const record=JSON.parse(fs.readFileSync('scripts/data/refresh-runs/daily-latest.json'));
if(process.env.GITHUB_REF!=='refs/heads/v3-official-data'||record.state!=='verified-ready-to-publish')throw new Error('Only a verified production refresh may publish');
verifyDailyFreshness(JSON.parse(fs.readFileSync('public/data.json')));
const expected=git('rev-parse','HEAD');git('fetch','origin','v3-official-data');
if(git('rev-parse','FETCH_HEAD')!==expected)throw new Error('Production changed during refresh; retain live release and rerun against the new source');
// Explicit allowlist: never commit training cards, historical statistics or code
// generated/modified by a dependency during ingestion.
git('add','--',...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES);
const staged=git('diff','--cached','--name-only').split('\n').filter(Boolean),allowed=new Set([...DAILY_SOURCE_FILES,...DAILY_ARTIFACT_FILES]);
if(staged.some(f=>!allowed.has(f)))throw new Error('Unexpected daily publication file');
if(staged.length){git('config','user.name','github-actions[bot]');git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');git('commit','-m','Refresh verified NBA and G League results '+record.finishedAt);git('-c','http.postBuffer=524288000','push','origin','HEAD:refs/heads/v3-official-data');}
console.log('Verified current-season snapshot ready for Pages deployment');

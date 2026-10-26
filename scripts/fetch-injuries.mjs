import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {INJURY_PAGE,injuryReportTimestamp,latestInjuryReport,parseInjuryReportPages,reconcileInjuries} from './lib/injury-report.mjs';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const request=async url=>{const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Injury source HTTP ${r.status}`);return r;};
const asOf=new Date().toISOString(),html=await(await request(INJURY_PAGE)).text();
const selected=latestInjuryReport(html,asOf);
const bytes=new Uint8Array(await(await request(selected.url)).arrayBuffer());
const task=getDocument({data:bytes.slice(),useSystemFonts:true,disableFontFace:true});
const doc=await task.promise;
const pages=[];
try{for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),text=await page.getTextContent();pages.push(text.items.filter(i=>i.str?.trim()).map(i=>({text:i.str,x:i.transform[4],y:i.transform[5]})));}}finally{await task.destroy();}
const result=parseInjuryReportPages(pages,{source:selected.url,asOf});
const roster=JSON.parse(fs.readFileSync(path.join(root,'scripts/data/live/roster.json'),'utf8'));
const matched=reconcileInjuries(result,roster);
const file=path.join(root,'scripts/data/live/injuries.json'),temporary=`${file}.tmp-${process.pid}`;
const snapshot={version:1,source:selected.url,asOf,pdfSha256:crypto.createHash('sha256').update(bytes).digest('hex'),pdfBase64:Buffer.from(bytes).toString('base64'),pages};
if(fs.existsSync(file)){const previous=JSON.parse(fs.readFileSync(file));if(injuryReportTimestamp(previous.source)>selected.at)throw new Error('Injury source moved backwards');}
try{fs.writeFileSync(temporary,JSON.stringify(snapshot)+'\n');fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.rmSync(temporary);}
console.log(JSON.stringify({reportAt:result.reportAt,rows:result.rows.length,confirmed:matched.confirmed.length,unresolved:matched.unresolved,notSubmitted:result.notSubmitted}));

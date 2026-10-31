// As-of game-level test of a simple prior/current-sample update. The prior is the
// preceding season's measured per-game rate, not the shipped forecast, so this
// evaluates the update rule only and cannot certify the complete projection stack.
import fs from 'node:fs';
import zlib from 'node:zlib';
const product=JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../public/history-games.json.gz',import.meta.url))));
const ix=Object.fromEntries(product.rowSchema.map((k,i)=>[k,i]));
const byPlayer=Object.values(product.byPlayer);
const keys=['minutes','pts','reb','ast'];
const windows=[3,5,10,20,40],strengths=[5,10,20,40,80,160];
const seasons=['2021-22','2022-23','2023-24','2024-25'];
const rows=[];
for(const records of byPlayer){
  for(let si=1;si<seasons.length;si++){
    const season=seasons[si],prior=seasons[si-1];
    const prev=records.filter(r=>r[ix.season]===prior&&r[ix.seasonType]==='Regular Season');
    const cur=records.filter(r=>r[ix.season]===season&&r[ix.seasonType]==='Regular Season').sort((a,b)=>String(a[ix.gameDate]).localeCompare(String(b[ix.gameDate]))||String(a[ix.gameId]).localeCompare(String(b[ix.gameId])));
    if(prev.length<20||cur.length<55)continue;
    for(const n of windows){
      const first=cur.slice(0,n),rest=cur.slice(n);
      if(rest.length<15)continue;
      for(const key of keys){
        const at=ix[key],mean=list=>list.reduce((s,r)=>s+Number(r[at]||0),0)/list.length;
        rows.push({season,n,key,prior:mean(prev),early:mean(first),future:mean(rest)});
      }
    }
  }
}
const mae=(list,k)=>list.reduce((s,r)=>s+Math.abs((r.prior*k+r.early*r.n)/(k+r.n)-r.future),0)/list.length;
const baseline=list=>list.reduce((s,r)=>s+Math.abs(r.prior-r.future),0)/list.length;
const results=[];
for(const n of windows)for(const key of keys){
  const train=rows.filter(r=>r.n===n&&r.key===key&&r.season!=='2024-25');
  const test=rows.filter(r=>r.n===n&&r.key===key&&r.season==='2024-25');
  if(train.length<100||test.length<30)throw new Error(`Insufficient ${key}/${n} holdout rows`);
  const k=strengths.map(k=>({k,loss:mae(train,k)})).sort((a,b)=>a.loss-b.loss||a.k-b.k)[0].k;
  results.push({firstGames:n,stat:key,trainN:train.length,testN:test.length,priorStrength:k,priorMae:+baseline(test).toFixed(3),updatedMae:+mae(test,k).toFixed(3),maeDelta:+(mae(test,k)-baseline(test)).toFixed(3)});
}
console.log(JSON.stringify({method:'Chronological preceding-season prior; first N target games observed; future target games held out. Earlier seasons choose strength, 2024-25 evaluates. This tests the update rule only, not the shipped model.',results},null,2));

const ABSENT='\u0000~';
// Keep specialist fields lossless without repeating hundreds of field names for
// every player. This also keeps daily data files below GitHub's per-file limit.
export function packCurrentStatistics(data){
 if(data.currentStatColumns){unpackCurrentStatistics(data);delete data.currentStatColumns;}
 const columns={};
 for(const [lg,players]of Object.entries(data.leagues))for(const p of players)for(const [phase,g]of Object.entries(p.currentGrades||{})){const scope=lg+':'+phase;columns[scope]??=new Set();for(const k of Object.keys(g.stats||{}))columns[scope].add(k);}
 data.currentStatColumns=Object.fromEntries(Object.entries(columns).map(([k,v])=>[k,[...v].sort()]));
 for(const [lg,players]of Object.entries(data.leagues))for(const p of players)for(const [phase,g]of Object.entries(p.currentGrades||{}))if(g.stats&&Object.keys(g.stats).length)g.stats=data.currentStatColumns[lg+':'+phase].map(k=>Object.hasOwn(g.stats,k)?g.stats[k]:ABSENT);
 return data;
}
export function unpackCurrentStatistics(data){
 if(!data.currentStatColumns)return data;
 for(const [lg,players]of Object.entries(data.leagues))for(const p of players)for(const [phase,g]of Object.entries(p.currentGrades||{}))if(Array.isArray(g.stats)){const keys=data.currentStatColumns[lg+':'+phase];if(!keys||keys.length!==g.stats.length)throw Error('Current specialist column schema mismatch');g.stats=Object.fromEntries(keys.flatMap((k,i)=>g.stats[i]===ABSENT?[]:[[k,g.stats[i]]]));}
 return data;
}

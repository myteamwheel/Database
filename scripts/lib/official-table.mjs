import fs from 'node:fs';

/** A missing response is not an empty, successfully fetched table. */
export function officialRows(body) {
  const table=Array.isArray(body?.resultSets)?body.resultSets[0]:body?.resultSets;
  if(!table||!Array.isArray(table.headers)||!table.headers.length||!Array.isArray(table.rowSet)) throw new Error('Malformed official result table');
  if(table.headers.some(h=>typeof h!=='string'||!h)||new Set(table.headers).size!==table.headers.length) throw new Error('Invalid official table headers');
  if(!table.headers.includes('PLAYER_ID')) throw new Error('Official player table missing PLAYER_ID');
  const rows=table.rowSet.map(row=>{
    if(!Array.isArray(row)||row.length!==table.headers.length)throw new Error('Invalid official table row width');
    const out=Object.fromEntries(table.headers.map((h,i)=>[h,row[i]]));
    if(!Number.isSafeInteger(out.PLAYER_ID)||out.PLAYER_ID<=0)throw new Error('Invalid official player identity');
    return out;
  });
  return rows;
}

export function writeAtomicJson(filename,value) {
  const bytes=JSON.stringify(value);
  if(bytes===undefined)throw new Error('Cannot publish undefined source');
  const count=v=>Array.isArray(v)?v.length:(Array.isArray(v?.resultSets)?v.resultSets[0]:v?.resultSets)?.rowSet?.length;
  if(count(value)===0&&fs.existsSync(filename)&&count(JSON.parse(fs.readFileSync(filename,'utf8')))>0) throw new Error('Refusing empty replacement of populated source; previous cache retained');
  const temp=`${filename}.tmp-${process.pid}`;
  try {fs.writeFileSync(temp,bytes);fs.renameSync(temp,filename);}
  finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

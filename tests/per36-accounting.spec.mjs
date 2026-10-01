import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const source=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url),'utf8'));
const PAGE=process.env.ACCOUNTING_TEST_URL||'file://'+fileURLToPath(new URL('../public/standalone.html',import.meta.url));
const metrics={pts:'PTS/36',reb:'REB/36',ast:'AST/36',stl:'STL/36',blk:'BLK/36',tov:'TOV/36',fg3:'3PM/36'};
for(const league of ['NBA','GLEAGUE'])test(`${league}: every per-36 table and CSV rate uses precise official exposure`,async({page})=>{
  await page.goto(PAGE);await page.waitForSelector('#tableBody tr [data-player]');
  if(league==='GLEAGUE')await page.click('.league-tab[data-league="GLEAGUE"]');
  await page.selectOption('#viewPreset','per36');
  await page.locator('.more-filters > summary').click();await page.check('#includeRosterOnly');
  await page.selectOption('#rowLimit','9999');
  const headerKeys=await page.locator('#tableHead th').evaluateAll(headers=>headers.map(h=>h.dataset.sort));
  expect(headerKeys).toContain('gp');expect(headerKeys).toContain('minutes');
  const rendered=await page.locator('#tableBody tr').evaluateAll(rows=>{
    const keys=[...document.querySelectorAll('#tableHead th')].map(h=>h.dataset.sort);
    return rows.map(r=>({id:r.querySelector('[data-player]').dataset.player,cells:Object.fromEntries(keys.map((k,i)=>[k,r.children[i].textContent.trim()]))}));
  });
  const pending=page.waitForEvent('download');await page.click('#exportBtn');
  let text='';for await(const chunk of await(await pending).createReadStream())text+=chunk.toString();
  const [headers,...csv]=text.trimEnd().split('\n').map(line=>[...line.matchAll(/"((?:[^"\n]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"')));
  const players=new Map(source.leagues[league].map(p=>[String(p.playerId),p]));
  expect(rendered.length).toBe(players.size);expect(csv.length).toBe(players.size);
  for(const [i,row]of rendered.entries()){
    const p=players.get(row.id);expect(csv[i][headers.indexOf('Player')]).toBe(p.name);
    for(const [key,label]of Object.entries(metrics)){
      const total=p.stats?.[`off_${key==='fg3'?'fg3m':key}`];
      const expected=p.appeared&&Number.isFinite(total)&&p.minutes>=1?(total*36/p.minutes).toFixed(1):'—';
      expect(row.cells[`p36.${key}`],`${p.name}: ${key}`).toBe(expected);
      const exported=csv[i][headers.indexOf(label)];
      if(expected==='—')expect(exported,`${p.name}: missing ${key}`).toBe('');
      else {expect(exported,`${p.name}: measured ${key}`).not.toBe('');expect(Number(exported),`${p.name}: exported ${key}`).toBe(Number(expected));}
    }
  }
  const help=await page.evaluate(()=>colDef('p36.pts').help);
  expect(help).toContain('precise season minutes');expect(help).not.toContain('/ MPG');
});

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
for(const league of ['NBA','GLEAGUE'])test(`${league}: scoped per-36 lines retain precise stint totals in UI and CSV`,async({page})=>{
  await page.goto(PAGE);await page.waitForSelector('#tableBody tr [data-player]');
  if(league==='GLEAGUE')await page.click('.league-tab[data-league="GLEAGUE"]');
  else await page.selectOption('#rosterScope','season');
  await page.selectOption('#viewPreset','per36');await page.locator('.more-filters > summary').click();
  await page.selectOption('#rowLimit','9999');await page.selectOption('#teamMode','only');
  const players=source.leagues[league], target=players.find(p=>p.teams?.length>1&&(league!=='NBA'||p.teams.some(s=>s.team===p.currentTeam)));
  expect(target).toBeTruthy();
  const allScoped=await page.evaluate(league=>DATA.leagues[league].flatMap(p=>(p.teams||[]).map(s=>({id:p.playerId,team:s.team,values:teamScoped(p,s.team,'only').per36}))),league);
  expect(allScoped.length).toBe(players.reduce((sum,p)=>sum+(p.teams||[]).length,0));
  for(const row of allScoped){const stint=players.find(p=>p.playerId===row.id).teams.find(s=>s.team===row.team);for(const key of Object.keys(metrics))expect(row.values[key]??null).toBe(stint.per36[key]??null);expect(row.values.ts??null).toBeNull();}
  for(const stint of target.teams.filter(s=>league!=='NBA'||s.team===target.currentTeam)){
    await page.selectOption('#teamFilter',stint.team);
    const rendered=await page.locator('#tableBody tr').evaluateAll(rows=>{const keys=[...document.querySelectorAll('#tableHead th')].map(h=>h.dataset.sort);return rows.map(r=>({id:r.querySelector('[data-player]').dataset.player,cells:Object.fromEntries(keys.map((k,i)=>[k,r.children[i].textContent.trim()]))}));});
    expect(rendered.some(r=>r.id===target.playerId)).toBe(true);
    const pending=page.waitForEvent('download');await page.click('#exportBtn');let text='';for await(const chunk of await(await pending).createReadStream())text+=chunk.toString();
    const [headers,...csv]=text.trimEnd().split('\n').map(line=>[...line.matchAll(/"((?:[^"\n]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"')));
    expect(csv.length).toBe(rendered.length);
    for(const [i,row]of rendered.entries()){const p=players.find(p=>p.playerId===row.id),s=p.teams?.find(s=>s.team===stint.team);if(!s)continue;
      for(const [key,label]of Object.entries(metrics)){const value=s.per36[key],display=Number.isFinite(value)?value.toFixed(1):'—';expect(row.cells[`p36.${key}`],`${p.name}/${stint.team}/${key}`).toBe(display);const exported=csv[i][headers.indexOf(label)];if(display==='—')expect(exported).toBe('');else expect(Number(exported)).toBe(Number(display));}
    }
  }
});

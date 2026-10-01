import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const PAGE=process.env.VALUE_TEST_URL||'file://'+fileURLToPath(new URL('../public/standalone.html',import.meta.url));
const source=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url),'utf8'));
test.beforeEach(async({page})=>{
  await page.goto(PAGE);
  await page.waitForFunction(()=>window.DATA&&document.querySelector('#tableBody tr td'));
});

test('numeric displays preserve zero and reject missing, boolean and whitespace values',async({page})=>{
  const results=await page.evaluate(()=>{
    const types=['int','pct','pctPoints','signed1','signed2','2','3','grade','1'];
    return types.map(type=>({type,zero:fmt(0,type),missing:[null,undefined,NaN,'',' ',false,true,[]].map(v=>fmt(v,type))}));
  });
  for(const row of results){
    expect(row.zero).not.toBe('—');
    expect(Number(row.zero.replace('%',''))).toBe(0);
    expect(row.missing).toEqual(Array(8).fill('—'));
  }
  expect(await page.evaluate(()=>fmt(0,'text'))).toBe('0');
});

test('current-roster grades are N/A in table and export and excluded by a positive minimum',async({page})=>{
  await page.locator('.more-filters > summary').click();
  await page.selectOption('#rosterScope','current');
  await page.selectOption('#rowLimit','9999');
  for(const order of ['1','-1']){
    await page.selectOption('#sortField','grade');
    await page.selectOption('#sortOrder',order);
    const rows=await page.locator('#tableBody tr').evaluateAll(rows=>rows.map(r=>({
      id:r.querySelector('[data-player]').dataset.player,
      grade:r.querySelector('td.grade').textContent,
      className:r.querySelector('td.grade').className,
    })));
    const expected=source.leagues.NBA.filter(p=>p.currentRoster);
    expect(rows.length).toBe(expected.length);
    let seenMissing=false;
    for(const row of rows){
      const p=expected.find(p=>String(p.playerId)===row.id);
      if(p.grade==null){
        seenMissing=true;
        expect(row.grade).toBe('N/A');
        expect(row.className).not.toMatch(/low|elite|strong|mid/);
      } else {
        expect(seenMissing).toBe(false);
        expect(Number(row.grade)).toBeCloseTo(p.grade,4);
      }
    }
  }
  const pending=page.waitForEvent('download');
  await page.click('#exportBtn');
  const stream=await(await pending).createReadStream();let csv='';
  for await(const chunk of stream)csv+=chunk.toString();
  const lines=csv.trimEnd().split('\n').map(line=>[...line.matchAll(/"((?:[^"\n]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"')));
  const [headers,...rows]=lines;
  for(const p of source.leagues.NBA.filter(p=>p.currentRoster&&!p.appeared)){
    const row=rows.find(row=>row[headers.indexOf('Player')]===p.name);
    expect(row[headers.indexOf('Grade')]).toBe('N/A');
    expect(row[headers.indexOf('Overall')]).toBe('N/A');
  }
  await page.fill('#minGrade','5');
  await page.locator('#minGrade').press('Tab');
  await expect(page.locator('#resultCount')).toHaveText(String(source.leagues.NBA.filter(p=>p.currentRoster&&p.grade!=null&&p.grade>=5).length));
  const ids=await page.locator('#tableBody [data-player]').evaluateAll(nodes=>nodes.map(n=>n.dataset.player));
  expect(ids.slice().sort()).toEqual(source.leagues.NBA.filter(p=>p.currentRoster&&p.grade!=null&&p.grade>=5).map(p=>String(p.playerId)).sort());
});

test('empty filter values cannot silently become zero and genuine zero is accepted',async({page})=>{
  await page.locator('.more-filters > summary').click();
  await page.click('#addRuleBtn');
  await page.selectOption('#ruleMetric','pts');
  await page.fill('#ruleValue','');
  await page.click('#saveRuleBtn');
  await expect(page.locator('#ruleDialog')).toHaveAttribute('open','');
  await expect(page.locator('.rule-chip')).toHaveCount(0);
  await page.fill('#ruleValue','0');
  await page.click('#saveRuleBtn');
  await expect(page.locator('#ruleDialog')).not.toHaveAttribute('open','');
  await expect(page.locator('.rule-chip')).toContainText('0');
  expect(await page.evaluate(()=>applyRules({pts:0}))).toBe(true);
  expect(await page.evaluate(()=>applyRules({pts:null}))).toBe(false);
});

test('comparison shows an ungraded player as N/A without a winner or a fabricated skill bar',async({page})=>{
  const ids=source.leagues.NBA;
  const ungraded=ids.find(p=>p.currentRoster&&!p.appeared),graded=ids.find(p=>p.grade>0&&Object.keys(p.skillProfile||{}).length);
  await page.evaluate(([a,b])=>{
    compared=new Set([a,b]);
    window.__wsSetMode('compare',false);
  },[graded.playerId,ungraded.playerId]);
  const row=page.locator('#workspace tr').filter({has:page.locator('td.left',{hasText:/^Grade$/})});
  await expect(row.locator('td').last()).toHaveText('N/A');
  await expect(row.locator('td').last()).not.toHaveClass(/winner/);
  await expect(page.locator('#workspace .cmp-axis .tiny').first()).toHaveText('—');
});

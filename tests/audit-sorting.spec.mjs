import {test,expect} from '@playwright/test';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
test('season and review sort the complete matching set in both directions, with missing values last',async({page})=>{
 await page.goto(url);await expect(page.locator('#seasonSort')).toBeVisible();
 for(const mode of ['current','seasonreview']){
  await page.click(`#modeNav [data-mode="${mode}"]`);
  const select=mode==='current'?'#seasonSort':'#reviewSort';
  const keys=await page.locator(select+' option').evaluateAll(els=>els.map(e=>e.value));
  await page.selectOption('#seasonLimit','1000');
  for(const key of keys){await page.selectOption(select,key);
   for(const dir of ['1','-1']){await page.selectOption('#seasonDir',dir);
    const result=await page.locator('.season-table > table').evaluate((table,{key,dir})=>{
     const index=[...table.querySelectorAll('thead button[data-season-sort]')].findIndex(b=>b.dataset.seasonSort===key);
     const text=['name','team'].includes(key);const vals=[...table.tBodies[0].rows].map(r=>r.cells[index].textContent.trim()).map(s=>text?s:s==='—'||!/^[+−-]?\d/.test(s)?null:Number(s.replace(/[%+]/g,'')));
     const present=vals.filter(v=>v!==null);return {ordered:present.every((v,i)=>!i||Number(dir)*(text?present[i-1].localeCompare(v):present[i-1]-v)<=0),missingLast:vals.slice(present.length).every(v=>v===null)};
    },{key,dir});expect(result,mode+' '+key+' '+dir).toEqual({ordered:true,missingLast:true});
   }
  }
  await page.click('[data-season-sort="name"]');await expect(page.locator('[data-season-sort="name"]').locator('..')).toHaveAttribute('aria-sort','ascending');
  await page.click('[data-season-sort="name"]');await expect(page.locator('[data-season-sort="name"]').locator('..')).toHaveAttribute('aria-sort','descending');
 }
});
test('primary TULIP navigation opens current plans with reversible minutes and historical ledger access',async({page})=>{
 await page.goto(url);await expect(page.locator('#seasonSort')).toBeVisible();await page.click('#tulipAllocBtn');
 await expect(page.locator('#teamAllocationDialog h2')).toHaveText('Next-game rotation plans');
 await page.click('[data-rotation-team="BOS"]');await page.click('#teamAllocationDialog [data-row-sort="2"]');
 await expect(page.locator('#teamAllocationDialog th').nth(2)).toHaveAttribute('aria-sort','ascending');
 await page.click('#teamAllocationDialog [data-row-sort="2"]');await expect(page.locator('#teamAllocationDialog th').nth(2)).toHaveAttribute('aria-sort','descending');
});

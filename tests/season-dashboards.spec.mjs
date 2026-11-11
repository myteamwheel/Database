import {test,expect} from '@playwright/test';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
async function open(page){const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await expect(page.locator('#seasonYear')).toBeVisible();return errors;}
test('both seasons share ledgers with distinct statistics and grades',async({page})=>{
 const errors=await open(page);const p=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.currentRoster&&p.currentGrades['Regular Season'].grade!==null));
 await page.fill('#seasonSearch',p.name);await expect(page.locator('.season-grade').first()).toHaveText((Math.floor(p.currentGrades['Regular Season'].grade*10000)/10000).toFixed(4));
 await page.selectOption('#seasonYear','2025-26');await expect(page.locator('.season-grade').first()).toHaveText((Math.floor(p.grade*10000)/10000).toFixed(4));
 for(const ledger of ['overall','scoring','playmaking','rebounding','defense','components','per36']){await page.selectOption('#seasonLedger',ledger);const before=await page.locator('.season-table thead').innerText();await page.selectOption('#seasonYear','2026-27');expect((await page.locator('.season-table thead').innerText()).replaceAll('2026–27','YEAR')).toBe(before.replaceAll('2025–26','YEAR'));await page.selectOption('#seasonYear','2025-26');}
 expect(errors).toEqual([]);
});
test('frozen 2026 forecasts compare with current results and sort accurate first',async({page})=>{
 const errors=await open(page);await page.click('#modeNav [data-mode="seasonreview"]');await expect(page.locator('.season-hero')).toContainText('2026-09-29');await expect(page.locator('#sourceLine')).toContainText('2026–27');
 const p=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.seasonActual.gp>0&&DATA.savedForecastReview.leagues.NBA.some(f=>f.playerId===String(p.playerId)&&f.projection)));
 const f=await page.evaluate(id=>DATA.savedForecastReview.leagues.NBA.find(f=>f.playerId===String(id)),p.playerId);
 await page.fill('#seasonSearch',p.name);const row=page.locator('.season-table > table > tbody > tr').first();await expect(row.locator('td').nth(2)).toHaveText(f.projection.pts.toFixed(1));await expect(row.locator('td').nth(3)).toHaveText(p.seasonActual.perGame.pts.toFixed(1));
 await page.fill('#seasonSearch','');await page.selectOption('#seasonLimit','1000');const vals=(await page.locator('.season-table > table > tbody > tr > td:nth-child(6)').allTextContents()).filter(s=>s!=='—').map(Number);expect(vals.every((v,i)=>!i||v>=vals[i-1])).toBe(true);
 const pending=page.waitForEvent('download');await page.click('#seasonExport');expect((await pending).suggestedFilename()).toContain('2026-27_saved-forecast-accuracy');expect(errors).toEqual([]);
});
test('G League phases stay separate and phone layout fits',async({page})=>{
 const errors=await open(page);await page.click('.league-tab[data-league="GLEAGUE"]');await page.selectOption('#seasonPhase','Regular Season');await expect(page.locator('.season-table > table > tbody > tr').first()).toContainText('Not modeled');
 await page.click('#modeNav [data-mode="seasonreview"]');await page.selectOption('#seasonPhase','Showcase');await expect(page.locator('.season-hero')).toContainText('Showcase G League');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
});

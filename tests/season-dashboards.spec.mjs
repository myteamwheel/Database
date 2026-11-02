import {test,expect} from '@playwright/test';import {fileURLToPath} from 'node:url';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
async function open(page){const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await expect(page.locator('.season-dashboard')).toBeVisible();return errors;}
test('current season opens first, uses actual current grades and exposes rotation TULIP',async({page})=>{
 const errors=await open(page);await expect(page.locator('#modeNav button').nth(0)).toHaveAttribute('data-mode','current');await expect(page.locator('#modeNav button').nth(1)).toHaveAttribute('data-mode','seasonreview');
 await expect(page.locator('.season-hero h2')).toContainText('Current results');await expect(page.locator('.season-table > table > thead')).toContainText('2026–27 Grade');await expect(page.locator('.season-table > table > thead')).toContainText('Rotation TULIP');
 const p=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.currentRoster&&p.currentGrades['Regular Season'].grade!==null));
 await page.fill('#seasonSearch',p.name);const row=page.locator('.season-table tbody tr').first();await expect(row).toContainText(String(p.seasonActual.gp));await expect(row.locator('.season-grade')).toHaveText((Math.floor(p.currentGrades['Regular Season'].grade*10000)/10000).toFixed(4));
 expect(p.currentGrades['Regular Season'].grade).not.toBe(p.grade);expect(errors).toEqual([]);
});
test('second tab compares the correct 2025 season and clearly distinguishes a reconstructed forecast from an archive',async({page})=>{
 const errors=await open(page);await page.click('#modeNav [data-mode="seasonreview"]');await expect(page.locator('.season-notice')).toContainText('not a saved 2025–26 prediction release');await expect(page.locator('.season-summary')).toContainText('mean absolute error');
 const p=await page.evaluate(()=>DATA.seasonReview.leagues.NBA.rows.find(p=>p.model));await page.fill('#seasonSearch',p.name);await expect(page.locator('.season-table tbody tr').first()).toContainText(p.actual.pts.toFixed(1));
 await page.selectOption('#reviewMetric','boxGrade');await expect(page.locator('.season-table > table > thead')).toContainText('Comparable box-score grade');
 const pending=page.waitForEvent('download');await page.click('#seasonExport');expect((await pending).suggestedFilename()).toContain('2025-26_retrospective-review');expect(errors).toEqual([]);
});
test('G League current phases have no invented grades and its review compares regular-season metrics',async({page})=>{
 const errors=await open(page);await page.click('.league-tab[data-league="GLEAGUE"]');await expect(page.locator('.season-notice')).toContainText('No published player results');
 await expect(page.locator('.season-grade').first()).toHaveText('—');await page.selectOption('#seasonPhase','Regular Season');await expect(page.locator('.season-notice')).toBeVisible();
 await page.click('#modeNav [data-mode="seasonreview"]');await expect(page.locator('.season-hero')).toContainText('G League regular-season');await expect(page.locator('.season-table > table > thead')).toContainText('Combined-season grade');
 const p=await page.evaluate(()=>DATA.seasonReview.leagues.GLEAGUE.rows.find(p=>p.model));await page.fill('#seasonSearch',p.name);await expect(page.locator('.season-table tbody tr').first()).toContainText(p.actual.pts.toFixed(1));expect(errors).toEqual([]);
});
test('season tabs fit a phone and preserve their explicit deep links',async({page})=>{
 const errors=await open(page);await page.setViewportSize({width:390,height:844});await page.click('#modeNav [data-mode="seasonreview"]');if(url.startsWith('file:'))await page.goto(url+'?mode=seasonreview');else await page.reload();await expect(page.locator('.season-hero h2')).toContainText('How close');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
});

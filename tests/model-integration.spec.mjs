import {legacyDatabaseUrl} from './helpers/legacy-database-url.mjs';
import {test,expect} from '@playwright/test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const PAGE=process.env.MODEL_INTEGRATION_URL||'file://'+path.join(ROOT,'public/standalone.html');
async function open(page){const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(legacyDatabaseUrl(PAGE));await page.waitForFunction(()=>window.DATA?.rotationPlans&&document.querySelector('#tableBody tr td'));return errors;}
test('next-game TULIP reconciles both rotations and exposes constraints',async({page})=>{
 const errors=await open(page);await page.selectOption('#viewPreset','tuliprotation');
 await expect(page.locator('#pageTitle')).toHaveText('2026-27 TULIP Rotation Plans');
 await expect(page.locator('#rosterScope')).toHaveValue('current');
 const target=await page.evaluate(()=>DATA.leagues.NBA.find(p=>!p.tulipRotation?.abstain&&Number.isFinite(p.tulipRotation?.tulip)));
 expect(target).toBeTruthy();await page.evaluate(id=>openPlayer(id),target.playerId);
 await expect(page.locator('#playerDialogBody')).toContainText('Measured 2026-27 MPG');
 await page.locator('#playerDialogBody [data-rotation-team]').first().click();
 const dialog=page.locator('#teamAllocationDialog');await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('240 minutes allocated');
 await expect(dialog.locator('thead')).toContainText('PG');
 const totals=await dialog.locator('tbody tr').evaluateAll(rows=>rows.reduce((a,r)=>a+Number(r.cells[2].textContent),0));expect(totals).toBe(240);
 expect(errors).toEqual([]);
});
test('current G League membership follows all 31 team sources, and phases export missing averages honestly',async({page})=>{
 const errors=await open(page);await page.click('.league-tab[data-league="GLEAGUE"]');await page.selectOption('#rosterScope','current');
 const sourceCount=await page.evaluate(()=>DATA.leagues.GLEAGUE.filter(p=>p.currentGLeagueRosterTeam).length);
 await expect(page.locator('#resultCount')).toHaveText(sourceCount.toLocaleString('en-US'));
 const target=await page.evaluate(()=>DATA.leagues.GLEAGUE.find(p=>p.currentGLeagueRosterTeam&&p.appeared&&p.gLeagueSeasonActual));
 await page.evaluate(id=>openPlayer(id),target.playerId);
 const phases=page.locator('#playerDialogBody details').filter({has:page.locator('summary',{hasText:'G League results by competition'})});
 await phases.locator('summary').click();await expect(phases).toContainText('Tip-Off Tournament');await expect(phases).toContainText('Regular season');
 const download=page.waitForEvent('download');await phases.locator('[data-gl-season-export]').click();expect((await download).suggestedFilename()).toContain('_gleague_phases.csv');
 expect(errors).toEqual([]);
});
test('rookie college evidence and remaining ranges are collapsed and readable on a phone',async({page})=>{
 const errors=await open(page);await page.setViewportSize({width:390,height:844});
 const target=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.proj?.why?.rookie?.production&&p.seasonForecast?.referenceRanges));
 expect(target).toBeTruthy();await page.evaluate(id=>openPlayer(id),target.playerId);
 const dialog=page.locator('#playerDialogBody');await expect(dialog).toContainText('College production.');
 await dialog.locator('details.proj-season-progress > summary').click();
 const ranges=dialog.locator('details.proj-ranges').filter({has:page.locator('summary',{hasText:'Remaining-season reference ranges'})});
 await expect(ranges).not.toHaveAttribute('open','');
 await ranges.locator('summary').click();await expect(ranges).toContainText('Historical cohort coverage');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
});

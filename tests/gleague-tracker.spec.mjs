import {test,expect} from '@playwright/test';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
test('G League tracker exposes every current listing with sources and separately collapsed historical leads',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await expect(page.locator('#seasonSort')).toBeVisible();await page.click('.league-tab[data-league="GLEAGUE"]');
 const panel=page.locator('#gLeagueRosterTracker');await expect(panel).not.toHaveAttribute('open','');await panel.locator(':scope > summary').click();
 const tracker=await page.evaluate(()=>DATA.gLeagueTracker);
 await expect(panel.locator('[data-season-player]')).toHaveCount(tracker.summary.listed);
 await expect(panel.locator(':scope > .ws-disclosure')).toHaveCount(31);
 const ids=await panel.locator('[data-season-player]').evaluateAll(bs=>bs.map(b=>Number(b.dataset.seasonPlayer)));
 expect(ids.slice().sort((a,b)=>a-b)).toEqual(tracker.records.filter(r=>r.listed).map(r=>r.playerId).sort((a,b)=>a-b));
 const first=panel.locator(':scope > .ws-disclosure').first();await first.locator(':scope > summary').click();
 await first.locator('[data-row-sort="4"]').click();await expect(first.locator('th').nth(4)).toHaveAttribute('aria-sort','descending');
 await first.locator('[data-row-sort="4"]').click();await expect(first.locator('th').nth(4)).toHaveAttribute('aria-sort','ascending');
 await first.locator('[data-season-player]').first().click();await expect(page.locator('#playerDialogBody')).toContainText('2026–27');await page.locator('#playerDialog').evaluate(d=>d.close());
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
});

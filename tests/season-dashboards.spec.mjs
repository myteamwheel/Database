import {test,expect} from '@playwright/test';
const url=process.env.SEASON_DASHBOARD_URL||new URL('../public/standalone.html',import.meta.url).href;
async function open(page){const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await expect(page.locator('#seasonYear')).toBeVisible();return errors;}
test('both seasons share ledgers with distinct statistics and grades',async({page})=>{
 const errors=await open(page);const p=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.currentRoster&&p.currentGrades['Regular Season'].grade!==null));
 await page.fill('#seasonSearch',p.name);await expect(page.locator('.season-grade').first()).toHaveText(p.currentGrades['Regular Season'].grade.toFixed(4));
 await page.selectOption('#seasonYear','2025-26');await expect(page.locator('.season-grade').first()).toHaveText(p.grade.toFixed(4));
 for(const ledger of ['overall','scoring','playmaking','rebounding','defense','components','per36']){await page.selectOption('#seasonLedger',ledger);const before=await page.locator('.season-table thead').innerText();await page.selectOption('#seasonYear','2026-27');expect((await page.locator('.season-table thead').innerText()).replaceAll('2026–27','YEAR')).toBe(before.replaceAll('2025–26','YEAR'));await page.selectOption('#seasonYear','2025-26');}
 expect(errors).toEqual([]);
});
test('current usage uses percentage points and historical navigation resets projections',async({page})=>{
 const errors=await open(page);
 const p=await page.evaluate(()=>DATA.leagues.NBA.find(p=>p.seasonActual?.gp>0&&Number.isFinite(p.currentGrades?.['Regular Season']?.usg)));
 await page.fill('#seasonSearch',p.name);
 const headings=await page.locator('.season-table > table > thead th').allTextContents();
 const index=headings.findIndex(h=>h.includes('USG'));expect(index).toBeGreaterThan(-1);
 await expect(page.locator('.season-table > table > tbody > tr').first().locator('td').nth(index)).toHaveText((p.currentGrades['Regular Season'].usg*100).toFixed(1)+'%');
 await page.click('[data-goto="proj"]');await expect(page.locator('#rosterScope')).toHaveValue('current');
 await page.click('#modeNav [data-mode="database"]');await expect(page.locator('#viewPreset')).toHaveValue('overall');await expect(page.locator('#rosterScope')).toHaveValue('season');
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
 const errors=await open(page);await page.click('.league-tab[data-league="GLEAGUE"]');await page.selectOption('#seasonPhase','Regular Season');const phaseCount=await page.evaluate(()=>DATA.gLeagueSeasonProgress.phases['Regular Season'].players);
 if(!phaseCount)await expect(page.locator('.season-table > table > tbody > tr').first()).toContainText('No games');
 await page.click('#modeNav [data-mode="seasonreview"]');await page.selectOption('#seasonPhase','Showcase');await expect(page.locator('.season-hero')).toContainText('Showcase G League');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);expect(errors).toEqual([]);
});

test('G League rotation agrees across ledger, filters, player card and CSV',async({page})=>{
 const errors=await open(page);
 const schema=()=>page.locator('.season-table thead [data-season-sort]').evaluateAll(cells=>cells.map(c=>c.dataset.seasonSort));
 await page.selectOption('#seasonYear','2025-26');const historical=await schema();
 await page.click('.league-tab[data-league="GLEAGUE"]');await page.selectOption('#seasonYear','2026-27');
 expect(await schema()).toEqual(historical);
 const {p,phase}=await page.evaluate(()=>({p:DATA.leagues.GLEAGUE.find(p=>Number.isFinite(p.tulipRotation?.tulip)),phase:DATA.gLeagueRotationMeta.phase}));
 if(!p){expect(await page.evaluate(()=>DATA.gLeagueRotationMeta.scores)).toBe(0);return;}
 await page.click('#tulipAllocBtn');const dialog=page.locator('#teamAllocationDialog');
 await expect(dialog.locator('[data-rotation-team]')).toHaveCount(31);
 await dialog.locator('[data-rotation-team="'+p.currentGLeagueRosterTeam+'"]').click();
 await expect(dialog).toContainText('240 minutes allocated');await dialog.locator('[data-ta-close]').click();
 await page.selectOption('#seasonPhase',phase);await page.selectOption('#seasonTeam',p.currentGLeagueRosterTeam);
 const keys=await schema(),col=keys.indexOf('tulip'),row=page.locator('.season-table > table > tbody > tr').filter({has:page.locator('[data-season-player="'+p.playerId+'"]')});
 expect(Number(await row.locator('td').nth(col).textContent())).toBe(p.tulipRotation.tulip);
 for(const dir of ['-1','1']){
   await page.selectOption('#seasonSort','tulip');await page.selectOption('#seasonDir',dir);
   const values=(await page.locator('.season-table tbody tr').evaluateAll((rows,i)=>rows.map(r=>Number(r.cells[i].textContent)),col)).filter(Number.isFinite);
   expect(values.every((v,i)=>!i||(v-values[i-1])*Number(dir)>=0)).toBe(true);
 }
 await page.fill('#seasonSearch',p.name);
 const download=page.waitForEvent('download');await page.click('#seasonExport');
 const stream=await (await download).createReadStream();let csv='';for await(const chunk of stream)csv+=chunk;
 const cells=csv.trim().split('\n')[1].slice(1,-1).split('","');
 expect(Number(cells[col+4])).toBe(p.tulipRotation.tulip);
 await row.locator('[data-season-player]').click();
 await expect(page.locator('#playerDialogBody')).toContainText('planned minutes: '+p.tulipRotation.recommendedMpg.toFixed(1));
 expect(errors).toEqual([]);
});

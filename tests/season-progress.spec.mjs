import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const source=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url)));
const url=new URL('../public/standalone.html',import.meta.url).href;
async function open(page){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForSelector('#tableBody tr td');
  await page.locator('[data-goto="current"]').click();return errors;
}
test('current-season tables render all three timeframes and export the selected view',async({page})=>{
  const errors=await open(page);
  for(const [preset,label] of [['actual2627','actual'],['remaining2627','remaining'],['combined2627','combined']]){
    await page.selectOption('#viewPreset',preset);
    await expect(page.locator('#seasonProgressNote')).toBeVisible();
    await expect(page.locator('#tableBody tr').first()).toBeVisible();
    const pending=page.waitForEvent('download');await page.click('#exportBtn');
    const download=await pending;expect(download.suggestedFilename()).toContain(`nba_2026-27_${label}`);
    const stream=await download.createReadStream();let csv='';for await(const chunk of stream)csv+=chunk;
    expect(csv.split('\n').length).toBeGreaterThan(400);
    expect(csv).not.toMatch(/NaN|undefined/);
  }
  expect(errors).toEqual([]);
});
test('season progress stays collapsed, opens by keyboard and exports every timeframe',async({page})=>{
  const errors=await open(page);
  const p=source.leagues.NBA.find(p=>p.seasonForecast?.fullSeason&&p.seasonActual.gp>0);
  await page.evaluate(id=>openPlayer(id),p.playerId);
  const detail=page.locator('#playerDialogBody .proj-season-progress');
  await expect(detail).not.toHaveAttribute('open','');
  await detail.locator('summary').focus();await page.keyboard.press('Enter');
  await expect(detail).toHaveAttribute('open','');
  await expect(detail).toContainText('Actual to date');
  const row=detail.locator('tbody tr').filter({has:page.locator('th',{hasText:'Points'})});
  const values=await row.locator('td').allTextContents();
  expect(values).toEqual(['actualToDate','remainingSeason','fullSeason'].map(k=>p.seasonForecast[k].perGame.pts.toFixed(1)));
  const pending=page.waitForEvent('download');await detail.locator('[data-season-export]').click();
  const stream=await(await pending).createReadStream();let csv='';for await(const chunk of stream)csv+=chunk;
  for(const k of ['actualToDate','remainingSeason','fullSeason'])expect(csv).toContain(k);
  expect(csv).not.toMatch(/undefined|NaN/);expect(errors).toEqual([]);
});

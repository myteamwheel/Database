import {legacyDatabaseUrl} from './helpers/legacy-database-url.mjs';
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const PAGE = process.env.COMPARISON_TEST_URL || 'file://' + fileURLToPath(new URL('../public/standalone.html',import.meta.url));
const data = JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url),'utf8'));

for(const league of ['NBA','GLEAGUE']) {
  test(`${league} comparison cards disclose limited periods and expandable source samples`,async({page})=>{
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.setViewportSize({width:390,height:844});
    const [id,set]=Object.entries(data.analysis.playerComps[league]).find(([,s])=>s.nearestOverall.some(r=>r.referenceProfile.limited)&&s.top3.some(r=>r.referenceProfile.limited));
    expect(id).toBeTruthy();
    await page.goto(`${PAGE}?mode=similarity&league=${league}&sim=${id}&chartYear=2025-26`);
    await expect(page.locator('.comp-overall-card')).toHaveCount(set.nearestOverall.length);
    await expect(page.locator('.comp-overall-card .comp-reference-limited')).toHaveCount(set.nearestOverall.filter(r=>r.referenceProfile.limited).length);
    await expect(page.locator('.comp-hero-card .comp-reference-limited')).toHaveCount(set.top3.filter(r=>r.referenceProfile.limited).length);
    await expect(page.locator('.comp-blueprint-player .comp-reference-limited')).toHaveCount(0);
    const first=page.locator('.comp-overall-card').first(), ref=set.nearestOverall[0].referenceProfile;
    const details=first.locator('.comp-reference-evidence');
    await expect(details).not.toHaveAttribute('open','');
    await expect(details.locator('p').first()).toBeHidden();
    await details.locator('summary').focus();
    await details.locator('summary').press('Enter');
    await expect(details).toHaveAttribute('open','');
    await expect(details).toContainText(`Seasons included: ${ref.seasons.join(', ')}.`);
    await expect(details).toContainText(`${Math.round(ref.games)} games`);
    await expect(details).toContainText(`${Math.round(ref.minutes)} minutes`);
    await expect(details).toContainText('not a whole-career average');
    await page.locator('.comp-method-note > summary').click();
    await expect(page.locator('.comp-method-note')).toContainText('highest-minute three-calendar-year window');
    await expect(page.locator('.comp-method-note')).toContainText(`${league==='NBA'?300:200} minutes`);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('a missing independent trait reference never becomes a mislabeled blend reference',async({page})=>{
  await page.goto(legacyDatabaseUrl(PAGE));
  await page.waitForFunction(()=>window.DATA?.analysis?.playerComps);
  await page.evaluate(()=>{
    const [id,set]=Object.entries(DATA.analysis.playerComps.NBA)[0];
    set.profileRead.components=[];
    set.profileRead.references={};
    set.profileRead.text='There is not enough shared evidence for a useful named style reference.';
    window.__wsRestoreUrlState({mode:'similarity',sim:id,chartYear:'2025-26'});
    window.__wsSetMode('similarity',false);
  });
  await expect(page.locator('.comp-blueprint-player')).toHaveCount(0);
  await expect(page.locator('.comp-style-copy')).toContainText('not enough shared evidence');
  expect(await page.locator('.comp-hero-card').count()).toBeGreaterThan(0);
});

test('Long Island NBA comparisons include past participants and preserve the selected season', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${PAGE}?mode=similarity&league=GLEAGUE&simScope=nba10&chartYear=2025-26&sim=1642849`);
  const picker = page.locator('#linCompPlayer');
  const season = page.locator('#compYear');
  const sets = data.analysis.longIslandNbaComps.seasons;
  await expect(picker.locator('option')).toHaveCount(Object.keys(sets['2025-26']).length);
  await expect(picker).toHaveValue('1642849');
  await expect(page.locator('#workspace')).toContainText('14 games');
  await expect(page.locator('#workspace')).toContainText('Showcase 13');
  await expect(page.locator('#workspace')).toContainText('Regular Season 1');
  await expect(page.locator('.comp-overall-card h4').first()).toHaveText(sets['2025-26']['1642849'].nearestOverall[0].name);
  await season.selectOption('2026-27');
  await expect(picker.locator('option')).toHaveCount(Object.keys(sets['2026-27']).length);
  await picker.selectOption('1642952');
  await expect(page.locator('#comp-style-heading')).toHaveText('Jonathan Pierre');
  await expect(page.locator('#chartPhase')).toHaveCount(0);
  await expect(page.locator('.comp-pool-note')).toContainText('2017-18 to 2026-27');
  // The downloadable file deliberately never writes browser history. Exercise
  // URL persistence when served over HTTP, as it is on GitHub Pages.
  if (new URL(PAGE).protocol === 'file:') {
    await page.goto(`${PAGE}?mode=similarity&league=GLEAGUE&simScope=nba10&chartYear=2026-27&sim=1642952`);
  } else {
    await expect(page).toHaveURL(/chartYear=2026-27/);
    await expect(page).toHaveURL(/sim=1642952/);
    await page.reload();
  }
  await expect(picker).toHaveValue('1642952');
  await expect(season).toHaveValue('2026-27');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('#simScopeSame').click();
  await expect(picker).toHaveCount(0);
  await page.locator('#simScopeRecentNba').click();
  await expect(picker).toHaveValue('1642952');
  expect(errors).toEqual([]);
});

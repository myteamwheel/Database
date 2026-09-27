import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const PAGE = 'file://' + fileURLToPath(new URL('../public/standalone.html', import.meta.url));
test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => window.DATA && document.querySelector('#tableBody tr td'));
});

test('stint per36 uses only the selected stint and does not leak season models', async ({page}) => {
  const result = await page.evaluate(() => {
    const p=DATA.leagues.NBA.find(p=>p.name==='James Harden');
    const q=teamScoped(p,'CLE','only');
    return {pts:get(q,'p36.pts'),three:get(q,'p36.fg3Pct'),mpg:q.mpg,seasonModel:get(q,'tb.tulip')};
  });
  expect(result.pts).toBeCloseTo(20.5*36/33.8,6);
  expect(result.three).toBe(0.435);
  expect(result.seasonModel).toBeNull();
});

test('display rank cannot sort and repeated reset preserves per36 ordering', async ({page}) => {
  await page.selectOption('#viewPreset','per36');
  const first=await page.locator('#tableBody tr').first().innerText();
  for(let i=0;i<2;i++) {
    await page.click('#resetBtn');
    expect(await page.locator('#tableBody tr').first().innerText()).toBe(first);
  }
  await expect(page.locator('#sortField option[value="viewRank"]')).toHaveCount(0);
  await expect(page.locator('#tableHead [data-sort="viewRank"]')).toHaveCount(0);
});

test('scatter excludes missing coordinates before numeric conversion', async ({page}) => {
  const expected=await page.evaluate(()=>DATA.leagues.NBA.filter(p=>p.appeared&&p.astTo!=null&&p.pts!=null).length);
  await page.click('[data-mode="scatter"]');
  await page.selectOption('#scX','astTo');
  await page.selectOption('#scY','pts');
  await expect(page.locator('#scStats')).toContainText(`n = ${expected}`);
  await expect(page.locator('#scStats')).toContainText('r = 0.002');
});

test('Role Value uses exact default target and hides stale rotation decisions', async ({page}) => {
  await page.click('[data-mode="tulip"]');
  const p=await page.evaluate(()=>{const p=DATA.leagues.NBA.find(p=>p.name==='Andre Drummond');return {id:p.playerId,target:p.tulip.card.targetMpg,impact:p.tulip.card.projection.projectedImpact};});
  await page.selectOption('#tuPlayer',p.id);
  await expect(page.locator('#tuTarget')).toHaveValue(String(p.target));
  await expect(page.locator('.ws-card').filter({hasText:`Projected impact at ${p.target} mpg`})).toContainText(p.impact.toFixed(2));
  await page.selectOption('#tuTarget','20');
  await expect(page.locator('#workspace')).toContainText('not computed for this target');
  await expect(page.locator('#workspace .read-block')).toHaveCount(0);
});

test('projection selection compares projections and unsupported NBA presets are absent', async ({page}) => {
  await expect(page.locator('#viewPreset option[value="nbaready"]')).toHaveCount(0);
  await expect(page.locator('#viewPreset option[value="per36nba"]')).toHaveCount(0);
  await page.selectOption('#viewPreset','proj');
  await page.locator('#tableBody input[type="checkbox"]').nth(0).check();
  await page.locator('#tableBody input[type="checkbox"]').nth(1).check();
  await page.click('[data-mode="compare"]');
  await expect(page.locator('#workspace h2')).toContainText('2026–27 projections');
});

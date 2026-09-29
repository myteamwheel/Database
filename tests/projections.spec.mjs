// 2026-27 projections in the browser: the view, the player card and the method page.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(ROOT, 'public/standalone.html');

async function open(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelector('#tableBody tr td'), null, { timeout: 60000 });
  return errors;
}

test.describe('2026-27 projections', () => {
  test('CSV export names the correct season for projections and stats', async ({ page }) => {
    await open(page);
    await page.click('.site-link[data-goto="proj"]');
    const pending = page.waitForEvent('download');
    await page.click('#exportBtn');
    const download = await pending;
    expect(download.suggestedFilename()).toBe('nba_2026-27_projections.csv');
    await page.click('.site-link[data-goto="stats"]');
    const statsPending = page.waitForEvent('download');
    await page.click('#exportBtn');
    expect((await statsPending).suggestedFilename()).toBe('nba_2025-26_rankings.csv');
  });

  test('the top navigation opens the projections view, sorted by projected points', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="proj"]');
    await expect(page.locator('#pageTitle')).toHaveText('2026-27 NBA Projections');
    await expect(page.locator('#projNote')).toBeVisible();
    await expect(page.locator('#viewPreset')).toHaveValue('proj');
    await expect(page.locator('.site-link[data-goto="proj"]')).toHaveClass(/active/);
    const headers = await page.$$eval('thead th', (ths) => ths.map((t) => t.innerText.trim()));
    for (const h of ['Team', 'Status', 'GP', 'MIN', 'PTS', 'REB', 'AST', '3PM', 'FG%', 'PTS chg']) {
      expect(headers.some((x) => x.replace(/ [↓↑]$/, '') === h), `missing column ${h}`).toBe(true);
    }
    expect(headers.some((x) => /PTS (low|high)/.test(x))).toBe(false);
    const col = headers.findIndex((h) => h.startsWith('PTS') && !h.includes('low') && !h.includes('high') && !h.includes('chg'));
    const pts = await page.$$eval('#tableBody tr', (rows, i) => rows.map((r) => Number(r.children[i].innerText)), col);
    expect(pts.length).toBeGreaterThan(20);
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeLessThanOrEqual(pts[i - 1]);
    const id = await page.evaluate(() => DATA.leagues.NBA.find((p) => p.proj && !p.proj.abstain).playerId);
    await page.evaluate((pid) => openPlayer(pid), id);
    const card = page.locator('#playerDialogBody .proj-card');
    await expect(card.locator('details.proj-ranges')).not.toHaveAttribute('open', '');
    await card.locator('details.proj-ranges summary').click();
    await expect(card.locator('details.proj-ranges table')).toBeVisible();
    await expect(card.locator('details.proj-ranges')).toContainText('Low reference');
    await expect(card.locator('details.proj-ranges')).toContainText('High reference');
    await page.click('[data-close="playerDialog"]');
    // Back to the season stats.
    await page.click('.site-link[data-goto="stats"]');
    await expect(page.locator('#pageTitle')).toHaveText('2025-26 NBA Player Stats');
    await expect(page.locator('#projNote')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the G League has its own projections view', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="proj"]');
    await page.click('.league-tab[data-league="GLEAGUE"]');
    await expect(page.locator('#pageTitle')).toHaveText('2026-27 G League Projections');
    expect(await page.locator('#tableBody tr').count()).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  test('a player card shows last season beside the projection and how it was built', async ({ page }) => {
    const errors = await open(page);
    const id = await page.evaluate(() => DATA.leagues.NBA.find((p) => p.proj && !p.proj.abstain && p.proj.status === 'new' && p.mpg > 25).playerId);
    await page.evaluate((pid) => openPlayer(pid), id);
    const card = page.locator('#playerDialogBody .proj-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('2026-27 projection');
    await expect(card).toContainText('How this line was built');
    await expect(card).toContainText(/new team/i);
    await expect(card).toContainText(/Points per 100 possessions/);
    const rowLabels = await card.locator('.proj-body > div > table:first-child td.left').allTextContents();
    for (const row of ['Games', 'Minutes', 'Points', 'Rebounds', 'Assists', 'FG%', '3P%', 'FT%']) {
      expect(rowLabels.map((label) => label.trim())).toContain(row);
    }
    expect(errors).toEqual([]);
  });

  test('the method page states the formula and accurately labels the historical validation', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="proj"]');
    await page.click('#projMethodBtn');
    const body = page.locator('#projMethodBody');
    await expect(body).toBeVisible();
    await expect(body.locator('.formula')).toContainText('rate = BASE x AGE');
    await expect(body).toContainText('Historical check of the frozen model');
    await expect(body).toContainText('It is not an accuracy score for today’s full projection.');
    // The winning cell must follow the measured MAEs, not assume a particular model always wins.
    const ptsRow = body.locator('tr', { has: page.locator('td.left', { hasText: /^Points$/ }) }).first();
    const expectedWinnerIndex = await page.evaluate(() => {
      const x = DATA.projectionMeta.backtest.nba.mae.pts;
      return [x.model, x.repeat, x.avg3].indexOf(Math.min(x.model, x.repeat, x.avg3)) + 1;
    });
    await expect(ptsRow.locator('td').nth(expectedWinnerIndex)).toHaveClass(/winner/);
    await expect(body).toContainText('What it does not know');
    expect(errors).toEqual([]);
  });
});

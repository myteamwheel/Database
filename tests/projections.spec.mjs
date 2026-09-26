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
  test('the top navigation opens the projections view, sorted by projected points', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="proj"]');
    await expect(page.locator('#pageTitle')).toHaveText('2026-27 NBA Projections');
    await expect(page.locator('#projNote')).toBeVisible();
    await expect(page.locator('#viewPreset')).toHaveValue('proj');
    await expect(page.locator('.site-link[data-goto="proj"]')).toHaveClass(/active/);
    const headers = await page.$$eval('thead th', (ths) => ths.map((t) => t.innerText.trim()));
    for (const h of ['Team', 'Status', 'GP', 'MIN', 'PTS', 'PTS low', 'PTS high', 'REB', 'AST', '3PM', 'FG%', 'PTS chg']) {
      expect(headers.some((x) => x.replace(/ [↓↑]$/, '') === h), `missing column ${h}`).toBe(true);
    }
    const col = headers.findIndex((h) => h.startsWith('PTS') && !h.includes('low') && !h.includes('high') && !h.includes('chg'));
    const pts = await page.$$eval('#tableBody tr', (rows, i) => rows.map((r) => Number(r.children[i].innerText)), col);
    expect(pts.length).toBeGreaterThan(20);
    for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeLessThanOrEqual(pts[i - 1]);
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
    for (const row of ['Games', 'Minutes', 'Points', 'Rebounds', 'Assists', 'FG%', '3P%', 'FT%']) {
      await expect(card.locator('td.left', { hasText: new RegExp(`^${row.replace('%', '%')}$`) })).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });

  test('the method page states the formula and the tested accuracy', async ({ page }) => {
    const errors = await open(page);
    await page.click('.site-link[data-goto="proj"]');
    await page.click('#projMethodBtn');
    const body = page.locator('#projMethodBody');
    await expect(body).toBeVisible();
    await expect(body.locator('.formula')).toContainText('rate = BASE x AGE');
    await expect(body).toContainText('How accurate it is');
    // The points row marks this model as the best of the three columns.
    const ptsRow = body.locator('tr', { has: page.locator('td.left', { hasText: /^Points$/ }) }).first();
    await expect(ptsRow.locator('td').nth(1)).toHaveClass(/winner/);
    await expect(body).toContainText('What it does not know');
    expect(errors).toEqual([]);
  });
});

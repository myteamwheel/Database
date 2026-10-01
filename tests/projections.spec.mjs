// 2026-27 projections in the browser: the view, the player card and the method page.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.PROJECTION_TEST_URL || 'file://' + path.join(ROOT, 'public/standalone.html');
// Read the published input independently: expected results never call app formatting/getters.
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
const metrics = { gp: 'Games', mpg: 'Minutes', pts: 'Points', reb: 'Rebounds', ast: 'Assists',
  stl: 'Steals', blk: 'Blocks', tov: 'Turnovers', fg3m: 'Threes made', fgPct: 'FG%', fg3Pct: '3P%', ftPct: 'FT%', ts: 'TS%' };
const percentKeys = new Set(['fgPct', 'fg3Pct', 'ftPct', 'ts']);
const numberText = (value, key) => value == null ? '—' : (Number(value) * (percentKeys.has(key) ? 100 : 1)).toFixed(1) + (percentKeys.has(key) ? '%' : '');
const statuses = { same: 'Returning', new: 'New team', rookie: 'Rookie estimate', historical: 'Historical fallback', unsigned: 'No NBA roster', 'nba-roster': 'On NBA roster', gleague: 'G League' };
const expectedTeam = p => p.league === 'NBA' ? p.currentTeam || 'No NBA roster' : p.proj?.team || p.team || '—';
const estimate = (p, key) => p.proj && !p.proj.abstain ? p.proj[key] : null;

async function exportedRows(page) {
  const pending = page.waitForEvent('download');
  await page.click('#exportBtn');
  const stream = await (await pending).createReadStream();
  let csv = '';
  for await (const chunk of stream) csv += chunk.toString();
  return csv.trimEnd().split('\n').map(line => [...line.matchAll(/"((?:[^"\n]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
}

async function checkCard(card, p) {
  if (p.proj.abstain) {
    await expect(card).toContainText(p.proj.reason);
    await expect(card).toContainText(p.currentTeam);
    await expect(card.locator('table')).toHaveCount(0);
    return;
  }
  const rows = await card.locator('.proj-estimates tbody tr').evaluateAll(rows => Object.fromEntries(rows.map(r => [r.children[0].textContent, [...r.querySelectorAll('td')].map(c => c.textContent.trim())])));
  for (const [key, label] of Object.entries(metrics)) {
    expect(rows[label], `${p.name}: ${label}`).toEqual([numberText(p[key === 'fg3m' ? 'fg3' : key], key), numberText(p.proj[key], key)]);
  }
  await expect(card.locator('.proj-context')).toContainText(expectedTeam(p));
  await expect(card.locator('.proj-context')).toContainText(statuses[p.proj.status]);
  for (const cls of ['proj-ranges', 'proj-why']) {
    const detail = card.locator(`details.${cls}`);
    await expect(detail).not.toHaveAttribute('open', '');
    await detail.locator('summary').focus();
    await detail.locator('summary').press('Enter');
    await expect(detail).toHaveAttribute('open', '');
  }
  const rangeRows = await card.locator('.proj-ranges tbody tr').evaluateAll(rows => Object.fromEntries(rows.map(r => [r.children[0].textContent, [...r.querySelectorAll('td')].map(c => c.textContent.trim())])));
  for (const key of ['gp', 'mpg', 'pts', 'reb', 'ast']) {
    expect(rangeRows[metrics[key]]).toEqual([numberText(p.proj[`${key}Lo`], key), numberText(p.proj[key], key), numberText(p.proj[`${key}Hi`], key)]);
  }
  await expect(card.locator('.proj-why')).not.toContainText('..');
  if (p.proj.status === 'rookie') await expect(card.locator('.proj-why')).toContainText('No prior NBA appearance record');
  if (p.proj.status === 'historical') {
    await expect(card.locator('.proj-why')).toContainText(p.proj.why.fallback.lastObservedSeason);
    await expect(card.locator('.proj-why')).not.toContainText("team's games last season");
  }
}

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
    const rowLabels = await card.locator('.proj-estimates th[scope="row"]').allTextContents();
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

  for (const league of ['NBA', 'GLEAGUE']) {
    test(`${league}: every table row and CSV agrees with the independently read forecast`, async ({ page }) => {
      const errors = await open(page);
      await page.click('.site-link[data-goto="proj"]');
      if (league !== 'NBA') await page.click('.league-tab[data-league="GLEAGUE"]');
      await page.locator('.more-filters > summary').click();
      await page.check('#includeRosterOnly');
      await page.selectOption('#rowLimit', '9999');
      const rendered = await page.locator('#tableBody tr').evaluateAll(rows => {
        const keys = [...document.querySelectorAll('#tableHead th')].map(h => h.dataset.sort);
        return rows.map(r => ({ id: r.querySelector('[data-player]')?.dataset.player,
          cells: Object.fromEntries(keys.map((k, i) => [k, r.children[i].textContent.trim()])) }));
      });
      const [headers, ...csv] = await exportedRows(page);
      const data = new Map(source.leagues[league].map(p => [String(p.playerId), p]));
      expect(rendered.length).toBe(data.size);
      expect(csv.length).toBe(data.size);
      const columns = { gp:'GP', mpg:'MIN', pts:'PTS', reb:'REB', ast:'AST', stl:'STL', blk:'BLK', tov:'TOV', fg3m:'3PM', fgPct:'FG% (pct pts)', fg3Pct:'3P% (pct pts)', ftPct:'FT% (pct pts)', ts:'TS% (pct pts)', lastPts:'25-26 PTS', dPts:'PTS chg' };
      for (const [i, row] of rendered.entries()) {
        const p = data.get(row.id);
        expect(p, `unknown player ${row.id}`).toBeTruthy();
        expect(csv[i][headers.indexOf('Player')]).toBe(p.name);
        const status = p.proj && !p.proj.abstain ? statuses[p.proj.status] : 'No estimate';
        for (const [key, val] of [['team', expectedTeam(p)], ['status', status]]) {
          expect(row.cells[`proj.${key}`], `${p.name}: ${key}`).toBe(val);
          expect(csv[i][headers.indexOf(key === 'team' ? 'Team' : 'Status')]).toBe(val === '—' ? '' : val);
        }
        for (const [key, header] of Object.entries(columns)) {
          const raw = key === 'lastPts' ? p.pts : estimate(p, key);
          const expected = numberText(raw, key);
          expect(row.cells[`proj.${key}`], `${p.name}: ${key}`).toBe(key === 'dPts' && raw > 0 ? `+${expected}` : expected);
          expect(csv[i][headers.indexOf(header)], `${p.name}: CSV ${key}`).toBe(expected === '—' ? '' : expected.replace('%', ''));
        }
      }
      await expect(page.locator('#sortLabel')).toContainText('2026-27 projections');
      expect(errors).toEqual([]);
    });

    test(`${league}: player dialog and Player tab reconcile, with keyboard-accessible details`, async ({ page }) => {
      const errors = await open(page);
      await page.click('.site-link[data-goto="proj"]');
      if (league !== 'NBA') await page.click('.league-tab[data-league="GLEAGUE"]');
      const cases = league === 'NBA' ? ['same','new','unsigned','rookie','historical','abstain'] : ['gleague','nba-roster'];
      for (const status of cases) {
        const p = source.leagues[league].find(p => status === 'abstain' ? p.currentRoster && p.proj?.abstain : p.proj?.status === status);
        expect(p, `required ${status} example`).toBeTruthy();
        await page.fill('#searchInput', p.name);
        await page.locator(`[data-player="${p.playerId}"]`).click();
        await checkCard(page.locator('#playerDialogBody .proj-card'), p);
        await page.click('[data-close="playerDialog"]');
        await page.locator(`[data-profile="${p.playerId}"]`).click();
        const details = page.locator('#workspace .ws-projection');
        await expect(details).not.toHaveAttribute('open', '');
        if (!p.proj.abstain) await expect(details.locator(':scope > summary')).toContainText(`${numberText(p.proj.pts, 'pts')} PTS`);
        await details.locator(':scope > summary').focus();
        await details.locator(':scope > summary').press('Enter');
        await checkCard(details.locator('.proj-card'), p);
        await page.locator('[data-mode="database"]').click();
      }
      expect(errors).toEqual([]);
    });
  }

  test('projection player details fit a phone and method navigation remains usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await open(page);
    const p = source.leagues.NBA.find(p => p.proj?.status === 'historical');
    await page.fill('#searchInput', p.name);
    await page.locator(`[data-profile="${p.playerId}"]`).click();
    const details = page.locator('.ws-projection');
    await details.locator(':scope > summary').click();
    await checkCard(details.locator('.proj-card'), p);
    expect(await details.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await details.locator('[data-proj-method]').click();
    await expect(page.locator('#projMethodDialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#projMethodDialog')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('an old stint filter cannot mix partial-season actuals with a full-season forecast', async ({ page }) => {
    await open(page);
    const p = source.leagues.NBA.find(p => p.proj && !p.proj.abstain && p.teams?.length > 1 && p.teams.some(s => s.team === p.currentTeam && s.pts !== p.pts));
    expect(p).toBeTruthy();
    await page.selectOption('#teamFilter', p.currentTeam);
    await page.locator('.more-filters > summary').click();
    await page.selectOption('#teamMode', 'only');
    await page.fill('#searchInput', p.name);
    await page.locator(`[data-player="${p.playerId}"]`).click();
    await checkCard(page.locator('#playerDialogBody .proj-card'), p);
    await page.click('[data-close="playerDialog"]');
    await page.click('.site-link[data-goto="proj"]');
    await expect(page.locator('#teamMode')).toBeDisabled();
    await page.fill('#searchInput', p.name);
    const headers = await page.locator('#tableHead th').evaluateAll(h => h.map(x => x.dataset.sort));
    const row = page.locator('#tableBody tr', { has: page.locator(`[data-player="${p.playerId}"]`) });
    await expect(row.locator('td').nth(headers.indexOf('proj.lastPts'))).toHaveText(numberText(p.pts, 'lastPts'));
    await page.locator(`[data-player="${p.playerId}"]`).click();
    await checkCard(page.locator('#playerDialogBody .proj-card'), p);
  });
});

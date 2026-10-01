import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = process.env.CROSS_TAB_TEST_URL || 'file://' + fileURLToPath(new URL('../public/standalone.html', import.meta.url));
const source = JSON.parse(fs.readFileSync(new URL('../public/data.json', import.meta.url), 'utf8'));

test('Role Value keeps every selectable unmodeled player without inventing an estimate', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(PAGE);
  await page.waitForFunction(() => window.DATA && window.__wsRestoreUrlState);
  let checked = 0;
  for (const league of ['NBA', 'GLEAGUE']) {
    await page.click(`.league-tab[data-league="${league}"]`);
    const missing = source.leagues[league].filter(p => !p.tulip && (p.appeared || (league === 'NBA' && p.currentRoster)));
    for (const p of missing) {
      await page.evaluate(id => {
        window.__wsRestoreUrlState({ mode: 'tulip', rolePlayer: id });
        window.__wsRefresh();
      }, p.playerId);
      await expect(page.locator('#tuPlayer')).toHaveValue(String(p.playerId));
      await expect(page.locator('.role-unavailable h2')).toHaveText(p.name);
      await expect(page.locator('.role-unavailable')).toContainText('No Role Value estimate');
      await expect(page.locator('.role-unavailable')).toContainText('not a zero score');
      await expect(page.locator('#tuTarget')).toHaveCount(0);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

for (const league of ['NBA', 'GLEAGUE']) {
  test(`${league}: every Team Fit result and roster baseline matches the published source`, async ({ page }) => {
    await page.goto(`${PAGE}?league=${league}&mode=teamfit`);
    await page.waitForSelector('#tfTeam');
    for (const [team, profile] of Object.entries(source.analysis.teams[league])) {
      await page.selectOption('#tfTeam', team);
      const members = source.leagues[league].filter(p => p.appeared && p.skillProfile && (league === 'NBA'
        ? p.currentTeam === team : (p.teams?.length ? p.teams.map(x => x.team) : [p.team]).includes(team)));
      await expect(page.locator('#workspace .ws-controls')).toContainText(`${members.length} measured player profiles`);
      await expect(page.locator('#workspace h3').filter({ hasText: 'measured fit results' })).toHaveText(`Top ${profile.topFits.length} measured fit results`);
      const actual = await page.locator('#workspace .compare-table tbody tr').evaluateAll(rows => rows.map(row => ({
        id: row.querySelector('[data-goto]').dataset.goto,
        name: row.querySelector('[data-goto]').textContent,
        grade: row.children[1].textContent.trim(),
        score: row.children[2].textContent.trim(),
        member: !!row.querySelector('.team-fit-member'),
      })));
      expect(actual).toEqual(profile.topFits.map(fit => ({ id: String(fit.playerId), name: fit.name,
        grade: fit.grade == null ? '—' : (Math.floor(fit.grade * 100) / 100).toFixed(2),
        score: `${fit.score}/100`, member: members.some(p => String(p.playerId) === String(fit.playerId)),
      })));
      const more = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'more fit results' }) });
      if (profile.topFits.length > 10) {
        await expect(more).not.toHaveAttribute('open', '');
        await more.locator('summary').click();
        await expect(more.locator('tbody tr')).toHaveCount(profile.topFits.length - 10);
      }
    }
  });
  test(`${league}: cohort deep links preserve identity and distinguish roster from historical actuals`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const rows = source.leagues[league];
    const selectable = rows.filter(p => p.appeared || (league === 'NBA' && p.currentRoster));
    const cohort = league === 'NBA' ? [
      selectable.find(p => p.currentRoster && !p.appeared && p.proj?.basis === 'rookie-cohort-fallback'),
      selectable.find(p => p.currentRoster && !p.appeared && p.proj?.basis === 'multi-year-history'),
      selectable.find(p => p.appeared && p.currentTeam && p.currentTeam !== (p.seasonTeam || p.team)),
      selectable.find(p => p.appeared && !p.currentRoster),
      selectable.find(p => source.leagues.GLEAGUE.some(q => q.appeared && q.nbaPersonId === p.nbaPersonId)),
    ] : [
      selectable.find(p => source.leagues.NBA.some(q => q.nbaPersonId === p.nbaPersonId)),
      selectable.find(p => p.teams?.length > 1),
    ];
    expect(cohort.every(Boolean), 'Each required cohort needs a real test case').toBe(true);
    const peer = selectable.find(p => p.appeared);
    for (const p of cohort) {
      const query = new URLSearchParams({ league, mode: 'player', player: p.playerId, sim: p.playerId, rolePlayer: p.playerId });
      await page.goto(`${PAGE}?${query}`);
      await expect(page.locator('#wsPlayerSel')).toHaveValue(String(p.playerId));
      await expect(page.locator('.ws-title h2')).toHaveText(p.name);
      const teamText = league === 'NBA' ? (p.currentTeam ? `Current NBA roster: ${p.currentTeam}` : 'No current NBA roster') : `${source.season} G League team: ${p.team}`;
      if (p.appeared) {
        await expect(page.locator('.ws-title')).toContainText(teamText);
        await expect(page.locator('.ws-title')).toContainText(`${source.season} actuals: ${p.gp} games`);
      } else await expect(page.locator('#workspace')).toContainText('no 2025-26 NBA appearance');
      await page.click('[data-mode="similarity"]');
      await expect(page.locator('#simSearch')).toHaveValue(p.name);
      if (p.appeared && source.analysis?.playerComps?.[league]?.[p.playerId]) {
        await expect(page.locator('.comp-target-strip h3')).toHaveText(p.name);
        await expect(page.locator('.comp-target-strip')).toContainText(teamText);
      }
      await page.click('[data-mode="tulip"]');
      await expect(page.locator('#tuPlayer')).toHaveValue(String(p.playerId));
      if (!p.tulip) await expect(page.locator('.role-unavailable h2')).toHaveText(p.name);
      await page.evaluate(ids => { compared = new Set(ids); window.__wsSetMode('compare'); }, [p.playerId, peer.playerId]);
      await expect(page.locator('#workspace > h2')).toContainText('2025–26 actuals');
      const header = page.locator('#workspace .compare-table').first().locator('thead th').nth(1);
      await expect(header).toContainText(p.name);
      await expect(header).toContainText(teamText);
      await page.evaluate(name => {
        document.querySelector('#searchInput').value = name;
        window.__wsRestoreUrlState({ mode: 'scatter', x: 'pts', y: 'ts' });
        window.__wsRefresh();
      }, p.name);
      const expectedPoints = rows.filter(q => q.appeared && q.name.toLowerCase().includes(p.name.toLowerCase()) && Number.isFinite(q.pts) && Number.isFinite(q.ts)).length;
      await expect(page.locator('#scStats')).toContainText(`n = ${expectedPoints}`);
      await expect(page.locator('#scFilterChips')).toContainText(`Search: ${p.name}`);
      await page.evaluate(() => {
        document.querySelector('#includeRosterOnly').checked = true;
        window.__wsSetMode('database');
      });
      await expect(page.locator(`#tableBody [data-player="${p.playerId}"]`)).toContainText(p.name);
    }
    expect(errors).toEqual([]);
  });
}

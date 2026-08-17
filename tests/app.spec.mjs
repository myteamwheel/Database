// Automated regression gate for the built standalone page.
// Runs headless against public/standalone.html; `npm run verify` fails if anything here fails.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(ROOT, 'public/standalone.html');

/** Console errors are a failure, not noise. */
async function open(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelector('#tableBody tr td'), null, { timeout: 60000 });
  return errors;
}
const count = (page) => page.$eval('#resultCount', (e) => Number(e.textContent.replace(/,/g, '')));
const setVal = (page, id, v) => page.$eval(id, (e, val) => {
  e.value = val; e.dispatchEvent(new Event(e.tagName === 'INPUT' && e.type === 'search' ? 'input' : 'change'));
}, v);
const setCheck = (page, id, v) => page.$eval(id, (e, val) => {
  e.checked = val; e.dispatchEvent(new Event('change'));
}, v);

test.describe('data + load', () => {
  test('both leagues load with the complete field set', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => ({
      nba: document.getElementById('nbaCount').textContent,
      gl: document.getElementById('gCount').textContent,
      nbaCount: DATA.counts.NBA, glCount: DATA.counts.GLEAGUE,
      nbaFields: new Set(DATA.leagues.NBA.flatMap((p) => Object.keys(p.stats || {}))).size,
      glFields: new Set(DATA.leagues.GLEAGUE.flatMap((p) => Object.keys(p.stats || {}))).size,
      catalog: Object.keys(DATA.fieldCatalog || {}).length,
      provenance: DATA.provenance?.sources?.length || 0,
      brefSnapshot: DATA.provenance?.basketballReferenceSnapshot?.generatedAt || null,
      grades: ['grade', 'rateGrade', 'magnitudeGrade'].every((k) => DATA.leagues.NBA[0][k] !== undefined),
    }));
    expect(d.nba).toBe(String(d.nbaCount));
    expect(d.gl).toBe(String(d.glCount));
    expect(d.nbaFields).toBeGreaterThan(800);
    expect(d.glFields).toBeGreaterThan(500);
    expect(d.catalog).toBeGreaterThan(1000);
    expect(d.provenance).toBeGreaterThan(100);
    expect(d.brefSnapshot).toBeTruthy();
    expect(d.grades).toBe(true);
    expect(errors).toEqual([]);
  });

  test('every preset renders and every declared field resolves', async ({ page }) => {
    const errors = await open(page);
    for (const league of ['NBA', 'GLEAGUE']) {
      if (league === 'GLEAGUE') { await page.click('.league-tab[data-league="GLEAGUE"]'); await page.waitForTimeout(500); }
      const presets = await page.$$eval('#viewPreset option', (o) => o.map((x) => x.value));
      expect(presets.length).toBeGreaterThan(8);
      for (const p of presets) {
        await setVal(page, '#viewPreset', p);
        await page.waitForTimeout(220);
        const cols = await page.$$eval('#tableHead th', (t) => t.length);
        const filled = await page.$$eval('#tableBody tr:first-child td',
          (t) => t.filter((x) => x.textContent.trim() !== '—').length);
        expect(cols, `${league}/${p} columns`).toBeGreaterThan(3);
        expect(filled, `${league}/${p} populated cells`).toBeGreaterThan(2);
      }
      await setVal(page, '#viewPreset', 'overall');
    }
    expect(errors).toEqual([]);
  });
});

test.describe('search, sort, filters', () => {
  test('accented and accentless search find the same player', async ({ page }) => {
    await open(page);
    await setVal(page, '#searchInput', 'Jokić');
    await page.waitForTimeout(200);
    const a = await page.$eval('#tableBody .player-link', (e) => e.textContent);
    await setVal(page, '#searchInput', 'Jokic');
    await page.waitForTimeout(200);
    const b = await page.$eval('#tableBody .player-link', (e) => e.textContent);
    expect(a).toContain('Joki');
    expect(b).toBe(a);
  });

  test('sorting works in both directions', async ({ page }) => {
    await open(page);
    const vals = async () => page.evaluate(() => {
      const i = [...document.querySelectorAll('#tableHead th')].findIndex((t) => t.dataset.sort === 'pts');
      return [...document.querySelectorAll('#tableBody tr')].slice(0, 10)
        .map((tr) => Number(tr.children[i]?.textContent));
    });
    await page.click('#tableHead th[data-sort="pts"]');
    await page.waitForTimeout(200);
    const desc = await vals();
    expect(desc[0]).toBeGreaterThanOrEqual(desc[1]);
    await page.click('#tableHead th[data-sort="pts"]');
    await page.waitForTimeout(200);
    const asc = await vals();
    expect(asc[0]).toBeLessThanOrEqual(asc[1]);
  });

  test('filters narrow, and a hybrid G-F satisfies a G filter', async ({ page }) => {
    await open(page);
    const all = await count(page);
    await setVal(page, '#minGp', '60');
    await page.waitForTimeout(200);
    expect(await count(page)).toBeLessThan(all);
    await setVal(page, '#minGp', '0');

    await setVal(page, '#positionFilter', 'G');
    await page.waitForTimeout(250);
    const guards = await count(page);
    const pureG = await page.evaluate(() =>
      DATA.leagues.NBA.filter((p) => p.appeared && p.positionFamily === 'G').length);
    expect(guards).toBeGreaterThan(pureG);   // G-F players are included
    await setVal(page, '#positionFilter', '');
  });

  test('numeric filter works in displayed units', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      document.getElementById('ruleMetric').value = 'ts';
      document.getElementById('ruleOp').value = '>=';
      document.getElementById('ruleValue').value = '60';
      document.getElementById('saveRuleBtn').click();
    });
    await page.waitForTimeout(250);
    const n = await count(page);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(582);
  });
});

test.describe('team scoping', () => {
  test('scope is applied before filters, and season-only fields are blanked', async ({ page }) => {
    await open(page);
    await setVal(page, '#teamFilter', 'CLE');
    await setVal(page, '#teamMode', 'only');
    await page.waitForTimeout(300);

    const row = await page.evaluate(() => {
      const hdrs = [...document.querySelectorAll('#tableHead th')].map((t) => t.dataset.sort);
      const tr = [...document.querySelectorAll('#tableBody tr')].find((r) => r.textContent.includes('Harden'));
      if (!tr) return null;
      const cells = [...tr.querySelectorAll('td')].map((t) => t.textContent.trim());
      return { gp: cells[hdrs.indexOf('gp')], grade: cells[hdrs.indexOf('grade')], ts: cells[hdrs.indexOf('ts')] };
    });
    expect(row).not.toBeNull();
    expect(row.gp).toBe('26');          // stint, not the 70-game season
    expect(row.grade).toBe('—');        // no stint-level grade exists
    expect(row.ts).toBe('—');           // no stint-level TS% exists

    // A 26-game stint must not survive a 30-game minimum.
    await setVal(page, '#minGp', '30');
    await page.waitForTimeout(300);
    const names = await page.$$eval('#tableBody .player-link', (e) => e.map((x) => x.textContent));
    expect(names).not.toContain('James Harden');
    await setVal(page, '#minGp', '0');
  });

  test('detail and compare stay scoped', async ({ page }) => {
    await open(page);
    await setVal(page, '#teamFilter', 'CLE');
    await setVal(page, '#teamMode', 'only');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const tr = [...document.querySelectorAll('#tableBody tr')].find((r) => r.textContent.includes('Harden'));
      tr.querySelector('.player-link').click();
    });
    await page.waitForTimeout(350);
    expect(await page.$eval('#playerDialogBody', (e) => e.textContent)).toContain('CLE stint only');
    await page.evaluate(() => document.getElementById('playerDialog').close());
  });
});

test.describe('roster-only players', () => {
  test('can be included and their profile does not crash', async ({ page }) => {
    const errors = await open(page);
    const before = await count(page);
    await setCheck(page, '#includeRosterOnly', true);
    await page.waitForTimeout(250);
    expect(await count(page)).toBeGreaterThan(before);

    const opened = await page.evaluate(() => {
      const p = DATA.leagues.NBA.find((x) => x.rosterOnly);
      const link = [...document.querySelectorAll('#tableBody .player-link')]
        .find((b) => b.textContent === p.name);
      if (!link) return 'not-visible';
      link.click();
      return document.getElementById('playerDialogBody').textContent;
    });
    if (opened !== 'not-visible') expect(opened).toContain('N/A');
    expect(await page.evaluate(() =>
      DATA.leagues.NBA.filter((p) => p.rosterOnly).every((p) => p.grade === null))).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('formula lab', () => {
  test('scores stay on 0-100 for positive and negative weights, ties share a percentile', async ({ page }) => {
    await open(page);
    const runLab = (metric, weight) => page.evaluate(([m, w]) => {
      document.getElementById('labMetric1').value = m;
      document.getElementById('labWeight1').value = String(w);
      for (const i of [2, 3, 4]) {
        document.getElementById('labMetric' + i).value = '';
        document.getElementById('labWeight' + i).value = '0';
      }
      document.getElementById('applyLab').click();
    }, [metric, weight]);

    await runLab('pts', 1); await page.waitForTimeout(350);
    let s = await page.evaluate(() => DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null));
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);

    await runLab('pts', -1); await page.waitForTimeout(350);
    s = await page.evaluate(() => DATA.leagues.NBA.map((p) => p.labScore).filter((v) => v != null));
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s)).toBeLessThanOrEqual(100);

    await runLab('blk', 1); await page.waitForTimeout(350);
    const tiesDiffer = await page.evaluate(() => {
      const by = {};
      DATA.leagues.NBA.forEach((p) => {
        if (p.blk != null && p.labScore != null) (by[p.blk] = by[p.blk] || new Set()).add(p.labScore.toFixed(6));
      });
      return Object.values(by).filter((x) => x.size > 1).length;
    });
    expect(tiesDiffer).toBe(0);
  });

  test('mixed season scopes are blocked on the G League panel', async ({ page }) => {
    await open(page);
    await page.click('.league-tab[data-league="GLEAGUE"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.getElementById('allowMixedScope').checked = false;
      document.getElementById('labMetric1').value = 'pts';
      document.getElementById('labWeight1').value = '1';
      document.getElementById('labMetric2').value = 'per';
      document.getElementById('labWeight2').value = '1';
      document.getElementById('applyLab').click();
    });
    await page.waitForTimeout(300);
    expect((await page.$eval('#labNote', (e) => e.textContent)).toLowerCase()).toContain('blocked');
  });
});

test.describe('dialogs, league switching, layout', () => {
  test('field catalog and metric definitions open', async ({ page }) => {
    await open(page);
    await page.click('#catalogBtn');
    await page.waitForTimeout(300);
    expect(await page.$eval('#catalogDialogBody', (e) => e.textContent)).toContain('Season scope');
    await page.evaluate(() => document.getElementById('catalogDialog').close());
    await page.click('#aboutBtn');
    await page.waitForTimeout(250);
    expect(await page.$eval('#metricDialogBody', (e) => e.textContent)).toContain('Counts');
    await page.evaluate(() => document.getElementById('metricDialog').close());
  });

  test('league switch with active filters, then reset', async ({ page }) => {
    const errors = await open(page);
    await setVal(page, '#minGp', '20');
    await page.click('.league-tab[data-league="GLEAGUE"]');
    await page.waitForTimeout(600);
    expect(await page.$$eval('#tableBody tr', (r) => r.length)).toBeGreaterThan(0);
    await page.click('#resetBtn');
    await page.waitForTimeout(300);
    const n = await count(page);
    expect(n).toBe(await page.evaluate(() => DATA.counts.GLEAGUE));
    expect(errors).toEqual([]);
  });

  for (const [name, width, height] of [['mobile', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]]) {
    test(`no horizontal body overflow at ${name} width`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const errors = await open(page);
      const o = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        tableOverflow: getComputedStyle(document.querySelector('.table-wrap')).overflowX,
      }));
      expect(o.tableOverflow).toBe('auto');
      expect(o.scroll).toBeLessThanOrEqual(o.client + 2);
      expect(errors).toEqual([]);
    });
  }
});

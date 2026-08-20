// Runs against the built standalone page, same target as the rest of the suite.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file://' + path.join(ROOT, 'public/standalone.html');

const open = async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelector('#tableBody tr td'), null, { timeout: 60000 });
  await page.waitForTimeout(400);
  return errors;
};

test.describe('Column tooltips', () => {
  test('every column in every preset has a hover explanation', async ({ page }) => {
    await open(page);
    const missing = await page.evaluate(() => {
      const out = [];
      for (const [preset, keys] of Object.entries(PRESETS)) {
        for (const k of keys) {
          if (k === 'select') continue;
          const d = colDef(k);
          if (!d || !d.help || String(d.help).trim().length < 10) out.push(`${preset} -> ${k}`);
        }
      }
      return out;
    });
    expect(missing, `columns with no usable hover text:\n${missing.join('\n')}`).toEqual([]);
  });

  test('derived-metric tooltips state what it is, in plain words, and the formula', async ({ page }) => {
    await open(page);
    // The metrics a reader cannot infer from the label must explain themselves.
    const keys = ['tulip.leagueDelta', 'opt.minutesDelta', 'opt.targetMpg', 'opt.gapVsTeam', 'nbaReadiness',
      'rb.defense', 'rb.hustle', 'p36.pts', 'p36n.pts', 'p36n.ts', 'custom.twoWayIndex'];
    const bad = await page.evaluate((ks) => ks.map((k) => {
      const h = String(colDef(k)?.help || '');
      const hasWhat = /WHAT:/.test(h) || h.length > 80;
      const hasFormula = /FORMULA:|formula|=|x |\//.test(h);
      return { k, len: h.length, hasWhat, hasFormula };
    }).filter((r) => !r.hasWhat || !r.hasFormula || r.len < 60), keys);
    expect(bad, `tooltips missing plain-words or formula:\n${JSON.stringify(bad, null, 1)}`).toEqual([]);
  });

  test('rendered headers carry the tooltip as a title attribute', async ({ page }) => {
    await open(page);
    const bare = await page.$$eval('thead th', (ths) => ths
      .filter((t) => t.innerText.trim() && !(t.getAttribute('title') || '').trim())
      .map((t) => t.innerText.trim()));
    expect(bare, `headers rendered with no title attribute: ${bare.join(', ')}`).toEqual([]);
  });
});

test.describe('Stat explainer UI', () => {
  test('hovering a column header shows a styled panel with what / plain words / formula', async ({ page }) => {
    await open(page);
    const th = page.locator('thead th.has-tip').first();
    await th.hover();
    await page.waitForSelector('#statTip.show', { timeout: 5000 });
    const tip = await page.evaluate(() => {
      const el = document.getElementById('statTip');
      return { visible: el.classList.contains('show'), text: el.innerText, keys: [...el.querySelectorAll('.tip-k')].map((k) => k.innerText) };
    });
    expect(tip.visible).toBe(true);
    // CSS uppercases these labels, so compare case-insensitively.
    expect(tip.keys.join('|').toLowerCase()).toContain('what it is');
    expect(tip.text.length).toBeGreaterThan(40);

    // The browser's own tooltip must not double up on top of the styled one.
    expect(await th.getAttribute('title')).toBeNull();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    expect(await th.getAttribute('title')).not.toBeNull();   // restored for screen readers
  });

  test('the panel stays inside the viewport', async ({ page }) => {
    await open(page);
    const ths = page.locator('thead th.has-tip');
    const n = Math.min(await ths.count(), 8);
    for (let i = 0; i < n; i++) {
      await ths.nth(i).hover();
      await page.waitForTimeout(120);
      const ok = await page.evaluate(() => {
        const r = document.getElementById('statTip').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
      });
      expect(ok, `tooltip escaped the viewport on header ${i}`).toBe(true);
    }
  });

  test('Stat guide lists every documented column and is searchable', async ({ page }) => {
    await open(page);
    await page.click('#statGuideBtn');
    await page.waitForSelector('[data-sg="list"] .stat-guide-item', { timeout: 5000 });
    const all = await page.locator('[data-sg="list"] .stat-guide-item').count();
    expect(all).toBeGreaterThan(80);
    await page.fill('[data-sg="search"]', 'tulip');
    await page.waitForTimeout(250);
    const filtered = await page.locator('[data-sg="list"] .stat-guide-item').count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(all);
    const txt = await page.locator('[data-sg="list"]').innerText();
    expect(txt.toLowerCase()).toContain('how it is calculated');

    // Opening and closing repeatedly must not accumulate dialogs. The first version created a new
    // <dialog> per open, giving every copy the same element ids, so the close button resolved to an
    // already-closed dialog and the live one leaked.
    const before = await page.locator('dialog').count();
    for (let i = 0; i < 3; i++) {
      await page.click('[data-sg="close"]');
      await page.waitForTimeout(150);
      await page.click('#statGuideBtn');
      await page.waitForTimeout(200);
    }
    expect(await page.locator('dialog').count()).toBe(before);
    await page.click('[data-sg="close"]');
    await page.waitForTimeout(150);
    expect(await page.locator('dialog[open]').count()).toBe(0);
  });
});

test.describe('Keyboard and accessibility', () => {
  test('sortable headers are keyboard operable and announce their sort state', async ({ page }) => {
    await open(page);
    const th = page.locator('thead th[data-sort]').nth(9);
    const key = await th.getAttribute('data-sort');
    await th.focus();
    // Focus alone must surface the explainer — the mouse is not the only way in.
    await page.waitForSelector('#statTip.show', { timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await page.$eval('#sortField', (s) => s.value)).toBe(key);
    const sorted = await page.locator(`thead th[data-sort="${key}"]`).getAttribute('aria-sort');
    expect(['ascending', 'descending']).toContain(sorted);
  });

  test('no unlabelled form controls', async ({ page }) => {
    await open(page);
    const bad = await page.evaluate(() => [...document.querySelectorAll('input,select')]
      .filter((i) => i.type !== 'checkbox' && i.type !== 'hidden')
      .filter((i) => !i.closest('label') && !i.getAttribute('aria-label') && !document.querySelector(`label[for="${i.id}"]`))
      .map((i) => i.id || i.type));
    expect(bad, `controls with no accessible name: ${bad.join(', ')}`).toEqual([]);
  });

  test('the page never scrolls horizontally, at desktop or mobile width', async ({ page }) => {
    for (const [w, h] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await open(page);
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, `page overflows horizontally at ${w}px by ${over}px`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('Smoke: every view renders', () => {
  test.setTimeout(180000);
  test('every preset renders rows and columns in both leagues', async ({ page }) => {
    const errors = await open(page);
    // Driven through the app's own change handler rather than selectOption, which waits for
    // actionability on a control the render loop replaces.
    const broken = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const bad = [];
      const sel = document.getElementById('viewPreset');
      const presets = [...sel.options].map((o) => o.value);
      const tabs = [...document.querySelectorAll('.league-tab')];
      for (const tab of tabs) {
        tab.click();
        await wait(250);
        const league = tab.innerText.trim().split(/\s+/)[0];
        for (const p of presets) {
          sel.value = p;
          sel.dispatchEvent(new Event('change'));
          await wait(40);
          const rows = document.querySelectorAll('#tableBody tr').length;
          const cols = document.querySelectorAll('thead th').length;
          const err = document.querySelector('#tableBody .error')?.innerText || '';
          if (rows === 0 || cols < 3 || err) bad.push(`${league}/${p}: rows=${rows} cols=${cols} ${err}`);
        }
      }
      return bad;
    });
    expect(broken, `views that failed to render:\n${broken.join('\n')}`).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('Mobile: the explainer must never trap the user', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('sorting on a touch device leaves the table visible and dismissable', async ({ page }) => {
    await open(page);
    const th = page.locator('thead th[data-sort]').nth(9);

    // Tap to sort. The panel must not be left covering the table with no way out.
    await th.tap();
    await page.waitForTimeout(400);
    const afterSort = await page.evaluate(() => {
      const el = document.getElementById('statTip');
      return { showing: !!el && el.classList.contains('show'), rows: document.querySelectorAll('#tableBody tr').length };
    });
    expect(afterSort.rows).toBeGreaterThan(0);
    expect(afterSort.showing, 'panel still covering the table after a sort tap').toBe(false);

    // When it IS shown on touch it must be closable — by its own button, by tapping away, and by Escape.
    await page.evaluate(() => {
      const th2 = document.querySelectorAll('thead th[data-sort]')[9];
      window.showStatTip ? window.showStatTip(th2, th2.dataset.sort) : th2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    if (await page.locator('#statTip.show').count()) {
      const closeBtn = page.locator('#statTip .tip-close');
      if (await closeBtn.count()) {
        await closeBtn.tap();
        await page.waitForTimeout(200);
        expect(await page.locator('#statTip.show').count()).toBe(0);
      }
    }

    // Escape always dismisses.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await page.locator('#statTip.show').count()).toBe(0);

    // The table is reachable and the page does not scroll sideways.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(2);
  });

  test('the panel stays anchored and in-viewport while scrolling, and always has a way out', async ({ page }) => {
    await open(page);
    const show = () => page.evaluate(() => {
      const th = document.querySelectorAll('thead th[data-sort]')[5];
      th.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    await show();
    await page.waitForTimeout(200);
    expect(await page.locator('#statTip.show').count()).toBe(1);

    // Table headers are position:sticky, so the anchor never leaves the screen and the panel stays
    // correctly attached to it. What matters is that it never drifts off-viewport while scrolling.
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(300);
    if (await page.locator('#statTip.show').count()) {
      const inside = await page.evaluate(() => {
        const r = document.getElementById('statTip').getBoundingClientRect();
        return r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
      });
      expect(inside, 'panel drifted outside the viewport while scrolling').toBe(true);
    }

    // Every exit route works. This is the actual defect being guarded: on touch the panel used to
    // stick after a sort with no way to dismiss it, covering the table.
    await page.locator('#statTip .tip-close').tap();
    await page.waitForTimeout(200);
    expect(await page.locator('#statTip.show').count()).toBe(0);

    await show(); await page.waitForTimeout(200);
    await page.locator('#tableBody').tap({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(200);
    expect(await page.locator('#statTip.show').count(), 'tapping the table should close it').toBe(0);

    await show(); await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await page.locator('#statTip.show').count(), 'Escape should close it').toBe(0);
  });
});

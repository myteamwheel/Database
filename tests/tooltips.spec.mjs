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
    const keys = ['tulip.leagueDelta', 'opt.optimalMpg', 'opt.minutesDelta', 'nbaReadiness',
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

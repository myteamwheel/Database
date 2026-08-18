import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3610;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.gz':'application/gzip' };

function serve() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const raw = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
      const file = path.resolve(ROOT, rel);
      if (!file.startsWith(path.resolve(ROOT) + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      });
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
}

test.beforeAll(async () => { await serve(); });
test.afterAll(async () => { await new Promise((resolve) => server?.close(resolve)); });

async function openLab(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${BASE}/history-lab.html`);
  await page.waitForFunction(() => window.__historyLab?.rows > 100000, null, { timeout: 60000 });
  return errors;
}

test.describe('History Lab', () => {
  test('loads the full current-player historical product and aggregates it', async ({ page }) => {
    const errors = await openLab(page);
    const state = await page.evaluate(() => ({ rows: window.__historyLab.rows, filtered: window.__historyLab.filteredRows, players: window.__historyLab.playerResults }));
    expect(state.rows).toBeGreaterThan(100000);
    expect(state.filtered).toBe(state.rows);
    expect(state.players).toBeGreaterThan(300);
    await expect(page.locator('#hPlayerTable tbody tr').first()).toBeVisible();
    await expect(page.locator('#hGameTable tbody tr').first()).toBeVisible();
    await expect(page.locator('#hSummary')).toContainText('Player-games');
    expect(errors).toEqual([]);
  });

  test('player search, opponent, phase, date and minimum-minute filters recompute the slice', async ({ page }) => {
    const errors = await openLab(page);
    const all = await page.evaluate(() => window.__historyLab.filteredRows);

    await page.fill('#hPlayer', 'LeBron James');
    await page.waitForFunction(() => window.__historyLab.playerResults === 1);
    await expect(page.locator('#hPlayerTable tbody')).toContainText('LeBron James');
    const lebron = await page.evaluate(() => window.__historyLab.filteredRows);
    expect(lebron).toBeGreaterThan(100);
    expect(lebron).toBeLessThan(all);

    await page.selectOption('#hSeason', '2023-24');
    await page.selectOption('#hPhase', 'Regular Season');
    await page.fill('#hMinMinutes', '20');
    await page.waitForTimeout(150);
    const narrowed = await page.evaluate(() => window.__historyLab.filteredRows);
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThan(lebron);
    const raw = await page.$$eval('#hGameTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    expect(raw.every((r) => r[2] === '2023-24' && r[3] === 'RS' && Number(r[7]) >= 20)).toBe(true);

    const opponent = await page.$eval('#hOpponent option:not([value=""])', (o) => o.value);
    await page.selectOption('#hOpponent', opponent);
    await page.waitForTimeout(120);
    const oppRows = await page.evaluate(() => window.__historyLab.filteredRows);
    expect(oppRows).toBeLessThanOrEqual(narrowed);
    expect(errors).toEqual([]);
  });

  test('starter filters distinguish known starter, known bench and unknown rather than coercing null', async ({ page }) => {
    const errors = await openLab(page);

    await page.selectOption('#hSeason', '2023-24');
    await page.selectOption('#hPhase', 'Regular Season');
    await page.selectOption('#hStarted', 'true');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__historyLab.filteredRows)).toBeGreaterThan(0);
    const knownStarts = await page.$$eval('#hGameTable tbody tr td:nth-child(7)', (els) => els.map((e) => e.textContent.trim()));
    expect(knownStarts.length).toBeGreaterThan(0);
    expect(knownStarts.every((x) => x === 'Yes')).toBe(true);

    await page.selectOption('#hSeason', '2015-16');
    await page.selectOption('#hStarted', 'unknown');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__historyLab.filteredRows)).toBeGreaterThan(0);
    const unknown = await page.$$eval('#hGameTable tbody tr td:nth-child(7)', (els) => els.map((e) => e.textContent.trim()));
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((x) => x === '—')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('main database exposes a direct History Lab entry point', async ({ page }) => {
    await page.goto(`${BASE}/index.html`);
    const link = page.locator('a[href="history-lab.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('History Lab');
  });
});

import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let origin;

const typeFor = (p) => p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript'
  : p.endsWith('.css') ? 'text/css' : p.endsWith('.json') ? 'application/json' : 'application/octet-stream';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(path.resolve(ROOT) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': typeFor(full), 'cache-control':'no-store' });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

const raw = fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8');
const baseData = JSON.parse(raw);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const statusFor = (bytes, id='initial') => ({
  schemaVersion:1,
  publicationId:id,
  season:baseData.season,
  publishedAt:'2026-09-29T23:55:00Z',
  dataSha256:hash(bytes),
  lastSuccessfulPublication:{ publicationId:id, publishedAt:'2026-09-29T23:55:00Z' },
  sourceDomains:{
    officialStats:{ status:'ok', checkedAt:'2026-09-29T23:50:00Z', fetchedAt:'2026-09-29T23:50:00Z', asOf:baseData.season,
      changeSummary:{added:1,removed:0,changed:3,retainedSources:0,unavailableSources:0}, limitation:null },
    rosterProjectionInputs:{ status:'ok', checkedAt:'2026-09-29T23:45:00Z', fetchedAt:'2026-09-29T23:45:00Z', asOf:'2026-09-29', limitation:null },
    transactions:{ status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null, limitation:'No verified transaction feed is configured.' },
    injuries:{ status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null, limitation:'No verified injury feed is configured.' },
    news:{ status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null, limitation:'No verified news ingestion is configured.' },
    basketballReferenceSnapshot:{ status:'snapshot', checkedAt:'2026-09-20T10:00:00Z', fetchedAt:'2026-09-20T10:00:00Z', asOf:baseData.season, limitation:'Static snapshot.' },
  },
  changes:{ officialStats:{added:1,removed:0,changed:3,retainedSources:0,unavailableSources:0} },
  forecastAdjustmentPolicy:{
    transactions:'not-applied-unless-verified-structured-input',
    injuries:'not-applied-unless-verified-structured-input',
    news:'not-applied-unless-verified-structured-input',
  },
});

async function routePublication(page, { reloadBytes = null, badReloadHash = false } = {}) {
  const reloadText = reloadBytes || raw;
  await page.route('**/public/data.json*', async (route) => {
    const url = route.request().url();
    if (/[?&]v=/.test(url)) {
      await route.fulfill({status:200,contentType:'application/json',body:reloadText});
    } else await route.continue();
  });
  await page.route('**/public/data-status.json*', async (route) => {
    const url = route.request().url();
    const isReload = /[?&]v=/.test(url);
    const bytes = isReload ? reloadText : raw;
    const status = statusFor(bytes, isReload ? 'reloaded' : 'initial');
    if (isReload && badReloadHash) status.dataSha256 = '0'.repeat(64);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(status)});
  });
}

test('reload published data swaps only a validated bundle and preserves URL/filter/player state', async ({page}) => {
  const target = baseData.leagues.NBA.find((p) => p.name === 'LeBron James') || baseData.leagues.NBA.find((p) => p.appeared);
  const next = JSON.parse(raw);
  next.publicationTestMarker = 'reloaded';
  const nextBytes = JSON.stringify(next);
  await routePublication(page, {reloadBytes:nextBytes});

  const url = `${origin}/index.html?q=Jokic&mode=player&player=${encodeURIComponent(target.playerId)}`;
  await page.goto(url);
  await expect(page.locator('#wsPlayerSel')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#reloadDataBtn')).toBeVisible();
  await expect(page.locator('#dataStatusBtn')).toBeVisible();
  const beforeSearch = page.url();
  await expect(page.locator('#searchInput')).toHaveValue('Jokic');
  await expect(page.locator('#wsPlayerSel')).toHaveValue(String(target.playerId));

  await page.click('#reloadDataBtn');
  await expect(page.locator('#reloadStatus')).toContainText(/reloaded|published/i);
  expect(await page.evaluate(() => DATA.publicationTestMarker)).toBe('reloaded');
  expect(page.url()).toBe(beforeSearch);
  await expect(page.locator('#searchInput')).toHaveValue('Jokic');
  await expect(page.locator('#wsPlayerSel')).toHaveValue(String(target.playerId));
});

test('failed publication validation leaves the currently loaded DATA untouched', async ({page}) => {
  const next = JSON.parse(raw);
  next.publicationTestMarker = 'must-not-apply';
  await routePublication(page, {reloadBytes:JSON.stringify(next), badReloadHash:true});
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('#tableBody tr td');
  expect(await page.evaluate(() => DATA.publicationTestMarker || null)).toBeNull();

  await page.click('#reloadDataBtn');
  await expect(page.locator('#reloadStatus')).toContainText(/failed|invalid|hash/i);
  expect(await page.evaluate(() => DATA.publicationTestMarker || null)).toBeNull();
});

test('data status dialog reports every source independently and labels unsupported domains', async ({page}) => {
  await routePublication(page);
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('#tableBody tr td');
  await page.click('#dataStatusBtn');
  await expect(page.locator('#dataStatusDialog')).toHaveAttribute('open', '');
  const text = await page.locator('#dataStatusDialog').innerText();
  for (const needle of ['Official stats','Roster / projection inputs','Transactions','Injuries','News','Basketball-Reference']) {
    expect(text).toContain(needle);
  }
  expect(text.match(/Not configured/gi)?.length || 0).toBeGreaterThanOrEqual(3);
  expect(text).toMatch(/Latest successfully published data|Latest successful publication/i);
  expect(text).toMatch(/1 added.*3 changed|3 changed.*1 added/i);
});

import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3620;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.gz':'application/gzip'};

test.beforeAll(async()=>{await new Promise((resolve,reject)=>{server=http.createServer((req,res)=>{const rel=decodeURIComponent((req.url||'/').split('?')[0]).replace(/^\/+/, '')||'index.html';const file=path.resolve(ROOT,rel);if(!file.startsWith(path.resolve(ROOT)+path.sep)){res.writeHead(403);res.end();return;}fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404);res.end('not found');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);});});server.once('error',reject);server.listen(PORT,'127.0.0.1',resolve);});});
test.afterAll(async()=>{await new Promise(resolve=>server?.close(resolve));});

async function open(page){const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('pageerror',e=>errors.push(e.message));await page.goto(`${BASE}/evidence-lab.html`);await page.waitForFunction(()=>window.__evidenceLab?.total>100000,null,{timeout:90000});return errors;}

test.describe('TULIP Evidence Lab',()=>{
  test('aligns the historical game and strictly-past feature stores and produces an evidence slice',async({page})=>{const errors=await open(page);const s=await page.evaluate(()=>({total:window.__evidenceLab.total,episodes:window.__evidenceLab.episodes,players:window.__evidenceLab.players}));expect(s.total).toBeGreaterThan(100000);expect(s.episodes).toBeGreaterThan(1000);expect(s.episodes).toBeLessThan(s.total);expect(s.players).toBeGreaterThan(100);await expect(page.locator('#eSupport')).toContainText('Prior');await expect(page.locator('#ePlayerTable tbody tr').first()).toBeVisible();await expect(page.locator('#eEpisodeTable tbody tr').first()).toBeVisible();expect(errors).toEqual([]);});

  test('window and expansion thresholds materially change the selected evidence rather than acting as labels',async({page})=>{const errors=await open(page);const before=await page.evaluate(()=>window.__evidenceLab.episodes);await page.fill('#eDelta','12');await page.dispatchEvent('#eDelta','change');await page.waitForTimeout(150);const highDelta=await page.evaluate(()=>window.__evidenceLab.episodes);expect(highDelta).toBeGreaterThan(0);expect(highDelta).toBeLessThan(before);await page.selectOption('#eWindow','5');await page.waitForTimeout(150);const five=await page.evaluate(()=>window.__evidenceLab.episodes);expect(five).not.toBe(highDelta);expect(errors).toEqual([]);});

  test('player and starter filters operate on observed episodes without coercing unknown starter status',async({page})=>{const errors=await open(page);await page.fill('#ePlayer','LeBron James');await page.waitForFunction(()=>window.__evidenceLab.players===1);await expect(page.locator('#ePlayerTable tbody')).toContainText('LeBron James');await page.selectOption('#eSeason','2015-16');await page.selectOption('#eStarted','unknown');await page.waitForTimeout(150);const n=await page.evaluate(()=>window.__evidenceLab.episodes);expect(n).toBeGreaterThan(0);const starts=await page.$$eval('#eEpisodeTable tbody tr td:nth-child(9)',els=>els.map(e=>e.textContent.trim()));expect(starts.length).toBeGreaterThan(0);expect(starts.every(x=>x==='—')).toBe(true);expect(errors).toEqual([]);});
});

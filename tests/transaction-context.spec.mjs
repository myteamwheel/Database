import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const data=JSON.parse(fs.readFileSync(new URL('../public/data.json',import.meta.url),'utf8'));
const PAGE=process.env.TRANSACTION_TEST_URL || 'file://'+fileURLToPath(new URL('../public/standalone.html',import.meta.url));
for(const league of ['NBA','GLEAGUE']) test(`${league}: official transaction context is collapsed, dated and exact`,async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const player=data.leagues[league].find(p=>p.recentNbaTransactions?.length && (p.appeared || p.currentRoster));
  expect(player).toBeTruthy();
  await page.goto(`${PAGE}?league=${league}&mode=player&player=${player.playerId}`);
  const details=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Recent official NBA transactions'})});
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute('open','');
  await details.locator('summary').click();
  for(const event of player.recentNbaTransactions){await expect(details).toContainText(event.date);await expect(details).toContainText(event.description);}
  await expect(details).toContainText(data.transactionMeta.latestEventDate);
  await expect(details).toContainText('medical');
  expect(errors).toEqual([]);
});

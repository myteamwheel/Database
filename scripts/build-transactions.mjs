// Dated official NBA context only. Never changes roster membership, grades or forecasts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerTransactionIndex, verifyTransactionSnapshot } from './lib/transactions.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root,'scripts/data/live/transactions.json');
const dataFile = path.join(root,'public/data.json');
const data = JSON.parse(fs.readFileSync(dataFile,'utf8'));
const snapshot = fs.existsSync(sourceFile) ? verifyTransactionSnapshot(JSON.parse(fs.readFileSync(sourceFile,'utf8'))) : null;
const fromDate = `${Number(data.projectionMeta.season.slice(0,4))}-07-01`;
const index = snapshot ? playerTransactionIndex(snapshot,{fromDate}) : new Map();
let attached = 0;
for (const rows of Object.values(data.leagues)) for (const player of rows) {
  player.recentNbaTransactions = index.get(String(player.nbaPersonId || player.playerId)) || [];
  if (player.recentNbaTransactions.length) attached++;
}
data.transactionMeta = snapshot ? { source:snapshot.source, fetchedAt:snapshot.fetchedAt,
  sourceRawSha256:snapshot.rawSha256, fromDate, latestEventDate:snapshot.summary.latestEventDate,
  perPlayerLimit:3, attachedPlayerRecords:attached,
  scope:'Official NBA transaction context only; not G League assignment status, medical clearance or automatic forecast adjustments.' } : null;
fs.writeFileSync(dataFile,JSON.stringify(data));
console.log(`Official transaction context: ${attached} NBA/G League records; from ${fromDate}; no model outputs changed`);

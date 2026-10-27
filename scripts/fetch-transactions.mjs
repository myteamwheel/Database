import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refreshTransactions } from './lib/transactions.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const revisionFile=path.join(root,'scripts/data/live/transaction-revisions.json');
const reviewedRevisions=fs.existsSync(revisionFile)?JSON.parse(fs.readFileSync(revisionFile,'utf8')):[];
const snapshot = await refreshTransactions({ file: path.join(root,'scripts/data/live/transactions.json'), reviewedRevisions });
console.log(JSON.stringify({ source: snapshot.source, fetchedAt: snapshot.fetchedAt, ...snapshot.summary }));

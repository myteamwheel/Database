import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshTransactions } from './lib/transactions.mjs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = await refreshTransactions({ file: path.join(root,'scripts/data/live/transactions.json') });
console.log(JSON.stringify({ source: snapshot.source, fetchedAt: snapshot.fetchedAt, ...snapshot.summary }));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicationStatus, deriveSourceDomains, writePublicationStatus } from './lib/publication.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(ROOT, 'public/data.json');
const statusPath = path.join(ROOT, 'public/data-status.json');
if (!fs.existsSync(dataPath)) throw new Error('public/data.json is missing; build the database before publishing status.');

const publicDataBytes = fs.readFileSync(dataPath);
const publicData = JSON.parse(publicDataBytes.toString('utf8'));
const previousStatus = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
const sourceDomains = deriveSourceDomains({ root: ROOT, publicData });
const publishedAt = process.env.PUBLICATION_PUBLISHED_AT
  || process.env.BUILD_GENERATED_AT
  || publicData.generatedAt;
if (!publishedAt) throw new Error('Publication timestamp is unavailable.');

const status = buildPublicationStatus({
  publicData,
  publicDataBytes,
  sourceDomains,
  previousStatus,
  publishedAt,
});
writePublicationStatus({ outputPath: statusPath, status });
console.log(JSON.stringify({
  publicationId: status.publicationId,
  season: status.season,
  publishedAt: status.publishedAt,
  dataSha256: status.dataSha256,
  officialStats: status.sourceDomains.officialStats.status,
  transactions: status.sourceDomains.transactions.status,
  injuries: status.sourceDomains.injuries.status,
  news: status.sourceDomains.news.status,
}));

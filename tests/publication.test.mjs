import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildPublicationStatus,
  deriveSourceDomains,
  validatePublicationStatus,
  writePublicationStatus,
} from '../scripts/lib/publication.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-test-'));
try {
  fs.mkdirSync(path.join(root, 'scripts/data/official_nba'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/data/projection'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/data/official_nba/_refresh-manifest.json'), JSON.stringify({
    version: 1,
    season: '2025-26',
    checkedAt: '2026-09-29T22:00:00Z',
    sources: [
      { name:'base_totals', status:'ok', fetchedAt:'2026-09-29T22:00:00Z', checkedAt:'2026-09-29T22:00:00Z',
        changeSummary:{ previousRows:500,nextRows:501,added:1,removed:0,changed:3,addedIds:['99'],removedIds:[],changedIds:['1','2','3'] } },
      { name:'advanced', status:'retained', fetchedAt:'2026-09-28T22:00:00Z', checkedAt:'2026-09-29T22:00:00Z',
        reason:'optional endpoint down' },
    ],
  }));
  fs.writeFileSync(path.join(root, 'scripts/data/projection/inputs.provenance.json'), JSON.stringify({
    file:'scripts/data/projection/inputs.json', sha256:'a'.repeat(64), fetchedAt:'2026-09-26T04:28:41.551Z'
  }));
  fs.writeFileSync(path.join(root, 'scripts/data/bref_build_v2.json'), JSON.stringify({
    generatedAt:'2026-09-20T10:00:00Z', source:'Basketball-Reference snapshot'
  }));

  const publicData = { season:'2025-26', generatedAt:'2026-09-29T23:00:00Z', counts:{NBA:600,GLEAGUE:570} };
  const bytes = JSON.stringify(publicData);

  const domains = deriveSourceDomains({ root, publicData });
  assert.equal(domains.officialStats.status, 'partial');
  assert.equal(domains.officialStats.checkedAt, '2026-09-29T22:00:00Z');
  assert.equal(domains.officialStats.fetchedAt, '2026-09-29T22:00:00Z');
  assert.equal(domains.rosterProjectionInputs.status, 'ok');
  assert.equal(domains.rosterProjectionInputs.fetchedAt, '2026-09-26T04:28:41.551Z');
  assert.equal(domains.basketballReferenceSnapshot.status, 'snapshot');
  for (const key of ['transactions','injuries','news']) {
    assert.equal(domains[key].status, 'not-configured');
    assert.equal(domains[key].fetchedAt, null);
  }

  const status = buildPublicationStatus({
    publicData,
    publicDataBytes: bytes,
    sourceDomains: domains,
    previousStatus: { publicationId:'old', publishedAt:'2026-09-28T23:00:00Z', dataSha256:'b'.repeat(64) },
    publishedAt:'2026-09-29T23:05:00Z',
  });
  assert.equal(status.season, '2025-26');
  assert.equal(status.dataSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(status.previousSuccessfulPublication.publicationId, 'old');
  assert.equal(status.changes.officialStats.added, 1);
  assert.equal(status.changes.officialStats.changed, 3);
  assert.equal(status.changes.officialStats.retainedSources, 1);
  assert.equal(status.forecastAdjustmentPolicy.transactions, 'not-applied-unless-verified-structured-input');
  assert.equal(status.forecastAdjustmentPolicy.injuries, 'not-applied-unless-verified-structured-input');
  assert.equal(status.forecastAdjustmentPolicy.news, 'not-applied-unless-verified-structured-input');
  assert.equal(validatePublicationStatus(status, { publicData, publicDataBytes: bytes }), true);

  const out = path.join(root, 'public/data-status.json');
  fs.mkdirSync(path.dirname(out), { recursive:true });
  writePublicationStatus({ outputPath: out, status });
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.publicationId, status.publicationId);

  const original = fs.readFileSync(out, 'utf8');
  assert.throws(() => writePublicationStatus({ outputPath: out, status:{ bad:true } }), /publication|invalid|schema/i);
  assert.equal(fs.readFileSync(out, 'utf8'), original);

  assert.throws(() => validatePublicationStatus({ ...status, dataSha256:'0'.repeat(64) }, { publicData, publicDataBytes: bytes }), /hash|sha/i);
  assert.throws(() => validatePublicationStatus({ ...status, season:'2024-25' }, { publicData, publicDataBytes: bytes }), /season/i);

  console.log('publication tests passed: source domains, explicit unsupported sources, changes, atomic status, hash/season validation');
} finally {
  fs.rmSync(root, { recursive:true, force:true });
}

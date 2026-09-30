import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REQUIRED_DOMAINS = [
  'officialStats',
  'rosterProjectionInputs',
  'transactions',
  'injuries',
  'news',
  'basketballReferenceSnapshot',
];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (p) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
const maxIso = (values) => values.filter(Boolean).sort().at(-1) || null;

function officialStatsDomain(root, publicData) {
  const dirs = ['official_nba','official_gleague_regular','official_gleague_showcase'];
  const manifests = dirs.map((dir) => ({
    dir,
    manifest: readJson(path.join(root, 'scripts/data', dir, '_refresh-manifest.json')),
  })).filter((x) => x.manifest);
  if (!manifests.length) {
    return {
      status: 'tracked-snapshot',
      checkedAt: null,
      fetchedAt: null,
      asOf: publicData?.season || null,
      manifests: 0,
      changeSummary: { added:0, removed:0, changed:0, retainedSources:0, unavailableSources:0 },
      limitation: 'Tracked official-stat files predate per-source refresh manifests; exact fetch time and row-level change history are unavailable.',
    };
  }
  const sources = manifests.flatMap(({dir, manifest}) => (manifest.sources || []).map((s) => ({...s, directory:dir})));
  const retained = sources.filter((s) => s.status === 'retained').length;
  const unavailable = sources.filter((s) => s.status === 'unavailable').length;
  const sums = sources.reduce((acc, s) => {
    const d = s.changeSummary || {};
    acc.added += Number(d.added || 0);
    acc.removed += Number(d.removed || 0);
    acc.changed += Number(d.changed || 0);
    return acc;
  }, { added:0, removed:0, changed:0 });
  return {
    status: retained || unavailable ? 'partial' : 'ok',
    checkedAt: maxIso(manifests.map((x) => x.manifest.checkedAt)),
    fetchedAt: maxIso(sources.map((s) => s.fetchedAt)),
    asOf: [...new Set(manifests.map((x) => x.manifest.season).filter(Boolean))].join(', ') || publicData?.season || null,
    manifests: manifests.length,
    sourceCount: sources.length,
    changeSummary: { ...sums, retainedSources: retained, unavailableSources: unavailable },
    limitation: retained || unavailable
      ? 'At least one optional official-stat source retained an earlier valid snapshot or is unavailable.'
      : null,
  };
}

export function deriveSourceDomains({ root, publicData }) {
  const projection = readJson(path.join(root, 'scripts/data/projection/inputs.provenance.json'));
  const bref = readJson(path.join(root, 'scripts/data/bref_build_v2.json'));
  return {
    officialStats: officialStatsDomain(root, publicData),
    rosterProjectionInputs: projection ? {
      status: 'ok',
      checkedAt: projection.fetchedAt || null,
      fetchedAt: projection.fetchedAt || null,
      asOf: projection.fetchedAt ? String(projection.fetchedAt).slice(0,10) : null,
      sha256: projection.sha256 || null,
      limitation: null,
    } : {
      status: 'unavailable', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'Projection/roster provenance file is unavailable.',
    },
    transactions: {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified transaction feed is configured. Roster snapshots are not presented as a transaction history.',
    },
    injuries: {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified injury/medical-status feed is configured. The model does not infer current clearance.',
    },
    news: {
      status:'not-configured', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'No verified news ingestion is configured. Headlines do not silently alter forecasts.',
    },
    basketballReferenceSnapshot: bref ? {
      status:'snapshot',
      checkedAt: bref.generatedAt || bref.fetchedAt || bref.provenance?.generatedAt || null,
      fetchedAt: bref.generatedAt || bref.fetchedAt || bref.provenance?.generatedAt || null,
      asOf: publicData?.season || null,
      limitation:'Static second-source snapshot; it is not refreshed by the official-stats reload.',
    } : {
      status:'unavailable', checkedAt:null, fetchedAt:null, asOf:null,
      limitation:'Basketball-Reference snapshot metadata is unavailable.',
    },
  };
}

export function validatePublicationStatus(status, { publicData = null, publicDataBytes = null } = {}) {
  if (!status || status.schemaVersion !== 1 || !status.publicationId || !status.season || !status.publishedAt) {
    throw new Error('Publication status schema is invalid.');
  }
  if (Number.isNaN(Date.parse(status.publishedAt))) throw new Error('Publication timestamp is invalid.');
  if (!/^[0-9a-f]{64}$/.test(String(status.dataSha256 || ''))) throw new Error('Publication data SHA256/hash is invalid.');
  if (!status.sourceDomains || REQUIRED_DOMAINS.some((key) => !status.sourceDomains[key])) {
    throw new Error('Publication source-domain status is incomplete.');
  }
  if (publicData && status.season !== publicData.season) throw new Error('Publication season does not match public data season.');
  if (publicDataBytes && status.dataSha256 !== hash(publicDataBytes)) throw new Error('Publication data hash/SHA256 does not match public data.');
  return true;
}

export function buildPublicationStatus({ publicData, publicDataBytes, sourceDomains, previousStatus = null, publishedAt }) {
  if (!publicData || !publicDataBytes || !sourceDomains) throw new Error('Publication requires public data bytes and source domains.');
  const dataSha256 = hash(publicDataBytes);
  const publicationId = `${publicData.season}-${String(publishedAt).replace(/[^0-9]/g,'').slice(0,14)}-${dataSha256.slice(0,12)}`;
  const officialChanges = sourceDomains.officialStats?.changeSummary || { added:0,removed:0,changed:0,retainedSources:0,unavailableSources:0 };
  const status = {
    schemaVersion: 1,
    publicationId,
    season: publicData.season,
    publishedAt,
    buildGeneratedAt: publicData.generatedAt || null,
    dataSha256,
    previousSuccessfulPublication: previousStatus?.publicationId && previousStatus.publicationId !== publicationId ? {
      publicationId: previousStatus.publicationId,
      publishedAt: previousStatus.publishedAt,
      dataSha256: previousStatus.dataSha256,
    } : (previousStatus?.publicationId === publicationId ? previousStatus.previousSuccessfulPublication || null : null),
    sourceDomains,
    changes: { officialStats: officialChanges },
    forecastAdjustmentPolicy: {
      transactions:'not-applied-unless-verified-structured-input',
      injuries:'not-applied-unless-verified-structured-input',
      news:'not-applied-unless-verified-structured-input',
      note:'Unconfigured or ambiguous external information does not silently rewrite forecasts.',
    },
  };
  validatePublicationStatus(status, { publicData, publicDataBytes });
  return status;
}

export function writePublicationStatus({ outputPath, status }) {
  validatePublicationStatus(status);
  fs.mkdirSync(path.dirname(outputPath), { recursive:true });
  const temp = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(status, null, 2) + '\n');
    fs.renameSync(temp, outputPath);
  } finally {
    fs.rmSync(temp, { force:true });
  }
  return outputPath;
}

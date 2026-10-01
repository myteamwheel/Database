import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseTransactions } from '../scripts/lib/transactions.mjs';
import {
  COVERAGE_STATES,
  MODEL_OUTPUTS,
  DEPENDENCY_AUDIT_FILES,
  buildPublicationStatus,
  deriveCoverageStates,
  deriveModelProvenance,
  deriveSourceDomains,
  validatePublicationStatus,
  writePublicationStatus,
} from '../scripts/lib/publication.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-test-'));
try {
  fs.mkdirSync(path.join(root, 'scripts/data/official_nba'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/data/projection'), { recursive: true });
  fs.writeFileSync(path.join(root,'index.html'),'<html>interface defaults fixture</html>');
  for(const relative of DEPENDENCY_AUDIT_FILES){const full=path.join(root,relative);fs.mkdirSync(path.dirname(full),{recursive:true});fs.copyFileSync(new URL(`../${relative}`,import.meta.url),full);}
  for (const spec of Object.values(MODEL_OUTPUTS)) {
    for (const relativePath of spec.codeFiles) {
      const full = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(full), { recursive:true });
      if (!fs.existsSync(full)) fs.writeFileSync(full, `// fixture ${relativePath}\n`);
    }
  }
  fs.writeFileSync(path.join(root, 'PROJECTION_2026_27.json'), JSON.stringify({ id:'PROJECTION_2026_27' }));
  fs.writeFileSync(path.join(root, 'scripts/data/projection/inputs.json'), JSON.stringify({ fetchedAt:'2026-09-26T04:28:41.551Z' }));

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

  const publicData = {
    season:'2025-26', generatedAt:'2026-09-29T23:00:00Z', counts:{NBA:3,GLEAGUE:1},
    gradeModel:{ version:'3.4' },
    projectionMeta:{ id:'PROJECTION_2026_27', contextVersion:'context-1', inputsSha256:'c'.repeat(16), rosterSha256:'d'.repeat(64), rostersAsOf:'2026-09-26' },
    tulipMeta:{ version:'TULIP Evidence v0.1' },
    tulipBetaMeta:{ config:{ version:'tulip-beta-support-v2' }, baselineSeason:'2025-26', rostersAsOf:'2026-09-26' },
    tulipCapacityMeta:{ version:'projected-role-v1', cardSha256:'e'.repeat(64), frozenAt:'2026-09-20', buildInputMode:'preserved_verified_frozen_output' },
    analysis:{ playerCompsMeta:{ version:'4.1.0', nbaHistory:'2009-10 through 2025-26', gleagueHistory:'2014-15 through 2025-26' } },
    provenance:{ buildCommit:'abc1234', gradeModelVersion:'3.4', sources:[
      { file:'official_nba/base_totals.json', sha256:'1'.repeat(16) },
      { file:'official_gleague_regular/base_totals.json', sha256:'2'.repeat(16) },
    ] },
    leagues: {
      NBA: [
        { appeared:true, currentRoster:true, gp:10, minutes:300, proj:{ basis:'multi-year-history' } },
        { appeared:false, currentRoster:true, gp:0, minutes:0, proj:{ basis:'rookie-cohort-fallback', why:{ rookie:{ peers:40 } } } },
        { appeared:false, currentRoster:true, gp:0, minutes:0, proj:{ abstain:true, reason:'insufficient evidence' } },
      ],
      GLEAGUE: [
        { appeared:true, currentRoster:false, gp:8, minutes:200, proj:{ basis:'multi-year-history' } },
      ],
    },
  };
  const bytes = JSON.stringify(publicData);

  const domains = deriveSourceDomains({ root, publicData });
  assert.equal(domains.officialStats.status, 'partial');
  assert.equal(domains.officialStats.checkedAt, '2026-09-29T22:00:00Z');
  assert.equal(domains.officialStats.fetchedAt, '2026-09-29T22:00:00Z');
  assert.equal(domains.rosterProjectionInputs.status, 'ok');
  assert.equal(domains.rosterProjectionInputs.fetchedAt, '2026-09-26T04:28:41.551Z');
  fs.mkdirSync(path.join(root, 'scripts/data/live'), { recursive:true });
  const transactionSnapshot = parseTransactions({NBA_Player_Movement:{rows:Array.from({length:1000},(_,i)=>({
    PLAYER_ID:i+1,TEAM_ID:1610612752,Transaction_Type:'Signing',TRANSACTION_DATE:'2026-09-30T00:00:00',TRANSACTION_DESCRIPTION:'Official signing fixture',
  }))}},{fetchedAt:'2026-10-01T12:00:00Z'});
  const transactionFile = path.join(root,'scripts/data/live/transactions.json');
  fs.writeFileSync(transactionFile,JSON.stringify(transactionSnapshot));
  assert.throws(()=>deriveSourceDomains({root,publicData}),/transaction context is stale/);
  const transactionPublicData={...publicData,transactionMeta:{sourceRawSha256:transactionSnapshot.rawSha256,fetchedAt:transactionSnapshot.fetchedAt}};
  assert.equal(deriveSourceDomains({root,publicData:transactionPublicData}).transactions.status,'tracked-snapshot');
  assert.throws(()=>deriveSourceDomains({root,publicData:{...transactionPublicData,transactionMeta:{...transactionPublicData.transactionMeta,fetchedAt:'2026-09-01'}}}),/stale/);
  fs.rmSync(transactionFile);
  fs.writeFileSync(path.join(root, 'scripts/data/live/roster.json'), JSON.stringify({
    source:'stats.nba.com/stats/playerindex', season:'2026-27', fetchedAt:'2026-09-30T12:00:00Z',
  }));
  const livePublicData = { ...publicData, projectionMeta:{ ...publicData.projectionMeta, rostersAsOf:'2026-09-30' } };
  const withLiveRoster = deriveSourceDomains({ root, publicData: livePublicData });
  assert.equal(withLiveRoster.rosterProjectionInputs.fetchedAt, '2026-09-30T12:00:00Z');
  assert.equal(withLiveRoster.rosterProjectionInputs.projectionInputsFetchedAt, '2026-09-26T04:28:41.551Z');
  assert.equal(withLiveRoster.rosterProjectionInputs.source, 'stats.nba.com/stats/playerindex');
  fs.rmSync(path.join(root, 'scripts/data/live/roster.json'));
  assert.equal(domains.basketballReferenceSnapshot.status, 'snapshot');
  for (const key of ['transactions','injuries','news']) {
    assert.equal(domains[key].status, 'not-configured');
    assert.equal(domains[key].fetchedAt, null);
  }


  const modelProvenance = deriveModelProvenance({ root, publicData });
  assert.equal(modelProvenance.schemaVersion, 1);
  assert.equal(modelProvenance.outputs.performanceGrades.modelVersion, '3.4');
  assert.equal(modelProvenance.outputs.projections.modelVersion, 'PROJECTION_2026_27+context-1');
  assert.equal(modelProvenance.outputs.tulipEvidence.modelVersion, 'TULIP Evidence v0.1');
  assert.equal(modelProvenance.outputs.tulipBeta.modelVersion, 'tulip-beta-support-v2');
  assert.equal(modelProvenance.outputs.projectedRoleMpg.modelVersion, 'projected-role-v1');
  assert.equal(modelProvenance.outputs.playerComparisons.modelVersion, '4.1.0');
  assert.match(modelProvenance.outputs.teamFit.modelVersion, /^code-sha256:[0-9a-f]{64}$/);
  assert.equal(modelProvenance.outputs.teamFit.inputVersion.rosterSha256,publicData.projectionMeta.rosterSha256);
  assert.equal(modelProvenance.outputs.teamFit.inputVersion.rostersAsOf,publicData.projectionMeta.rostersAsOf);
  assert.match(modelProvenance.outputs.crossLeague.modelVersion, /^code-sha256:[0-9a-f]{64}$/);
  const conflictingGradeVersion = JSON.parse(JSON.stringify(publicData));
  conflictingGradeVersion.provenance.gradeModelVersion = '3.3';
  assert.throws(() => deriveModelProvenance({ root, publicData: conflictingGradeVersion }), /grade model version mismatch/i);
  for (const item of Object.values(modelProvenance.outputs)) {
    assert.match(item.codeVersionSha256, /^[0-9a-f]{64}$/);
    assert.ok(item.codeFiles.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
    assert.ok(item.inputVersion && typeof item.inputVersion === 'object');
  }

  const coverage = deriveCoverageStates({ publicData, sourceDomains: domains });
  assert.deepEqual(coverage.allowedStates, [...COVERAGE_STATES]);
  assert.equal(coverage.sourceDomains.officialStats.state, 'partial');
  assert.equal(coverage.sourceDomains.rosterProjectionInputs.state, 'complete');
  assert.equal(coverage.sourceDomains.basketballReferenceSnapshot.state, 'fallback');
  assert.equal(coverage.sourceDomains.transactions.state, 'unavailable');
  assert.equal(coverage.leagues.NBA.state, 'partial');
  assert.deepEqual(coverage.leagues.NBA.seasonData.counts, { complete:1, partial:2, fallback:0, unavailable:0 });
  assert.deepEqual(coverage.leagues.NBA.projections.counts, { complete:1, partial:0, fallback:1, unavailable:1 });
  assert.equal(coverage.leagues.GLEAGUE.state, 'complete');
  assert.deepEqual(coverage.leagues.GLEAGUE.seasonData.counts, { complete:1, partial:0, fallback:0, unavailable:0 });
  assert.deepEqual(coverage.leagues.GLEAGUE.projections.counts, { complete:1, partial:0, fallback:0, unavailable:0 });

  const status = buildPublicationStatus({
    publicData,
    publicDataBytes: bytes,
    sourceDomains: domains,
    modelProvenance,
    previousStatus: { publicationId:'old', publishedAt:'2026-09-28T23:00:00Z', dataSha256:'b'.repeat(64) },
    publishedAt:'2026-09-29T23:05:00Z',
  });
  assert.equal(status.season, '2025-26');
  assert.equal(status.dataSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(status.previousSuccessfulPublication.publicationId, 'old');
  assert.equal(status.changes.officialStats.added, 1);
  assert.equal(status.changes.officialStats.changed, 3);
  assert.equal(status.changes.officialStats.retainedSources, 1);
  assert.deepEqual(status.coverage, coverage);
  assert.deepEqual(status.modelProvenance, modelProvenance);
  assert.equal(status.forecastAdjustmentPolicy.transactions, 'not-applied-unless-verified-structured-input');
  assert.equal(status.forecastAdjustmentPolicy.injuries, 'not-applied-unless-verified-structured-input');
  assert.equal(status.forecastAdjustmentPolicy.news, 'not-applied-unless-verified-structured-input');
  assert.equal(validatePublicationStatus(status, { publicData, publicDataBytes: bytes, root }), true);
  const validatorPath = path.join(root, 'scripts/lib/projection-validation.mjs');
  assert.ok(modelProvenance.outputs.projections.codeFiles.some(file => file.path === 'scripts/lib/projection-validation.mjs'));
  const validatorBytes = fs.readFileSync(validatorPath);
  fs.appendFileSync(validatorPath, '// changed accounting gate\n');
  assert.throws(() => validatePublicationStatus(status, { publicData, publicDataBytes: bytes, root }), /provenance|implementation|code/i);
  fs.writeFileSync(validatorPath, validatorBytes);
  const gradesPath=path.join(root,'scripts/lib/grades.mjs'),originalGrades=fs.readFileSync(gradesPath),nestedPath=path.join(root,'scripts/lib/nested-ingredient.mjs');
  fs.writeFileSync(gradesPath,"export {value} from './nested-ingredient.mjs';\n");
  fs.writeFileSync(nestedPath,'export const value=1;\n');
  const nestedProvenance=deriveModelProvenance({root,publicData});
  assert.ok(nestedProvenance.outputs.performanceGrades.codeFiles.some(f=>f.path==='scripts/lib/nested-ingredient.mjs'),'Imported helper must be fingerprinted without a manual seed-list edit');
  const nestedStatus=buildPublicationStatus({publicData,publicDataBytes:bytes,sourceDomains:domains,modelProvenance:nestedProvenance,publishedAt:'2026-09-29T23:05:00Z'});
  fs.appendFileSync(nestedPath,'// changed deeply imported formula\n');
  assert.throws(()=>validatePublicationStatus(nestedStatus,{publicData,publicDataBytes:bytes,root}),/provenance|implementation|code/i);
  fs.writeFileSync(gradesPath,originalGrades);fs.unlinkSync(nestedPath);
  for (const relative of ['scripts/lib/sources.mjs','scripts/lib/roster.mjs','app.js','workspace.js','index.html',...DEPENDENCY_AUDIT_FILES]) {
    const full=path.join(root,relative), originalBytes=fs.readFileSync(full);
    fs.appendFileSync(full,'// changed shared numeric or stint identity semantics\n');
    assert.throws(()=>validatePublicationStatus(status,{publicData,publicDataBytes:bytes,root}),/provenance|implementation|code/i);
    fs.writeFileSync(full,originalBytes);
  }
  const rebuiltSame = buildPublicationStatus({
    publicData, publicDataBytes: bytes, sourceDomains: domains, modelProvenance, previousStatus: status, publishedAt:'2026-09-29T23:05:00Z'
  });
  assert.deepEqual(rebuiltSame, status);

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
  const invalidState = JSON.parse(JSON.stringify(status));
  invalidState.coverage.leagues.NBA.state = 'mostly';
  assert.throws(() => validatePublicationStatus(invalidState, { publicData, publicDataBytes: bytes }), /coverage/i);
  const mismatchedSource = JSON.parse(JSON.stringify(status));
  mismatchedSource.coverage.sourceDomains.transactions.state = 'complete';
  assert.throws(() => validatePublicationStatus(mismatchedSource), /coverage/i);

  const staleCounts = JSON.parse(JSON.stringify(status));
  staleCounts.coverage.leagues.NBA.projections.counts.complete += 1;
  assert.throws(() => validatePublicationStatus(staleCounts, { publicData, publicDataBytes: bytes }), /coverage/i);
  const gradeFile = path.join(root, MODEL_OUTPUTS.performanceGrades.codeFiles[0]);
  fs.appendFileSync(gradeFile, '// implementation changed\n');
  assert.throws(() => validatePublicationStatus(status, { publicData, publicDataBytes: bytes, root }), /model provenance|implementation|stale/i);


  console.log('publication tests passed: source domains, normalized coverage states, model/code/input provenance, stale implementation rejection, changes, atomic status, hash/season validation');
} finally {
  fs.rmSync(root, { recursive:true, force:true });
}

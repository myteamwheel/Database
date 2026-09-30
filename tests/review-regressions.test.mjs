import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffResultTables } from '../scripts/lib/refresh.mjs';
import { deriveSourceDomains } from '../scripts/lib/publication.mjs';
import { writeArchiveFiles } from '../scripts/archive-forecast.mjs';
import * as verifier from '../scripts/verify-forecast-archive.mjs';
import { scoreArchive } from '../scripts/lib/forecast-archive.mjs';

test('column order does not manufacture changed player rows', () => {
  const old = {resultSets:{headers:['PLAYER_ID','PTS'],rowSet:[[1,20]]}};
  const next = {resultSets:{headers:['PTS','PLAYER_ID'],rowSet:[[20,1]]}};
  assert.equal(diffResultTables(old,next).changed,0);
});

test('one healthy league manifest cannot claim all official sources are current', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'review-domains-'));
  try {
    const dir=path.join(root,'scripts/data/official_nba');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'_refresh-manifest.json'),JSON.stringify({season:'2025-26',sources:[{status:'ok'}]}));
    const domain=deriveSourceDomains({root,publicData:{season:'2025-26'}}).officialStats;
    assert.equal(domain.status,'partial');
    assert.equal(domain.missingManifests,2);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('archive ID cannot escape its directory or replace the manifest', () => {
  const archive=JSON.parse(fs.readFileSync(new URL('../scripts/data/forecast-archive/2026-27-preseason-2026-09-29-e718284.json',import.meta.url)));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-archive-'));
  try {
    for(const forecastId of ['../escaped','index','a/b','a\\b']) {
      assert.throws(()=>writeArchiveFiles({...archive,forecastId},{archiveDir:path.join(root,'snapshots')}),/forecast.*id|filename/i);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('append-only manifest preserves every existing entry verbatim', () => {
  const entry={forecastId:'old',path:'old.json',sha256:'abc'};
  assert.equal(typeof verifier.validateManifestExtension,'function');
  assert.equal(verifier.validateManifestExtension({forecasts:[entry]},{forecasts:[entry,{forecastId:'new'}]}),true);
  assert.throws(()=>verifier.validateManifestExtension({forecasts:[entry]},{forecasts:[]}),/removed|missing/i);
  assert.throws(()=>verifier.validateManifestExtension({forecasts:[entry]},{forecasts:[{...entry,sha256:'changed'}]}),/modified|changed/i);
});

test('forecast scoring rejects pre-publication results and excludes zero-game rates', () => {
  const archive={season:'2026-27',publishedAt:'2026-10-01',leagues:{NBA:[{identity:'NBA:1',projection:{gp:70,pts:20}}]}};
  const actual={season:'2026-27',asOf:'2027-04-20',status:'final',leagues:{NBA:[{playerId:1,gp:0,pts:0}]}};
  assert.throws(()=>scoreArchive(archive,{...actual,asOf:'2026-09-01'}),/publication|published/i);
  const report=scoreArchive(archive,actual);
  assert.equal(report.leagues.NBA.overall.model.gp.n,1);
  assert.equal(report.leagues.NBA.overall.model.pts.n,0);
  assert.throws(()=>scoreArchive(archive,{...actual,leagues:{NBA:[{playerId:1,gp:-1,pts:20}]}}),/games|gp/i);
});

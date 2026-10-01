import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { refreshSources, diffResultTables, archiveSeasonSnapshot } from '../scripts/lib/refresh.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-test-'));
const outDir = path.join(root, 'source');
const spec = (name = 'base_totals', required = true) => ({ name, url: `https://test.invalid/${name}`,
  required, totals: true, columns: ['PLAYER_ID','GP','MIN','PTS','FGM','FGA'] });
const table = (pts = 100) => ({ resultSets: { headers: ['PLAYER_ID','GP','MIN','PTS','FGM','FGA'], rowSet: [[1,10,300,pts,40,80]] } });
const fetchFor = (items) => async (url) => {
  const name = url.split('/').at(-1);
  const item = items[name];
  if (item instanceof Error) throw item;
  return item;
};

try {
  const first = await refreshSources({ jobs: [spec()], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table() }), pauseMs: 0, now: '2026-09-28T00:00:00Z' });
  assert.equal(first.changed, 1);
  const saved = fs.readFileSync(path.join(outDir, 'base_totals.json'), 'utf8');
  assert.equal(JSON.parse(saved).resultSets.rowSet.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, '_refresh-manifest.json'), 'utf8')).sources[0].status, 'ok');

  const optionalSeed = await refreshSources({ jobs: [spec(), spec('advanced', false)], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table(), advanced: table() }), pauseMs: 0 });
  assert.equal(optionalSeed.changed, 1);

  const unchanged = await refreshSources({ jobs: [spec()], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table() }), pauseMs: 0, now: '2026-09-28T01:00:00Z' });
  assert.equal(unchanged.changed, 0);

  await assert.rejects(refreshSources({ jobs: [spec()], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: new Error('network down') }), pauseMs: 0 }), /previous snapshot preserved/);
  assert.equal(fs.readFileSync(path.join(outDir, 'base_totals.json'), 'utf8'), saved);

  for(const id of [true,false,[1],{id:1},1.5,'01','1e0',0,Number.MAX_SAFE_INTEGER+1]) {
    const invalid=table();invalid.resultSets.rowSet[0][0]=id;
    await assert.rejects(refreshSources({jobs:[spec()],outDir,season:'2025-26',seasonType:'Regular Season',leagueId:'00',fetchImpl:fetchFor({base_totals:invalid}),pauseMs:0}),/player ID/);
    assert.equal(fs.readFileSync(path.join(outDir,'base_totals.json'),'utf8'),saved);
  }
  const duplicate=table();duplicate.resultSets.rowSet.push(['1',10,300,100,40,80]);
  await assert.rejects(refreshSources({jobs:[spec()],outDir,season:'2025-26',seasonType:'Regular Season',leagueId:'00',fetchImpl:fetchFor({base_totals:duplicate}),pauseMs:0}),/Duplicate player ID/);
  assert.equal(fs.readFileSync(path.join(outDir,'base_totals.json'),'utf8'),saved);

  const mixed = await refreshSources({ jobs: [spec(), spec('advanced', false)], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table(120), advanced: new Error('optional endpoint down') }), pauseMs: 0 });
  assert.equal(mixed.changed, 1);
  assert.equal(mixed.retained, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, '_refresh-manifest.json'), 'utf8')).sources[1].status, 'retained');

  const diffNone = diffResultTables(table(100), table(100), spec());
  assert.deepEqual(diffNone, { previousRows: 1, nextRows: 1, added: 0, removed: 0, changed: 0, addedIds: [], removedIds: [], changedIds: [] });

  const changedTable = table(125);
  const diffChanged = diffResultTables(table(100), changedTable, spec());
  assert.equal(diffChanged.changed, 1);
  assert.deepEqual(diffChanged.changedIds, ['1']);

  const added = { resultSets: { headers: ['PLAYER_ID','GP','MIN','PTS','FGM','FGA'], rowSet: [[1,10,300,100,40,80],[2,2,30,10,4,8]] } };
  const diffAdded = diffResultTables(table(100), added, spec());
  assert.equal(diffAdded.added, 1);
  assert.deepEqual(diffAdded.addedIds, ['2']);
  const diffRemoved = diffResultTables(added, table(100), spec());
  assert.equal(diffRemoved.removed, 1);
  assert.deepEqual(diffRemoved.removedIds, ['2']);

  const manifestAfterChange = JSON.parse(fs.readFileSync(path.join(outDir, '_refresh-manifest.json'), 'utf8'));
  assert.equal(manifestAfterChange.sources[0].changeSummary.changed, 1);

  await assert.rejects(refreshSources({ jobs: [spec()], outDir, season: '2026-27', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table() }), pauseMs: 0 }), /Season rollover/);

  const archiveRoot = path.join(root, 'archive');
  const rolled = archiveSeasonSnapshot({ outDir, archiveRoot, nextSeason: '2026-27' });
  assert.equal(rolled.rolledOver, true);
  assert.equal(rolled.previousSeason, '2025-26');
  assert.equal(rolled.nextSeason, '2026-27');
  assert.ok(fs.existsSync(path.join(rolled.archiveDir, '_refresh-manifest.json')));
  assert.ok(!fs.existsSync(path.join(outDir, '_refresh-manifest.json')));
  assert.ok(fs.existsSync(outDir));
  await assert.rejects(Promise.resolve().then(() => archiveSeasonSnapshot({
    outDir: rolled.archiveDir, archiveRoot, nextSeason: '2026-27'
  })), /already exists|destination/i);

  console.log('refresh source tests passed: valid promotion, source diffs, fail-closed retention, optional retention, and rollover archive');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

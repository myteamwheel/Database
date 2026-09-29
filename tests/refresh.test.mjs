import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { refreshSources } from '../scripts/lib/refresh.mjs';

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

  const mixed = await refreshSources({ jobs: [spec(), spec('advanced', false)], outDir, season: '2025-26', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table(120), advanced: new Error('optional endpoint down') }), pauseMs: 0 });
  assert.equal(mixed.changed, 1);
  assert.equal(mixed.retained, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, '_refresh-manifest.json'), 'utf8')).sources[1].status, 'retained');

  await assert.rejects(refreshSources({ jobs: [spec()], outDir, season: '2026-27', seasonType: 'Regular Season',
    leagueId: '00', fetchImpl: fetchFor({ base_totals: table() }), pauseMs: 0 }), /Season rollover/);
  console.log('refresh source tests passed: valid promotion, no-change, fail-closed retention, optional-source retention, rollover guard');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

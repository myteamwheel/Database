import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVerifiedForecast } from '../scripts/verify-forecast-archive.mjs';
import { scoreForecastFile } from '../scripts/score-forecast-archive.mjs';
import { writeArchiveFiles } from '../scripts/archive-forecast.mjs';

const root = path.join(import.meta.dirname, '..');
const sourceDir = path.join(root, 'scripts/data/forecast-archive');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'index.json'), 'utf8'));
const sourceEntry = sourceManifest.forecasts[0];
const sourceSnapshot = JSON.parse(fs.readFileSync(path.join(sourceDir, sourceEntry.path), 'utf8'));

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-archive-io-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(sourceManifest, null, 2) + '\n');
  fs.copyFileSync(path.join(sourceDir, sourceEntry.path), path.join(dir, sourceEntry.path));
  return dir;
}

test('verified reader rejects altered snapshot bytes and unsafe manifest paths', () => {
  const dir = fixtureDir();
  try {
    fs.appendFileSync(path.join(dir, sourceEntry.path), ' ');
    assert.throws(() => readVerifiedForecast({ archiveDir: dir, forecastId: sourceEntry.forecastId }), /hash/i);
    const manifest = { ...sourceManifest, forecasts: [{ ...sourceEntry, path: '../outside.json' }] };
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest));
    assert.throws(() => readVerifiedForecast({ archiveDir: dir, forecastId: sourceEntry.forecastId }), /invalid|escape/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verified reader rejects duplicate manifest identities and symlink escapes', () => {
  const dir = fixtureDir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-archive-outside-'));
  try {
    const duplicate = { ...sourceEntry };
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ ...sourceManifest, forecasts: [sourceEntry, duplicate] }));
    assert.throws(() => readVerifiedForecast({ archiveDir: dir, forecastId: sourceEntry.forecastId }), /duplicate forecast id/i);

    const outsideSnapshot = path.join(outside, 'escape.json');
    fs.copyFileSync(path.join(sourceDir, sourceEntry.path), outsideSnapshot);
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.symlinkSync(outsideSnapshot, path.join(dir, 'nested', 'escape.json'));
    const manifest = { ...sourceManifest, forecasts: [{ ...sourceEntry, path: 'nested/escape.json' }] };
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest));
    assert.throws(() => readVerifiedForecast({ archiveDir: dir, forecastId: sourceEntry.forecastId }), /escape|symlink/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('writer fails closed when another writer holds the archive lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-archive-lock-'));
  try {
    fs.writeFileSync(path.join(dir, '.archive-write.lock'), 'manual recovery required\n');
    assert.throws(() => writeArchiveFiles(sourceSnapshot, { archiveDir: dir }), /locked/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writer validates the existing archive before appending and releases its own lock once', () => {
  const dir = fixtureDir();
  const next = structuredClone(sourceSnapshot);
  next.forecastId = 'next-capture';
  try {
    fs.appendFileSync(path.join(dir, sourceEntry.path), 'corrupt');
    assert.throws(() => writeArchiveFiles(next, { archiveDir: dir }), /hash/i);
    assert.equal(fs.existsSync(path.join(dir, 'next-capture.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.archive-write.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writer rejects invalid incoming headline forecasts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-archive-invalid-'));
  try {
    const missing = structuredClone(sourceSnapshot);
    missing.forecastId = 'missing-headline';
    const league = missing.leagues.NBA.length ? 'NBA' : 'GLEAGUE';
    const projected = missing.leagues[league].find((row) => !row.abstain && row.projection);
    assert.ok(projected, 'fixture must contain a projected row');
    projected.projection.gp = null;
    assert.throws(() => writeArchiveFiles(missing, { archiveDir: dir }), /gp|finite|nonnegative/i);

    const negative = structuredClone(sourceSnapshot);
    negative.forecastId = 'negative-headline';
    negative.leagues[league].find((row) => !row.abstain && row.projection).projection.pts = -1;
    assert.throws(() => writeArchiveFiles(negative, { archiveDir: dir }), /pts|finite|nonnegative/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scoring refuses to overwrite archive, manifest, actuals or an existing report', () => {
  const dir = fixtureDir();
  const actualPath = path.join(dir, 'actual.json');
  fs.writeFileSync(actualPath, JSON.stringify({ season: sourceSnapshot.season, asOf: '2027-06-01', status: 'final', leagues: { NBA: [], GLEAGUE: [] } }));
  try {
    assert.throws(() => scoreForecastFile({ archive: sourceEntry.forecastId, actual: actualPath, archiveDir: dir, out: path.join(dir, sourceEntry.path) }), /overwrite|EEXIST/i);
    assert.throws(() => scoreForecastFile({ archive: sourceEntry.forecastId, actual: actualPath, archiveDir: dir, out: actualPath }), /overwrite/i);
    assert.throws(() => scoreForecastFile({ archive: sourceEntry.forecastId, actual: actualPath, archiveDir: dir, out: path.join(dir, 'fresh-report.json') }), /overwrite/i);
    const out = path.join(dir, 'report.json');
    fs.writeFileSync(out, 'existing');
    assert.throws(() => scoreForecastFile({ archive: sourceEntry.forecastId, actual: actualPath, archiveDir: dir, out }), /overwrite|EEXIST|exist/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

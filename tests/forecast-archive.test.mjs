import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureForecast, writeArchiveFiles, readGitFile } from '../scripts/archive-forecast.mjs';
import {
  sha256,
  projectionIdentity,
  extractArchivedPlayer,
  validateArchive,
  nbaBaselines,
  gleagueBaseline,
  buildArchive,
} from '../scripts/lib/forecast-archive.mjs';

let pass = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); pass++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const projection = {
  season: '2026-27', team: 'PHI', status: 'same', basis: 'multi-year-history', age: 27,
  modelVersion: 'PROJECTION_2026_27+context-1', timeframe: 'preseason-full-season',
  gp: 72.1, mpg: 31.2, pts: 20.2, reb: 6.7, oreb: 1.4, dreb: 5.3,
  ast: 4.4, stl: 1.1, blk: 0.5, tov: 2.3,
  fgm: 7.4, fga: 15.3, fg3m: 2.2, fg3a: 6.1, ftm: 3.2, fta: 4.0,
  fgPct: 0.484, fg3Pct: 0.361, ftPct: 0.800, ts: 0.592,
  ptsLo: 16.8, ptsHi: 23.9, rebLo: 5.3, rebHi: 8.1, astLo: 3.4, astHi: 5.6,
  mpgLo: 27.0, mpgHi: 34.8, gpLo: 61, gpHi: 80,
  accounting: {
    gp: 72.1, mpg: 31.2, pts: 20.2, reb: 6.7, oreb: 1.4, dreb: 5.3,
    ast: 4.4, stl: 1.1, blk: 0.5, tov: 2.3, fgm: 7.4, fga: 15.3,
    fg3m: 2.2, fg3a: 6.1, ftm: 3.2, fta: 4.0, ftValue: 1,
    totals: { pts: 1456.42 }
  },
  uncertainty: { method: 'legacy-veteran-residuals', calibratedForContextVersion: false },
  availability: { basis: 'historical-appearance-rate', injuryStatus: 'not-verified' },
  why: { seasons: [{ season: '2025-26', gp: 70, min: 2100, weight: 1 }], minutes: { last: 30, projected: 31.2 } },
};

const player = { playerId: 'p1', nbaPersonId: 123, name: 'Test Player', proj: projection };

test('sha256 is deterministic', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('identity is scoped by league', () => {
  assert.notEqual(projectionIdentity('NBA', player), projectionIdentity('GLEAGUE', player));
  assert.equal(projectionIdentity('NBA', player), 'NBA:123');
});

test('projected row preserves published forecast and evidence', () => {
  const out = extractArchivedPlayer('NBA', player);
  assert.equal(out.identity, 'NBA:123');
  assert.equal(out.name, 'Test Player');
  assert.equal(out.team, 'PHI');
  assert.equal(out.status, 'same');
  assert.equal(out.basis, 'multi-year-history');
  assert.equal(out.projection.pts, 20.2);
  assert.deepEqual(out.uncertainty, projection.uncertainty);
  assert.deepEqual(out.availability, projection.availability);
  assert.deepEqual(out.why, projection.why);
});

test('abstention has reason and no numeric projection', () => {
  const out = extractArchivedPlayer('NBA', {
    playerId: 'p2', nbaPersonId: 456, name: 'No History',
    proj: { abstain: true, reason: 'No NBA minutes in recent seasons.' },
  });
  assert.equal(out.abstain, true);
  assert.equal(out.reason, 'No NBA minutes in recent seasons.');
  assert.equal('projection' in out, false);
});

test('same canonical id may appear once per league', () => {
  const nba = extractArchivedPlayer('NBA', player);
  const gl = extractArchivedPlayer('GLEAGUE', { ...player, playerId: 'g1' });
  assert.doesNotThrow(() => validateArchive({ players: [nba, gl] }));
});

test('duplicate identity in one league fails', () => {
  const row = extractArchivedPlayer('NBA', player);
  assert.throws(() => validateArchive({ players: [row, structuredClone(row)] }), /duplicate.*NBA:123/i);
});

test('abstention carrying numeric projection fails', () => {
  const row = { identity: 'NBA:9', league: 'NBA', nbaPersonId: 9, playerId: '9', name: 'Bad', abstain: true, reason: 'none', projection: { pts: 0 } };
  assert.throws(() => validateArchive({ players: [row] }), /abstention.*projection/i);
});

test('invalid makes or attempts fail', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.fgm = 16;
  assert.throws(() => validateArchive({ players: [row] }), /FGM.*FGA/i);
});

test('inconsistent rebounds fail', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.reb = 8.0;
  assert.throws(() => validateArchive({ players: [row] }), /REB.*OREB.*DREB/i);
});

test('high-precision accounting is authoritative when rounded G League fields drift', () => {
  const row = extractArchivedPlayer('GLEAGUE', player);
  row.projection.fgm=7.4; row.projection.fg3m=2.2; row.projection.ftm=1.2; row.projection.fta=1.5; row.projection.pts=20.5;
  row.projection.accounting={...row.projection.accounting,fgm:7.449,fg3m:2.249,ftm:1.249,ftValue:2.7,pts:20.5193};
  assert.doesNotThrow(() => validateArchive({ players: [row] }));
});

test('inconsistent high-precision points accounting fails', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.accounting.pts = 30;
  assert.throws(() => validateArchive({ players: [row] }), /points accounting/i);
});

const seasonRecord = (season, gp, mpg, pts, reb, ast, fgm, fga, fg3m, fg3a, ftm, fta) => ({
  season, team: 'AAA', gp, min: gp * mpg, pts: gp * pts,
  oreb: gp * reb * 0.25, dreb: gp * reb * 0.75, ast: gp * ast, stl: gp, blk: gp * 0.5, tov: gp * 2, pf: gp * 2.2,
  fgm: gp * fgm, fga: gp * fga, fg3m: gp * fg3m, fg3a: gp * fg3a, ftm: gp * ftm, fta: gp * fta,
});

const rec25 = seasonRecord('2025-26', 80, 30, 20, 8, 5, 7, 14, 2, 5, 4, 5);
const rec24 = seasonRecord('2024-25', 60, 24, 12, 6, 4, 4, 10, 1, 4, 3, 4);
const rec23 = seasonRecord('2023-24', 40, 18, 8, 4, 2, 3, 8, 1, 3, 1, 2);
const nbaSeasons = new Map([
  ['2025-26', new Map([[7, rec25]])],
  ['2024-25', new Map([[7, rec24]])],
  ['2023-24', new Map([[7, rec23]])],
  ['2022-23', new Map([[8, seasonRecord('2022-23', 50, 20, 10, 5, 3, 4, 9, 1, 3, 1, 2)]])],
]);
const D = {
  nba: { seasons: nbaSeasons, teamGames: () => 82 },
  gleague: { seasons: new Map([['2025-26', new Map([[7, rec25]])]]), teamGames: () => 50 },
};

test('NBA repeat baseline matches last season and scales GP by appearance share', () => {
  const { repeat } = nbaBaselines(D, 7, '2026-27');
  assert.equal(repeat.pts, 20);
  assert.equal(repeat.mpg, 30);
  assert.equal(repeat.gp, 80);
});

test('NBA three-year baseline uses 5/4/3 times games for per-game stats', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const den = 5*80 + 4*60 + 3*40;
  const expectedPts = (5*80*20 + 4*60*12 + 3*40*8) / den;
  assert.ok(Math.abs(avg3.pts - expectedPts) < 1e-12);
  const expectedMpg = (5*80*30 + 4*60*24 + 3*40*18) / den;
  assert.ok(Math.abs(avg3.mpg - expectedMpg) < 1e-12);
});

test('NBA three-year percentages pool weighted makes and attempts', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const made = 5*rec25.fgm + 4*rec24.fgm + 3*rec23.fgm;
  const att = 5*rec25.fga + 4*rec24.fga + 3*rec23.fga;
  assert.ok(Math.abs(avg3.fgPct - made/att) < 1e-12);
});

test('NBA three-year GP uses weighted appearance shares', () => {
  const { avg3 } = nbaBaselines(D, 7, '2026-27');
  const expected = ((5*(80/82) + 4*(60/82) + 3*(40/82)) / (5+4+3)) * 82;
  assert.ok(Math.abs(avg3.gp - expected) < 1e-12);
});

test('NBA naive baselines do not reach back beyond the recent three seasons', () => {
  const out = nbaBaselines(D, 8, '2026-27');
  assert.equal(out.repeat, null);
  assert.equal(out.avg3, null);
});

test('G League exposes repeat only', () => {
  const out = gleagueBaseline(D, 7, '2026-27', 50);
  assert.equal(out.repeat.pts, 20);
  assert.equal('avg3' in out, false);
});



const table = (headers, rows) => ({ headers, rows });
const baseHeaders = ['PLAYER_ID','PLAYER_NAME','TEAM_ABBREVIATION','AGE','GP','MIN','FGM','FGA','FG3M','FG3A','FTM','FTA','OREB','DREB','AST','TOV','STL','BLK','PF','PTS'];
const advHeaders = ['PLAYER_ID','USG_PCT','PACE','POSS'];
const releaseInputs = {
  playerIndex: table([], []), rosters2627: table(['PERSON_ID','ROSTER_STATUS','TEAM_ABBREVIATION'], [[7,1,'AAA']]),
  nba: {
    '2025-26': { base: table(baseHeaders, [[7,'Veteran','AAA',27,80,2400,560,1120,160,400,320,400,160,480,400,160,80,40,160,1600]]), adv: table(advHeaders, [[7,.25,100,5000]]) },
    '2024-25': { base: table(baseHeaders, [[7,'Veteran','AAA',26,60,1440,240,600,60,240,180,240,90,270,240,120,60,30,120,720]]), adv: table(advHeaders, [[7,.22,99,3000]]) },
    '2023-24': { base: table(baseHeaders, [[7,'Veteran','AAA',25,40,720,120,320,40,120,40,80,40,120,80,80,40,20,80,320]]), adv: table(advHeaders, [[7,.20,98,1500]]) },
  },
  gleague: {
    '2025-26': { base: table(baseHeaders, [[7,'Veteran','GLA',27,20,600,140,280,40,100,80,100,40,120,100,40,20,10,40,400]]), adv: table(advHeaders, [[7,.28,101,1300]]) },
  },
};
const releaseData = {
  projectionMeta: { id:'PROJECTION_2026_27', season:'2026-27', timeframe:'preseason-full-season', contextVersion:'context-1', rostersAsOf:'2026-09-28', rosterSha256:'placeholder' },
  leagues: {
    NBA: [{...player, playerId:'7', nbaPersonId:7, name:'Veteran'}],
    GLEAGUE: [{...player, playerId:'g7', nbaPersonId:7, name:'Veteran', proj:{...projection, team:'GLA', status:'gleague'}}],
  },
};
releaseData.projectionMeta.rosterSha256 = sha256(JSON.stringify(releaseInputs.rosters2627));
const releaseCard = { id:'PROJECTION_2026_27', gleague:{games:50}, builtFrom:{sha256:sha256(JSON.stringify(releaseInputs))} };

test('buildArchive preserves release values and attaches same-date baselines', () => {
  const archive = buildArchive({ data: structuredClone(releaseData), card: releaseCard, rawInputs: JSON.stringify(releaseInputs),
    sourceCommit:'abc123', publishedAt:'2026-09-29', publicationBasis:'verified-release-date', forecastId:'fixture' });
  assert.equal(archive.forecastId, 'fixture');
  assert.equal(archive.players.length, 2);
  assert.equal(archive.players.find(x=>x.league==='NBA').baselines.repeat.pts, 20);
  assert.equal(archive.players.find(x=>x.league==='GLEAGUE').baselines.repeat.pts, 20);
});

test('capture reads exact requested ref bytes and records absent optional roster', () => {
  const bytes = new Map([
    ['public/data.json', Buffer.from(JSON.stringify(releaseData))],
    ['PROJECTION_2026_27.json', Buffer.from(JSON.stringify(releaseCard))],
    ['scripts/data/projection/inputs.json', Buffer.from(JSON.stringify(releaseInputs))],
  ]);
  const seen=[];
  const out = captureForecast({ ref:'release-ref', forecastId:'fixture', publishedAt:'2026-09-29', dryRun:true,
    readRefFile:(ref,p,{optional=false}={})=>{ seen.push([ref,p]); if(bytes.has(p)) return bytes.get(p); if(optional) return null; throw new Error('missing'); },
    resolveRef:()=>({sha:'fullsha',committedAt:'2026-09-29T05:51:38Z'}) });
  assert.ok(seen.every(([ref])=>ref==='release-ref'));
  assert.equal(out.archive.sources['scripts/data/live/roster.json'].present, false);
  assert.equal(out.archive.sources['public/data.json'].sha256, sha256(bytes.get('public/data.json')));
});

test('capture rejects roster hash mismatch', () => {
  const bad=structuredClone(releaseData); bad.projectionMeta.rosterSha256='bad';
  const map=new Map([
    ['public/data.json',Buffer.from(JSON.stringify(bad))],['PROJECTION_2026_27.json',Buffer.from(JSON.stringify(releaseCard))],['scripts/data/projection/inputs.json',Buffer.from(JSON.stringify(releaseInputs))],
  ]);
  assert.throws(()=>captureForecast({ref:'r',forecastId:'f',publishedAt:'2026-09-29',dryRun:true,
    readRefFile:(ref,p,{optional=false}={})=>map.get(p)??(optional?null:(()=>{throw new Error('missing')})()),resolveRef:()=>({sha:'s',committedAt:'t'})}),/roster hash/i);
});

test('readGitFile configures git show for the frozen 151 MB release artifact', () => {
  const out=readGitFile('HEAD','public/data.json',{cwd:'/tmp',run:(cmd,args,opts)=>{
    assert.equal(cmd,'git');
    assert.deepEqual(args,['show','HEAD:public/data.json']);
    assert.ok(opts.maxBuffer >= 151_257_684);
    return Buffer.from('ok');
  }});
  assert.equal(out.toString(),'ok');
});

test('writeArchiveFiles refuses overwrite and writes deterministic manifest', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forecast-archive-'));
  try {
    const archive={schemaVersion:1,forecastId:'f1',season:'2026-27',type:'preseason-full-season',publishedAt:'2026-09-29',sourceCommit:'s',players:[]};
    writeArchiveFiles(root,archive);
    assert.throws(()=>writeArchiveFiles(root,archive),/already exists/i);
    const index=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));
    assert.equal(index.forecasts[0].forecastId,'f1');
    assert.ok(index.forecasts[0].sha256);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

if (!process.exitCode) console.log(`ALL PASS · ${pass} tests`);

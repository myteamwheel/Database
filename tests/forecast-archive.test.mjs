import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureForecast, writeArchiveFiles, readGitFile } from '../scripts/archive-forecast.mjs';
import { verifyArchiveDirectory, validateArchiveDiff } from '../scripts/verify-forecast-archive.mjs';
import {
  sha256,
  projectionIdentity,
  extractArchivedPlayer,
  validateArchive,
  nbaBaselines,
  gleagueBaseline,
  buildArchive,
  deriveCohorts,
  scoreArchive,
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
  row.projection.fgm=7.4; row.projection.fga=15.3; row.projection.fgPct=0.484;
  row.projection.fg3m=2.2; row.projection.fg3a=6.2; row.projection.fg3Pct=0.361;
  row.projection.ftm=1.2; row.projection.fta=1.6; row.projection.ftPct=0.8; row.projection.pts=20.4;
  row.projection.accounting={...row.projection.accounting,fgm:7.4,fga:15.3,fgPct:7.4/15.3,
    fg3m:2.249,fg3a:2.249/0.361,fg3Pct:0.361,ftm:1.249,fta:1.249/0.8,ftPct:0.8,ftValue:2.7,pts:20.4213};
  assert.doesNotThrow(() => validateArchive({ players: [row] }));
});

test('high-precision shooting accounting is authoritative at low rounded volume', () => {
  const row = extractArchivedPlayer('GLEAGUE', player);
  row.projection.fg3m=0.2; row.projection.fg3a=0.4; row.projection.fg3Pct=0.361; row.projection.pts=18.1;
  row.projection.accounting={...row.projection.accounting,fg3m:0.1444,fg3a:0.4,fg3Pct:0.361,pts:18.1444};
  assert.doesNotThrow(() => validateArchive({ players: [row] }));
});

test('inconsistent high-precision shooting percentage fails', () => {
  const row = extractArchivedPlayer('NBA', player);
  row.projection.accounting.fg3Pct = 0.8;
  assert.throws(() => validateArchive({ players: [row] }), /3P%.*accounting/i);
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

const archivedRow = (id, opts={}) => ({
  identity:`NBA:${id}`, league:'NBA', playerId:String(id), nbaPersonId:id, name:`P${id}`,
  team:opts.team || 'AAA', status:opts.status || 'same', basis:opts.basis || 'multi-year-history', age:opts.age ?? 27,
  modelVersion:'m1', timeframe:'preseason-full-season',
  projection:{gp:opts.gp ?? 80,mpg:opts.mpg ?? 30,pts:opts.pts ?? 20,reb:opts.reb ?? 8,ast:opts.ast ?? 5,stl:1,blk:.5,tov:2,fg3m:2,fgPct:.5,fg3Pct:.4,ftPct:.8},
  why:{minutes:{last:opts.lastMpg ?? 25}},
  baselines:{repeat:opts.repeat===null?null:(opts.repeat || {gp:78,mpg:28,pts:18,reb:7,ast:4,stl:.9,blk:.4,tov:2.1,fg3m:1.8,fgPct:.48,fg3Pct:.36,ftPct:.79}),
             avg3:opts.avg3===null?null:(opts.avg3 || {gp:76,mpg:27,pts:17,reb:6.5,ast:3.8,stl:.8,blk:.4,tov:2,fg3m:1.7,fgPct:.47,fg3Pct:.35,ftPct:.78})}
});
const actualRow = (id, opts={}) => ({nbaPersonId:id,name:`P${id}`,team:opts.team || 'BBB',gp:opts.gp ?? 82,min:(opts.gp ?? 82)*(opts.mpg ?? 31),pts:(opts.gp ?? 82)*(opts.pts ?? 22),oreb:(opts.gp ?? 82)*2,dreb:(opts.gp ?? 82)*7,ast:(opts.gp ?? 82)*6,stl:(opts.gp ?? 82)*1.2,blk:(opts.gp ?? 82)*.6,tov:(opts.gp ?? 82)*2.2,fgm:opts.fgm ?? 700,fga:opts.fga ?? 1400,fg3m:opts.fg3m ?? 200,fg3a:opts.fg3a ?? 500,ftm:opts.ftm ?? 300,fta:opts.fta ?? 375});
const actualFile = (rows,status='final') => ({schemaVersion:1,season:'2026-27',asOf:'2027-04-15',status,leagues:{NBA:rows,GLEAGUE:[]}});

test('scoreArchive computes exact MAE RMSE bias and coverage', () => {
  const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1,{pts:20}),archivedRow(2,{pts:10,repeat:null,avg3:null}),{identity:'NBA:3',league:'NBA',nbaPersonId:3,name:'P3',abstain:true,reason:'no history',baselines:{repeat:null,avg3:null}}]};
  const out=scoreArchive(archive,actualFile([actualRow(1,{pts:22}),actualRow(2,{pts:14}),actualRow(3,{pts:9})]));
  const pts=out.leagues.NBA.allModel.metrics.pts;
  assert.equal(pts.n,2); assert.equal(pts.mae,3); assert.ok(Math.abs(pts.rmse-Math.sqrt(10))<1e-12); assert.equal(pts.bias,-3);
  assert.deepEqual(out.coverage.NBA,{archiveRows:3,projected:2,abstained:1,actualMatched:3,repeatAvailable:1,avg3Available:1});
});

test('paired baseline comparisons use identical eligible players', () => {
  const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1,{pts:20}),archivedRow(2,{pts:10,repeat:null,avg3:null})]};
  const out=scoreArchive(archive,actualFile([actualRow(1,{pts:22}),actualRow(2,{pts:100})]));
  assert.equal(out.leagues.NBA.allModel.metrics.pts.n,2);
  assert.equal(out.leagues.NBA.vsRepeat.model.metrics.pts.n,1);
  assert.equal(out.leagues.NBA.vsRepeat.baseline.metrics.pts.n,1);
  assert.equal(out.leagues.NBA.vsRepeat.model.metrics.pts.mae,2);
  assert.equal(out.leagues.NBA.vsRepeat.baseline.metrics.pts.mae,4);
});

test('shooting percentage thresholds are exact and do not remove other metrics', () => {
  const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1),archivedRow(2),archivedRow(3),archivedRow(4)]};
  const rows=[actualRow(1,{fga:99,fg3a:49,fta:49}),actualRow(2,{fga:100,fg3a:50,fta:50}),actualRow(3,{fga:0,fg3a:0,fta:0}),actualRow(4,{fga:1400,fg3a:500,fta:375})];
  const out=scoreArchive(archive,actualFile(rows));
  assert.equal(out.leagues.NBA.allModel.metrics.fgPct.n,2);
  assert.equal(out.leagues.NBA.allModel.metrics.fg3Pct.n,2);
  assert.equal(out.leagues.NBA.allModel.metrics.ftPct.n,2);
  assert.equal(out.leagues.NBA.allModel.metrics.pts.n,4);
});

test('deriveCohorts depends only on archived pre-outcome fields', () => {
  assert.deepEqual(deriveCohorts(archivedRow(1,{status:'rookie',basis:'rookie-cohort-fallback',age:22,lastMpg:20})).sort(), ['age-23-and-under','prior-lower-minutes','rookie'].sort());
  const mover=deriveCohorts(archivedRow(2,{status:'new',basis:'multi-year-history',age:34,lastMpg:30}));
  assert.ok(mover.includes('new-team')); assert.ok(mover.includes('recent-history-veteran')); assert.ok(mover.includes('age-33-and-over')); assert.ok(mover.includes('prior-high-minutes'));
  assert.ok(deriveCohorts(archivedRow(3,{status:'historical',basis:'older-history-fallback'})).includes('older-history-returner'));
  assert.ok(deriveCohorts(archivedRow(4,{status:'unsigned'})).includes('unsigned-at-forecast'));
});

test('interim scoring requires explicit opt-in and omits GP', () => {
  const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1)]};
  const interim=actualFile([actualRow(1,{gp:20})],'interim');
  assert.throws(()=>scoreArchive(archive,interim),/interim/i);
  const out=scoreArchive(archive,interim,{interim:true});
  assert.equal(out.asOf,'2027-04-15'); assert.equal('gp' in out.leagues.NBA.allModel.metrics,false);
});

test('season and actual identity errors fail closed', () => {
  const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1)]};
  assert.throws(()=>scoreArchive(archive,{...actualFile([actualRow(1)]),season:'2027-28'}),/season/i);
  assert.throws(()=>scoreArchive(archive,actualFile([actualRow(1),actualRow(1)])),/duplicate.*NBA:1/i);
});

test('score CLI emits deterministic JSON and writes identical --out', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forecast-score-cli-'));
  try {
    const archive={schemaVersion:1,forecastId:'f',season:'2026-27',players:[archivedRow(1)]};
    const actual=actualFile([actualRow(1)]);
    const ap=path.join(root,'archive.json'), xp=path.join(root,'actual.json'), op=path.join(root,'report.json');
    fs.writeFileSync(ap,JSON.stringify(archive)); fs.writeFileSync(xp,JSON.stringify(actual));
    const stdout=execFileSync(process.execPath,['scripts/score-forecast-archive.mjs','--archive',ap,'--actual',xp],{cwd:path.resolve('.'),encoding:'utf8'});
    execFileSync(process.execPath,['scripts/score-forecast-archive.mjs','--archive',ap,'--actual',xp,'--out',op],{cwd:path.resolve('.'),encoding:'utf8'});
    assert.deepEqual(JSON.parse(stdout),JSON.parse(fs.readFileSync(op,'utf8')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});



test('verifyArchiveDirectory accepts a valid manifest and snapshot', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forecast-verify-ok-'));
  try {
    const archive={schemaVersion:1,forecastId:'f1',season:'2026-27',type:'preseason-full-season',publishedAt:'2026-09-29',sourceCommit:'abc',players:[]};
    writeArchiveFiles(root,archive);
    const out=verifyArchiveDirectory({rootDir:root});
    assert.equal(out.snapshots,1);
    assert.equal(out.forecasts[0],'f1');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('verifyArchiveDirectory fails on manifest hash mismatch and missing file', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forecast-verify-bad-'));
  try {
    const archive={schemaVersion:1,forecastId:'f1',season:'2026-27',type:'preseason-full-season',publishedAt:'2026-09-29',sourceCommit:'abc',players:[]};
    writeArchiveFiles(root,archive);
    const indexPath=path.join(root,'index.json');
    const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
    index.forecasts[0].sha256='0'.repeat(64);
    fs.writeFileSync(indexPath,JSON.stringify(index,null,1)+'\n');
    assert.throws(()=>verifyArchiveDirectory({rootDir:root}),/hash/i);
    index.forecasts[0].sha256=sha256(fs.readFileSync(path.join(root,'f1.json')));
    index.forecasts[0].file='missing.json';
    fs.writeFileSync(indexPath,JSON.stringify(index,null,1)+'\n');
    assert.throws(()=>verifyArchiveDirectory({rootDir:root}),/missing/i);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('verifyArchiveDirectory fails duplicate manifest ids and bad manifest counts', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forecast-verify-dupe-'));
  try {
    const archive={schemaVersion:1,forecastId:'f1',season:'2026-27',type:'preseason-full-season',publishedAt:'2026-09-29',sourceCommit:'abc',players:[]};
    writeArchiveFiles(root,archive);
    const indexPath=path.join(root,'index.json');
    const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
    index.forecasts.push(structuredClone(index.forecasts[0]));
    fs.writeFileSync(indexPath,JSON.stringify(index,null,1)+'\n');
    assert.throws(()=>verifyArchiveDirectory({rootDir:root}),/duplicate/i);
    index.forecasts.pop();
    index.forecasts[0].counts.projected=1;
    fs.writeFileSync(indexPath,JSON.stringify(index,null,1)+'\n');
    assert.throws(()=>verifyArchiveDirectory({rootDir:root}),/count/i);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('validateArchiveDiff allows additions and index changes', () => {
  assert.doesNotThrow(()=>validateArchiveDiff([
    {status:'A',path:'scripts/data/forecast-archive/new.json'},
    {status:'M',path:'scripts/data/forecast-archive/index.json'},
  ]));
});

test('validateArchiveDiff rejects mutation deletion and rename of snapshots', () => {
  for (const rows of [
    [{status:'M',path:'scripts/data/forecast-archive/old.json'}],
    [{status:'D',path:'scripts/data/forecast-archive/old.json'}],
    [{status:'R100',path:'scripts/data/forecast-archive/old.json',newPath:'scripts/data/forecast-archive/new.json'}],
  ]) assert.throws(()=>validateArchiveDiff(rows),/append-only/i);
});

test('validateArchiveDiff ignores unrelated paths', () => {
  assert.doesNotThrow(()=>validateArchiveDiff([{status:'M',path:'scripts/build-projections.mjs'}]));
});

if (!process.exitCode) console.log(`ALL PASS · ${pass} tests`);

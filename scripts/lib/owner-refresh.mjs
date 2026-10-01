import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SUPPORTED_BUILD_SEASON = '2025-26';

export function ownerRefreshStages({ season = SUPPORTED_BUILD_SEASON } = {}) {
  if (season !== SUPPORTED_BUILD_SEASON) {
    throw new Error(`Owner refresh builder currently supports ${SUPPORTED_BUILD_SEASON}; ${season} requires an explicit season/builder rollover before ingestion.`);
  }
  return [
    { id:'fetch-official', command:'npm', args:['run','fetch'] },
    { id:'fetch-transactions', command:'npm', args:['run','fetch:transactions'] },
    { id:'fetch-live-roster', command:'npm', args:['run','fetch:live-roster'] },
    // Training inputs are hash-pinned to the fitted model card. Refreshing them
    // is a separate, explicitly validated model refit, not routine ingestion.
    { id:'fetch-bios', command:'npm', args:['run','fetch:bios'] },
    { id:'fetch-birthdates', command:'npm', args:['run','fetch:birthdates'] },
    { id:'build', command:'npm', args:['run','build'] },
    { id:'verify', command:'npm', args:['run','verify'] },
  ];
}

function writeRecord(root, record) {
  const dir = path.join(root, 'scripts/data/refresh-runs');
  fs.mkdirSync(dir, { recursive:true });
  const out = path.join(dir, 'latest.json');
  const temp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(temp, out);
}

export function defaultStageRunner(root, extraEnv = {}) {
  return async (stage) => {
    const result = spawnSync(stage.command, stage.args, {
      cwd: root,
      encoding:'utf8',
      env:{ ...process.env, ...extraEnv },
      stdio:['ignore','pipe','pipe'],
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || (result.error?.message || ''),
    };
  };
}

export async function runOwnerRefresh({
  root,
  season = SUPPORTED_BUILD_SEASON,
  now = () => new Date().toISOString(),
  runStage = null,
} = {}) {
  if (!root) throw new Error('Owner refresh root is required.');
  const stages = ownerRefreshStages({ season });
  const artifacts = ['public/data.json', 'public/data-status.json', 'public/standalone.html'].map((file) => {
    const filename = path.join(root, file);
    return { filename, bytes: fs.existsSync(filename) ? fs.readFileSync(filename) : null };
  });
  const runner = runStage || defaultStageRunner(root, { REFRESH_SEASON: season });
  const startedAt = now();
  const record = {
    version:1,
    season,
    state:'running',
    startedAt,
    finishedAt:null,
    stages:[],
    failure:null,
    note:'Owner/local refresh only. This command never commits or pushes git.',
  };
  writeRecord(root, record);

  for (const stage of stages) {
    const stageStartedAt = now();
    let result;
    try {
      result = await runner(stage);
    } catch (error) {
      result = { code:1, stdout:'', stderr:error?.message || String(error) };
    }
    const stageRecord = {
      id:stage.id,
      command:[stage.command, ...(stage.args || [])].join(' '),
      startedAt:stageStartedAt,
      finishedAt:now(),
      status:result.code === 0 ? 'ok' : 'failed',
      stdout:String(result.stdout || '').slice(-4000),
      stderr:String(result.stderr || '').slice(-4000),
    };
    record.stages.push(stageRecord);
    if (result.code !== 0) {
      // Do not leave a failed build available for accidental publication. Raw
      // input caches remain available for diagnosis; public artifacts roll back.
      for (const { filename, bytes } of artifacts) {
        if (bytes === null) fs.rmSync(filename, { force:true });
        else fs.writeFileSync(filename, bytes);
      }
      record.state='failed';
      record.finishedAt=now();
      record.failure={ stage:stage.id, reason:stageRecord.stderr || stageRecord.stdout || `exit ${result.code}` };
      writeRecord(root, record);
      return record;
    }
    writeRecord(root, record);
  }

  record.state='verified-ready-to-publish';
  record.finishedAt=now();
  writeRecord(root, record);
  return record;
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchJson } from './refresh.mjs';

export const TRANSACTION_URL = 'https://stats.nba.com/js/data/playermovement/NBA_Player_Movement.json';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TYPES = new Set(['Signing','Waive','Trade','AwardOnWaivers','ContractConverted']);

export function parseTransactions(payload, { fetchedAt, minRows = 1000 } = {}) {
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Transaction fetch date is invalid');
  const rows = payload?.NBA_Player_Movement?.rows;
  if (!Array.isArray(rows) || rows.length < minRows) throw new Error('Transaction ledger missing or unexpectedly small');
  const seen = new Set(), events = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid transaction row');
    if (!TYPES.has(row.Transaction_Type)) throw new Error('Unknown official transaction type');
    if (!Number.isSafeInteger(row.PLAYER_ID) || row.PLAYER_ID < 0) throw new Error('Invalid transaction player ID');
    if (!Number.isSafeInteger(row.TEAM_ID) || row.TEAM_ID < 1610612737 || row.TEAM_ID > 1610612766) throw new Error('Invalid transaction team ID');
    if (typeof row.TRANSACTION_DESCRIPTION !== 'string' || !row.TRANSACTION_DESCRIPTION.trim()) throw new Error('Missing transaction description');
    if (typeof row.TRANSACTION_DATE !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.TRANSACTION_DATE)) throw new Error('Invalid transaction event date');
    const date = row.TRANSACTION_DATE.slice(0,10);
    const parsed = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date || date > fetchedAt.slice(0,10)) throw new Error('Invalid/future transaction event date');
    const identity = hash(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push({ id: identity, date, type: row.Transaction_Type, playerId: row.PLAYER_ID || null,
      teamId: row.TEAM_ID, description: row.TRANSACTION_DESCRIPTION });
  }
  events.sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { version: 1, source: TRANSACTION_URL, fetchedAt, rawSha256: hash(rows), rows,
    summary: { rawRows: rows.length, uniqueEvents: events.length, duplicateRows: rows.length - events.length,
      playerEvents: events.filter(e => e.playerId !== null).length,
      nonPlayerEvents: events.filter(e => e.playerId === null).length,
      firstEventDate: events.at(-1)?.date || null, latestEventDate: events[0]?.date || null } };
}

export function verifyTransactionSnapshot(snapshot, options = {}) {
  if (snapshot?.version !== 1 || snapshot.source !== TRANSACTION_URL) throw new Error('Transaction snapshot source/schema is invalid');
  const parsed = parseTransactions({ NBA_Player_Movement: { rows: snapshot.rows } }, { ...options, fetchedAt: snapshot.fetchedAt });
  if (parsed.rawSha256 !== snapshot.rawSha256 || JSON.stringify(parsed.summary) !== JSON.stringify(snapshot.summary)) throw new Error('Transaction snapshot hash/summary mismatch');
  return parsed;
}

export function playerTransactionIndex(snapshot, { fromDate = '2026-07-01', limit = 3, minRows = 1000 } = {}) {
  const verified = verifyTransactionSnapshot(snapshot,{ minRows });
  const scopeTime = Date.parse(`${fromDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !Number.isFinite(scopeTime) || new Date(scopeTime).toISOString().slice(0,10) !== fromDate || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid player transaction scope');
  const seen = new Set(), index = new Map();
  const ordered = verified.rows.slice().sort((a,b)=>b.TRANSACTION_DATE.localeCompare(a.TRANSACTION_DATE) || hash(a).localeCompare(hash(b)));
  for (const row of ordered) {
    const id = hash(row), date = row.TRANSACTION_DATE.slice(0,10);
    if (!row.PLAYER_ID || date < fromDate || seen.has(id)) continue;
    seen.add(id);
    const key = String(row.PLAYER_ID), entries = index.get(key) || [];
    if (entries.length < limit) entries.push({ id, date, type:row.Transaction_Type, teamId:row.TEAM_ID, description:row.TRANSACTION_DESCRIPTION });
    index.set(key,entries);
  }
  return index;
}

export async function refreshTransactions({ file, now = () => new Date().toISOString(), fetchImpl = fetchJson, minRows = 1000 } = {}) {
  if (!file) throw new Error('Transaction destination is required');
  const previous = fs.existsSync(file) ? verifyTransactionSnapshot(JSON.parse(fs.readFileSync(file,'utf8')), { minRows }) : null;
  const payload = await fetchImpl(TRANSACTION_URL);
  const next = parseTransactions(payload, { fetchedAt: now(), minRows });
  if (previous && next.summary.latestEventDate < previous.summary.latestEventDate) throw new Error('Transaction feed moved backwards; prior snapshot retained');
  const nextIdentities = new Set(next.rows.map(hash));
  if (previous && previous.rows.some(row => !nextIdentities.has(hash(row)))) throw new Error('Transaction history removed or revised; explicit review required, prior snapshot retained');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, JSON.stringify(next) + '\n'); fs.renameSync(temp,file); }
  finally { if (fs.existsSync(temp)) fs.rmSync(temp); }
  return next;
}

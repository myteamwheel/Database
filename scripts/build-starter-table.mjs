// Write validated per-game starter status onto the historical player-game rows, carrying explicit
// provenance. Direct-source and derived values must never be indistinguishable downstream.
//
//   starterSource          DIRECT_NBA | DIRECT_ESPN | RECONSTRUCTED_V1 | UNKNOWN
//   starterMethodVersion   the exact source revision or solver version that produced the value
//   starterValidation      validated_direct | derived_consistent | unresolved
//
// starterValidation is a VALIDATION DESCRIPTOR, not a probability. There is no calibrated model
// behind these values, so emitting something like 0.974 would invent precision that does not exist.
//
// A value is only ever written where a source semantically establishes it:
//   - VALID team-game (exactly five flagged): flagged -> true, everyone else -> false. The "false"
//     is semantic rather than an inference from absence, because validity was independently
//     confirmed — five flagged AND player-level season-total reconciliation. A DNP player in such a
//     team-game demonstrably did not start.
//   - INVALID team-game: EVERY row is null, including unflagged players. Absence of a flag is not
//     evidence of benching while the superset assumption is unproven.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = path.join(ROOT, 'scripts/data/history');
const OUT = path.join(HIST, 'starters');
fs.mkdirSync(OUT, { recursive: true });

export const METHOD_VERSIONS = {
  DIRECT_NBA: 'nba/boxscoretraditionalv2#START_POSITION@v1',
  DIRECT_ESPN: 'espn/summary#athlete.starter@v1',
  RECONSTRUCTED_V1: 'bmatch/maxflow-scc@v1',
};

const prov = JSON.parse(fs.readFileSync(path.join(HIST, 'provenance.json'), 'utf8'));
const rows = [];

for (const season of prov.seasons) {
  for (const [file, st, slug] of [
    ['gamelog.json', 'Regular Season', 'regular'],
    ['gamelog_playoffs.json', 'Playoffs', 'playoffs'],
  ]) {
    const logPath = path.join(HIST, season, file);
    if (!fs.existsSync(logPath)) continue;
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));

    // Direct NBA starter crawl for this season-phase, if it has been fetched and validated.
    const sPath = path.join(HIST, season, `starters_${slug}.json`);
    const byKey = new Map();
    const tgStatus = new Map();
    if (fs.existsSync(sPath)) {
      for (const r of JSON.parse(fs.readFileSync(sPath, 'utf8'))) {
        byKey.set(`${r.gameId}|${r.playerId}|${r.teamId}`, r);
        tgStatus.set(`${r.gameId}|${r.teamId}`, r.starterSourceStatus);
      }
    }

    for (const g of log) {
      const k = `${g.gameId}|${g.playerId}|${g.teamId}`;
      const hit = byKey.get(k);
      const status = tgStatus.get(`${g.gameId}|${g.teamId}`);
      let starter = null, source = 'UNKNOWN', validation = 'unresolved', evidence = null;
      if (hit && status === 'VALID') {
        starter = hit.started;
        source = 'DIRECT_NBA';
        validation = 'validated_direct';
        // START_POSITION only ever asserts the POSITIVE. A false is the validated complement of a
        // team-game-level source — the team-game was confirmed to carry exactly five flags — not an
        // athlete-level explicit negative. Downstream consumers must not assume the upstream feed
        // literally carried starter=false, which matters most for DNP rows.
        evidence = starter ? 'explicit_true' : 'validated_complement_false';
      }
      rows.push({
        season, seasonType: st, gameId: g.gameId, gameDate: g.gameDate,
        playerId: g.playerId, teamId: g.teamId,
        starter,
        starterSource: source,
        starterMethodVersion: source === 'UNKNOWN' ? null : METHOD_VERSIONS[source],
        starterValidation: validation,
        starterEvidence: evidence,
      });
    }
  }
}

/* ------------------------------------------------------------- audit */
const by = {};
for (const r of rows) {
  const k = r.starterSource;
  by[k] = by[k] || { rows: 0, started: 0, benched: 0, nulls: 0 };
  by[k].rows++;
  if (r.starter === true) by[k].started++;
  else if (r.starter === false) by[k].benched++;
  else by[k].nulls++;
}
const total = rows.length;
const pct = (a) => (100 * a / total).toFixed(2) + '%';

console.log('='.repeat(78));
console.log('STARTER COVERAGE BY PROVENANCE');
console.log('='.repeat(78));
console.log('  source              rows        share    started   bench    null');
for (const k of ['DIRECT_NBA', 'DIRECT_ESPN', 'RECONSTRUCTED_V1', 'UNKNOWN']) {
  const b = by[k];
  if (!b) { console.log(`  ${k.padEnd(18)} ${'0'.padStart(8)}   ${'0.00%'.padStart(7)}`); continue; }
  console.log(`  ${k.padEnd(18)} ${String(b.rows).padStart(8)}   ${pct(b.rows).padStart(7)}` +
    `   ${String(b.started).padStart(7)} ${String(b.benched).padStart(7)} ${String(b.nulls).padStart(7)}`);
}
console.log(`  ${'TOTAL'.padEnd(18)} ${String(total).padStart(8)}`);

const known = total - (by.UNKNOWN?.rows || 0);
console.log(`\n  rows with a known starter status: ${known} of ${total}  (${pct(known)})`);
console.log('\n  by season-phase:');
const bySeason = {};
for (const r of rows) {
  const k = `${r.season} ${r.seasonType}`;
  bySeason[k] = bySeason[k] || { n: 0, known: 0 };
  bySeason[k].n++;
  if (r.starterSource !== 'UNKNOWN') bySeason[k].known++;
}
for (const [k, v] of Object.entries(bySeason)) {
  if (!v.known) continue;
  console.log(`    ${k.padEnd(26)} ${v.known}/${v.n}  (${(100 * v.known / v.n).toFixed(1)}%)`);
}

// Invariant: a written team-game must show exactly five starters.
const tg = new Map();
for (const r of rows) {
  if (r.starterSource === 'UNKNOWN') continue;
  const k = `${r.gameId}|${r.teamId}`;
  tg.set(k, (tg.get(k) || 0) + (r.starter === true ? 1 : 0));
}
const bad = [...tg.entries()].filter(([, n]) => n !== 5);
console.log(`\n  written team-games with starters != 5: ${bad.length} of ${tg.size}`);
if (bad.length) { console.log('    ' + JSON.stringify(bad.slice(0, 5))); process.exitCode = 1; }

// Persist ONLY rows whose status is established. A row absent from this file is UNKNOWN by
// definition, so writing 244,221 explicit null/UNKNOWN records stored no information and cost
// 60 MB in every clone. Consumers must default missing keys to
// {starter: null, starterSource: 'UNKNOWN', starterValidation: 'unresolved'}.
const known_rows = rows.filter((r) => r.starterSource !== 'UNKNOWN');
const SCHEMA_VERSION = 1;
const artifact = {
  schemaVersion: SCHEMA_VERSION,
  // Consumers MUST fail closed on an unrecognised schemaVersion rather than best-effort parse.
  onUnknownSchemaVersion: 'FAIL_CLOSED',
  rowKey: ['gameId', 'playerId', 'teamId'],
  schema: ['gameId', 'playerId', 'teamId', 'starter', 'starterSource', 'starterMethodVersion',
    'starterValidation', 'starterEvidence'],
  scope: {
    leagueId: '00',
    seasonPhases: [...new Set(known_rows.map((r) => `${r.season} ${r.seasonType}`))].sort(),
    description: 'Per-game starter status for season-phases that passed player-level acceptance. Phases absent from seasonPhases are entirely UNKNOWN.',
  },
  generatedAt: new Date().toISOString(),
  sourceRevisions: METHOD_VERSIONS,
  absentKeyMeans: { starter: null, starterSource: 'UNKNOWN', starterValidation: 'unresolved', starterEvidence: null },
  evidenceSubtypes: {
    explicit_true: 'the source literally flagged this athlete as a starter',
    validated_complement_false: 'not flagged, within a team-game independently validated to carry exactly five flags; NOT an athlete-level explicit negative from the feed',
  },
  totalHistoricalRows: rows.length,
  establishedRows: known_rows.length,
  rows: known_rows.map((r) => [r.gameId, r.playerId, r.teamId, r.starter, r.starterSource,
    r.starterMethodVersion, r.starterValidation, r.starterEvidence]),
};
const f = path.join(OUT, 'player_game_starters.json');
const payload = JSON.stringify(artifact);

/* --- artifact guards: catch a size explosion BEFORE it reaches a remote, as 43fad97 did not --- */
const MAX_BYTES = 25e6;
const MAX_UNKNOWN_SHARE = 0.05;
const unknownSerialised = payload.split('"UNKNOWN"').length - 1;
const unknownShare = known_rows.length ? unknownSerialised / (known_rows.length + unknownSerialised) : 0;
const guardFailures = [];
if (payload.length > MAX_BYTES) guardFailures.push(`artifact is ${(payload.length / 1e6).toFixed(1)} MB, limit ${MAX_BYTES / 1e6} MB`);
if (unknownShare > MAX_UNKNOWN_SHARE) guardFailures.push(`${(100 * unknownShare).toFixed(1)}% of serialised rows are UNKNOWN, limit ${100 * MAX_UNKNOWN_SHARE}% — absent keys already mean UNKNOWN, so writing them stores nothing`);
console.log(`\n  artifact ${(payload.length / 1e6).toFixed(2)} MB · serialised UNKNOWN rows ${unknownSerialised} (${(100 * unknownShare).toFixed(2)}%)`);
if (guardFailures.length) {
  for (const g of guardFailures) console.log('  ARTIFACT GUARD FAILED: ' + g);
  process.exit(1);
}
fs.writeFileSync(f, payload);
fs.writeFileSync(path.join(OUT, 'starter_table_provenance.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodVersions: METHOD_VERSIONS,
  validationDescriptors: {
    validated_direct: 'a direct semantic source states it, and that source passed acceptance for this season-phase',
    derived_consistent: 'no direct source; solver output uniquely forced by official constraints',
    unresolved: 'not established by any available source; starter is null',
  },
  note: 'starterValidation is a descriptor, not a calibrated probability.',
  rows: rows.length, byProvenance: by,
  sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16),
}, null, 1));
console.log(`\n  -> ${path.relative(ROOT, f)}`);

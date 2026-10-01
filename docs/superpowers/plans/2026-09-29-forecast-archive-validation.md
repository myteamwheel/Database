# Forecast Archive and Validation Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Freeze the deployed 2026–27 preseason projections from release \`e7182849d62cba46566f3ffafc4c1e620e5ef8ff\` as immutable, provenance-rich evidence and add deterministic verification/scoring infrastructure without changing production projection values or UI behavior.

**Architecture:** Add a focused archive library plus three thin CLIs: capture, verify and score. Capture reads release bytes explicitly from a git ref, derives pre-existing naive baselines from the same frozen projection inputs, and writes an append-only snapshot plus manifest; verify checks schema/accounting/hashes and optional git-diff immutability; score accepts an explicit final/interim actual-results file and compares model versus baselines on identical eligible samples.

**Tech Stack:** Node.js >=20, ESM, built-in \`fs/path/crypto/child_process\`, existing projection helpers in \`scripts/lib/projection.mjs\`, current custom Node test harness style, GitHub Actions.

**Spec:** \`docs/superpowers/specs/2026-09-29-forecast-archive-validation-design.md\`

## Global Constraints

- The first archive is the deployed 2026–27 preseason forecast from commit \`e7182849d62cba46566f3ffafc4c1e620e5ef8ff\`.
- The first snapshot must read release artifacts by git ref rather than trusting the current working tree.
- Archived snapshot files are append-only; ordinary tooling has no overwrite flag.
- \`index.json\` may change only to append manifest entries for new snapshots.
- No production projection values, fitting logic or public UI behavior may change.
- NBA baselines must reproduce the existing \`scripts/fit-projections.mjs\` definitions: repeat last season and 5/4/3 game-weighted three-year average.
- G League gets the currently supported repeat-last-line baseline only.
- Missing baselines/outcomes remain unavailable; never coerce them to zero.
- Every snapshot records model id, model/context version, forecast timeframe, roster-as-of date, source commit and raw source hashes from the frozen release.
- Every manifest entry records league counts plus projected, abstained and baseline-available counts.
- Scoring always reports coverage/sample counts separately from error.
- Percentage metrics use the existing held-out test eligibility: actual FGA >=100 for FG%, actual 3PA >=50 for 3P%, actual FTA >=50 for FT%.
- Final scoring accepts only actual files with \`status: "final"\`; \`status: "interim"\` additionally requires explicit \`--interim\`.
- Cohorts are defined from archived pre-outcome fields only.
- Node engine compatibility remains >=20 and no new runtime dependency is introduced.
- `scripts/data/live/roster.json` was absent at the frozen `e718284` ref; the initial snapshot must record that source as absent and preserve the release's embedded `projectionMeta.rosterSha256` rather than inventing a file hash.
- Snapshot-only changes under `scripts/data/forecast-archive/**` are repository evidence and must not trigger generated browser-artifact rebuilds or GitHub Pages deploys.

## Review Focus

- A roster/player can exist in both NBA and G League: identity uniqueness must be scoped by league and canonical id, not name.
- A player can have no recent three-year history but still receive an older-history projection: archive the model forecast while leaving naive recent-history baselines unavailable.
- A percentage can be numerically present but have insufficient actual attempts: exclude only that percentage metric, not the player's other eligible metrics.
- A pull request can legitimately append a new snapshot and update \`index.json\`: immutability checks must allow additions while rejecting modification/deletion/rename of prior snapshot files.
- An interim actual file can contain valid per-game rates before season end: allow explicitly labeled interim rate scoring but do not report GP as final forecast accuracy.
- A snapshot-only commit must still run audit/archive integrity checks, but must not rebuild `public/data.json` or redeploy the static site.

---

### Task 1: Pure archive schema, projection extraction and accounting validation

**Files:**
- Create: \`scripts/lib/forecast-archive.mjs\`
- Create: \`tests/forecast-archive.test.mjs\`

**Interfaces:**
- Produces: \`sha256(bytes: Buffer|string) -> string\`
- Produces: \`projectionIdentity(league: "NBA"|"GLEAGUE", player: object) -> string\`
- Produces: \`extractArchivedPlayer(league: string, player: object) -> object\`
- Produces: \`validateArchive(archive: object) -> { projected: number, abstained: number, byLeague: object }\`
- Later tasks consume these functions without duplicating schema rules.

- [ ] **Step 1: Write failing extraction/validation tests**

In \`tests/forecast-archive.test.mjs\`, add fixture players and checks that:
- NBA and G League rows with the same numeric person id receive distinct identity keys;
- a projected row preserves id/name/team/status/basis/age, GP/MPG and all published box-score/shooting fields, \`uncertainty\`, \`availability\`, and \`why\`;
- an abstention preserves \`reason\` and carries no numeric \`projection\`;
- duplicate identity keys throw;
- FGM > FGA, 3PM > 3PA, FTM > FTA, or inconsistent rebound/points accounting throws.

- [ ] **Step 2: Run the focused test and verify failure**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: FAIL because \`scripts/lib/forecast-archive.mjs\` does not exist.

- [ ] **Step 3: Implement the archive schema helpers**

Implement the four interfaces above in \`scripts/lib/forecast-archive.mjs\`. Use \`player.nbaPersonId ?? player.playerId\` as the canonical id source, scoped by league. Preserve the full published \`proj.why\`, \`proj.uncertainty\`, and \`proj.availability\` objects rather than re-deriving explanation evidence later.

- [ ] **Step 4: Run the focused test**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: PASS for extraction, abstention, uniqueness and accounting tests.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/lib/forecast-archive.mjs tests/forecast-archive.test.mjs
git commit -m "feat: define forecast archive schema"
\`\`\`

### Task 2: Freeze the pre-existing naive baseline definitions

**Files:**
- Modify: \`scripts/lib/forecast-archive.mjs\`
- Modify: \`tests/forecast-archive.test.mjs\`
- Reference only: \`scripts/fit-projections.mjs:416-439\`
- Reference only: \`scripts/lib/projection.mjs:141-156,505-515\`

**Interfaces:**
- Consumes: existing \`prepare\`, \`historyBefore\`, \`actualLine\`, and \`prevSeason\` helpers from \`scripts/lib/projection.mjs\`.
- Produces: \`nbaBaselines(D: object, pid: number, targetSeason: string) -> { repeat: object|null, avg3: object|null, evidence: object }\`
- Produces: \`gleagueBaseline(D: object, pid: number, targetSeason: string, games: number) -> { repeat: object|null, evidence: object }\`

- [ ] **Step 1: Add exact baseline tests**

Add synthetic three-season history where expected values can be calculated by hand. Assert:
- repeat per-game fields equal the most recent available recent season;
- repeat GP equals that season's appearance share times 82;
- NBA avg3 uses weights 5/4/3 multiplied by games for per-game stats;
- avg3 shooting percentages use weighted made/attempt totals rather than averaging percentages;
- avg3 GP uses 5/4/3 weighted appearance shares;
- no recent history returns \`null\` baselines rather than reaching back to an older-history fallback;
- G League exposes repeat only;
- the G League repeat line matches the release's combined 2025–26 base where the regular-season input alone differs.

- [ ] **Step 2: Run the focused test and verify failure**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: FAIL on missing baseline functions.

- [ ] **Step 3: Implement the baseline functions**

Copy the mathematical definitions, not code dependencies, from \`baselineLines()\` in \`scripts/fit-projections.mjs\`; use exported projection-history helpers so the archive does not mutate or refit the model. Keep NBA and G League rules separate.

- [ ] **Step 4: Run focused tests**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: PASS including exact hand-calculated baseline assertions.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/lib/forecast-archive.mjs tests/forecast-archive.test.mjs
git commit -m "feat: preserve forecast comparison baselines"
\`\`\`

### Task 3: Build the explicit git-ref capture CLI and manifest writer

**Files:**
- Create: \`scripts/archive-forecast.mjs\`
- Modify: \`scripts/lib/forecast-archive.mjs\`
- Modify: \`tests/forecast-archive.test.mjs\`
- Modify: \`package.json\`

**Interfaces:**
- Produces: \`readGitFile(ref: string, path: string) -> Buffer\`
- Produces: \`resolveGitCommit(ref: string) -> { sha: string, committedAt: string }\`
- Produces: \`buildArchive({ data, card, rawInputs, sourceCommit, publishedAt, publicationBasis, forecastId }) -> object\`
- Produces CLI: \`node scripts/archive-forecast.mjs --ref <git-ref> --id <forecast-id> [--published-at <ISO>] [--dry-run]\`
- Produces npm command: \`npm run archive:forecast -- --ref ... --id ...\`

- [ ] **Step 1: Add capture failure-mode tests**

Use a temporary git repository fixture or injectable \`readRefFile\` function and assert:
- current-working-tree bytes are ignored when \`--ref\` points to different committed bytes;
- duplicate forecast ids are rejected;
- ambiguous/missing season or timeframe is rejected;
- a missing required release artifact fails closed;
- absence of \`scripts/data/live/roster.json\` is allowed and recorded as absent;
- the full input roster hash must agree with published \`projectionMeta.rosterSha256\`;
- \`--dry-run\` creates no files.

- [ ] **Step 2: Run and verify failure**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: FAIL on missing capture interfaces.

- [ ] **Step 3: Implement capture**

The CLI must read these release paths with \`git show <ref>:<path>\`:
- \`public/data.json\`
- \`PROJECTION_2026_27.json\`
- \`scripts/data/projection/inputs.json\`
- optionally \`scripts/data/live/roster.json\`

Resolve the full commit SHA with git. For recovery of the already-published first release, default \`publishedAt\` to the resolved commit timestamp and record \`publicationBasis: "source-commit-time"\` unless an explicit timestamp is supplied.

Build baseline history from \`prepare(JSON.parse(rawInputs))\`. Attach baselines only where their same-date history supports them. Compute full SHA-256 hashes from the raw release bytes before parsing.

- [ ] **Step 4: Implement append-only manifest writing**

Create \`scripts/data/forecast-archive/\` on first use. Refuse if the target snapshot path already exists. Append one entry to \`index.json\`, sorted by publication time then forecast id. Write snapshot and manifest atomically via temporary files plus rename so a failed write does not leave a half-written manifest.

- [ ] **Step 5: Add package command and run tests**

Add:
\`"archive:forecast": "node scripts/archive-forecast.mjs"\`

Run: \`node tests/forecast-archive.test.mjs\`

Expected: PASS.

- [ ] **Step 6: Commit**

\`\`\`bash
git add scripts/archive-forecast.mjs scripts/lib/forecast-archive.mjs tests/forecast-archive.test.mjs package.json
git commit -m "feat: capture immutable forecast releases"
\`\`\`

### Task 4: Generate and lock the e718284 preseason snapshot

**Files:**
- Create: \`scripts/data/forecast-archive/index.json\`
- Create: \`scripts/data/forecast-archive/2026-27-preseason-2026-09-29-e718284.json\`
- Modify: \`tests/forecast-archive.test.mjs\`

**Interfaces:**
- Consumes Task 3 CLI.
- Produces the canonical first archive used by all future 2026–27 evaluation.

- [ ] **Step 1: Generate the snapshot from the release ref**

Run:
\`\`\`bash
npm run archive:forecast -- \
  --ref e7182849d62cba46566f3ffafc4c1e620e5ef8ff \
  --id 2026-27-preseason-2026-09-29-e718284 \
  --published-at 2026-09-29
\`\`\`

Expected: one new snapshot plus \`index.json\`; source commit is the full \`e718284...\` SHA and publication basis is \`source-commit-time\`.

- [ ] **Step 2: Add exact release-equivalence integration assertions**

In \`tests/forecast-archive.test.mjs\`, read \`public/data.json\` from \`e718284\` with \`git show\` and assert for every NBA/G League player:
- archived projection/abstention matches the released \`p.proj\` fields selected by the schema;
- archived source hashes match raw release bytes;
- counts by league/projected/abstained equal the released data;
- no archive record was created from a player name alone.

- [ ] **Step 3: Run the archive tests**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: PASS with exact release equality.

- [ ] **Step 4: Prove normal projection builds do not rewrite the archive**

Record snapshot and manifest hashes, run \`npm run build:projections\`, then assert the snapshot hash is unchanged. The manifest also remains unchanged because no new snapshot is being appended.

- [ ] **Step 5: Commit**

\`\`\`bash
git add scripts/data/forecast-archive tests/forecast-archive.test.mjs
git commit -m "data: freeze 2026-27 preseason forecast"
\`\`\`

### Task 5: Add deterministic scoring, coverage and pre-outcome cohorts

**Files:**
- Modify: \`scripts/lib/forecast-archive.mjs\`
- Create: \`scripts/score-forecast-archive.mjs\`
- Modify: \`tests/forecast-archive.test.mjs\`
- Modify: \`package.json\`

**Interfaces:**
- Produces actual-results contract:
  \`{ season: string, asOf: string, status: "final"|"interim", leagues: { NBA: object[], GLEAGUE: object[] } }\`
- Produces: \`deriveCohorts(player: object) -> string[]\`
- Produces: \`scoreArchive(archive: object, actuals: object, { interim?: boolean } = {}) -> object\`
- Produces CLI: \`node scripts/score-forecast-archive.mjs --archive <path-or-id> --actual <path> [--interim] [--out <path>]\`
- Produces npm command: \`npm run score:forecast -- ...\`

- [ ] **Step 1: Add synthetic scoring tests**

Assert on hand-built forecast/actual rows:
- MAE, RMSE and signed bias are exact;
- the report includes an all-model sample plus a separate paired model-vs-repeat and model-vs-avg3 sample for each metric;
- within each paired comparison, model and baseline use the exact same eligible players; a player with no baseline stays in all-model scoring but is excluded from that paired comparison;
- coverage, abstention and unavailable-baseline counts are separate from error;
- FG% requires actual FGA >=100, 3P% requires actual 3PA >=50, FT% requires actual FTA >=50;
- a missing percentage outcome does not remove the player's PTS/REB/etc. scoring;
- NBA and G League are never pooled into one league score;
- season mismatch throws;
- \`status: "interim"\` without \`--interim\` throws;
- interim mode omits GP accuracy and labels the report with \`asOf\`;
- a metric with zero eligible observations is reported unavailable rather than dividing by zero.

- [ ] **Step 2: Add cohort tests before any 2026–27 outcome data is used**

Freeze these cohort rules:
- \`rookie\`: archived status/basis identifies rookie fallback;
- \`recent-history-veteran\`: non-rookie \`multi-year-history\`;
- \`older-history-returner\`: \`older-history-fallback\`;
- \`same-team\`: status \`same\`;
- \`new-team\`: status \`new\`;
- \`unsigned-at-forecast\`: status \`unsigned\`;
- \`age-23-and-under\`: age <=23;
- \`age-33-and-over\`: age >=33;
- \`prior-high-minutes\`: archived \`why.minutes.last >= 24\`;
- \`prior-lower-minutes\`: archived finite \`why.minutes.last < 24\`.

Assert cohort membership depends only on archive fields; actual results cannot alter it.

- [ ] **Step 3: Implement scoring and cohort interfaces**

Use identity joins by league + canonical player id. Score \`gp, mpg, pts, reb, ast, stl, blk, tov, fg3m\` plus eligible percentages. For final NBA scoring, actual GP is the final player GP. For interim scoring, omit GP error entirely because the full-season GP forecast is not comparable to incomplete GP-to-date.

- [ ] **Step 4: Add the CLI/package command and deterministic JSON report**

Add:
\`"score:forecast": "node scripts/score-forecast-archive.mjs"\`

Sort league, cohort, method and metric keys deterministically before writing JSON. Default to stdout; \`--out\` writes a file without mutating the archive.

- [ ] **Step 5: Run focused tests and commit**

Run: \`node tests/forecast-archive.test.mjs\`

Expected: PASS.

\`\`\`bash
git add scripts/lib/forecast-archive.mjs scripts/score-forecast-archive.mjs tests/forecast-archive.test.mjs package.json
git commit -m "feat: score frozen forecasts against outcomes"
\`\`\`

### Task 6: Add archive integrity and append-only CI enforcement

**Files:**
- Create: \`scripts/verify-forecast-archive.mjs\`
- Modify: \`tests/forecast-archive.test.mjs\`
- Modify: \`package.json\`
- Modify: \`.github/workflows/audit-player-database.yml\`

**Interfaces:**
- Produces CLI: \`node scripts/verify-forecast-archive.mjs [--base-ref <git-ref>]\`
- Produces npm command: \`npm run verify:forecast-archive -- [--base-ref ...]\`
- With no base ref: validate manifest, snapshot hashes, schema, accounting and source metadata.
- With base ref: additionally inspect git diff and reject modification/deletion/rename of pre-existing snapshot JSON files; allow added snapshots and \`index.json\` changes.

- [ ] **Step 1: Add verifier tests**

Create temporary archive/manifest fixtures and assert:
- file hash mismatch fails;
- manifest points to missing file fails;
- duplicate manifest id fails;
- modifying an existing snapshot relative to base fails;
- deleting or renaming an existing snapshot fails;
- adding a new snapshot passes;
- changing \`index.json\` plus adding that snapshot passes;
- malformed archive schema/accounting fails.

- [ ] **Step 2: Implement verifier**

Use \`git diff --name-status <base-ref>..HEAD -- scripts/data/forecast-archive\`. Treat \`index.json\` specially; any M/D/R status for another snapshot path fails. Current-state validation always runs even when no base ref is supplied.

- [ ] **Step 3: Wire package scripts**

Add:
- \`"test:forecast-archive": "node tests/forecast-archive.test.mjs"\`
- \`"verify:forecast-archive": "node scripts/verify-forecast-archive.mjs"\`

Insert \`npm run test:forecast-archive && npm run verify:forecast-archive\` into the existing \`verify\` chain.

- [ ] **Step 4: Wire GitHub Actions with an explicit base ref**

In \`.github/workflows/audit-player-database.yml\`, add archive tests after projection/model verification and before browser tests.

For pull requests pass \`\${{ github.event.pull_request.base.sha }}\`. For pushes pass \`\${{ github.event.before }}\` when it is non-zero; otherwise run current-state verification without a base. Keep \`fetch-depth: 0\`, which the workflow already uses.

- [ ] **Step 5: Exclude snapshot-only commits from generated rebuild and Pages deploy**

In `.github/workflows/rebuild-generated.yml`, keep the existing positive `scripts/**` trigger and add the later negative pattern:

`!scripts/data/forecast-archive/**`

In `.github/workflows/deploy-pages.yml`, do the same after `scripts/**`. This preserves normal behavior for archive source-code changes elsewhere under `scripts/**`, while appending only a snapshot/manifest does not rebuild or publish the public site. The audit workflow remains unfiltered and still verifies the archive.

- [ ] **Step 6: Run local verification**

Run:
\`\`\`bash
npm run test:forecast-archive
npm run verify:forecast-archive
npm run test:projections
\`\`\`

Expected: all PASS and projection values unchanged.

- [ ] **Step 6: Commit**

\`\`\`bash
git add scripts/verify-forecast-archive.mjs tests/forecast-archive.test.mjs package.json .github/workflows/audit-player-database.yml
git commit -m "ci: enforce immutable forecast archives"
\`\`\`

### Task 7: Close the subproject with full regression evidence and checklist update

**Files:**
- Modify: \`docs/MODEL_REBUILD_CHECKLIST.md\`
- Modify only if implementation revealed a factual clarification: \`docs/superpowers/specs/2026-09-29-forecast-archive-validation-design.md\`

**Interfaces:**
- Consumes all previous tasks.
- Produces a truthful item-17 status and documented commands/evidence.

- [ ] **Step 1: Run the complete focused verification suite**

Run:
\`\`\`bash
npm run test:forecast-archive
npm run verify:forecast-archive
npm run test:projections
npm run audit
npm run verify:artifact
\`\`\`

Expected: PASS.

- [ ] **Step 2: Run the full project verification**

Run: \`npm run verify\`

Expected: PASS, including Playwright browser regression. If an unrelated pre-existing failure occurs, document it separately and do not weaken archive tests to get green.

- [ ] **Step 3: Verify no production forecast/UI drift**

Compare the working-tree \`public/data.json\` projection payload with a clean rebuild before and after archive work. The only expected source changes for this subproject are archive code/data/tests/package/CI/docs; no \`p.proj\` value, app behavior or HTML copy should change.

- [ ] **Step 4: Update item 17 in the master checklist**

Change item 17 from \`NOT STARTED\` to \`IMPLEMENTED + VERIFIED\` only if:
- the \`e718284\` snapshot is tracked and exact;
- baselines are frozen;
- integrity is enforced in CI;
- scorer/cohorts are tested and ready for explicit actuals.

Record that actual 2026–27 accuracy results are necessarily pending season outcomes; infrastructure completion is not an accuracy claim.

- [ ] **Step 5: Commit**

\`\`\`bash
git add docs/MODEL_REBUILD_CHECKLIST.md docs/superpowers/specs/2026-09-29-forecast-archive-validation-design.md
git commit -m "docs: verify forecast archive milestone"
\`\`\`

### Task 8: Review follow-up — fail-closed archive I/O

**Files:** `scripts/archive-forecast.mjs`, `scripts/verify-forecast-archive.mjs`, `scripts/score-forecast-archive.mjs`, new `tests/forecast-archive-io.test.mjs`, `package.json`.

**Interfaces:** Preserve capture/writer/scorer signatures. Add `readVerifiedForecast({ archiveDir, forecastId, snapshotPath })` returning the parsed, hash-verified snapshot. Existing `verifyArchiveDirectory` summary is unchanged.

- [ ] Add real temporary-file tests for concurrent/locked writers, incomplete archives, invalid provenance, altered hashes, unsafe manifest paths, scoring output overwrites, and explicit capture dates.
- [ ] Run `node --test tests/forecast-archive-io.test.mjs`; expect new safeguards to fail before implementation.
- [ ] Serialize writers with an exclusive lock, verify prior evidence before appending, install snapshots without replacing existing paths, and clean up this writer's files on ordinary failure. Stale locks require manual inspection, not automatic stealing. New actual captures require explicit publication dates; dry runs may retain a labeled commit-time fallback. Preserve the already-frozen snapshot.
- [ ] Make scoring load verified bytes through the manifest, reject symlinks/escaping paths, and create report outputs exclusively outside the archive. Add archive and actual-source hashes to report provenance.
- [ ] Run `npm run test:forecast-archive && npm run verify:forecast-archive`; expect all checks to pass. Leave local changes available for whole-candidate review before committing.

### Task 9: Review follow-up — candidate evidence and handoff

**Files:** checklist, review report and handoff documents; transfer artifacts outside the repository.

**Interfaces:** Consumes Task 8 safeguards and the existing review corrections; does not refit models or ingest live sources.

- [ ] Run `npm run verify` with browser permissions; expect a clean full run or record exact unresolved failures without weakening acceptance criteria.
- [ ] Obtain one fresh-context review of the whole candidate, fix important findings with regression tests, and rerun affected checks.
- [ ] Update checklist and handoff with exact results, local/CI/live distinctions, limitations and next action. Regenerate portable patch/ZIP and verify them. Do not publish without the release gate.

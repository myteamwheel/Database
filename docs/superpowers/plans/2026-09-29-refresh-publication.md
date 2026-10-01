# Refresh / Publication / Failure-Handling Implementation Plan

**Goal:** Make refresh behavior explicit, fail-closed, auditable, and user-visible without pretending unsupported sources are current.

**Branch:** \`refresh-publication-next\` stacked on TULIP PR #18.

**Scope from the master plan:** refresh/publication flow, separate source timestamps/status, failure retention, season rollover handling, duplicate prevention, visible change record, and public retrieval of the latest successfully published snapshot.

## Constraints

- Public users may only reload the latest successfully published snapshot. They may not trigger ingestion or write to the repository.
- Owner ingestion remains local/self-hosted because stats.nba.com is not reliable from GitHub-hosted runners in this project.
- GitHub Actions verifies submitted refresh commits and may deploy them, but does not pretend to be the source fetcher.
- Required-source failure preserves the previous valid source snapshot and publication.
- Optional-source failure is explicit and retains the prior valid source when available.
- Transactions, injuries, and news remain separately labeled \`not-configured\` until a verified source exists; they must not silently affect forecasts.
- A new season cannot mix with the prior season. Rollover must archive the previous source snapshot before starting the new one.
- Corrected official totals and postponed/resumed games are represented as source-content changes; the publication change log reports what rows changed without guessing the real-world cause.
- Existing user URL state and selected workspace state must survive a public reload wherever the selected entities still exist.

## Task 1 — Source diffs and season rollover

**Files**
- Modify \`scripts/lib/refresh.mjs\`
- Extend \`tests/refresh.test.mjs\`

Add:
- \`diffResultTables(previousJson, nextJson, spec)\`
- per-source change summaries: added IDs, removed IDs, changed rows, previous/new row counts
- duplicate-player rejection remains strict
- \`archiveSeasonSnapshot({ outDir, archiveRoot, nextSeason })\`
- rollover refuses overwrite if the archive destination already exists
- rollover preserves prior source files and manifest before clearing the live destination

Tests:
- corrected row is reported as changed, not added/removed
- new/removed player IDs are counted
- unchanged fetch has zero row diffs
- season rollover archives the old snapshot atomically
- duplicate/ambiguous rollover destination fails closed

## Task 2 — Publication manifest and atomic status artifact

**Files**
- Create \`scripts/lib/publication.mjs\`
- Create \`scripts/publish-data-status.mjs\`
- Create \`tests/publication.test.mjs\`
- Modify \`package.json\`

Publication status contract:
- publication id/version
- season and publishedAt
- public data SHA-256
- source-domain records for:
  - officialStats
  - rosterProjectionInputs
  - transactions
  - injuries
  - news
  - basketballReferenceSnapshot
- each domain has status, checkedAt/fetchedAt/asOf where supported, and limitation text
- change summary from refresh manifests
- \`lastSuccessfulPublication\`
- explicit forecast-adjustment policy: news/injury/transaction data cannot alter forecasts unless a structured verified input is configured

Write \`public/data-status.json\` atomically. If status generation fails, do not replace the prior file.

## Task 3 — Owner refresh command

**Files**
- Create \`scripts/owner-refresh.mjs\`
- Modify \`package.json\`
- Add tests around orchestration via injectable command runner

Command stages:
1. optionally perform a deliberate season rollover
2. run source fetch commands
3. fetch projection inputs / bios / birthdates / splits as configured
4. rebuild all generated products
5. run audits and verification
6. write the publication status artifact only after verification succeeds

No git push is performed by the script. The owner reviews/commits the resulting diff.

The command emits a machine-readable run record with:
- state: running / failed / verified-ready-to-publish
- startedAt / finishedAt
- command/stage results
- changed-source summary
- failure reason if any

## Task 4 — Public reload and status UI

**Files**
- Modify \`index.html\`
- Modify \`app.js\`
- Modify browser tests

Add:
- **Reload published data** button
- **Data status** button/dialog
- reload fetches \`public/data.json\` and \`public/data-status.json\` with cache-busting
- successful reload swaps DATA only after both files validate
- failure leaves current in-memory DATA intact and shows an error
- URL/filter/player state is restored after successful reload
- status dialog shows each source domain independently and never implies transactions/injuries/news are current when they are not configured
- show latest successful publication timestamp and latest change summary

## Task 5 — Verification workflow

**Files**
- Create/modify GitHub workflow(s)
- Modify main audit workflow to test refresh/publication contracts

GitHub-hosted CI:
- does **not** fetch stats.nba.com
- tests refresh/publication logic using fixtures
- rebuilds from tracked snapshots
- verifies \`public/data-status.json\` matches tracked source/public artifacts
- runs browser tests for public reload/state preservation/status dialog

## Task 6 — Review evidence

**Files**
- Update \`docs/MODEL_REBUILD_CHECKLIST.md\`
- Update PR body

Completion status must distinguish:
- implemented and verified
- supported but not configured
- unavailable by source
- future self-hosted scheduling work

The section is ready for review only after focused tests and the full repository audit/browser suite pass.

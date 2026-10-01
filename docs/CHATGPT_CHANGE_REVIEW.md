# Regular-ChatGPT changes — review ledger

Review dated 2026-09-30; release verified 2026-10-01. **PR #22 merged after all 19 checks passed; Pages deployed and live assets were checked.**
The user subsequently authorized commit, exact-head verification, CI and deployment after all gates pass.

## What was actually found

The regular-ChatGPT work is an open PR stack, not six published releases:

| PR | Reviewed head | Assessment |
|---|---|---|
| #14 | 91ae435 | Useful forecast archive/scoring infrastructure; corrected safeguards below; further capture/scoring integrity gates remain |
| #16 | 7b6ac61 | Useful projection accounting, context reserves, coverage and timeframe helper; not a complete new projection/rookie model |
| #18 | 73be8c5 | Useful TULIP diagnostics and truthful limitations; does not rebuild/validate the allocator |
| #19 | 3a078ae | Useful refresh/status/reload infrastructure; several safety and labeling corrections required |
| #20 | eafcc7f | Useful identity/team/timeframe/Team Fit consistency audit; not proof of all UI flows or model accuracy |
| #21 | 869ab3c | Useful score/missing-value explanations; not a full data-semantics audit |

All six had successful recorded-head CI checks when inspected. That evidence applies to those heads, not automatically to the new release corrections. Relevant full audit runs: 36640401164, 36644588423, 36647422303, 36650945367, 36652435706, 36653538707. The new release is https://github.com/myteamwheel/Database/pull/22.

Alternative #15 (971a269) overlaps the archive work and is not included. Alternative #17 (b05bf5e) adds coarse positional transfer and diminishing-priority heuristics, but its full audit failed (36646563655); do not replace #18 with it just because its focused tests passed. It needs separate reconciliation and evidence. Neither draft was deleted, closed or merged. Old #9 is a temporary starter-acceptance execution branch, not a release feature.

Inline PR-review comments were empty when queried. Changed implementation comments and plan notes were examined as claims: references to future feeds, a timeframe helper, partial TULIP feasibility and historical validation are not counted as finished features. Duplicate new forecast/refresh planning begun in this Codex session was stopped rather than layered on top of the PR stack.

## Twenty-one grouped implementation corrections

1. **Frozen training inputs:** removed re-fetching hash-pinned model inputs from routine owner refresh; otherwise the subsequent build rejects its changed input hash. Model refitting remains a separate deliberate operation.
2. **Failed refresh rollback:** restore prior public data, status and standalone bytes after a failed stage, including removing candidate artifacts absent before the run. Raw caches remain for diagnosis.
3. **Verification must be last:** removed the status rewrite after verification; build already prepares status before validation.
4. **Projection accounting:** reject headline/accounting disagreement, differing game denominators, three-point attempts exceeding all attempts, impossible two-point makes and invalid free-throw value.
5. **Forecast timeframe arithmetic:** permit fractional expected remaining appearances; reject zero-game actuals with positive totals and inconsistent shot/point accounting; support explicit free-throw value.
6. **False refresh changes:** source column reordering no longer marks every player changed.
7. **Source health:** a healthy manifest from one league no longer implies complete official-source coverage; missing scope is partial and timestamps are qualified.
8. **Archive filenames:** reject traversal/separators and the reserved index name before writing.
9. **Append-only manifest:** preserve every existing entry unchanged when verifying against a base ref, not only the snapshot files themselves.
10. **Forecast scoring:** reject results dated before publication and invalid actual values; zero-game players can contribute availability error but not fictitious per-game errors.
11. **Reload validation:** reject malformed core bundles before swapping; unavailable cryptographic verification now fails closed instead of bypassing the hash check.
12. **Offline behavior:** standalone snapshots cannot pretend to fetch updates; disable reload and direct users to the live site. Preserve packed-data loading.
13. **Truthful copy:** a build timestamp is not a successful deployment timestamp; non-appearing records are not all described as currently rostered people who have never played.
14. **Rebuild determinism:** normalize rookie effective-peer evidence to nine decimal places. Five records previously differed at roughly 1e-14 across platforms; no meaningful predicted stat change was intended.
15. **Artifact sync:** include and verify the matching data-status artifact when rebuilding review artifacts; add review regression tests to the audit workflow.
16. **Candidate reproducibility:** preserve committed artifact provenance during the clean rebuild rather than embedding the candidate HEAD and guaranteeing a dirty generated artifact.
17. **Existing-archive integrity:** verify the complete existing archive before any append; reject unindexed snapshots and duplicate manifest IDs/paths.
18. **Archive lock ownership:** release a writer lock exactly once, preventing a failed writer from deleting a later writer's lock.
19. **Forecast completeness:** reject missing, non-finite or negative scoreable headline forecasts before capture.
20. **Material missingness:** treat finite-to-missing and missing-to-finite model outputs as material changes requiring an explanation trace.
21. **Filesystem confinement:** use real paths to block snapshot symlink escape and scoring output anywhere inside the archive, including macOS path aliases; hash actual-result bytes from the same read that is parsed.

Tests were added and observed failing for the demonstrated defects before fixes. The original immutable forecast snapshot was left unchanged. The master checklist was rewritten to remove contradictory completed/live claims and distinguish helpers, data-limited work and release gates.

## Verification ledger

Final local verification (2026-09-30):

- Node-only review regressions: 5 pass.
- Projection accounting: 17 checks pass; timeframe arithmetic: 19 pass.
- Projection suite after metadata normalization: 50 pass.
- Forecast archive suite: 61 pass; original snapshot verification passes (1 snapshot, 1,267 projections, 2 abstentions).
- Owner refresh, source refresh and publication focused suites pass.
- Cross-tab/semantic/context audit and artifact checks pass in the focused batch. Artifact check compared 1,826,825 values losslessly.
- After correcting the two obsolete/racy assertions from the earlier review, one clean complete `npm run verify` passed, including all 85/85 Chromium cases in 3.5 minutes.
- Broader Node checks passed: audit, preset audit, TULIP Beta/diagnostics/capacity, projections, archive/scoring, comparisons (1,143 targets), source/publication/owner refresh, publication verification, TULIP verification/backtest, history, starter/oracle, artifact and the new review suite. The historical backtest initially stopped for missing immutable raw cache; it passed after hydration from the pinned commit. The incidental tracked provenance overwrite from hydration was restored, not included as a product change.
- Review suite also passes context reconciliation (9 checks), score/missing semantics and cross-tab consistency (705 NBA, 564 G League, 30 teams, 221 dual-league identities). These counts measure coverage, not independent verification of real-world roster truth.
- Generated-data comparison with the PR head found only 63 rounded rookie effective-peer metadata fields and one roughly 3e-14 change in Chicago modeled-demand metadata. No predicted player stat changed.
- JavaScript syntax and diff whitespace checks passed. Frozen training inputs, model card and original archive are unchanged.
- At the pre-release review, all eight prior PR heads were unchanged/open and their discussion and inline review comments were empty. PR #22 subsequently merged and deployed.
- No fresh full ingestion or secure owner-trigger service was added; no greater forecasting accuracy is claimed.

## Follow-up after release

- PR #22 passed all 19 checks at its final code commit, merged, and deployed. The live site served byte-identical index, scripts and status files from the generated artifact commit.
- Forecast capture/scoring safeguards (exclusive lock, fail-closed install, explicit write-time publication, verified manifest/hash reads, safe non-overwriting reports and report source hashes) are published and tested. Immutability alone does not authenticate an actual-results source.
- Failed owner-run rollback is not an atomic transaction across all raw sources and does not protect against power loss/process termination.
- The status schema retains legacy field names for compatibility. The UI now says snapshot prepared, but a future schema revision should distinguish build, publication and verified deployment explicitly.
- Raw roster/projection provenance is not a verified live transaction feed. Rookie production, current contracts/injuries/news, scheduling and next-season ingestion remain unfinished.
- Full in-season UI, complete positional/availability-aware TULIP allocation, broader calibration and UX/data-scope acceptance remain open in the 18-point checklist.
- A fresh read-only reviewer found six important release blockers; all six were corrected and given regression coverage before the clean full-suite pass. This is code review evidence, not independent sports-model validation.

## Resume boundary

First read the checklist and handoff and inspect actual production state. PR #22 is released. Continue only with the partial model/data standards in the checklist, and do not apply either older source patch or both competing archive/allocator drafts wholesale.

## Portable review patch

`REVIEW_SOURCE.patch` is based on PR #21 commit `869ab3c97aae898872c6eca469bcc89f70b14cb1`. It contains source, tests, workflow and documentation changes, not large regenerated public artifacts. Do not apply it twice or onto a different branch without reviewing the diff. After authorized application, rebuild with `npm run build:projections && npm run publish:status && npm run build:standalone`, then rerun the checks. The local review checkout already contains the corrections and generated artifacts; do not apply the patch there again.

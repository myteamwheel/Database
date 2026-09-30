# Website handoff — read this before continuing

Updated 2026-09-30. **Review and clean full local verification complete. Corrections remain local and uncommitted; nothing has been pushed, merged or deployed yet.**

## Current instruction / stop boundary

The user reviewed the checkpoint and authorized the release path. Finish release corrections, commit, run the exact-head candidate gate and CI, deploy only if green, then verify the live site. Do not begin unrelated model/data expansion until this release path is resolved.

## Authoritative state

- Repository: https://github.com/myteamwheel/Database
- Live site: https://myteamwheel.github.io/Database/index.html
- Production/default branch: `v3-official-data`, fetched tip `14723f5` (documentation added after previously verified app release `e718284`).
- Main checkout: `/Users/bretttulip/Documents/Codex/2026-09-27/i-need-you-to-go-through/work/Database`.
- Review checkout: `/Users/bretttulip/Documents/Codex/2026-09-27/i-need-you-to-go-through/work/Database-review`, branch `review/chatgpt-20260929`, based on PR #21 head `869ab3c`.
- Master checklist: `docs/MODEL_REBUILD_CHECKLIST.md` in the review checkout (rewritten with all 18 standards and honest partial statuses).
- Local files are not automatically visible to regular ChatGPT. Upload this document and the review/checklist files, or provide their committed GitHub links when available. A chat claim is not repository evidence.

## Review stack found on GitHub

These PRs are **open**, stacked rather than merged. Exact-head CI success was checked for the six canonical PRs; that does not approve the new local corrections.

| PR | Branch / head | Base | Scope |
|---|---|---|---|
| 14 | forecast-archive-validation / 91ae435 | v3-official-data | Forecast archive and scoring |
| 16 | projection-model-rebuild-next / 7b6ac61 | #14 | Projection accounting/context/rookie evidence/timeframes |
| 18 | tulip-minutes-validation-next / 73be8c5 | #16 | TULIP feasibility diagnostics, not a validated rotation optimizer |
| 19 | refresh-publication-next / 3a078ae | #18 | Refresh/publication status and reload |
| 20 | cross-tab-consistency-next / eafcc7f | #19 | Cross-tab/Team Fit checks |
| 21 | score-missing-semantics-next / 869ab3c | #20 | Missing-value/score meaning copy |

Also open: **#15 forecast-archive-baseline (971a269)** and **#17 tulip-rotation-hardening (b05bf5e)** are parallel drafts requiring comparison, not automatic inclusion. #9 is an older temporary starter-acceptance execution PR whose marker is not intended to merge.

## Recovery protocol — prevents duplicated work after usage runs out

Before every work session, and after every completed section:

1. Read this handoff, the master checklist and `docs/CHATGPT_CHANGE_REVIEW.md` when present.
2. Inspect GitHub open/closed PRs, base/head SHAs, changed files, review comments and CI for the exact head. Fetch branches if terminal access exists. Never infer that a PR is deployed because its tests passed.
3. Inspect `git status`, `git log`, and the diff from the last recorded SHA. Preserve uncommitted work. Check whether another chat advanced the branch.
4. Classify each item as NOT STARTED, PARTIAL, IMPLEMENTED/UNVERIFIED, VERIFIED LOCALLY, CI VERIFIED, or LIVE VERIFIED. “Ready for review” is not complete or published.
5. Treat comments/TODOs/proposed code as proposals, not executable implementation. Confirm actual callers and data flow.
6. Work on one bounded section. Record changed files, exact commit, test commands/results, limitations and next action immediately—not only in the final reply.
7. Push only when authorized, after checks. Update the shared GitHub handoff/checklist in the same PR/commit so either chat can recover without private conversation history. Never overwrite another chat’s branch with force-push.
8. If regular ChatGPT cannot access or edit the repository, provide a patch and a change ledger labeled NOT APPLIED. Do not claim tests, commits, merges or deployment happened without tool evidence. Ask the user to carry the patch/ledger back to Codex.

## Copy/paste prompt for regular ChatGPT (not Work)

> Continue the MyTeamWheel Database project using the attached handoff and checklist. First read the actual GitHub PR/branch state and compare it with the recorded commit SHAs; do not duplicate work already done in another chat. Distinguish production, stacked review PRs, drafts, local changes and comment-only proposals. Respect the current stop boundary. If authorized to work, handle one checklist section at a time, test actual behavior and update the durable progress/checklist files before ending each section. Preserve immutable forecast evidence, frozen model training inputs and explicit missing-data semantics. Do not invent sports data, injury information, test results or accuracy claims. Do not merge/deploy unreviewed changes. If you lack repo tools, return an unapplied patch plus a precise progress ledger instead of claiming implementation. Keep your final reply short and state the next action.

## Known constraints

- Production is static GitHub Pages; no secret/token may be embedded in browser code.
- Current statistical season is 2025–26; production forecast target is preseason 2026–27. A timeframe helper is not a live in-season forecasting feature.
- Injuries/news/transactions and college/international rookie production were not configured at the last verified release. Check new code before changing that status.
- TULIP engineering checks do not establish causal/win-optimal minute recommendations.
- Full canonical build runs in Ubuntu with immutable historical cache hydrated from commit `c17bc8d7cf2e41822a8bcf6fbf4b0b62bca095ee`. Avoid committing incidental local regenerated artifacts.
- Prior local Chromium launch was blocked by the macOS sandbox. Record actual current test results; do not repeat the old failure as if freshly observed.
- Two generated-output stashes in the main checkout are older assistant backups; do not apply them to the review stack.

## This review’s progress

Final recovery checkpoint: the review checkout contains 15 grouped implementation corrections, regression tests, rebuilt local artifacts, the corrected checklist and review report. All changes remain uncommitted and unpublished. Read the final verification section below; earlier in-progress logs are historical evidence, not the current status. Source caches were hydrated only for tests, and incidental tracked provenance was restored. Do not restart this review or reapply its patch without checking the working tree.

- [x] Located relevant regular-ChatGPT chats and all eight new PRs.
- [x] Fetched branches and established actual stack order.
- [x] Stopped duplicate new forecast/refresh work; removed only the new duplicate planning document created earlier in this session (no product code removed).
- [x] Reviewed canonical implementation paths, changed comments and plans; triaged overlapping drafts (not approved).
- [x] Corrected 15 grouped implementation defects/gaps with focused regression evidence.
- [x] Inspected exact-head CI evidence and ran focused checks; final broad run is recorded in the review report.
- [x] Updated master checklist and created `docs/CHATGPT_CHANGE_REVIEW.md`.
- [x] Added six release-blocker corrections from an independent read-only review with regression tests.
- [x] Ran one clean complete `npm run verify`, including all 85 browser cases.
- [ ] Commit the accumulated candidate and pass the 34-stage exact-head gate.
- [ ] Push and obtain exact-head CI evidence.
- [ ] Publish and spot-check the live site.

## Current verification/recovery details

- Main new report: `work/Database-review/docs/CHATGPT_CHANGE_REVIEW.md`.
- Node focused tests pass: projections 50, accounting 17, timeframe 19, archive 61, review regressions 5, plus owner/source refresh and publication checks.
- Full clean browser run: 85/85 passed as part of `npm run verify` on the corrected local candidate.
- Broad Node suites passed across `/tmp/review-node-full.log` and `/tmp/review-node-resumed.log` after restoring the immutable history cache. Restored the incidental tracked provenance change from hydration. No raw live ingestion was performed.
- Generated projection changes are metadata precision only: 63 rounded rookie effective-peer fields and one roughly 3e-14 modeled-demand difference. Predicted player stats, immutable archive, training inputs and model card were not changed.
- Archive writer concurrency, existing-archive validation, verified scoring inputs, realpath confinement, scoreable-row completeness and material missingness transitions now have passing regression coverage. Do not mark #17's whole completion standard checked until exact-head CI and release integration pass.
- This is a durable local checkpoint. Regular ChatGPT cannot see local changes until the user uploads the handoff, checklist, review report and patch, or a later authorized commit makes them accessible remotely.

## Transfer package

Upload `CHATGPT_REVIEW_HANDOFF.zip` from this task directory to regular ChatGPT. It includes this handoff, the full 18-item checklist, the review ledger, and `REVIEW_SOURCE.patch`. The source patch targets PR #21 head `869ab3c97aae898872c6eca469bcc89f70b14cb1` and excludes regenerated public artifacts. Those must be rebuilt after an authorized application. This review checkout already contains the patch; do not apply it again here.

If the chat cannot inspect GitHub or apply patches, it must label suggestions NOT APPLIED and return a precise patch/change ledger. It cannot truthfully promise autonomous continuation or deployment without those capabilities. The next Codex session must inspect this local checkout and current GitHub heads before acting.

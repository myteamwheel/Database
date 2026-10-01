# Website handoff — read this before continuing

Updated 2026-10-01. **PR #22 merged; all 19 PR checks passed; Pages deployed and live assets were verified.**

## Latest release checkpoint (supersedes historical local-only notes)

- Release PR: https://github.com/myteamwheel/Database/pull/22
- Remote branch: `codex/reviewed-release-20260930`; local branch: `review/chatgpt-20260929`.
- Implementation commit `8b84c5604c98f35f021a3991d902716c47784c44`; synchronized artifact/CI commit `492e94393697c80ad84ad79b991f0024d9ba9aa6`.
- At `492e943`, `npm run verify:candidate -- --archive-base-ref 869ab3c97aae898872c6eca469bcc89f70b14cb1 --require-clean-generated` passed all 34 stages, 85/85 browser tests, zero skipped stages, no generated/unexpected working-tree changes, and 10/10 explained material player changes. Report finished 2026-09-30T21:19:03Z.
- PR #22 passed all 19 checks at `db2e518` and merged as `2f28d555`. Artifact rebuild `1f5c06f9` passed and [deployed through Pages](https://github.com/myteamwheel/Database/actions/runs/36801784697). Live index, scripts and status matched the committed payload byte for byte; Player Comps, Projections and TULIP Team Allocation opened without console errors. Production later advanced to `c4821b7` through workflow and evidence-only commits; website bytes were unchanged.
- Twenty-one grouped corrections are recorded in the review ledger. The original 18 feature standards remain honestly partial where data/model work is missing.
- Old transfer ZIPs/source patches are historical. Continue from the production branch and inspect actual GitHub history before applying anything.

## Current instruction / stop boundary

The user reviewed the checkpoint and authorized the release path. Finish release corrections, commit, run the exact-head candidate gate and CI, deploy only if green, then verify the live site. Do not begin unrelated model/data expansion until this release path is resolved.

## Authoritative state

- Repository: https://github.com/myteamwheel/Database
- Live site: https://myteamwheel.github.io/Database/index.html
- Production/default branch: `v3-official-data`, verified tip `c4821b7` after the release and starter evidence update.
- Main checkout: `/Users/bretttulip/Documents/Codex/2026-09-27/i-need-you-to-go-through/work/Database`.
- Review checkout: `/Users/bretttulip/Documents/Codex/2026-09-27/i-need-you-to-go-through/work/Database-review`, branch `review/chatgpt-20260929`, based on PR #21 head `869ab3c`.
- Master checklist: `docs/MODEL_REBUILD_CHECKLIST.md` in the review checkout (rewritten with all 18 standards and honest partial statuses).
- Local files are not automatically visible to regular ChatGPT. Upload this document and the review/checklist files, or provide their committed GitHub links when available. A chat claim is not repository evidence.

## Review stack found on GitHub

The following PRs were stacked when reviewed; their commits were incorporated into merged PR #22. The older individual PR pages may still appear open but should not be merged again.

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

The production branch contains 21 grouped implementation corrections, regression tests, rebuilt artifacts, the corrected checklist and review report from merged PR #22. Source caches were hydrated only for tests, and incidental tracked provenance was restored. Do not restart this review or reapply its patch.

- [x] Located relevant regular-ChatGPT chats and all eight new PRs.
- [x] Fetched branches and established actual stack order.
- [x] Stopped duplicate new forecast/refresh work; removed only the new duplicate planning document created earlier in this session (no product code removed).
- [x] Reviewed canonical implementation paths, changed comments and plans; triaged overlapping drafts (not approved).
- [x] Corrected 15 grouped implementation defects/gaps with focused regression evidence.
- [x] Inspected exact-head CI evidence and ran focused checks; final broad run is recorded in the review report.
- [x] Updated master checklist and created `docs/CHATGPT_CHANGE_REVIEW.md`.
- [x] Added six release-blocker corrections from an independent read-only review with regression tests.
- [x] Ran one clean complete `npm run verify`, including all 85 browser cases.
- [x] Commit/push the accumulated candidate and pass the 34-stage exact-head local gate at `492e943`.
- [x] All 19 PR #22 checks passed at `db2e518`.
- [x] Pages deployed website payload `1f5c06f9`; live navigation and asset hashes were spot-checked.

## Current verification/recovery details

- Main new report: `work/Database-review/docs/CHATGPT_CHANGE_REVIEW.md`.
- Node focused tests pass: projections 50, accounting 17, timeframe 19, archive 61, review regressions 5, plus owner/source refresh and publication checks.
- Full clean browser run: 85/85 passed as part of `npm run verify` on the corrected local candidate.
- Broad Node suites passed across `/tmp/review-node-full.log` and `/tmp/review-node-resumed.log` after restoring the immutable history cache. Restored the incidental tracked provenance change from hydration. No raw live ingestion was performed.
- Generated projection changes are metadata precision only: 63 rounded rookie effective-peer fields and one roughly 3e-14 modeled-demand difference. Predicted player stats, immutable archive, training inputs and model card were not changed.
- Archive writer concurrency, existing-archive validation, verified scoring inputs, realpath confinement, scoreable-row completeness and material missingness transitions have passing regression, PR and release evidence. This establishes the archive infrastructure; future prediction accuracy still awaits outcomes.
- The implementation is on production. Regular ChatGPT must inspect the current branch and its actual CI/deployment state; old attachments are not authoritative.

## Continuation

Use the production branch and the authoritative checklist. Older transfer ZIPs and source patches predate the release and must not be applied again. If another chat cannot inspect GitHub or apply patches, it must label suggestions NOT APPLIED and return a precise change ledger.

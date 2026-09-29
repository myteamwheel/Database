# TULIP Beta feasibility and validation plan

**Base:** \`projection-model-rebuild-next\` / PR #16  
**Branch:** \`tulip-minutes-validation-next\`  
**Scope:** checklist item 5 only.

## Goal

Make TULIP Beta auditable as the experimental allocator it actually is.

This section must improve feasibility accounting, threshold distributions, player/team explanations and validation metadata without implying that the exact MPG deltas—or even their directional labels—have been established as win-optimal.

## Constraints

- Preserve the frozen negative causal result from \`TULIP_RESEARCH_STATUS.md\`.
- Do not inspect the untouched chronological TULIP holdouts or redefine success criteria in this section.
- Do not claim the existing Projected Role MPG backtest validates TULIP Beta.
- Do not add injury, availability or positional facts that the current sources do not verify.
- A zero-sum eligible-player ledger is not the same thing as a playable 240-minute rotation.
- G League continues to abstain.
- No arbitrary +/- delta clamp or team quota may be introduced.

## Task 1 — Formal allocation diagnostics

Create \`scripts/lib/tulip-beta-diagnostics.mjs\` and focused tests.

For each current NBA roster, report:
- current-roster player count;
- scored and abstained counts plus abstention reasons;
- current and recommended MPG totals for the scored allocation pool;
- gained, surrendered and net MPG;
- ledger conservation;
- individual 0–40 feasibility;
- scored and roster position-family coverage;
- explicit feasibility status:
  - ledger/bounds enforced;
  - availability not verified;
  - position/lineup constraints not enforced;
  - not a complete 240-minute playable rotation.

## Task 2 — Magnitude distribution audit

Publish deterministic counts for absolute TULIP magnitude at:
- >=3 MPG
- >=5 MPG
- >=7 MPG
- >=10 MPG

For each threshold report positive, negative and absolute counts. Also report support tiers and extrapolated recommendation counts.

These are descriptive distributions only, not calibrated confidence levels or thresholds.

## Task 3 — Player-level trace contract

Every scored TULIP row gets a structured \`drivers\` object describing:
- team-relative value direction and SD gap;
- current workload and direct evidence-supported ceiling;
- whether the recommendation extrapolates beyond direct workload evidence;
- role-evidence tier/factor;
- roster-balance factor;
- availability status = not verified;
- position/lineup feasibility = not enforced.

This is explanation metadata; it must not change the numeric allocation.

## Task 4 — Frozen validation status

Publish a machine-readable \`validation\` block in \`tulipBetaMeta\` that records:
- frozen DEV quasi-experiment result: reduced form -0.127 pts/SD;
- Anderson-Rubin 95% CI [-1.756, 1.021];
- exact magnitude not validated;
- ordinal play-more/play-less labels not validated as win prescriptions;
- existing Projected Role MPG backtest is separate and does not validate this allocator;
- chronological TULIP holdouts remain unspent by this section;
- allocator historical replay status is not run / not claimed.

## Task 5 — UI truthfulness

The team allocation modal and player detail must surface:
- this is a conserved eligible-player workload ledger, not a playable 240-minute rotation;
- simultaneous availability is not verified;
- positional/lineup feasibility is not enforced;
- excluded current-roster players and reasons can exist;
- exact magnitude and direction are experimental, not validated coaching prescriptions.

Do not add an “optimal rotation” label.

## Task 6 — Verification

Add tests for:
- all team diagnostics matching the shipped payload;
- +/-3/5/7/10 distribution counts matching player rows;
- every scored row carrying the structured trace;
- all scored rows inside 0–40;
- all scored-team ledgers conserving;
- explicit non-validation metadata;
- no G League scores;
- UI copy retaining all limitation statements.

Run focused TULIP tests and the full repository audit before marking the PR ready.

# TULIP rotation hardening plan

**Base:** `projection-model-rebuild-next` / PR #16
**Branch:** `tulip-rotation-hardening`
**Scope:** checklist item 5 plus the TULIP-specific parts of items 12, 14 and 18.

## Constraints

- Keep player evaluation separate from minute allocation.
- Do not claim causal or win-maximizing validity. Existing historical causal evidence remains negative / not established.
- Preserve NBA-only scope unless a validated G League value signal exists.
- Do not invent injury/availability status. Explicit availability inputs may be honored; absent inputs remain unverified.
- Position handling is a coarse substitution guard from roster-listed position families, not a claim that a recommended set is a playable lineup.
- Diminishing returns are a transparent heuristic stabilizer, not a fitted causal coefficient.
- Team ledgers must conserve exactly at 0.1 MPG resolution.
- No arbitrary quota may force a specific count of large recommendations.

## Task 1 — Separate evaluation from allocation

Export a pure value-signal function that produces reliability-shrunk player value versus the current team average. It must not emit recommended MPG.

The allocator consumes those signals plus workload/evidence constraints and creates the recommendation.

## Task 2 — Coarse position-compatible transfer ledger

Use roster-listed G/F/C family tokens. When both sides have known positions, minutes may transfer only across overlapping family tokens. Missing position evidence remains explicitly unknown rather than guessed.

The guard is coarse and does not model five-man lineup combinations.

## Task 3 — Diminishing marginal transfer priority

Allocate the ledger in 0.1-MPG increments. A player's marginal priority declines as additional minutes are added or removed so a large initial signal cannot monopolize the entire transfer pool without limit.

The scale is a documented heuristic and must be surfaced in metadata.

## Task 4 — Availability contract

Honor only explicit verified availability inputs. With no verified injury/availability feed, current production output must say availability is unverified and must not infer health from missed games.

## Task 5 — Distribution and constraint diagnostics

Publish counts for absolute TULIP >= 3, 5, 7 and 10 MPG, support tiers, extrapolated recommendations, unfilled requested minutes, and coarse position-constrained rows.

These are diagnostics, never quotas.

## Task 6 — Explanation/UI consistency

Player and team views must distinguish:
1. player evaluation signal;
2. workload/evidence request;
3. position-aware, zero-sum allocation;
4. diminishing marginal priority;
5. verified limitations.

The team view must no longer say positions are unenforced once the coarse guard is active, but it must still say the output is not a playable 240-minute rotation and does not enforce simultaneous lineups or verified availability.

## Task 7 — Verification

Run:
- focused TULIP hardening unit tests;
- existing TULIP Beta integration/regression tests;
- TULIP verification/backtest where historical cache is available;
- full repository audit and browser regression.

A result is review-ready only after the dedicated and repository-wide gates are green.

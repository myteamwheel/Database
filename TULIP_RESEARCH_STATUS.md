# TULIP — research status (branch closed 2026-08-21)

## Product objective (unchanged, still the right question)
> Given the players currently available to a team, what average MPG allocation would maximize that
> team's expected ability to win, and how does that allocation differ from each player's current MPG?
>
> **TULIP = Optimal MPG − Current MPG**

## Current answer
**Not identified well enough to publish.**

## What was established

1. The original `6.6 min/SD` translation and the ±8 clamp were **never a validated win-optimal
   mapping**. `6.6` was chosen to preserve the display scale of the older `×2.2` approach after a
   change of units.
2. A **constant player-value model tends toward capacity/boundary solutions**, not smooth minute
   adjustments. The smooth ±3 output was an artifact of clamping, not a property of the objective.
3. The **conserving allocation infrastructure is technically sound** — zero sign reversals, zero
   amplification, conserved ledgers — but technical soundness does not establish basketball
   optimality.
4. **BPM/box-score-based routing showed no validated positive win effect** under the frozen DEV
   quasi-experiment: reduced form −0.127 pts/SD (t −0.49), AR 95% CI [−1.756, 1.021].
5. **Raw historical on-court +/−, WOWY, and their blend failed the pre-registered identification
   tests** (pre-trend t 2.15 / 3.89 / 2.17). Margin-derived priors contaminate this instrument — a
   risk declared in advance that then materialised.
6. The **primary shock instrument is relevant but relies mostly on injury variation whose exogeneity
   cannot be established.** The cleaner administrative shocks (C1) have first-stage F 2.1 and cannot
   test it.
7. **Neither exact MPG recommendations nor ordinal "play more / play less to win" labels are
   supported.** The ordinal labels carry the same prescriptive claim at lower precision, and the DEV
   experiment tested that direction and did not validate it.
8. **Both chronological holdout seasons (2024-25, 2025-26) remain untouched** and unspent, available
   for a genuinely improved future model.

## Not shipped
`TULIP: +X.X MPG`, `UNDERUSED`, `ABOUT RIGHT`, `OVERUSED` — none ships with a winning
interpretation. TULIP Score may be preserved only as an experimental, descriptive, team-relative
value ranking, labelled as such, and is not a coaching recommendation.

## Kept, and kept separate
**Projected Role MPG** (`TULIP_CAPACITY_V1`, card-sha256:96cb2f34c6cd06c3) — a validated forecast of
the workload a player is likely to RECEIVE after an offseason move. It answers a different question
and **must never be called TULIP.**

## Branch closed
No further candidate search, no modification of the success criteria, no inspection of holdout
outcomes, and no RAPM work.

The outcome here is an accurate negative result: we tried to validate the thing TULIP was actually
meant to mean, and the available evidence did not clear the standard required to claim we know how
many more or fewer minutes a player should receive to help his team win.

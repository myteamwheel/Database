# Bounded value-prior challenge — PRE-REGISTRATION (written before any outcome coefficient)

DEV seasons only (2015-16..2023-24). 2024-25 and 2025-26 remain untouched and unspent.

## The single question
Is the failure in the TULIP optimization framework, or is box-score-based player value the wrong
input for estimating the winning value of an extra minute?

Design A, the instrument, the allocator, the workload framework and the TULIP definition are FROZEN.
Only the player-value prior changes. Design A will NOT be altered to make a new prior work.

## Candidate priors — declared now, no additions later
All must be computable strictly from games BEFORE the prediction date.

- **V0 BENCHMARK (frozen):** standardized, shrunk box-score production (GameScore per 36) — the prior
  used in the failed test. NOTE: this is a BPM-family box-score prior, not literally BPM; per-game
  BPM is not available historically without leakage.
- **V1:** prior-game ON-COURT plus/minus per 36, shrunk. A direct on-court impact signal rather than
  box-score production. Temporally clean: built only from prior games.
- **V2:** prior-games WOWY — team margin in prior games the player PLAYED minus prior games he MISSED,
  shrunk. A with/without impact estimator requiring no lineup data.
- **V3:** predeclared 50/50 blend of standardized V0 and standardized V1. Weights fixed HERE, not tuned.

RAPM feasibility is audited below rather than assumed; if lineup-level possession data is not
available for DEV seasons without a major acquisition, RAPM is recorded as infeasible, not attempted
badly.

## Leakage rule
A prior may use only games strictly before the prediction date. Any metric whose published historical
value embeds later games is disqualified. V1 and V2 derive from prior-game margins; the OUTCOME is the
current game's margin, so temporality holds. Team-season fixed effects absorb team quality, which is
the main mechanical-correlation risk of margin-derived priors — this risk is recorded, not dismissed.

## Success condition — a candidate advances ONLY if, on DEV, ALL hold
1. the same falsification battery remains acceptable (pre-trend, placebo, opponent balance);
2. first-stage relevance remains adequate under the frozen Design A;
3. the structural effect moves in the hypothesized POSITIVE direction;
4. weak-IV-robust (Anderson-Rubin) uncertainty supports a nonzero POSITIVE effect;
5. the result is not carried by one team, player, season or tier (leave-one-out);
6. sensitivity to unobserved confounding is materially more robust than V0's (V0 required only
   ~0.28 SD of an opponent-strength-like factor to erase);
7. it materially outperforms V0 under the identical specification — not merely a prettier coefficient.

## If no candidate clears the bar
Stop the research. Report that TULIP's intended claim is not supported by current historical
evidence. Do not ship `+X.X MPG`, UNDERUSED or OVERUSED as winning recommendations. TULIP Score may
be preserved only as an experimental/descriptive team-relative value ranking, labelled as such.

## If one clears it
Freeze that prior AND the full optimizer before any holdout season is touched. Only then do 2024-25
and 2025-26 decide whether TULIP graduates.

---

# RESULT (DEV only, 2026-08-21) — NO CANDIDATE CLEARS THE BAR

Identical frozen Design A, identical conditioned specification, identical falsification battery.
Holdout seasons 2024-25 and 2025-26 were never touched; no holdout outcome was fetched or read.

| prior | first-stage F | pre-trend | reduced form pts/SD | AR 95% CI | verdict |
|---|---:|---|---:|---|---|
| **V0** box-score (benchmark) | 250.2 | **passes** (t 1.12) | -0.127 (se 0.261, t -0.49) | [-1.756, 1.021] | null |
| **V1** prior on-court +/- | 154.1 | **FAILS** (t 2.15) | +0.100 (se 0.232, t 0.43) | [-0.888, 1.425] | disqualified |
| **V2** prior WOWY | 145.3 | **FAILS** (t 3.89) | -0.254 (se 0.277, t -0.92) | [-1.884, 0.712] | disqualified |
| **V3** 50/50 blend V0+V1 | 187.0 | **FAILS** (t 2.17) | -0.012 (se 0.245, t -0.05) | [-0.415, 0.351] | disqualified |

## Why V1/V2/V3 fail
Exactly the risk recorded in the pre-registration: **margin-derived priors contaminate the
identification.** Because V1 and V2 are built from prior team margins, the instrument constructed
from them inherits prior team performance, and the pre-trend test detects it. Team-season fixed
effects were not sufficient to absorb this. V3 is half V1 and inherits the failure.

This was declared as the main risk BEFORE the test and it materialised. It was not discovered after
seeing an inconvenient coefficient.

## The bind
- The only prior with **clean identification** (V0, box-score) gives a **null**.
- The priors carrying **genuinely different information** (instrument correlations 0.088-0.284 with
  V0) have **contaminated identification**.
- Independently of falsification, **not one candidate produced an AR interval excluding zero on the
  positive side.** Success criterion 4 fails for all four regardless of criterion 1.

## VERDICT — research stopped
Per the pre-registered rule: **no candidate clears the bar, so the research stops.**

**The current historical evidence does not support TULIP as a win-prescriptive minutes metric.**

Not shipped, in any form implying winning:
- `TULIP: +X.X MPG`
- `UNDERUSED` / `ABOUT RIGHT` / `OVERUSED`

TULIP Score may be preserved ONLY as an experimental, descriptive, team-relative value ranking,
labelled as such. It is not a coaching recommendation and must not be presented as one.

## What this did establish
1. The proposed instrument has strong, stable first-stage RELEVANCE across the tested value priors
   (F 135-250 over four independent priors) and survives observed-covariate conditioning. **Exogeneity
   remains UNPROVEN**, because the identifying variation is predominantly injury-driven and the
   cleaner administrative shocks are too weak to test it. Relevance is not validity.
2. Under the frozen quasi-experimental specification, effects larger than roughly the design's
   detectable scale (MDE ~0.79 pts/SD) are inconsistent with the DEV estimates; smaller effects remain
   unresolved. **Because instrument exogeneity is not established, this is NOT a definitive causal
   bound.**
3. Margin-derived value priors cannot be used with this instrument without breaking pre-trend
   balance. That is a reusable negative result for any future attempt.
4. **Pregame historical RAPM remains untested.** It would require substantially more play-by-play /
   lineup reconstruction (only 10.5% of DEV games have PBP) and could provide a better
   adjusted-impact prior than raw +/- or WOWY, since it adjusts for teammates and opponents.
   **However, RAPM is itself derived from scoring outcomes**, so the same pre-trend / endogeneity
   concerns must be RE-EVALUATED rather than assumed solved. It is not a clean escape hatch from
   outcome-derived priors.
   CORRECTION: an earlier draft of this file described RAPM as "neither box-score nor margin-derived".
   That was factually wrong. RAPM is a regularized adjusted plus-minus estimated from stint/possession
   scoring margin. Not started, and not a recommendation to start it.

## Holdout status
2024-25 and 2025-26 remain **unspent**. No frozen policy earned the right to be tested on them.

# Phase 1-2 result — DEV only (frozen 2026-08-21)

Holdout seasons 2024-25 and 2025-26 remain UNTOUCHED. No holdout outcome was fetched or read.

## Phase 1 — falsification tests: all fail to reject

| test | result | verdict |
|---|---|---|
| T1 pre-trend, prior 3-game margin | +0.170 pts/SD, t 1.14 | null not rejected |
| T1 pre-trend, prior 5-game margin | +0.146 pts/SD, t 1.28 | null not rejected |
| T3 opponent pre-game strength | +0.083 pts/SD, t 0.76 | null not rejected |
| T2 outcome placebo (player PRESENT) | -0.110 pts/SD, t -0.63, 257 clusters | null not rejected |

A first placebo run covered only 51 clusters because a global `break` truncated it to whichever
team-seasons iterated first. That was a biased subset, not a placebo; it was fixed to cap per cell
and re-run over 257 clusters, with the same conclusion.

**Wording, per the frozen rule: we FAILED TO REJECT important violations of the identifying
assumptions. This is not proof that injury shocks are exogenous.**

## Phase 2 — structural estimate (DEV, frozen conditioned spec)
n=3,439 shock team-games, 245 team-season clusters, team-season FE +
{priorMpg, gameIdx, nTeammates, totW}, cluster-robust at team-season.
Outcome: full 48-minute regulation margin, no garbage-time deletion.

- **First stage (conditioned): beta 0.875, cluster-F 281.9** — relevance is strong.
- **Reduced form: -0.316 pts per SD of instrument, se 0.284, t -1.11, 95% CI [-0.872, +0.240]**
- **IV: -0.635 pts per SD of realized reallocation**
- **Anderson-Rubin 95% CI (weak-IV-robust): [-1.802, +0.584] — INCLUDES ZERO**

## Power of the null
Minimum detectable effect at 80% power / 5%: **~0.79 pts per SD of instrument.**
The data can rule out reallocation effects LARGER than that. It cannot distinguish smaller true
effects from zero. **This is a bounded null, not evidence of no effect.**

## Sensitivity
To erase the (already insignificant) reduced form, an omitted pre-game factor correlated with the
instrument would need to contribute ~0.28 pts per SD — roughly 0.28 SD of an opponent-strength-like
factor. The estimate is fragile to modest residual confounding, which on its own would disqualify
magnitude even had it been significant.

## Shock-class direction, reported separately, never pooled

| class | n | clusters | pts/SD | se | t |
|---|---:|---:|---:|---:|---:|
| C3_INJURY | 2,828 | 239 | -0.210 | 0.322 | -0.65 |
| C1_ADMIN | 65 | 17 | -0.321 | 0.813 | -0.39 |
| C2_PERSONAL | 48 | 17 | -0.317 | 0.846 | -0.38 |
| C4_TEAM_REST *(endogenous)* | 169 | 42 | -2.196 | 1.109 | -1.98 |
| C5_OTHER | 222 | 37 | -0.986 | 0.542 | -1.82 |

**C1 vs C3: underpowered but DIRECTIONALLY CONCORDANT** — both negative, neither significant. The
cleaner-exogeneity class does not contradict the injury-driven one. Every class points the same
(negative) way, which is at least internally consistent.

## VERDICT — magnitude does NOT graduate
Pre-registered criterion 3 (monotone dose-response with slope CI excluding zero) **FAILS**. Per the
frozen rule, any failure means ordinal only. No specification-shopping was performed and none will be.

**TULIP V1 ships as UNDERUSED / ABOUT RIGHT / OVERUSED. The `TULIP: +X.X MPG` number does not ship.**

Leading interpretations, which this design CANNOT distinguish:
1. NBA coaches already allocate minutes close enough to optimal that forced deviations do not help
   — the "uncomfortable null" pre-registered as a real possible finding.
2. The true effect is smaller than ~0.79 pts/SD and this design lacks the power to see it.
3. Box-score player value misses what makes a forced replacement worse (defense, fit, matchup), so
   routing toward nominally higher-value players is not actually routing toward better minutes.

## Holdout status
2024-25 and 2025-26 remain unspent. There is no frozen optimizer worth testing on them, and
preserving them is worth more than confirming a null.

---

# CORRECTION (2026-08-21) — the ordinal claim is withdrawn too

The line "TULIP V1 ships ordinal — UNDERUSED / ABOUT RIGHT / OVERUSED" **overstated the evidence and
is withdrawn.**

UNDERUSED and OVERUSED are themselves prescriptive: they mean "should play more/fewer minutes because
it should help the team win." The DEV experiment tested precisely that direction — whether
shock-induced movement toward the TULIP value ordering improved regulation margin — and did not
validate it. Shipping the ordinal label would repeat the same unsupported claim at lower precision.

**Supported today:** TULIP Score ranks players by a team-relative standardized box-score value signal.
**NOT supported:** UNDERUSED = should play more to win; OVERUSED = should play less to win.

Both the number and the labels are withheld while their intended interpretation is winning.

## The result, stated at its true strength
> The current box-score-based TULIP value prior did not demonstrate that reallocating minutes toward
> its preferred players improves regulation scoring margin in the pre-registered DEV quasi-experiment.
> The design rules out large positive effects at its detectable scale (MDE ~0.79 pts/SD) but is
> underpowered for smaller effects.

Five explanations remain live and NONE has won: (1) coaches already near-optimal; (2) effect below
detectable scale; (3) inadequate player-value prior; (4) residual identification problems; (5) some
combination. **"Coaches are near-optimal" is NOT a conclusion of this work.**

The wrong-signed point estimate is NOT evidence that TULIP should be reversed. Its CI is far too wide.

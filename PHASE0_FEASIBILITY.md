# Phase 0 — outcome-blind feasibility & overlap audit (frozen 2026-08-21)

No scoring margin, win/loss, net rating or plus-minus was read. Outcomes are stripped at data-load
in every script (`phase0-feasibility.mjs`, `phase0-overlap.mjs`, `phase0-support.mjs`,
`phase0-designb.mjs`). Minutes and box-score production ARE used: allocation is the permitted first
stage, and production is a model input, not a team outcome.

## 1. Shock sample
5,062 rotation-player absence shocks over 11 seasons (2015-16..2025-26), where the absent player
appeared in >=6 of the prior 10 team games at >=15 MPG.

| class | all | with estimable frozen weights |
|---|---:|---:|
| C3_INJURY (ruled out pre-game) | 4,224 | **3,847** |
| C4_TEAM_REST (explicitly endogenous) | 278 | 256 |
| C5_OTHER | 273 | 240 |
| C2_PERSONAL | 145 | 129 |
| C1_ADMIN (suspension/league) | 142 | 129 |

Classes are pre-registered and NEVER pooled. Coach's-Decision DNPs (49,145 league-wide) are excluded
from identification entirely as endogenous.

**Only C3 has power.** C1 and C2 at ~129 each cannot carry an estimate alone and are pre-registered
robustness splits, reported with their n and without significance-chasing.

## 2. Independence / concentration
- 730 distinct absent players; **398 effective independent** (1/HHI)
- **609 players with >=2 shocks** -> within-absent-player fixed effects are feasible
- 4,004 distinct shocked team-games; 851 with simultaneous absences
- instrument mass is diffuse: top 1% of shocks carry 6.0%, top 5% carry 20.8%
- 164 effective independent team-seasons of 316

No small set of teams, players or shocks dominates the instrument.

## 3. First stage (allocation only — no outcome)
Predicted value flow -> realized allocation flow: n=4,601, beta 0.922, r 0.455, **R2 0.207**,
naive F 1,199.6. The mechanical routing genuinely predicts where minutes go.
Naive F is reported for feasibility only; the weak-instrument-robust diagnostic (effective F,
Anderson-Rubin) is pre-registered for the outcome stage.

## 4. Empirical support — CORRECTED
A first pass measured single-game minutes against a prior average and reported p50 8.4 MPG with 52%
of shifts >=8. **That was invalid**: it captured ordinary game-to-game minute variance, not
shock-induced reallocation, and overstated the dose by ~1.8x at the median. Corrected to the
systematic shift `mean(minutes | teammate OUT) - mean(minutes | teammate IN)` over cells with >=3
games each side (53,430 cells, 1,004 absent players, 330 team-seasons):

| | systematic \|shift\| |
|---|---:|
| p50 | 2.71 |
| p75 | 5.23 |
| p90 | 8.45 |
| p95 | 10.78 |
| p99 | 15.59 |

Statistically distinguishable from own sampling error (|shift| > 1.96 SE): 16,287 cells (30.5%).
Among those: p50 6.39, p90 12.10, max 28.3.

**Support by magnitude (distinguishable cells):** >=1 MPG 16,287 · >=2 16,201 · >=3 15,252 ·
>=5 11,150 · >=8 5,413.

**Verdict: support credibly covers roughly +/-8 MPG, densest between +/-2 and +/-5, and thins out
past ~+/-11.** This is materially better than the "+/-2-3 only" contingency. The optimizer's support
constraint should bind near the p95 of distinguishable shifts, not at a cosmetic clamp.

Caveat carried forward: only 30.5% of cells are individually distinguishable from noise, so the
outcome stage must weight by precision rather than treat all cells equally.

## 5. Design B — FAILS its own premise
The claim "forced vacancies remove discretion by construction" is not supported:

- starter vacancies: 2,038
- **only 34.6% produce a single clean replacement**; 63.5% produce MULTIPLE new starters (the coach
  reshuffles positional structure, exactly the objection raised against this design)
- among repeat vacancies of the same absent starter, the same player replaced him every time in only
  **44.7%** of cells; median top-replacement share 0.67

**Design B is therefore demoted to descriptive robustness and is NOT a credibility anchor.** Its
"instrument: none" claim is withdrawn.

## 6. Status
Design A passes feasibility on every pre-registered criterion: adequate and diffuse shocks, a strong
allocation first stage, within-player FE feasible, and support extending to roughly +/-8 MPG.

Not yet tested, and requiring outcome data (to be run BEFORE the main coefficient is read):
placebo on games where the "absent" player actually played, pre-trend on prior margins, balance,
and the weak-instrument-robust diagnostics.

---

# Stage 5-6 — split, dev-only support, outcome-blind diagnostics (frozen)

## Chronological split (declared before any support rule was chosen)
- **DEVELOPMENT** 2015-16 .. 2023-24 — 3,451 usable shocks. All model/support/clamp selection here.
- **HOLDOUT** 2024-25, 2025-26 — 1,150 usable shocks. Never inspected for selection.

**Disclosure:** stage 3 computed support POOLED across all 11 seasons, which included holdout
*exposure* (minutes), never holdout outcomes. That pooled figure is discarded and used for nothing.
Dev-only figures are nearly identical (p50 2.71, p95 10.75 vs pooled 2.71 / 10.78), so the substance
is unaffected, but the rule is now derived from development data alone.

Dev-only distinguishable cells: >=1 12,683 · >=2 12,621 · >=3 11,874 · >=5 8,686 · >=8 4,236 · >=11 1,779.

**Wording corrected:** observed systematic reallocation support is dense through roughly +/-5 MPG and
extends materially toward +/-8 MPG. This is OBSERVED EXPOSURE DENSITY, not causal support. The
causally usable region will be set after identification diagnostics, by a pre-specified precision
rule — NOT by p95, which is merely descriptive.

## First stage (team-season FE, cluster-robust at team-season, DEV only)
All usable shocks: n=3,439, 245 clusters, beta 0.783, se 0.052, **cluster-F 225.6**.

By class, never pooled:

| class | n | clusters | beta | cluster-F |
|---|---:|---:|---:|---:|
| C3_INJURY | 2,828 | 239 | 0.755 | **217.4** |
| C4_TEAM_REST | 169 | 42 | 0.905 | 19.2 |
| C5_OTHER | 222 | 37 | 1.027 | 12.3 |
| C2_PERSONAL | 48 | 17 | 0.668 | **2.5** |
| C1_ADMIN | 65 | 17 | 0.173 | **2.1** |

**Material finding: C1_ADMIN has essentially no first stage.** The shock class with the most
defensible exogeneity cannot serve as a relevance-bearing robustness check. Identification power
rests almost entirely on C3_INJURY, the class whose exogeneity is most questionable.

## Leave-one-out (DEV)
beta is highly stable: drop-one-team 0.759-0.808 · drop-one-player 0.773-0.795 ·
drop-one-team-season 0.758-0.797 · drop-one-season 0.755-0.804. No unit drives the result.

## Balance — failed, then absorbed
Raw instrument correlations with predetermined covariates: totW **-0.283**, gameIdx +0.140,
priorMpg -0.115, nTeammates -0.115. The totW correlation is largely mechanical (the instrument is
built from routed minutes) and encodes the direct-effect channel: how much was lost.

After team-season FE + linear controls on all four:
- instrument retains **96.1%** of its SD (exposure 99.5%)
- conditioned first stage is STRONGER: beta 0.875, se 0.052, **cluster-F 281.9**
- residual correlation with every control ~0.000

**Conditioning does not destroy the instrument.** The conditioned specification is the frozen one.

## Identification status — NOT causally identified
Relevance: established and robust. Balance: failures absorbable and absorbed.
**Exogeneity: NOT established.**

Design A is a quasi-experimental IV candidate, not an identified causal design. Recentering is not
claimed, because a credible shock-assignment mechanism for injuries cannot currently be specified:
injury/illness depends on prior workload, accumulated fatigue, age, injury history, schedule density
and team situation. Permuting injuries as if all players faced equal hazard would be indefensible.
Specifying such a mechanism requires an injury-hazard model whose own validity is an assumption, and
C1_ADMIN — the natural exogeneity check — lacks the first stage to test it.

**Therefore the outcome stage must treat pre-trend and outcome-placebo tests as the actual test of
exogeneity, run and reported BEFORE the structural coefficient, with the pre-registered rule that
failure there ends the magnitude claim.**

---

# Correction to the research record (2026-08-21)

The earlier line "treat pre-trend and outcome-placebo as the actual test of exogeneity" is WRONG and
is replaced by:

> **Pre-trend and outcome-placebo are NECESSARY FALSIFICATION TESTS of the identifying assumptions.
> They are not sufficient proof of exogeneity.** They can reveal violations; they cannot establish
> the absence of unmeasured injury-related confounding.

If they pass, the only defensible wording is **"we failed to reject important violations of the
identifying assumptions"** — never "injury shocks are exogenous".

## Frozen Phase 0 conclusion
Design A has strong relevance and survives observed-covariate conditioning, but its identifying
exogeneity assumption remains UNVERIFIED, because the variation is overwhelmingly injury-driven and
the cleaner administrative shocks (C1, cluster-F 2.1) are too weak to serve as an independent
relevance-bearing check. A real limitation; not necessarily fatal.

## Rules for the stages that follow
1. DEV seasons only (2015-16..2023-24). 2024-25 and 2025-26 outcomes stay untouched.
2. Falsification tests run and are reported BEFORE the structural coefficient is read.
3. Material failure => Design A fails for causal magnitude. No specification-shopping around it.
4. Passing => "failed to reject", not "exogenous".
5. Structural estimate only then, frozen conditioned spec, weak-IV-robust inference.
6. DEV estimate is calibration evidence, NOT a shipped magnitude.
7. Entire optimizer/policy frozen before either holdout season is exposed.
8. Sensitivity required: how strong must an unobserved pre-game factor be to erase/reverse the effect.
9. C1/C2 reported separately as reduced-form direction only. Never pooled to manufacture power.

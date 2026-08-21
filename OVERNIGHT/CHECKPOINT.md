# Overnight checkpoint — TULIP v3 rotation/source layer

Written so a crash or context loss does not erase the night's reasoning. Update as work proceeds.

## Where the project stands

TULIP v1 (`BPM gap x 2.2`) and v2 (team-relative allocation) are LIVE and validated at their own
level. Everything below is v3 research, unshipped, local only. Do not deploy v3 tonight.

## The question being answered right now

Model A needs `ASSIGNED WORKLOAD` — the role a team OPENED for a player — separated from
`REALIZED OPENER MINUTES`. That needs exact stint data. Two candidate sources:

- **GameRotation** (`stats.nba.com/stats/gamerotation`): exact IN/OUT times, near-exact vs box
  score (0.20-0.28 min, zero players >1 min off). Coverage appears partial; being measured.
- **PlayByPlayV3 reconstruction**: full coverage, but reconstructing lineups from substitution
  text currently carries 3.00 min mean error after three rounds of bug fixes.

## Decision pending: A vs B

- **A** — GameRotation coverage sufficient -> primary source, PBP for context/fallback.
- **B** — GameRotation too sparse -> use it as Tier A GROUND TRUTH to fix and audit the
  deterministic PBP reconstructor, then admit Tier B episodes only if held-out evidence supports it.

Decide on measurements, not convenience.

## Hard rules established this session

1. Never equate "not in the repo" with "unavailable". Test sources before claiming a limitation.
2. Raw acquisition is immutable; normalization and validation are separate layers.
3. A game's fate is never decided during acquisition: SUCCESS / FAILED_PASS1 / RECOVERED_PASS2 /
   REJECTED_BY_VALIDATION / UNAVAILABLE_AFTER_ALL_SOURCES.
4. Delayed retry passes, never rapid repeated retries.
5. No arbitrary thresholds. Derive them (e.g. sub-offset tolerance from the measured distribution).
6. Percentages always carry raw denominators, and the denominator is COMPLETED ATTEMPTS.
7. Lineup reconstruction is deterministic accounting and must stay auditable. ML belongs only in
   Assigned Workload, where prediction is the objective.
8. Never lower a validation standard to increase coverage.
9. Complexity must beat the simpler baseline out-of-sample or be rejected.

## Known limitation that cannot be engineered away

Where GameRotation is missing, true stint timing is UNOBSERVED. Worse reconstruction error among
unavailable games would be evidence of selection; similar error is reassuring but never proof.

## Sequence after the source decision

Assigned Workload (learned, not another coefficient) -> must beat `openerMin` out-of-sample ->
rebuild Model A from scratch -> Model B (performance capacity, components preserved) ->
TULIP Capacity / Headroom / Destination Fit.

## Files

- `scripts/fetch-rotation.mjs` acquisition (raw cache, status machine)
- `scripts/validate-rotation.mjs` conservation battery
- `scripts/diagnose-rotation-coverage.mjs` CONTROL/SHOCK/RANDOM
- `scripts/analyze-rotation-bias.mjs` availability bias
- `scripts/compare-pbp-cleanliness.mjs` feed integrity (NOT reconstruction difficulty)
- `scripts/compare-reconstruction-difficulty.mjs` the direct difficulty test
- `scripts/measure-sub-offsets.mjs` empirical tolerance
- `scripts/lib/opportunity.mjs` shock detection, episodes, pre-event features
- `scripts/fit-workload-distribution.mjs` Model A (current best: R2 .541, MAE 4.90, coverage 50/80/90 exact)

## PBP reconstruction progress (offline work, while rotation crawl runs)

Deterministic rule fixes, each found by inspecting actual disagreements against GameRotation ground
truth rather than by optimizing aggregate error. Measured on 9 games with both sources,
199 player-games:

| fix | exact match |
|---|---|
| starting point | 74.4% |
| name source from roster, not from the player's own sub events | 81.4% |
| forward-scan period-boundary rule | 82.4% |
| generational suffixes retained in descriptions ("Morris Sr.") | 89.4% |
| never-subbed-out means played to the buzzer | 89.4% |
| diacritics folded ("Doncic" vs "Doncic") | 90.5% |

Concrete bugs, all in the SAME class — a player's entry appears inside ANOTHER player's event
("SUB: Morris Sr. FOR Rozier"), so any name-matching failure silently starts his stint late:
- name taken from his own sub events, which fails for players never subbed out
- suffix stripped from roster name but present in description
- accents present in roster name but absent from description

Remaining error modes (19 of 199): stint_ends_too_early 8, stint_extends_too_long 6,
missed_Q2_opening_lineup 3, no_stints 1, missing_stints 1.

Not yet diagnosed: a zero-length truth stint at a period boundary (Harrison Barnes 36.0-36.0)
where reconstruction extends to the final buzzer instead.

## Broad reconciliation check — TOTAL MINUTES ONLY

Rules developed on 9 Tier A games, then measured against box-score minutes across the whole PBP
cache — 961 games, 18,026 player-games:

  mean |recon - box|   3.00 min  ->  1.952 min
  within 0.2 min       34.6%
  off by >1 min        14.5%

WHAT THIS DOES AND DOES NOT SHOW. It shows the fixes improve TOTAL-MINUTE reconciliation beyond the
games they were written on. It does NOT show that first entry, first exit, Q2/Q3 opening lineups,
first-stint duration or stint count improved — those are unobservable without GameRotation, and two
different stint reconstructions can produce nearly identical totals. Calling this "the stint rules
generalize" was an overclaim.

TWO ACCURACY CLASSES, never to be conflated:
  box-minute accuracy   measurable on all 961 cached games
  stint/timing accuracy measurable ONLY where trusted GameRotation ground truth exists
Tier B may NOT be admitted for Assigned Workload on box-minute agreement alone.

The 9-game figure (90.5% exact) is DEVELOPMENT evidence, not validation: the rules were written
while inspecting those very disagreements.
Only 2018-19 and 2021-22 are in the PBP cache (crawl paused at 961 of 2,729 to avoid API contention
with the rotation crawl).

## Team-level lineup reconstruction — the architectural fix

Independent per-player matching could not use the constraints that actually determine a lineup.
Rebuilt as joint team-level state in `scripts/lib/lineup.mjs`:
  - exactly five on the floor;
  - a substitution removes one and adds one;
  - THE INCOMING PLAYER IS NOT ALREADY ON THE FLOOR.

That last constraint resolves same-surname roster-mates deterministically. Play-by-play writes bare
surnames ("SUB: Holiday FOR Davis") with no initial, and the resolver stress test found 9.67% of
team-games (2,477 of 25,626) contain two roster-mates sharing a surname — Wagner brothers,
Grant/Robert Williams, the Antetokounmpos, Brook/Robin Lopez. Per-player matching must abstain on
all of them; lineup state decides them.

### Period-opening lineups solved as a constrained state

Assuming the previous period's closing five carries over gave Q3 accuracy of 16.7%. Teams re-set
after halftime. Each period's opening five is now solved from deterministic constraints:
  1. subbed OUT before ever being subbed IN that period => was on the floor at the period start;
  2. subbed IN during the period => was NOT on the floor before that;
  3. exactly five;
  4. previous closing lineup is EVIDENCE for leftover slots, never an assumption.
Where candidates exceed open slots the period is recorded ambiguous rather than guessed.

### Development Tier A, feature by feature (9 games, 199 player-games)

| feature | before | after |
|---|---|---|
| opening five | 100.0% | 100.0% |
| Q2 opening lineup | 50.0% | 94.4% |
| Q3 opening lineup | 16.7% | 100.0% |
| second-half opening | 16.7% | 100.0% |
| stint count exact | 51.3% | 99.0% |
| first entry | 0.28m | 0.01m |
| first exit | 1.99m | 0.06m |
| first stint length | 1.78m | 0.05m |
| first-half minutes | 1.08m | 0.20m |
| total minutes | 4.17m | 0.20m |

Unresolved substitution events: 3.

DEVELOPMENT EVIDENCE ONLY. These games shaped the rules. Validation and the 2021-22 era audit
remain untouched and will be evaluated once against a frozen version.

## Ambiguity is a usable quality signal, not only a defect

Broad-cache reconciliation, team-level reconstructor: mean 1.461 min, 10.1% off by >1 min.
But split by whether the reconstructor FLAGGED ambiguity:

  team-games with NO ambiguous period   991   mean error 0.78 min
  team-games WITH ambiguous period(s)   931   mean error 2.22 min

So the flag identifies its own unreliable output. That is the basis for admitting Tier B
selectively rather than wholesale: episodes drawn from team-games with no flagged ambiguity are
markedly more trustworthy, and flagged ones can be excluded instead of silently degrading the
dataset. This matches the standing rule — abstain rather than guess.

Ambiguity reasons across the cache: "N candidates for N slots" 742, "underdetermined" 441,
"more than five must-be-on" 71.

Traced one "more than five" case by hand (0021800565, HOU). Period 1 actually resolves correctly
to exactly five; the contradiction arises in later periods when an earlier period's CLOSING lineup
is itself wrong, over-supplying candidates. So the residual is error propagation across periods,
not a flaw in the must-be-on inference. Worth noting the earlier `touched` fix did NOT reduce the
count (71 vs 72), so that hypothesis was wrong and is recorded as such.

DECISION for the overnight path: do not chase full elimination of ambiguity. Use the flag as an
inclusion criterion, and quantify how much Tier B survives it.

## Tier B yield under a per-PERIOD ambiguity criterion

A per-GAME criterion discards half the data unnecessarily. Assigned Workload reads starter status,
first entry/exit, first-stint length and first-half minutes — all determined by Q1-Q2. Q1 is seeded
by official starters and is never ambiguous, so Q2 is the binding constraint.

  periods clean overall            6,535 / 7,792   83.9%
  team-games clean overall           990 / 1,922   51.5%
  team-games with Q2 unambiguous   1,601 / 1,922   83.3%
  team-games with Q2 and Q3 clean  1,346 / 1,922   70.0%

So scoping the criterion to the periods the feature actually depends on retains 83.3% rather than
51.5%. This is the admission rule to carry into Assigned Workload, PENDING untouched validation of
the frozen reconstructor — a per-period cleanliness flag is not itself evidence of accuracy.

NEXT STEP when the crawl supplies more Tier A: freeze the reconstructor as v1, evaluate once on
untouched validation games, and report feature-by-feature. Development results (Q2 94.4%,
Q3 100%, first entry 0.01m, total 0.20m) are NOT validation.

## The ambiguity flag is a valid admission criterion (development evidence)

Development Tier A, split by whether the reconstructor flagged Q2 as ambiguous:

  Q2 CLEAN    Q2 opening lineup exact 15/15   total-minute error 0.000 min
  Q2 FLAGGED  Q2 opening lineup exact  2/3    total-minute error 1.113 min

The reconstructor is EXACT where it does not flag ambiguity, and every error sits in the flagged
subset. So flagged team-games can be excluded rather than trusted, and the earlier headline numbers
(94.4% Q2, 0.20 min total) understate clean-subset performance because they pool both.

Inspected the single flagged Q2 failure (0021800393, NOP): reason "underdetermined: 0+7 for 2" —
seven roster candidates for two slots, and the code fills arbitrarily after flagging. The fill is a
guess, but it is a FLAGGED guess and consumers exclude it. Left as is deliberately: removing the
fill would break the five-player invariant downstream for no gain, since the flag already governs
admission.

STILL DEVELOPMENT EVIDENCE. v1 is frozen (rule hashes recorded in reconstructor_versions.json) and
awaits its single evaluation on untouched validation games, which is blocked only on fetching PBP
for those games — queued to run after the rotation crawl to avoid API contention.

## Measured pilot rates (real denominators)

  26 SUCCESS / 100 completed attempts = 26.0% first-pass
  74 FAILED_PASS1 awaiting the delayed retry pass
Not yet a coverage conclusion: pass 2 has not run, and FAILED_PASS1 is not UNAVAILABLE.

## What the admission criterion buys on the broad cache

  all team-games        20,013 player-games   mean 1.461 min   >1min 10.1%
  Q2 unambiguous        16,592 player-games   mean 1.281 min   >1min  8.8%
  no ambiguity at all   10,197 player-games   mean 0.767 min   >1min  4.5%

Note the gap against development Tier A, where the clean subset showed 0.000 min. Two candidate
explanations, not yet separated: the nine development games may be easier, or box-minute
comparison is simply noisier than stint comparison. Do not treat 0.767 and 0.000 as measuring the
same thing — one is total minutes against the box score, the other is stint agreement against
GameRotation.

---

## 2026-08-20 — ACQUISITION STALL: FULL RECONCILIATION

### The 8.8 hours, accounted for completely

| segment | duration | cause |
|---|---|---|
| pass 1, 04:20:11 -> 07:13:35 UTC | 173.3 min | 250 attempts @ 41.6 s/attempt |
| 07:13:35 -> 12:55:46 UTC | **342.2 min** | **no process running at all** |
| 12:55:46 -> 13:09:09 UTC | 13.5 min | morning retry work |
| total | 529.0 min | matches observed span |

### What actually happened
Pass 1 **completed normally**: `250/250 · accepted 62 · rejected 0 · failed 188`, exiting at
07:13:35Z. The orchestrator `finish_pilot.sh` was to wait for it, sleep 300s, then start pass 2 at
~07:18:35Z. Pass 2 produced **zero** cache writes, so the orchestrator was already dead — consistent
with the SIGTERM kills of background jobs earlier in the session.

The machine was awake throughout: `caffeinate -dimsu` held a `PreventUserIdleSystemSleep` assertion
continuously from 01:45:27 EDT, and `pmset -g log` records no Sleep/Wake events after 00:18.

**The defect was that orchestration was not durable, and nothing detected its absence.**

### Hypotheses REJECTED by this evidence
- `REQUEST_HANG` — no request was in flight; the process had exited cleanly.
- "one systematic stall mechanism across all gaps" — the nine sub-20-minute gaps are runs of
  consecutive *failures* in a success-only timestamp series. Seven consecutive 30s failures produce a
  5-minute gap between successful writes. Expected, not anomalous.
- "the 45s timeout was censoring slow-but-valid responses" — see below. This was the stated
  justification for the timeout change and it is false.

### Measured endpoint behaviour (probe, concurrency 1, 120s diagnostic timeout)
- successful responses: **72–776 ms**
- failures: **HTTP 500 at ~30,400 ms** — the server's own ~30s deadline
- no intermediate latencies observed

The earlier claim of a "13.3s median, 25.3s max" for successful responses is **not reproducible** and
should not be relied on. A 45s client timeout never truncated a valid response. Lowering it to 40s
changed nothing about which data could be obtained.

A **control game that had previously succeeded** returned HTTP 500 on this probe, so 500s are
transient and are not evidence about a specific game's availability.

### Infrastructure added
- `scripts/lib/acquire.mjs` — atomic manifest, in-flight record written BEFORE the request,
  heartbeat, stall guard independent of the abort path, per-attempt policy versioning,
  append-only attempt log.
- `scripts/supervise-acquire.mjs` — external supervisor; restarts on death or stale heartbeat.
- `scripts/probe-latency.mjs` — measurement only; never touches cache or manifest.
- `scripts/test-timeout-mechanism.mjs` — proves timeout behaviour against a local stalling server.

### Confirmed latent defect, now fixed
`fetch-rotation.mjs` cleared its abort timer as soon as headers arrived, leaving `r.json()`
unbounded. Reproduced deterministically: a server that sends headers then stalls the body made the
old pattern hang past a 3x ceiling with no abort, while the fixed pattern aborted on schedule and
left normal responses unaffected. This did **not** cause the 5.7-hour gap, but it was a genuine
unbounded-hang path.

### Statuses that are NOT availability judgements
`WORKER_STALL` (stall guard fired) and `INTERRUPTED` (process died in flight) are acquisition-
infrastructure events. They are always retry-eligible and are never evidence that data does not
exist. Work gathered under the unvalidated experimental settings is tagged `experimental_c3_t40`.

### Open, NOT yet resolved
- The empirical replacement for the arbitrary 3s five-on-floor tolerance **cannot** be read off
  `measure-sub-offsets.mjs`. Its p99.9 suggestion is 401.9s, and 37 of 41 observed spans exceed 3s
  with a 90s median — that distribution is dominated by real off-five spans, not timestamp jitter.
  Adopting 401.9s would gut the conservation check to raise coverage. Left unchanged pending
  disentanglement of real gaps from recording artefacts.
- `compare-reconstruction-difficulty.mjs` had never executed (undefined `rosterName`); now fixed.
  First run: mean box-minute error 1.47 (rotation available, n=14) vs 1.98 (unavailable, n=947).
  Unavailable games are *harder*, the direction that indicates Tier A selection toward easier games.
  n=14 is very small; not conclusive.

---

## 2026-08-20 — ASSIGNED WORKLOAD vs openerMin: THE DECISIVE COMPARISON

### Correction to an earlier negative result
Frozen reconstructor v1 first read as 61.8% opening-five accuracy on untouched validation, and I
wrongly concluded the PBP path was dead. Stratifying by whether official starter data exists:

| feature | with official starters (42 tg / 424 pg) | without (26 tg / 274 pg) |
|---|---|---|
| opening five | 100.0% | 0.0% |
| Q2 opening | 97.6% | 73.1% |
| first entry | 0.11 min (99.1% <=0.5m) | 7.94 min |
| first exit | 0.16 min (98.8%) | 8.93 min |
| first stint | 0.11 min (98.3%) | 2.96 min |
| first-half minutes | 0.14 min (98.1%) | 4.45 min |

`lineup.mjs` seeds the opening lineup from roster `started` flags; with no starter rows that seed is
empty, so the opening five is guaranteed wrong and first-entry timing is mechanically corrupted.
Official starters agree with GameRotation's opening five **42/42 = 100%**. The pooled 3.18-minute
first-entry figure was an artefact of averaging 0.11 with 7.94.

**Admission criterion adopted:** a team-game enters the reconstructed sample only when official
starters exist for it. 83.8% of opener games qualify.

### The experiment
Identical rows, identical OLS estimator, identical splits; only the feature set varies.
n=4,180-4,680 episodes, 690 players. Sources: PBP_RECON 4,089 / GAMEROTATION 91.

| set | grouped-CV MAE | R2 | CRPS |
|---|---|---|---|
| A `openerMin` (production) | 4.725 | 0.5417 | 3.353 |
| B assigned only | 4.756 | 0.5335 | 3.381 |
| C both | 4.678 | 0.5481 | 3.321 |

Chronological holdout (2024-25, n=307): A 4.728 / B 4.733 / C 4.645.

Player-clustered bootstrap, 2000 reps:
- **C vs A: +0.050 MPG MAE, 95% CI [0.034, 0.070]** — real but 0.20% of the 25.2 MPG mean.
- **B vs A: -0.035 MPG, CI [-0.071, -0.004]** — assigned workload alone is significantly WORSE
  than realized opener minutes.

Learning curve (subsampled by player) — the gain has saturated:

    n=723   -0.026
    n=1414  +0.023
    n=2371  +0.039
    n=3518  +0.058
    n=4680  +0.055

### VERDICT
Rotation-derived Assigned Workload does **not** materially improve prediction of sustained latent
workload. It cannot replace `openerMin` (B is worse), and adding it yields ~1% relative MAE — an
effect that is statistically detectable at this sample size and practically negligible, and that
stops growing past ~2,400 episodes. **More opener-game crawling cannot rescue it.**

Recommendation: keep `openerMin`, do not build the Assigned Workload machinery, do not harden the
acquisition layer further for this purpose. The `×2.2` multiplier question and Model B remain open
and are unaffected by this result.

---

## 2026-08-20 (later) — ASSIGNED WORKLOAD DROPPED · MODEL B BUILT · CAPACITY CURVE

### Correction: the denominator for a predictive gain
An earlier note framed +0.050 MAE as "0.20% of the 25.2 MPG mean / 3 seconds of playing time".
Wrong denominator. Against the 4.725 baseline MAE that is a **1.1% MAE reduction** (holdout 1.8%,
CRPS ~1%). Error reduction is not the same quantity as a change in a player's projection.

### DEFECT FOUND: `started` was null in every gamelog row
All five seasons ship `started: null`, so Model A's `startedOpener` and `promotedToStart` were
CONSTANT ZERO, and the code comment claiming starter promotion as "the one genuine assignment signal"
described a feature not present in the data. `lib/starter-flags.mjs` now attaches the real flags from
`starters_*.json` (100% coverage on these seasons).

**Production Model A improved by fixing this alone:**

| | before | after |
|---|---|---|
| MAE | 4.90 | **4.82** |
| R2 | 0.5408 | **0.5527** |
| CRPS | 3.498 | **3.446** |
| ECE | 3.02% | 3.06% |
| coverage | 50.1/80.0/90.0 | 49.9/79.9/89.9 |

This 1.6% gain is larger than anything Assigned Workload delivered, at no infrastructure cost.

### Assigned Workload: DROPPED from primary architecture
The earlier 1.1% gain was largely an artefact of A lacking starter information that C had. With real
flags on both sides (and after fixing a singular design — `a_started` duplicated `startedOpener`,
producing MAE 7.28 / R2 -1.02, a numerical blow-up, not a finding):

| set | grouped MAE | R2 |
|---|---|---|
| A openerMin + real starter flag | 4.729 | 0.5544 |
| B assigned only | 4.790 | 0.5423 |
| C both | 4.714 | 0.5563 |

C vs A: **+0.015 MAE = 0.32%**. B vs A: **-0.061, CI excludes 0 — significantly WORSE.**

Prespecified subgroups (fixed before looking, no subdivision): every target cell non-significant.
- expansion >=8 MPG: +0.2% ns, **-0.3% on holdout**
- promoted to starter (n=653): +0.1% ns, -0.1% on holdout
Learning curve flat around zero.

**Decision:** dropped from the primary architecture, retained as experimental. It must never replace
`openerMin` — the evidence rejects that clearly.

### MODEL B — Performance Capacity (new)
`scripts/fit-performance-capacity.mjs`. Components predicted separately, grouped-by-player CV:

| component | R2 | does w help? |
|---|---|---|
| rebounding | 0.688 | -0.04% |
| creation AST/36 | 0.645 | +0.35% |
| volume FGA/36 | 0.597 | +1.24% |
| turnovers | 0.358 | -0.03% |
| defensive box proxy | 0.151 | -0.02% |
| scoring efficiency TS% | 0.059 | +0.98% |
| summary GS/36 | 0.388 | +2.29% |

Calibration ECE 1.66%; interval coverage 49.4/79.4/89.8; MAE flat across workload bands (3.09-3.91),
so the null is not a power failure. Chronological holdout confirms (rebounding R2 0.717).

**Finding: effectiveness is essentially workload-invariant in this range.** Capacity is limited by
ROLE PERSISTENCE, not by per-minute decay.

Corroborated by the exogenous-timing estimate (`fit-effectiveness-response.mjs`, treatment on the
opener, outcome on subsequent games): GameScore/36 coefficient +0.0098 / +0.0118 / +0.0284 / +0.0282
at MIN_FOLLOW 1/2/3/5 — only MIN_FOLLOW=3 excludes zero, a knife-edge that does not survive
sensitivity. TS% coefficient includes zero. No nonlinear cliff by band.

Known weaknesses, stated not buried: TS% is near-unpredictable (R2 0.059); the defensive proxy is
box-score only (R2 0.151); Model B conditions on persistence (2,102 of 10,968 episodes), so it is a
conditional object and cannot be read marginally.

### LEAKAGE CAUGHT IN THE CURVE
The first capacity curve used realized follow-up minutes as Model B's workload input, which made
P(effective|w) RISE 53% -> 71% with w. That is reverse causality — players who ended up playing more
had been playing better — and it violated the rule that no outcome-window information may be a
predictor. The workload input is now the OPENER's minutes. P(effective|w) is then flat (57% -> 60%
across 22-32 MPG), consistent with Model B.

### TULIP CAPACITY CURVE (`scripts/tulip-capacity-curve.mjs`)
Reports P(sustain>=w), P(effective|w) and the joint separately, with local support and explicit
abstention. Established starter, 26 MPG baseline:

    w=22  sustain 57%  effective 60%  joint 34%  (High)
    w=26  sustain 38%  effective 60%  joint 23%  (High)
    w=30  sustain 21%  effective 62%  joint 13%  (High)
    w=32  sustain 15%  effective 62%  joint  9%  (High)

The `x2.2` / `minutesPerSd 6.6` coefficient is NOT reinstated and remains unused by this path.

---

## 2026-08-20 (final) — MODEL A EARNS LITTLE; TULIP CAPACITY DEFINED AND BACKTESTED

### Simple-baseline benchmark — the most important test in the project
Identical rows, folds, estimator. n=10,968 / 782 players.

| spec | grouped MAE | R2 | chrono MAE | chrono R2 |
|---|---|---|---|---|
| 1 mpg only | 5.480 | 0.4292 | 5.612 | 0.4358 |
| 2 opener only | 5.326 | 0.4660 | 5.230 | 0.4917 |
| 3 mpg+opener | 4.914 | 0.5390 | 4.915 | 0.5572 |
| 4 mpg+opener+starter | 4.850 | 0.5476 | 4.870 | 0.5639 |
| 5 simple quality (7 feat) | 4.823 | 0.5516 | 4.842 | 0.5682 |
| 6 FULL Model A (12 feat) | 4.819 | 0.5527 | 4.840 | 0.5683 |

**Full model vs best simple: +0.004 MAE (0.08%), 95% CI [-0.006, 0.013] — INCLUDES ZERO.**
Four features get within 0.64% of the full model. The five per-36 quality features add nothing
measurable. **Production simplified to spec 5.** R2 .553 is not impressive in isolation; almost all
of it is `current MPG + opener + starter`.

### Sanity checks on the workload distribution — all pass
- monotonicity: **0 violations** in 11,960 held-out comparisons
- face validity: P(>=22) rises 23% -> 87% across actual-sustained bands
- direction: predicted vs actual by baseline band 15.5/15.0, 19.7/19.5, 22.4/22.0, 25.5/25.6,
  29.1/29.3, 33.0/32.8
- **the suspicious 57% was a bad QUERY, not a bad model.** The curve script forced
  `openerMin = threshold` on every row, so it asked about a 26-MPG player demoted to a 22-minute
  opener. Real holdout players with baseline 24-28 using their OWN opener: **P(>=22) = 77%, observed
  frequency 79%.**

**Known flaw:** on the chronological holdout the model is systematically UNDER-confident — actual
exceeds predicted in all ten bands (85.2->91.9, 94.5->97.6), ECE 3.67%. Not fixed; recorded.

### TULIP CAPACITY — definition
**Capacity = expected sustained latent workload from Model A.** No cutoff, no invented coefficient.
Chosen on evidence: MAE 4.842 / bias +0.182, vs median 4.846 / +0.518, vs current-MPG null 5.833.
**Headroom = Capacity - current MPG**, kept separate (team- and role-dependent).
Model B is reported as a separate quality layer with its own uncertainty. No workload penalty is
applied to the MPG number, because the data does not support one.

### THE DECISIVE BACKTEST (trained 2018-24, held out 2024-25, n=2,392)
Among players at the SAME current workload (within 1 MPG), does the higher-TULIP player sustain more?

    capacity gap >= 3 MPG:  805/1100 = 73.2%   95% CI [70.6%, 75.8%]
    capacity gap >= 5 MPG:  698/875  = 79.8%   95% CI [77.1%, 82.4%]
    (50% = no skill)

**TULIP discriminates.** It is not merely restating current minutes.

Headroom buckets vs what actually happened:

    headroom        n     current   TULIP   ACTUAL
    much less <-3  177     26.6     21.9     21.7
    less           245     25.8     23.9     23.9
    about same     571     26.3     26.4     25.9
    more           587     23.3     25.3     25.0
    much more >+3  812     19.1     24.9     25.0

Group-level calibration is close to exact.

### Honest characterisation
TULIP is strong at RANKING and at group-level calibration, and weak at individual point prediction
(MAE 4.84). Real held-out hits: Schroder 21.3 -> TULIP 30.7 -> actual 33.2; Collier 19.1 -> 29.2 ->
29.4. Real misses: Holland II 15.4 -> 25.0 -> actual 11.2; Simons 30.3 -> 22.7 -> actual 37.9.
Use it to compare players, not to promise a specific minute count.

---

## 2026-08-20 — DEPLOYMENT-MODE GATE: THE ORIGINAL TULIP PROMISE IS NOT MET

One fixed pair universe: 202,029 held-out pairs (2024-25), different players, current MPG within
1.0, different outcomes. Only the predictor changes between rows. Player-clustered bootstrap CIs.

| method | all pairs | gap>=3 (n) | gap>=5 (n) | Spearman |
|---|---|---|---|---|
| current MPG only | 52.2% [51.7,52.6] | — (0) | — (0) | 0.159 |
| openerMin only | 65.7% [64.2,66.6] | 71.6% (130,979) | 75.3% (92,040) | 0.454 |
| openerMin + starter | 65.7% [64.3,66.6] | 73.0% (118,809) | 76.9% (82,169) | 0.462 |
| **PRE-OPPORTUNITY TULIP** | **55.8% [54.7,57.6]** | 65.5% (13,385) | 64.1% (569) | **0.220** |
| POST-OPP (spec 5) | 66.5% [65.0,67.4] | 75.7% (99,747) | 80.6% (56,882) | 0.487 |

### Conclusions, stated plainly
1. **The headline 73%/80% was supplied by the observed opportunity, not by TULIP.**
   `openerMin + starter` alone reaches 73.0% / 76.9%. The full model reaches 75.7% / 80.6%, and on
   the comparable all-pairs column adds **0.8pp over openerMin alone** (65.7% -> 66.5%).
2. **Pre-opportunity TULIP does not meaningfully discriminate.** Among two players at the same
   current workload it picks the one who ends up playing more **55.8%** of the time, against 52.2%
   for current-MPG-only. The CI excludes 50%, so the signal is real, but 3.6pp over the null is not
   a front-office product. It is confident (gap>=3) on only 6.6% of pairs, and its gap>=5 cell has
   n=569 with concordance BELOW its own gap>=3 cell.
3. Therefore the Brooklyn question — "before we acquire this 19-MPG player, does he have 26-MPG
   capacity?" — **is not answered by this work.**

### Naming, corrected
- The working model is **TULIP Role Persistence / Opportunity Confirmation**: given a player has
  ALREADY received an expanded role, how much of it sticks. It is genuinely useful and genuinely
  validated — but it is mostly `openerMin`, and must not be marketed as latent capacity.
- **TULIP Capacity (pre-opportunity portable) is NOT delivered.** Do not brand it as such.

### Recalibration — attempted honestly, did not help
Correction learned from nested out-of-fold predictions inside TRAINING seasons only, frozen, then
applied once to 2024-25. Frozen scale **1.0028**; ECE 3.67% -> 3.68%; coverage 50.2/79.9/89.9 ->
50.5/80.1/90.0. The under-confidence is not a residual-spread problem — the holdout season simply had
higher persistence than the training seasons. **Left as-is and documented.**

### Known gap in the pre-opportunity feature set
No birthdate exists anywhere in this dataset, so AGE could not be used; a seasons-observed experience
proxy was substituted and is a poor one. A genuine pre-opportunity capacity model would want true
age, position/physicals, contract status and team-context features. That is a data-acquisition
question, not a modelling one — and it is the single most plausible reason the pre-opportunity model
is weak.

---

## 2026-08-20 — PRE-OPPORTUNITY TULIP CAPACITY: DELIVERED (with an important correction)

### CORRECTION to the previous entry
The earlier "PRE-OPPORTUNITY TULIP = 55.8%" was a MIS-SPECIFIED MODEL, not a property of the data.
That feature set omitted **recent minutes** (mean MPG over the 10 games before the opener) — the most
obvious pre-opportunity workload variable there is. Verified by control:

    baselineMpg only                  52.2%   (pairs are matched on baselineMpg, so ~50% is expected)
    + recent 10-game MPG (P0)         64.8%

Bio data WAS obtainable: `leaguedashplayerbiostats`, one request per season, giving age, height,
weight and draft slot. Coverage 91% age / 89% height.

### Results — three pre-opportunity specs, identical rows and splits
Grouped 5-fold by player, n=10,968 / 782 players:

| spec | MAE | R2 | CRPS |
|---|---|---|---|
| P0 workload only | 5.024 | 0.5099 | 3.600 |
| P1 + age/physicals/draft/career/fouls | 4.995 | 0.5155 | 3.579 |
| P2 + team blockage | 4.994 | 0.5158 | 3.579 |

Chronological holdout 2024-25 (n=2,392): P0 5.013 / .5311, P1 5.002 / .5342, P2 4.997 / .5348.
Spearman(headroom, actual change): .417 / .423 / .424.

Same-current-MPG concordance, 202,029 held-out pairs:

    baselineMpg only   52.2% [51.7,52.6]
    P0                 64.8% [62.6,65.9]   gap>=3 74.1% (90,198)   gap>=5 78.7% (45,170)
    P1                 64.8% [62.8,65.9]
    P2                 64.8% [62.7,66.0]
    -- for reference, from the previous entry --
    openerMin only     65.7%
    POST-OPP spec 5    66.5%

Coverage vs accuracy (confidence = model's own predicted gap, full curve shown, no threshold picked
after the fact):

    coverage     5%    10%    20%    40%    60%    80%   100%
    P0         85.0%  82.4%  79.4%  74.9%  71.2%  67.8%  64.8%
    P2         86.9%  83.5%  79.8%  75.0%  71.3%  68.0%  64.8%

### VERDICT
1. **Pre-opportunity TULIP Capacity works.** 64.8% concordance among players at the same current
   workload, versus 52.2% for the matched baseline, with a clean monotone confidence curve reaching
   **86.9% at 5% coverage**. This is the selective-use product: it need not rank every pair.
2. **The opener is worth only ~1.7pp** (64.8% -> 66.5%). The previous conclusion that the headline
   result was "supplied by the observed opportunity" was wrong — it was supplied by WORKLOAD HISTORY,
   which is available before the opportunity.
3. **Age, physicals, draft slot, career history, foul rate and team blockage add essentially nothing**
   in aggregate (+0.03 MAE, +0.0pp concordance); a small edge appears only in the most-confident 5-10%
   of pairs. They are retained in P2 because they do not hurt, but they are not the source of signal.

### Prespecified historical cases (2024-25, 15-22 MPG, >=5 follow-ups, n=35)
Selection rule fixed before inspecting outcomes.

Top-6 predicted headroom — all six sustained materially more:
Pritchard 18.1 -> TULIP 26.5 -> ACTUAL 30.1; Wiggins 19.6 -> 26.7 -> 29.9; Wilson 17.1 -> 23.6 ->
28.2; Collier 19.1 -> 25.2 -> 29.4; Coffey 20.6 -> 26.6 -> 32.7; Wiggins 19.2 -> 25.0 -> 29.4.
TULIP under-predicted the magnitude in every one.

Bottom-6 (near capacity) — five of six stayed flat or fell: Reath 15.6 -> 3.0; Sasser 16.6 -> 15.7;
Rupert 15.4 -> 9.3; K. Williams 18.5 -> 15.6; Walker 16.9 -> 8.2. One miss: Pippen Jr 21.4 -> 25.1.

Honest misses both ways: too low — Robinson 15.3 -> 19.9 -> 28.7, Mathews 15.0 -> 17.5 -> 26.1,
Schroder 21.3 -> 25.5 -> 33.2. Too high — Clingan 16.6 -> 21.3 -> 14.1, Holland II 15.4 -> 19.0 ->
11.2, Reath 15.6 -> 15.8 -> 3.0.

Group check, same band, same current MPG:

    top decile of headroom     n=20  current 17.6  TULIP 22.4  ACTUAL 24.5  (+6.9)
    bottom decile              n=20  current 17.7  TULIP 18.8  ACTUAL 17.7  (+0.1)

Identical current workload; outcomes diverge by 6.8 MPG. CAVEAT: this band has only n=35, so the
examples are illustrative. The statistical weight is in the 202,029-pair concordance, not here.

### PRODUCT
- **TULIP Capacity** = pre-opportunity predicted sustained workload (P2). Headroom = Capacity -
  current MPG. Deployable before acquisition.
- **TULIP Role Persistence** = the opener-based model, separate and honestly named.

---

## 2026-08-20 — FINAL GATE: SIGNAL IS REAL, "PORTABLE" IS UNPROVEN

### Test 1 — the naive rule matches the model exactly
"Pick whichever player has the higher recent-10 MPG" is not a model. On 202,029 held-out pairs:

| spec | grouped MAE | chrono MAE | concordance |
|---|---|---|---|
| baselineMpg only | 5.480 | 5.612 | 52.2% |
| **recentMpg only** | 5.058 | 5.059 | **64.8%** |
| recent + trend | 5.058 | 5.065 | 64.8% |
| P0 workload only | 5.024 | 5.013 | 64.8% |
| P1 + age/physicals/draft/career/fouls | 4.995 | 5.002 | 64.8% |
| P2 + team blockage | 4.994 | 4.997 | 64.8% |

Naive rule concordance **64.8%**, coverage curve 5%->85.0%, 10%->82.4%, 20%->79.3%, 40%->74.9% —
IDENTICAL to P0 to three significant figures. P2 shows +1.9pp at 5% coverage (86.9% vs 85.0%) with
heavily overlapping CIs.

**TULIP's pre-opportunity ranking IS recent-10 MPG.** The model adds a calibrated magnitude and an
uncertainty interval, not a better ordering.

### Test 2 — PORTABILITY CANNOT BE TESTED WITH THIS DESIGN
Cross-team episodes: **11 of 10,968 (0.1%)**; **2** in the untouched holdout. The opportunity-episode
design requires the player to be on the same roster throughout the teammate-absence window, so
mid-season trades are structurally excluded — this is a property of the design, not a data gap.

**The word "portable" is UNPROVEN, not disproven.** No cross-team estimate can be manufactured from
n=2. Testing it would need a different design (e.g. season-boundary team changes), which is out of
scope under the current instruction not to open new loops.

### Test 3 — selective use CONFIRMED on the untouched chronological holdout
All predictions from a model fitted only on 2018-24; pair universe is 2024-25 only; intervals
resample PLAYERS (pairs share players).

    coverage    recentMpg only          P2 + team blockage        pairs
       5%    85.0% [80.4, 87.8]      86.9% [82.9, 89.0]        10,101
      10%    82.4% [77.8, 85.0]      83.5% [79.4, 85.6]        20,202
      20%    79.3% [75.2, 81.4]      79.8% [76.0, 81.7]        40,405
      40%    74.9% [71.5, 76.8]      75.0% [71.8, 76.7]        80,811
     100%    64.8% [62.6, 65.9]      64.8% [62.7, 65.9]       202,029

### PRODUCT DECISION
- **Primary model simplified to P0: baseline MPG + recent-10 MPG.** The 22 acquired features (age,
  height, weight, draft slot, career history, foul rate, availability, team blockage) move chrono MAE
  by 0.016 and the ranking by 0.0pp. They are NOT retained merely because they were acquired.
- **Do not call it "portable capacity".** Honest description: *a pre-opportunity workload-trajectory
  model* that predicts which same-current-MPG player will sustain a larger role, driven by recent
  minutes. Whether that transfers across rosters is untested.
- The bio data and blockage code are kept on disk for a future portability study; they are not in the
  production path.

### LEADERBOARD (untouched 2024-25, P0, selection rule fixed before viewing outcomes)
Top hidden-capacity hits: Jalen Johnson 23.2 -> TULIP 33.7 -> ACTUAL 34.4; Pritchard 18.1 -> 26.4 ->
30.1; Wiggins 19.6 -> 27.1 -> 29.9; Wilson 17.1 -> 23.8 -> 28.2; Jordan Miller 8.9 -> 16.3 -> 20.6.
Top misses: Cason Wallace 22.8 -> 29.4 -> 18.3 (-11.1); Buzelis 12.7 -> 20.2 -> 12.1; Beekman 12.0 ->
16.0 -> 28.4 (+12.3); Krejci 13.3 -> 14.9 -> 27.2 (+12.3).
Low-capacity calls: Lonzo Ball 31.3 -> 22.5 -> 22.2 (near-exact); Kleber 22.5 -> 19.8 -> 20.0.

Headroom decile calibration, monotone apart from decile 6:

    decile 1  current 16.0  TULIP 23.4  ACTUAL 22.9  (+6.9 vs current)
    decile 5  current 18.6  TULIP 21.1  ACTUAL 20.7  (+2.1)
    decile 10 current 28.0  TULIP 26.6  ACTUAL 25.3  (-2.7)

---

## 2026-08-20 — CROSS-TEAM PORTABILITY: TULIP CAPACITY EARNS ITS NAME

### Dataset
1,470 qualifying transitions (>=20 Team A games before the cutoff, >=10 Team B games after), 627
players, 10 seasons. 970 offseason / 500 in-season. Cutoff = immediately before the first Team B
game; every predictor comes from Team A history only. Predictive test, NOT causal — moves are not
random.

### THE KEY REVERSAL: recent-10 does NOT travel
Within a team, `recent-10 MPG` was unbeatable. Across teams it is the WORST simple baseline, and
Team A SEASON MPG beats it outright.

Primary target, first 10 Team B games (n=1,470):

| spec | MAE | R2 | Spearman | vs recent-10 |
|---|---|---|---|---|
| 1 Team A season MPG | 5.209 | 0.4237 | 0.492 | +0.315 |
| 2 Team A recent-10 | 5.524 | 0.3556 | 0.408 | — |
| 3 recent-10 + trend | 5.457 | 0.3679 | 0.422 | +1.2% |
| 4 PORTABLE player | 5.208 | 0.4258 | 0.492 | +5.7% |
| 5 PORTABLE + attrs | 5.050 | 0.4467 | 0.515 | **+8.6%** |
| 6 DESTINATION-aware | 5.036 | 0.4489 | 0.519 | +8.8% |

Consistent across all three prespecified windows: t6to15 +8.8%, tRest +10.1%.
Chronological holdout 2024-25 (n=155): recent-10 5.898 -> portable+attrs 5.357 (+0.541), destination
5.325 (+0.572).

### PAIRWISE — matched on Team A recent-10 within 1.0 (72,556 pairs)
Among two players who looked IDENTICAL by recent minutes on their old team, who sustains more on the
new one?

    2 Team A recent-10     50.5% [50.0, 51.3]   (the matching variable: no discrimination, as expected)
    1 Team A season MPG    60.2% [59.1, 61.9]
    4 PORTABLE player      60.4% [59.3, 61.6]
    5 PORTABLE + attrs     61.2% [60.1, 62.4]   gap>=3 69.2%   gap>=5 74.7%
    6 DESTINATION-aware    61.1% [59.9, 62.5]

Coverage vs accuracy: portable+attrs 82.4% at 5%, 78.3% at 10%, 74.3% at 20% — against 48.7% for
recent-10.

### Interpretation
**Recent-10 MPG was measuring same-team rotation momentum, which does not transfer. Season-length
workload and player attributes DO transfer.** That reconciles both studies: within-team, momentum
dominates; across teams, it is worthless and the durable signal is season-level role plus who the
player is.

- Attributes (age, height, weight, draft slot, production profile) matter HERE (+1.0pp over season
  MPG alone, MAE 5.208 -> 5.050) though they added nothing within-team. Keep them in the portable model.
- **Destination context adds essentially nothing** (61.1% vs 61.2%; MAE 5.036 vs 5.050). Capacity and
  team fit are separable, and on this evidence destination is the weaker half. Small edge on offseason
  moves only (MAE 5.087 -> 4.969).

Stratified: offseason recent-10 Spearman 0.324 -> portable 0.468 -> destination 0.489;
in-season 0.545 -> 0.566 -> 0.581. Portability gain is LARGER for offseason moves.

### Untouched 2024-25 examples (rule fixed before viewing)
High portable headroom: Huerter A-recent 10.5 / A-season 20.9 -> pred 20.6 -> ACTUAL 25.2;
Roddy 3.2 / 18.1 -> 16.0 -> 18.7; Biyombo 7.3 / 19.8 -> 15.0 -> 17.6; Cain 3.4 / 9.9 -> 12.7 -> 13.5.
Low headroom: Brogdon 34.4 / 28.8 -> 24.2 -> ACTUAL 24.1; DiVincenzo 40.9 / 29.2 -> 26.2 -> 27.4;
Caruso 33.5 / 28.7 -> 24.0 -> 19.6.
Misses too low: Castleton 4.6 -> 6.0 -> 25.8 (+19.8); Boston Jr 18.0 -> 12.7 -> 28.3 (+15.6).
Misses too high: McGowens 10.2 -> 17.2 -> 2.2 (-15.0); Porter Jr 36.0 -> 30.7 -> 16.8 (-13.9).

Quintiles: top n=31 A-recent 7.5 -> predicted 13.2 -> ACTUAL 13.4 (+5.9);
bottom n=31 A-recent 28.8 -> predicted 21.7 -> ACTUAL 23.5 (-5.3).

### VERDICT
**TULIP Capacity has earned its name.** Team A information predicts Team B sustained workload
materially better than recent minutes, on 1,470 cross-team transitions, surviving chronological
validation and three prespecified target windows.

PRODUCTION MODEL: spec 5, PORTABLE + attrs (Team A workload history + age/physicals/draft/production).
Destination context is NOT included — it does not pay for itself.
Caveats: holdout n=155 is modest; individual MAE ~5.1 MPG remains large; this is predictive, not
causal — teams trade players for reasons the box score cannot see.

---

## 2026-08-20 — FINAL GATE vs TEAM A SEASON MPG: PASSES 3 OF 4 CRITERIA

### 1. Portable+attrs vs Team A season MPG, all three windows (player-clustered CIs)

| window | season MPG | portable | MAE gain | 95% CI | dR2 | dSpearman |
|---|---|---|---|---|---|---|
| tFirst10 (n=1470) | 5.209 | 5.050 | +0.159 | [0.068, 0.240] excl 0 | +0.0229 | +0.039 |
| t6to15 (n=1331) | 5.183 | 5.072 | +0.111 | [0.035, 0.201] excl 0 | +0.0255 | +0.043 |
| tRest (n=1470) | 4.938 | 4.729 | +0.209 | [0.109, 0.281] excl 0 | +0.0374 | +0.055 |

Relative gain 2.1-4.2%. Chronological holdout 2024-25 (n=155): base 5.522 -> portable 5.357 -> dest 5.325.

### 2. Matched pairs on TEAM A SEASON MPG (within 1.0), 73,052 pairs

    season MPG (matching var)  51.0% [50.4, 51.6]
    portable+attrs             54.7% [53.4, 56.5]  gap>=3 61.4% (15,187)  gap>=5 68.1% (2,518)
    destination-aware          54.6% [53.0, 56.2]

Real (CI excludes 50%) but modest: among two players with the SAME established Team A workload, the
model picks the one who sustains more 54.7% of the time.

### 3. In-season vs offseason — THE CRITERION THAT FAILS

    offseason n=970: season MPG 5.087 -> portable 4.964 · gain +0.122 [0.035, 0.221] EXCLUDES 0
    in-season n=500: season MPG 4.938 -> portable 4.898 · gain +0.040 [-0.075, 0.188] INCLUDES 0

**The portable advantage does NOT survive on in-season trades.** For mid-season moves, established
Team A season MPG is as good as the model.

### VERDICT — scoped, not unconditional
Brett's rule required the model to beat season MPG on clustered uncertainty, chronological holdout,
same-season-MPG matched pairs, AND both move types. It passes three and fails the fourth.

- **Offseason acquisitions: TULIP Capacity earns the name.** Validated incremental signal over the
  strongest simple Team A workload baseline.
- **In-season trades: it does not.** Output is labelled "season-MPG equivalent" there rather than
  quietly presented as if the model were adding value.

Magnitude is modest throughout: 2-4% MAE, 54.7% matched-pair concordance. On the 2024-25 offseason
holdout the per-quintile advantage is inconsistent — TULIP is WORSE than baseline in the two
lowest-workload quintiles (6.26 vs 5.81, 6.69 vs 6.62) and better in the middle/upper (3.88 vs 3.99,
5.09 vs 5.73, 4.50 vs 4.51). n=18 per quintile.

### Corrected interpretations
- NOT "destination is the weaker half". Correct: **the destination-context variables tested here add
  little incremental predictive value** beyond the portable model (54.6% vs 54.7%). Whether
  destination fit matters is untested; these particular features may simply be weak.
- NOT a proven latent physical/skill capacity construct. Correct: **evidence of portable workload
  prediction across team changes.** It predicts sustainable Team B workload.

### PRODUCT (`scripts/tulip-capacity-product.mjs`)
Capacity MPG, Headroom vs Team A season MPG, 50% interval from frozen training residuals, evidence
grade A-D from local support (with in-season capped), plus a side-by-side baseline comparison.
Untouched 2024-25: hits Paul George 33.8 -> 29.5 -> 29.5 (0.0), Brogdon 28.8 -> 24.2 -> 24.1,
Nurkic 23.6 -> 17.3 -> 17.2. Misses Castleton 4.6 -> 6.0 -> 25.8 (+19.8), McGowens 14.9 -> 17.2 ->
2.2 (-15.0), Porter Jr 34.3 -> 30.7 -> 16.8 (-13.9).

---

## 2026-08-20 — TULIP_CAPACITY_V1 FROZEN

Identifier: **card-sha256:96cb2f34c6cd06c3** · card at `TULIP_CAPACITY_V1.json` · id at `TULIP_CAPACITY_V1.id`

Implementation audit PASSED (7/7): no Team B leakage (400 transitions re-derived, 0 mismatches),
attributes as of prediction date, offseason/in-season classification exact, season-MPG vs recent-10
distinct (r=0.881), starter coverage 100%, holdout disjoint, missing-attribute robustness.

Top production coefficients (MPG per 1 sd): aSeasonMpg +3.26, aRecent5 +1.70, aSeasons -1.55,
aGames +1.53, aGsPer36 +1.31, aCareerHighMpg +0.82, age -0.79, aRecent10 -0.78.
50% interval width **8.7 MPG**.

### IMPORTANT SOBERING RESULT from the frozen backtest
On the 2024-25 OFFSEASON holdout specifically (n=94):
- TULIP beat the Team A season-MPG baseline on **49/94 players (52.1%)** — near coin-flip per player
- mean |err| TULIP **5.248** vs baseline **5.305** — a gain of only 0.057 MPG on this subset

The stronger, statistically supported offseason gain (+0.122, CI [0.035, 0.221]) comes from grouped
CV over all 970 offseason transitions. On any SINGLE season's worth of moves the edge is small and
noisy. Both numbers must be quoted together; the aggregate result is real, the per-season per-player
edge is thin.

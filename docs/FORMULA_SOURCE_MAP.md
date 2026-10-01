# Formula and source map

This document is the human-readable companion to `public/data-status.json -> modelProvenance`.
The publication artifact is the machine-readable source of truth for the exact implementation hashes and input versions used by a build. A semantic version names a model where one already exists; otherwise the SHA-256 fingerprint of the implementation files is the model version. No new accuracy claim follows from versioning a model.

| Output family | Formula / implementation | Semantic version source | Primary input version | Evidence boundary |
| --- | --- | --- | --- | --- |
| Performance Grade, Rate Grade, Magnitude Grade, custom metrics | `scripts/lib/grades.mjs`, `scripts/lib/metrics.mjs`, `scripts/build-v3.mjs` | `GRADE_MODEL_VERSION` / `gradeModel.version` | published source-manifest fingerprint | Descriptive within-league performance model; source gaps remain missing rather than zero. |
| 2026-27 projections | `scripts/lib/projection.mjs`, `scripts/lib/projection-context.mjs`, `scripts/lib/projection-validation.mjs`, `scripts/build-projections.mjs` | `projectionMeta.id + contextVersion` | exact model-card SHA-256, projection-input SHA-256, roster SHA-256 | Current injury clearance is not verified; fallback and abstention states remain explicit. Required season accounting is checked during the build; its validator is included in the implementation fingerprint. |
| TULIP role evidence | `scripts/lib/tulip.mjs`, `scripts/lib/tulip-diagnostics.mjs`, `scripts/build-v3.mjs` | `tulipMeta.version` | published source-manifest fingerprint and historical inventory | Observational role evidence; not causal identification or validated win-optimal minutes. |
| TULIP Beta recommended MPG | `scripts/lib/tulip-beta.mjs`, `scripts/lib/tulip-beta-diagnostics.mjs`, `scripts/build-v3.mjs` | `tulipBetaMeta.config.version` | 2025-26 baseline evidence plus published 2026-27 roster version | Experimental zero-sum allocator; availability/position constraints remain incomplete. |
| Projected Role MPG | `scripts/lib/tulip-capacity-v1.mjs`, `scripts/lib/tulip-capacity-build.mjs`, `scripts/build-v3.mjs` | `tulipCapacityMeta.version` | frozen card SHA-256 / frozen date / source-cache mode | Predicts observed post-move role MPG; explicitly not a physical-capacity estimate or TULIP Beta validation. |
| Historical player comparisons | `scripts/lib/comparison-profiles.mjs`, `scripts/build-player-comps.mjs` | `analysis.playerCompsMeta.version` | published source-manifest fingerprint plus declared NBA/G League history windows | Blend fit is heuristic, not a probability or career projection. |
| Skill profiles, similarity, archetypes, Team Fit | `scripts/lib/analysis.mjs`, `scripts/build-v3.mjs` | implementation SHA-256 when no semantic version exists | published source-manifest fingerprint | Team Fit measures roster-need match, not overall player quality. |
| Cross-league readiness and translation | `scripts/lib/crossleague.mjs`, `scripts/build-crossleague.mjs` | implementation SHA-256 when no semantic version exists | same-season dual-league source-manifest fingerprint | Selected small samples; exploratory/descriptive rather than a validated career forecast. |

## Publication contract

For every output family, `modelProvenance` records:

- the semantic model version when the model already has one;
- a deterministic SHA-256 over the exact implementation files;
- the SHA-256 of each implementation file;
- the relevant input-version identifiers and source-manifest fingerprint;
- the source/evidence description used by the output.

Publication verification recomputes this map from the checked-out source and input files. If an implementation file changes without regenerating publication status, verification fails. The same happens if the embedded Grade Model version and provenance Grade Model version disagree.

The Grade Model now uses one canonical `GRADE_MODEL_VERSION = 3.4` constant. This corrects the prior metadata disagreement where the same build was labeled `3.1` in `gradeModel` and `3.3` in `provenance`, while the implementation itself identified the rebuild as v3.4.

## Exposure precision and accounting

Official season totals and precise minutes are the preferred source for per-36 lines: `36 × official stat total / precise season minutes`. Rounded displayed MPG is not a denominator when precise exposure exists. Fallback records without official totals use per-game rate times games over precise minutes; legacy records without games can use MPG, without inventing missing values.

Projection headlines use one decimal for expected games and box-score rates. `proj.accounting` retains nine-decimal rates and expected games; season totals use that precise expected-game exposure, not rounded headline games. Roster effective minutes use the same exposure divided by the NBA's 82-game schedule. Displayed lines can therefore differ by their stated rounding without disagreeing with the underlying 240-minute ledger.

`tests/independent-accounting.test.mjs` imports no production model, validation or formatting helper. It checks official actuals, pooled percentages, precise per-36 rates, forecast identities and all NBA roster aggregates. Deliberate corruptions must fail, so the audit cannot pass through an empty population or agreement between shared helpers.

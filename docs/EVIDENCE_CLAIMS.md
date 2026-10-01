# Evidence and accuracy claim contract

`public/data-status.json -> evidenceClaims` is the machine-readable claim boundary for the public outputs. It is deliberately separate from `modelProvenance`: provenance identifies exactly which code and inputs produced an output; evidence states what has and has not been demonstrated about that output.

## Publication rule

A predictive-accuracy claim may be marked supported only when a chronological as-of evaluation names the exact shipped model version and evaluates the full shipped model scope. A backtest for an earlier formula, a layer-only diagnostic, an in-sample fit, UI verification, or robustness test cannot be promoted into evidence for the full current model.

## Current boundaries

- **2026-27 projections:** overall predictive accuracy for the exact `PROJECTION_2026_27+context-1` stack is not established. The published 2025-26 veteran backtest is measured historical evidence but predates the full context stack. The 459-player/29-team context reconciliation result evaluates the minute layer only; it holds rates, injuries and availability fixed. Neither result validates the complete rookie, returner, injury/availability and context behavior now shipped.
- **Performance grades:** descriptive within-league ratings, not forecasts.
- **TULIP role evidence / TULIP Beta:** experimental/observational decision-support evidence. Robustness or ledger feasibility is not causal or predictive validation, and neither direction nor exact minute magnitude is established as win-optimal.
- **Projected Role MPG:** a separate frozen workload/role projection with its own limited benchmarks. Its evidence is not transferable to TULIP Beta or the 2026-27 stat projection.
- **Player comparisons and Team Fit:** descriptive/heuristic matching, not calibrated predictive probabilities.
- **Cross-league readiness/translation:** measured only on selected dual-league samples where reported. This does not establish general NBA-career probability or broad out-of-sample career accuracy.

UI changes, accessibility fixes, deterministic rebuild checks and artifact integrity checks remain valuable verification, but they are not model-accuracy evidence.

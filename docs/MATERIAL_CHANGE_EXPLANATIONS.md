# Material player-output change explanations

`npm run explain:material-changes -- --before <old-data.json> --after <new-data.json> --out <report.json>` compares two built public datasets and emits player-level explanations for material model/output movement.

The gate deliberately ignores tiny numerical churn and rank-only movement. Rank is population-relative and can move because another player changed; the underlying player value is the output that must be explained.

Tracked player-output families are performance/rate/magnitude grades, 2026-27 projections, TULIP Beta, Projected Role MPG, player comparisons, Team Fit, and record-presence changes. Each family uses a declared materiality threshold. Explanations come from already-published component/driver traces, model/version changes, roster/team changes, or source/reference changes; they are not generated free-form narratives.

A change is `legacy-trace-limited` only when the old artifact predates an explanation trace that is present in the new artifact. That is explicitly weaker than exact before/after attribution but is allowed for the one-time migration. A material change with neither changed drivers nor an explicit model/version boundary is `unexplained`, and validation fails.

Projected Role MPG now serializes explanation-only coefficient contributions (`why.topDrivers`) plus any attribute defaults used. Those fields do not alter the frozen numeric model output.

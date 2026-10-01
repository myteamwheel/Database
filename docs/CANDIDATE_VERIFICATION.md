# Candidate release verification

This is the final pre-CI/pre-release gate for the accumulated review corrections. It does **not** ingest live sports data and it does not deploy anything.

## What the gate proves

`npm run verify:candidate -- --archive-base-ref <base-sha>` rebuilds the candidate from committed snapshots, hydrates the immutable 2015-16 through 2024-25 historical cache from `c17bc8d7cf2e41822a8bcf6fbf4b0b62bca095ee`, and verifies the following categories:

- historical products and strict timing contracts
- database/accounting/review regressions
- frozen projections, context arithmetic and sensitivity
- append-only forecast archive integrity
- comparison models
- TULIP Beta and Projected Role MPG contracts
- refresh/publication failure behavior and evidence-claim boundaries
- presets, cross-tab identity/timeframe/Team Fit consistency, history and starter invariants
- lossless standalone artifact encoding and deterministic rebuilds
- material player-output changes against the previously verified live release `e7182849d62cba46566f3ffafc4c1e620e5ef8ff`
- JavaScript syntax and the complete Playwright browser regression suite

A passing candidate report is evidence about the exact checked-out source head. It is not evidence that the site is deployed, that live feeds are configured, or that an unvalidated model became accurate.

## Release comparison

The material-change comparison is pinned to the previously verified live artifact at `e7182849d62cba46566f3ffafc4c1e620e5ef8ff`. The forecast-archive immutability comparison is separate and must receive the actual review/PR base SHA through `--archive-base-ref`.

Those refs answer different questions and must not be conflated.

## Clean-generated mode

CI uses `--require-clean-generated`. In that mode the candidate fails if the canonical generated artifacts differ from the committed head after rebuilding. This prevents exact-head CI from blessing source code while GitHub Pages would still publish stale committed output.

The allowed generated set is intentionally narrow:

- `scripts/data/history/player_history_product.json`
- `public/history-games.json.gz`
- `public/history-role-features.json.gz`
- `public/data.json`
- `public/data-status.json`
- `public/standalone.html`

Any other tracked or untracked project-file mutation is a failure. The verification JSON files themselves are exempted.

## What is deliberately excluded

- `npm run fetch` / live stats ingestion
- owner refresh execution against external sources
- merge, push or deployment
- claims that legacy projection backtests validate the full current context stack
- claims that TULIP Beta is causal or win-optimal

Source-failure behavior is exercised through deterministic fixture tests instead of contacting external feeds.

# Takeover audit — 2026-08-17

Baseline transferred from Claude: `f22def1a3ed14f1f4d3526bf9e041f635ab6a0c7` on `main`.
The two handoff ZIPs were SHA-256 verified before work began. This document records what the
transferred source/data actually support and the first post-handoff corrections.

## Source of truth

Executable audits and generated artifacts take precedence over prose handoff notes. The takeover
found two stale empirical TULIP claims in the handoff/source comments. On the transferred build,
recomputation gives:

- starter-share SMD pooled: about `-0.008`;
- worst target-band starter-share SMD: about `-0.968` in the 28–32 MPG band, not the older `0.798`;
- alternative-outcome Spearman versus NetRtg: PIE `0.881`, rate composite `0.771`, Rate Grade
  `0.884`;
- NetRtg top-20 overlap: `15/20`, `14/20`, `15/20`, not the older blanket `16/20` claim.
- Spearman is now computed as Pearson correlation of average ranks, so ties are handled correctly rather than using the no-ties shortcut formula.

These are robustness diagnostics, not predictive validation and not causal identification. The
numbers are now generated from the same build as the artifact and `tulip-verify.mjs` fails if the
persisted metadata drifts from recomputation.

## Historical data

The local handoff includes 10 NBA seasons, 2015-16 through 2024-25:

- 272,307 player-game rows;
- 12,813 games;
- 1,453 players;
- 30 teams;
- zero duplicate canonical `season|seasonType|gameId|playerId|teamId` keys;
- zero failures across the 14 historical integrity checks;
- 30/30 immutable core datasets hash-verified.

Raw historical rows remain local/build-time data. A full local player-season summary is
regenerable with `npm run build:history-summary` and is gitignored. A compact tracked product
artifact (`scripts/data/history/player_history_product.json`) contains descriptive history for
current-database players, joined by official NBA person id. The browser's main database receives only
compact season-phase rows; a separate gzip product carries current-player game logs and is fetched or
decoded only on demand.

At this audit the product artifact contains 3,635 player-season-phase rows for 566 current players;
the full local history contains 7,561 player-season-phase rows. The browser has historical records
on 680 current NBA/G League records because the same person can appear in both league panels.

## Starter history

Canonical starter status remains sparse and provenance-aware:

- `DIRECT_NBA`: 28,086 established player-game rows;
- `DIRECT_ESPN`: 0;
- `RECONSTRUCTED_V1`: 0;
- implicit `UNKNOWN`: 244,221.

2023-24 is the only accepted direct starter domain at takeover.

### 2023-24 regular season

Re-run acceptance result:

- 1,230/1,230 games fetched, zero failures;
- 2,460/2,460 team-games VALID;
- 26,401/26,401 historical appearance rows joined;
- zero duplicate keys;
- zero minute disagreements over 1.0 minute;
- official aggregate starts = 12,300 = 5 × 2,460;
- 572/572 players match the official NBA Starter split exactly;
- zero player-level mismatches; maximum discrepancy 0.

### 2023-24 playoffs

The transferred local cache contains a separate `SeasonType=Playoffs` starter split. The old
reconciliation script skipped it unconditionally; that drift is corrected. Re-run result:

- 82/82 games fetched, zero failures;
- 164/164 team-games VALID;
- 1,685/1,685 appearance rows joined;
- official aggregate starts = 820 = 5 × 164;
- 214/214 players match the separate playoff Starter split exactly;
- zero player-level mismatches; maximum discrepancy 0.

Regular season and playoff acceptance remain separate domains.

### 2015-16 / 2016-17 corruption and reconstruction

The NBA `START_POSITION` source is exhaustively invalid for all 2,460 regular-season team-games in
each of those two seasons. Constraint reconstruction remains noncanonical because its central
superset assumption — that every true starter is contained in the corrupted candidate set — has
not been externally established for the full seasons.

Measured forced-true starter slots, conditional on that assumption:

- 2015-16: 6,023 / 12,300 = 48.97%;
- 2016-17: 6,071 / 12,300 = 49.36%.

The max-flow/SCC classifier is implementation-tested against a deterministic brute-force oracle:
3,000 random instances / 25,808 edges / zero disagreements (seed 12345), in addition to hand-built
and source-precedence tests. No reconstructed row is promoted into canonical starter truth.

## Leakage-safe historical feature layer

`featuresAsOf` and `rollingRoleFeaturesAsOf` now:

- filter strictly `< indexDate`;
- support 5/10/20-game windows;
- expose minutes median and sample SD;
- treat starter `null` as unknown, never as bench;
- compute start share only over games with established starter status;
- accept numeric/string player-id representations without changing identity semantics.

Tests include deliberately contaminated target-date/future fixtures that must not alter pre-index
features.

## Product/UI change

Player profiles now show a compact historical NBA record: season, team(s), GP, MPG, PTS, REB, AST,
and starter fields only where established. Historical rows are descriptive product data. They are
not silently added to the current TULIP Evidence estimator.

To protect the single-file distribution, attached player-season history uses a shared positional
schema rather than repeating object keys. The current attached history is about **0.31 MB**. A second
compressed product, `public/history-games.json.gz`, carries **145,430 current-player game rows** in
about **2.12 MB gzip** and is loaded only when requested. The standalone embeds both compressed
payloads and is about **7.64 MB**, leaving roughly **8.36 MB** below the 16,000,000-byte publishing
ceiling.

## TULIP readiness wording

Historical game logs are no longer described as missing. Metadata now separates:

1. data present in the project; and
2. data consumed by the current estimator.

Current state:

- project game rows: available;
- current TULIP estimator consumes historical game rows: no;
- availability with reliable pre-tip timing: unavailable;
- transactions for identification: unavailable;
- lineup/possession data: unavailable;
- current emitted evidence tiers: B and D;
- Tier C is potentially researchable from project game rows after it is wired leakage-safely;
- Tier A still needs reliable pre-tip availability/transaction context;
- TULIP Forecast: unavailable pending chronological experiments and baseline comparisons.

## Verification performed in the takeover environment

Passed locally after the changes:

- `build:history-summary`;
- `build:history-games`;
- `build:data`;
- `build:standalone`;
- historical integrity audit;
- historical SHA verification (30/30);
- v3 data audit;
- preset audit;
- TULIP verifier including metadata reconciliation;
- artifact lossless round-trip (>1.56M comparisons), including byte-for-byte embedded history gzip verification;
- history/leakage tests, including the on-demand 145,430-row game-log product;
- b-matching unit tests;
- deterministic b-matching brute-force oracle;
- starter-source precedence tests;
- 2023-24 regular-season starter reconciliation;
- 2023-24 playoff starter reconciliation.

A fresh Node Playwright regression run could not be executed in the takeover sandbox: the transferred
ZIP did not include `node_modules`, the available `playwright` executable is the Python CLI rather than
`@playwright/test`, and dependency installation is unavailable from this sandbox. The prior Claude
handoff reported 28/28 before transfer, but that is **not** treated as a regression result for these
post-transfer source changes. GitHub CI is extended to rebuild from committed snapshots and run the
full browser suite after dependencies are installed.

## Remaining high-priority work

1. Fetch/accept direct starter history for the other clean-era seasons, validating every team-game.
2. Run full-season ESPN starter coverage for 2015-16/2016-17 before considering reconstruction.
3. Keep reconstruction conditional and provenance-distinct; never use it to overwrite direct data.
4. Continue historical product views beyond the new RS/PO season table and on-demand game logs
   (richer metric-selectable trends, season/team views and cross-player historical querying) without
   folding 145k player-game rows into the main database payload.
5. Acquire reliable pre-tip availability/transaction context before Tier A.
6. Define the historical role-expansion experiment prospectively, build mandatory simple baselines,
   then use chronological holdouts before any TULIP Forecast claim.

## Deterministic build contract added during takeover

The generated product/browser artifacts previously carried two reproducibility hazards: wall-clock
`generatedAt` values and filesystem modification times inside source provenance. A clean checkout can
therefore produce different bytes even when every source payload is identical.

The takeover build now makes reproducibility explicit:

- `BUILD_GENERATED_AT` is the sole external timestamp for `player_history_product.json` and
  `public/data.json`; CI pins it to the source commit timestamp.
- Source-file provenance retains stable row counts, byte sizes and SHA-256 content hashes, but no
  longer serializes filesystem mtimes.
- `BUILD_COMMIT` is explicit in CI rather than inferred from an arbitrary working copy.
- `scripts/verify-build-determinism.mjs` snapshots the current generated files, performs two complete
  history-summary/history-game/data/standalone builds under identical provenance inputs, requires
  byte-identical SHA-256 output, then restores the caller's artifacts.
- The audit workflow runs that determinism gate before browser regression tests.
- The generated-artifact workflow excludes `player_history_product.json` from its `scripts/**`
  trigger, so a generated commit cannot recursively trigger itself. Source commits made by automation
  are still allowed to trigger one rebuild.

Takeover-environment check under fixed `BUILD_GENERATED_AT` / `BUILD_COMMIT`: the compact historical
product, `public/history-games.json.gz`, `public/data.json`, and `public/standalone.html` were
byte-identical across two complete builds.

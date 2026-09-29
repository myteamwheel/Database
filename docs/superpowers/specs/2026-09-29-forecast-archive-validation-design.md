# 2026–27 Forecast Archive and Validation Baseline — Design

**Status:** Proposed design approved in chat on 2026-09-29. This document defines the first implementation subproject. It does not change production projections by itself.

**Parent checklist:** `docs/MODEL_REBUILD_CHECKLIST.md`, primarily item 17, with supporting value for items 2, 3, 4, 10, 15, 16 and 18.

**Baseline release to preserve:** deployed GitHub Pages release `e7182849d62cba46566f3ffafc4c1e620e5ef8ff` from 2026-09-29. The later `d48a7ca` commit only records audit status and does not replace the forecast release.

## Purpose

Freeze what the 2026–27 preseason projection system actually predicted before additional model work changes those predictions.

The archive must make later accuracy claims reproducible. At season end, the project must be able to answer:

- what the model predicted on the publication date;
- which model version, roster context and input snapshots produced it;
- what simple baselines available on that same date predicted;
- how the frozen forecast performed against actual outcomes;
- whether performance differed for rookies, veterans, team changers, long-gap returners, NBA players and G League players;
- whether a later model revision improved on the frozen preseason release rather than merely producing more appealing outputs.

The archive is evidence infrastructure. It is not a new projection model and does not claim that the current projection is more accurate than the previous one.

## Non-goals

This subproject does **not**:

- redesign the projection formulas;
- add college or international rookie inputs;
- add transaction, injury or news ingestion;
- implement rest-of-season or combined in-season forecasts;
- validate TULIP;
- change the public projection UI;
- automatically schedule refreshes;
- publish a forecast leaderboard before actual 2026–27 outcomes exist.

Those remain separate checklist items.

## Source-of-truth release

The first archive is the deployed 2026–27 preseason forecast from commit `e718284`.

The archived forecast must be derived from the exact release artifacts, not from a later rebuild that happens to produce similar numbers. The archive records full SHA-256 hashes for its material sources, including at minimum:

- `public/data.json`;
- `PROJECTION_2026_27.json`;
- `scripts/data/projection/inputs.json`;
- the live roster snapshot used by `build-projections.mjs`, when present.

The archive also records the deployed source commit, publication date, projection model id, context version, roster-as-of date and projection timeframe already exposed through `projectionMeta`.

## Architecture

### 1. Immutable tracked forecast snapshots

Add a repository-only archive under:

`scripts/data/forecast-archive/`

The first snapshot will use a stable id such as:

`2026-27-preseason-2026-09-29-e718284`

and a tracked JSON file such as:

`scripts/data/forecast-archive/2026-27-preseason-2026-09-29-e718284.json`

The file is **not** part of the normal generated public payload and is never overwritten by `npm run build` or `npm run refresh`.

Each archive contains:

- schema version;
- forecast id;
- target league season;
- forecast type (`preseason-full-season` for this release);
- publication timestamp/date;
- source commit;
- source file hashes;
- model id and model/context versions;
- roster-as-of date;
- league coverage counts;
- one frozen record per published player projection;
- same-date naive baseline forecasts where supported.

Player identity uses the existing league plus canonical player id/person id. Names are descriptive only and never serve as the join key.

### 2. Frozen player projection record

For each non-abstaining projection, preserve enough information to score the original forecast without depending on future versions of `public/data.json`.

At minimum:

- league;
- player id and NBA person id where available;
- player name;
- forecast team;
- roster/projection status;
- projection basis;
- age;
- model version;
- forecast timeframe;
- projected GP and MPG;
- projected PTS, REB, OREB, DREB, AST, STL, BLK, TOV;
- projected FGM/FGA, 3PM/3PA, FTM/FTA;
- projected FG%, 3P%, FT% and TS%;
- the current uncertainty/reference bounds exactly as published, clearly labelled as historical reference bounds rather than newly calibrated probabilities;
- enough explanation metadata to identify rookie fallback, older-history fallback, new-team context and the seasons used.

Abstentions are archived too, with their reason and no invented numeric forecast. This allows later coverage reporting rather than scoring only the easy cases.

### 3. Same-date simple baselines

The archive must preserve the simple alternatives that were knowable on the forecast date.

For NBA players with usable history, reproduce the definitions already used by `scripts/fit-projections.mjs`:

**Repeat baseline**
- repeat the most recent available season's per-game line unchanged;
- GP uses that season's appearance share scaled to 82 games.

**Three-year baseline**
- per-game production from the last three seasons;
- recency weights 5/4/3;
- weighted by games played, matching the current backtest implementation;
- GP uses the same 5/4/3 weighted appearance-share definition.

Do not redesign these baselines for the archive. Their value is that they are simple, pre-existing and were defined before 2026–27 results.

For G League, preserve the baseline currently supported by the fitted evaluation code: repeat the most recent comparable line. A new G League three-year baseline should not be introduced in this subproject merely for symmetry.

Rookies and other players for whom a baseline is undefined must be marked unavailable rather than assigned zero.

### 4. Archive manifest

Maintain a small manifest at:

`scripts/data/forecast-archive/index.json`

Each entry records:

- forecast id;
- season;
- type;
- publication date;
- source commit;
- relative file path;
- file SHA-256;
- counts by league;
- projected, abstained and baseline-available counts.

The manifest is an index, not a source of forecast values.

### 5. Append-only verification

The project should treat archived forecasts as append-only evidence.

Verification must ensure:

- every archive id is unique;
- every manifest entry resolves to exactly one file;
- stored file hash matches the file bytes;
- archive schema is valid;
- player identity keys are unique within league;
- numeric projections are finite where required;
- abstentions contain no scoreable prediction;
- makes never exceed attempts;
- rebounds and shooting accounting remain internally valid;
- the initial `e718284` snapshot exactly matches the corresponding deployed forecast values;
- normal build/refresh commands do not rewrite prior archive files.

A CI guard should reject modification or deletion of an existing archive snapshot except through an explicit maintenance escape hatch documented for genuine corruption recovery. Git history remains the ultimate audit trail; the archive itself should also be tamper-evident through the manifest hash.

### 6. Scoring interface

Add a scorer that consumes:

1. one frozen forecast archive; and
2. an explicit actual-results dataset for the same target season.

The scorer never silently reads whatever the website currently considers “current.” The target season and actual-data source must be explicit.

Initial scoring metrics:

- MAE;
- RMSE;
- signed bias;
- sample count;
- coverage count and abstention count.

Score the model and every available archived baseline on the same eligible player set for each metric.

Core per-game metrics should mirror the projection model evaluation where meaningful:

- GP;
- MPG;
- PTS;
- REB;
- AST;
- STL;
- BLK;
- TOV;
- 3PM;
- FG%, 3P%, FT% with minimum-attempt eligibility rules stated explicitly.

The scoring report must distinguish forecast error from coverage. A method must not appear better merely because it abstained on difficult players.

### 7. Cohort reporting

Cohorts are defined only from information frozen in the archive or from objective identity/status fields, never from hindsight.

Required NBA cohort cuts:

- rookies;
- non-rookie recent-history veterans;
- older-history/long-gap fallbacks;
- same-team players;
- new-team players;
- unsigned-at-forecast players if later outcomes are available;
- age 23 and under;
- age 33 and over;
- prior high-minute and lower-minute groups using archived prior-season evidence where available.

G League results are reported separately rather than pooled into NBA accuracy.

Cohort reports include sample sizes. Small cohorts must not be presented as decisive evidence.

### 8. Final versus interim scoring

The first implementation targets **final full-season scoring**.

If the scorer is run before the target season is complete, it must either:

- refuse final scoring; or
- require an explicit `--interim` mode that labels every result as incomplete and records the actual-data cutoff date.

Interim results may not replace the original forecast snapshot or be described as final model accuracy.

Full in-season forecast semantics remain checklist item 16 and are outside this subproject.

## Interfaces and expected files

The implementation plan may adjust names to fit existing patterns, but the intended responsibility boundaries are:

- `scripts/lib/forecast-archive.mjs` — pure schema, extraction, baseline and scoring helpers;
- `scripts/archive-forecast.mjs` — create one explicit immutable snapshot from specified release artifacts;
- `scripts/verify-forecast-archive.mjs` — archive/manifest integrity and append-only checks;
- `scripts/score-forecast-archive.mjs` — score a frozen archive against explicit actual results;
- `tests/forecast-archive.test.mjs` — deterministic extraction, baseline, accounting, coverage, scoring and failure tests;
- `scripts/data/forecast-archive/index.json` — archive manifest;
- `scripts/data/forecast-archive/2026-27-preseason-2026-09-29-e718284.json` — first frozen snapshot.

The existing `package.json` should gain focused archive commands and the main verification pipeline should include archive integrity tests once implemented.

## Release-capture rule

The first archive must preserve the production forecast represented by release `e718284`, not a future improved forecast.

If implementation occurs after source/model changes, the script must fetch/read the release artifacts at `e718284` or otherwise verify byte identity with those artifacts before writing the initial snapshot.

A later improved preseason forecast may be archived as a **new forecast id**. It never replaces the original one.

## Accuracy claims

No claim such as “the new model is more accurate” is allowed merely because:

- projections changed more;
- projections look more realistic;
- the model has more inputs;
- historical descriptive fit improved;
- one cohort looks better;
- the model beat a baseline on one statistic.

An accuracy claim requires the frozen forecast, explicit outcomes, the same eligible sample for model/baseline comparisons, reported sample counts and reproducible scoring.

For 2026–27, the original preseason archive is the anchor against which later revisions can be compared.

## Failure handling

Archive creation must fail closed when:

- the requested source commit/artifact cannot be verified;
- source hashes do not match the expected release;
- duplicate player identity keys exist;
- projection accounting is invalid;
- the forecast id already exists;
- an existing snapshot would be overwritten;
- the target season/timeframe is ambiguous.

Scoring must fail closed when:

- archive season and actual season differ;
- the actual dataset lacks an explicit cutoff/finality state;
- identity joins are ambiguous;
- a requested metric has no eligible observations.

Unavailable baselines or outcomes are reported as unavailable, never converted to zero.

## Testing requirements

Tests should cover at least:

1. deterministic extraction from a fixed projection fixture;
2. exact repeat-baseline calculation;
3. exact NBA 5/4/3 game-weighted three-year baseline calculation;
4. rookie/no-history baseline unavailability;
5. duplicate player identity rejection;
6. invalid makes/attempts and rebound accounting rejection;
7. abstention preservation;
8. archive id overwrite rejection;
9. manifest hash mismatch rejection;
10. model-versus-baseline scoring on the same eligible sample;
11. cohort derivation without outcome leakage;
12. final-season mismatch and premature-final scoring rejection;
13. deterministic report output;
14. exact initial snapshot match against release `e718284`.

## Acceptance criteria

This subproject is complete only when:

- the `e718284` 2026–27 preseason forecast is frozen in a tracked immutable snapshot;
- source/model/roster provenance is sufficient to reproduce what was published;
- NBA repeat and three-year baselines are frozen using the pre-existing definitions;
- supported G League baseline(s) are frozen without inventing unsupported symmetry;
- archive verification is part of automated tests/CI;
- scoring code can reproduce known synthetic examples and is ready for explicit 2026–27 actual data;
- coverage and abstentions are reported separately from error;
- cohort scoring definitions are frozen before 2026–27 outcomes are used;
- no production projection values or UI behavior are changed by this subproject;
- `docs/MODEL_REBUILD_CHECKLIST.md` item 17 can truthfully move from NOT STARTED to implemented/verified or an explicitly narrower partial state.

## Relationship to later work

Once this archive exists, projection improvements can proceed without erasing the baseline.

Every materially revised published forecast should receive a new immutable archive id. At the end of 2026–27, the project can score the original preseason release and later revisions against the same outcomes and baselines.

That evidence then informs, rather than prejudges, later work on projection context, rookies, veteran returners, stability and in-season forecasting.

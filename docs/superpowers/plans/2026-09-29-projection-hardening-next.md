# Projection hardening and forecast-semantics plan

**Base:** `forecast-archive-validation` / PR #14
**Branch:** `projection-model-rebuild-next`
**Scope:** checklist items 2, 3, 4, 10, 13, 16 and 18. This batch hardens semantics and diagnostics around the existing projection model without changing fitted coefficients merely to make outputs look different.

## Constraints

- Preserve the frozen `e718284` archive from PR #14.
- Any materially changed future forecast must become a new archive snapshot; never mutate the original.
- Do not claim context-1, rookie, or returner accuracy without leakage-safe evidence.
- Keep NBA and G League semantics explicit where they differ.
- Missing injury, contract, college/international or current-season evidence remains unavailable rather than inferred.
- All new production helpers are test-first.
- Public point estimates may change only when a tested model/input rule intentionally changes them; documentation-only diagnostics must not silently change them.

## Task 1 — Explicit forecast timeframe arithmetic

Create `scripts/lib/forecast-timeframes.mjs` and `tests/forecast-timeframes.test.mjs`.

Implement a pure helper that combines season-to-date actual totals with a remaining-season per-game forecast. It must:
- require explicit season, as-of date, scheduled games and actual games played;
- preserve actual totals exactly;
- calculate remaining games explicitly;
- output actual-to-date, remaining-season, and combined full-season views;
- calculate combined rates from totals, never average percentages;
- handle zero attempts and zero remaining games without inventing values;
- reject actual games > scheduled games or negative totals;
- clearly mark the output as interim or final.

This helper is infrastructure only while 2026–27 has not begun; `build-projections.mjs` remains `preseason-full-season`.

## Task 2 — Central projection accounting validator

Create `scripts/lib/projection-validation.mjs`.

Validate projected per-game and total accounting for both NBA and G League:
- makes <= attempts;
- 3PM <= FGM and 3PA <= FGA;
- REB = OREB + DREB;
- points identity respects each league's free-throw point value;
- FG%, 3P%, FT% and TS% derive from the underlying attempts/makes;
- totals equal per-game values × projected games within deterministic rounding tolerance;
- projected games/minutes stay within league bounds.

Use this validator from tests and archive verification where appropriate so accounting rules are not duplicated.

## Task 3 — Returner support metadata

Extend older-history fallback evidence with:
- last observed season;
- blank-season gap count;
- weighted historical exposure;
- reliability;
- support classification (`low`, `very-low`, or `unavailable`);
- explicit note that return-to-play/injury clearance is not predicted.

Do not change the fallback formula in this task.

## Task 4 — Rookie input coverage contract

Every rookie fallback gets a machine-readable coverage block for:
- draft slot;
- position;
- entry age;
- historical cohort;
- pre-NBA production;
- contract security;
- current injury clearance.

Unavailable inputs remain false/unavailable. Add aggregate rookie coverage to `projectionMeta` and keep the fallback explicitly provisional.

## Task 5 — Minute-reconciliation sensitivity suite

Strengthen `reconcileMinutes` tests with controlled perturbations:
- role demand +1 MPG moves the targeted player's effective minutes in the same direction;
- availability/share reduction lowers that player's effective minutes and reallocates the released budget;
- players with more historical minutes are less mobile under identical pressure than low-sample players;
- small perturbations do not create discontinuous multi-MPG jumps in unrelated players;
- all scenarios preserve the team budget and feasible bounds.

These are stability tests, not accuracy claims.

## Task 6 — Held-out context reconciliation check

Extend the historical projection evaluation to measure the current minute-reconciliation layer on the same held-out 2025–26 opening-roster setup already used by the legacy model.

Report separately:
- legacy model metrics;
- context-reconciled metrics;
- sample size;
- team budget coverage;
- change in MAE for MPG/PTS/REB/AST;
- explicit statement that this validates the reconciliation layer only for veteran/history-eligible players and does not validate rookies/returners.

Do not refit coefficients based on the held-out result.

## Task 7 — Verification and checklist update

Run focused projection/timeframe/accounting tests plus the full project verification. Update the master checklist truthfully:
- mark items complete only where the entire acceptance standard is satisfied;
- otherwise record the new verified capability and remaining data-limited gap.

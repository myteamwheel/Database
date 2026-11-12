# Season and forecast corrections

- [x] Verify the September 29, 2026 preseason archive against its manifest and source metadata.
- [x] Replace the 2025–26 retrospective prediction tab with saved 2026–27 forecasts versus current actuals.
- [x] Remove reconstructed prediction rows from the public payload.
- [x] Add metric error sorting and a disclosed average scaled error across nine per-appearance metrics.
- [x] Use one table and seven shared core ledgers for 2025–26 and 2026–27, with season-specific inputs and grades.
- [x] Keep G League current competition phases separate and disclose the older combined-season scope.
- [x] Fix season-specific exports and player dialogs; remove duplicate current-results top navigation.
- [x] Keep unplayed results and unsupported forecasts missing, rather than assigning zero or borrowing last season.
- [x] Complete release checks and verify publication: Pages run 43144047521 succeeded with 128 browser checks; four additional browser checks passed against the public site. Published artifact: 2025-26-20261111214644-f68f63c863ec.
- [x] Repair browser verification infrastructure: use the pinned Playwright image, preserve Bash and scoped Git workspace trust, and dispatch Pages through Node rather than a missing GitHub CLI.
- [ ] Publish a successful fresh source ingestion. Run 43144190226 reached the official NBA sources but rejected game-log rows from games still in progress. The live UI is current, but NBA and G League statistics remain at the November 5 validated snapshot. Morning refreshes remain scheduled; a successful unattended run has not yet been observed.

- [ ] Expose the remaining specialist historical tracking/custom ledgers for the current season. These need corresponding current-season source ingestion and coverage. Historical specialist tables remain available under “2025–26 detailed tables.”

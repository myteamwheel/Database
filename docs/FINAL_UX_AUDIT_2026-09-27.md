# Final usability and data audit — September 27, 2026

Scope: the current GitHub Pages database, its source, generated player data, historical products, and desktop/mobile interactions. This is a tested release checklist, not a guarantee that every possible browser interaction or basketball interpretation is flawless.

## 20 improvements in this pass

1. **Player page:** collapsed component breakdowns, full statistical profiles, situational splits, monthly splits, team history, historical records and on-demand game logs. The overview remains visible.
2. **Player Comps detail:** full side-by-side tables are collapsed, keeping the player, style blueprint and comparison cards prominent.
3. **Player picker:** added proper combobox state, arrow-key navigation, scrolling to the active option, Enter selection, Escape dismissal and focus-out cleanup. Partial text no longer silently selects an arbitrary prefix match.
4. **Comparison identities:** excluded unresolved numeric IDs from the reference-player pool and added a regression check for readable names.
5. **Comparison position labels:** recognized PF/SF and hybrid positions instead of describing forwards as generic players.
6. **Style descriptions:** stopped inferring positive qualities from matching axis names. Floor spacing, efficient scoring, lead playmaking and shot blocking now require supporting values in both profiles. Removed unsupported ball-pressure/on-ball-creation language and redundant supporting-reference sentences. Historical years and percentages stay out of the short summary.
7. **Blueprint hierarchy:** ordered trait cards to match the explanation and labeled their contributions instead of showing generic reference numbers.
8. **History Lab results:** paginated player summaries in groups of 50, with accurate totals and navigation. Filtering and exports continue to use the complete matching dataset.
9. **History Lab controls:** kept player, season and phase visible; moved advanced filters/sorting into a disclosure.
10. **Team Fit:** shows 10 initial recommendations, with additional results and roster strengths collapsed; marks existing roster members and avoids repetitive empty explanations.
11. **Role Value:** collapsed decomposition, comparables, limits and expansion lists; added an accessible table for the plotted frontier while keeping its headline evidence visible.
12. **Stat guide:** starts with a small set of collapsed essential definitions; search still covers all documented metrics.
13. **Dialogs:** added sticky headers and accessible close buttons to long stat-guide and team-allocation dialogs.
14. **Navigation/accessibility:** exposed wrapped navigation on narrow screens, labeled controls and comparison checkboxes, and distinguished sortable from static table headers.
15. **Compare empty state:** added an explicit path back to Player Stats to choose players.
16. **Projection context:** corrected the league-specific explanation rather than presenting NBA wording on G League projections.
17. **Formula descriptions:** synchronized scoring, defense and efficiency explanations with the actual ingredients; corrected the turnover-percentage ingredient identifier and defensive-swing description.
18. **Provenance:** corrected source-row counting, including the combine dataset, and removed a stale coverage claim from the README.
19. **Packaging/cache:** versioned browser assets, updated deployment asset checks to accept query strings, and repaired standalone title/script packaging and hosted navigation.
20. **Historical validation:** added strict raw-cache verification to the rebuild workflow so missing raw files cannot silently pass a full-history verification claim. Local partial checks explicitly warn about missing coverage.

## Checked behavior

| Area | Reviewed and exercised |
| --- | --- |
| Player Stats | Both leagues; all presets; search and accent folding; sort direction; filters; per-36 mode; season vs current-roster team scope; formula lab; roster-only states |
| Projections | NBA and G League views; comparison with actuals; correct export season; missing-history explanations; plausible statistical identities and deterministic rebuild |
| Player | Grades and components; collapse/expand controls; historical phase separation; on-demand game log; unknown starter status remains unknown |
| Compare | Selection from the database; appropriate actual/projected fields; descriptive historical trajectories; empty-state guidance |
| Scatter | Axes and filters; correlation/sample reporting; missing coordinates excluded; accessible data and color legend |
| Player Comps | 1–3 distinct non-self references in the same league; weights total 100%; named references; finite fit values; trait evidence; scrollable/keyboard picker; compact blueprint and expandable tables |
| Team Fit | Bounded fit values; separate from player quality; existing roster labels; expandable recommendations |
| Role Value | Explicit abstentions; supported target roles; separate player/team reads; residual-bias disclosures; accessible frontier data |
| TULIP Team | Current-roster scope; gain/loss/no-change filters; sorting; zero-sum team ledger; explanations do not confuse constraints with causes |
| History Lab | Player and raw-row pagination; player/season/phase/opponent/minutes/starter filters; summary reconciliation; no unnecessary current-data download |
| Stat guide and tooltips | Searchable definitions; click-to-open formulas; keyboard sorting; accessible labels; dismissible panels on mobile |
| Layout and packaging | Mobile/tablet/desktop overflow tests; standalone payload round-trip; versioned hosted assets |

The automated browser suite covers these paths; manual browser inspection supplements it but does not amount to a visual review of every player and every possible filter combination.

## Validation

- Data audit and preset audit: no failures. The data audit retains the source-gap warnings listed below.
- Player-comparison tests: all 1,143 appeared-player profiles checked; 25 one/two-player blends; 273 distinct weight patterns.
- Projection tests: 18 checks, including statistical identities and rebuild reproducibility.
- TULIP Beta: 22 engineering/ledger checks. Projected Role MPG: 16 integration checks. These are engineering checks, **not proof of predictive or causal validity**.
- Historical products: 3,635 season/phase records and 145,430 browser game rows; unknown starter information is not guessed.
- Starter solver: 3,000 synthetic cases checked against brute force, with zero disagreements across 25,808 edges.
- Standalone: 1,728,520 decoded-value comparisons against the canonical payload; no field loss.
- Browser regression and publishing results are recorded in the GitHub Actions deployment for this release. A successful deployment is gated on the full browser suite.

## Remaining limitations and optional follow-ups

1. **Incomplete source data:** 7 NBA and 3 G League multi-team players have no per-team stint breakdown. Some measurements and tracking fields are absent. Keep these missing, not fabricated or coerced to zero.
2. **Non-playing players:** 123 NBA and 3 G League roster-only entries have no played-season statistics. They are intentionally ungraded, not broken rows. Missing-history projections explicitly abstain.
3. **Historical coverage:** History Lab covers available NBA history for current-database players, not every historical NBA player or G League game. Some starter statuses remain unknown. Full raw-cache checks require cache hydration; the published compact products are independently tested.
4. **Comparisons are analogies:** a high statistical fit is not scouting confirmation or career upside. Tiny samples remain provisional. Shooting and box-score activity cannot establish athleticism, movement, defensive positioning or overall defensive skill. New phrase thresholds are transparent heuristics, not externally calibrated scouting labels.
5. **Model uncertainty:** Role Value retains selection imbalance, TULIP is experimental, and projections/readiness are estimates. Team-fit scores do not mean a transaction is feasible or a player is better. The warnings remain visible.
6. **Further UX polish:** universal searchable pickers outside Player Comps and richer direct editing of Compare selections remain possible improvements; existing controls function but are less convenient for very large player lists.
7. **Validation boundary:** broad Chromium checks and sampled live visual checks do not certify every Safari/Firefox/iOS combination, every assistive technology, or all individual player narratives. No claim of zero undiscovered bugs is made.

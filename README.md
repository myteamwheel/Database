# 2025-26 NBA + G League Performance Database

Ranked, filterable database of every player who appeared in the 2025-26 NBA or NBA G League
regular season, with a 0.0000-9.9999 per-game performance grade calculated separately inside
each league.

Run it:

```bash
npm run build && python3 -m http.server 3600
```

Then open <http://localhost:3600>. `npm run audit` validates the generated data, and
`npm run refresh` re-pulls every source and rebuilds from scratch.

`npm run build` also emits `public/standalone.html` — a single self-contained file carrying the
**complete** current-season database plus the compressed historical game-log product. The main
payload is losslessly columnar-encoded and then gzip-compressed before base64 embedding; historical
game logs use a separate gzip payload decoded only when a player asks for them. The current build is
about **7.64 MB** against a 16 MB publishing ceiling, leaving roughly 8.36 MB of headroom without
dropping fields.

---

## What v3 changed

v2 was built entirely from Basketball-Reference, on the finding that `stats.nba.com` does not
respond from GitHub-hosted runners. That finding is correct, but it is specific to CI: the
official API answers normally from a local machine. v3 therefore uses the official source as
the backbone and keeps Basketball-Reference as a second opinion. Everything below was measured
against the v2 build, not estimated.

| | v2 | v3 |
|---|---|---|
| G League stat fields per player | 79 | **277** |
| NBA stat fields per player | 228 | **540** |
| G League age | 38% missing | **100% populated** |
| G League listed position | 68% statistically inferred | **100% real** (457 official, 104 Basketball-Reference) |
| G League impact tier | BPM/VORP family 100% null | **PIE, Off/Def/Net Rating, DEF WS** |
| G League team-page enrichment | 0 of 32 teams (rate-limited) | not needed — official bulk endpoints |
| Crossover identity | Basketball-Reference id with trailing `d` removed | **exact NBA person id**, 180 → 199 |
| Top G League player's sample | **2 games** | 40 games |

### The grade defect v2 shipped with

v2 graded raw per-game rates with no shrinkage and displayed sample size separately. The
consequence was that its number one and number two ranked G League players had played **two and
three games**. v3 keeps per-game production as exactly the thing being measured, but shrinks each
player's composite toward the minutes-weighted league mean in proportion to minutes played:

```
graded = (minutes × own_score + K × league_mean) / (minutes + K)
```

`K` is **80%** of the league's median minutes (NBA 756, G League 521), chosen from the sensitivity
sweep in `scripts/k-sensitivity.mjs` rather than by preference: at 0.6 the G League top 25 still
admitted a 13-game line, while 0.8 removes every sub-16-game line at a rank correlation of 0.9995.
`reliabilityWeight` is the
weight a player's own line received — `minutes / (minutes + K)` — so the displayed number and the
grade are the same statement. It is **not** a statistical confidence level and it does not reach
100: the observed maximum is about 84. The lowest games played anywhere in the G League top 25 is
now 16, and 36 in the NBA top 25.

### The season-definition problem v2 did not notice

`stats.nba.com` splits the G League year into two season types: `Showcase` (the Tip-Off
Tournament, 464 players / 4,249 player-games) and `Regular Season` (526 / 10,550). Neither half
alone is a player's season. Basketball-Reference's G League table is Regular Season for almost
everyone, but silently folds in the 35 players who *only* appeared in the Showcase Cup — so it is
neither one thing nor the other, which is why its 562 rows never reconciled against any single
official universe.

v3 combines both halves into one full-season line, and says so. Counting stats are summed
exactly and every percentage is recomputed from the summed totals. Possession-rate statistics
that cannot be re-derived without team context are blended on the denominator that produced them
(minutes, points, field-goal attempts, or field goals made) rather than naively averaged. Each
player carries `regularGP` and `showcaseGP`, and the **Season Splits** view exposes both halves
so the combination is inspectable rather than asserted.

Combining is also simply a better sample: median G League games played goes from 20 to 29.

---

## Sources

| Source | Used for |
|---|---|
| `stats.nba.com` LeagueID 00 | NBA backbone: box score, advanced, misc, scoring, usage, defense, bios, player index, hustle, and 8 player-tracking endpoints |
| `stats.nba.com` LeagueID 20 | G League backbone: same dashboards for both season types, plus catch-&-shoot and pull-up tracking |
| `stats.nba.com` `commonplayerinfo` | 39 players absent from the bulk bio dashboards |
| Basketball-Reference 2025-26 | Second opinion, and the only source of PER, win shares and the BPM/VORP family (NBA only) |

Raw payloads are committed under `scripts/data/` so the build is reproducible without re-fetching.
`npm run fetch` re-pulls them; note it must run locally, not in CI.

### Coverage that does not exist, and is not invented

- **The G League publishes no BPM, OBPM, DBPM or VORP anywhere.** Those fields stay null for all
  561 G League players. The audit fails the build if any G League row ever acquires one. The
  impact concepts are bridged instead from PIE, net rating and defensive win shares, which the
  G League does publish.
- **The G League has no hustle or full player-tracking data.** Only catch-&-shoot and pull-up
  come back populated; drives, passing, touches, rebounding-chance and defensive-rim tracking
  return zero rows. The Tracking view is therefore NBA-only and is hidden on the G League panel
  rather than shown empty.
- **Four Factors returns zero rows for both leagues** in 2025-26 and is not included.
- Height is missing for 5 players and weight for 18 — blank at the source, confirmed by
  individual `commonplayerinfo` lookups. Neither field enters any calculation.

### Two fields that are easy to misread

- `toRatio` is NBA.com's `TM_TOV_PCT` — turnovers per 100 possessions used. It is **not**
  Basketball-Reference's `TOV%` (turnovers per possession ended). Both are carried, under
  separate names, rather than merged under one label.
- `age` is NBA.com's listed age. `seasonAge` is Basketball-Reference's convention (age on
  1 February of the season), which runs a year lower for anyone with a February-to-August
  birthday. 246 of 580 NBA players differ between the two.

---

## Identity and league separation

- NBA and G League are separate panels and separate ranking universes.
- A player who appeared in both has two independent records and two independent grades, each
  built only from what he did in that league. Nothing is blended across leagues.
- Crossovers are matched on the **official NBA person id**, which both league dashboards share —
  an exact join. v2 inferred them from a Basketball-Reference id naming convention and found 180;
  the exact join finds **199**.
- Player detail shows the same person's other-league line side by side, with a note that the two
  grades are not on a shared scale.
- Multi-team players are one full-season aggregate record, but each carries a `teams` array of
  real per-team stint lines, and team filters match **any** team a player appeared for. Querying
  `stats.nba.com` by `TeamID` returns the player's *current* team abbreviation rather than the team
  the row describes, so both of James Harden's stints initially came back labelled CLE; the queried
  id is stamped and mapped instead. Stint games reconcile to season totals for all 72 NBA and 97
  G League multi-team players.

---

## The 0.0000-9.9999 grade

Six components, each an average of within-league percentiles, combined with fixed weights:

**The headline grade is PER GAME**, matching the original brief. Volume ingredients are per-game;
rate ingredients (TS%, usage, rebound and assist percentages) are basis-independent. A per-36
version of the identical model ships alongside as **`rateGrade`** — it answers a different
question, since 12 points in 16 minutes is 27 per 36 and outranks 19 points in 32 minutes there
but not in the headline grade.

| Component | Weight | Built from |
|---|---|---|
| Scoring | 30% | points per game, TS%, usage, FT and 3PT attempts per game, self-created scoring |
| Playmaking | 18% | assists per game, AST%, AST/TO, turnover suppression, creation load |
| Rebounding | 14% | total/offensive/defensive rebounds per game and their rates |
| Defense | 16% | steals and blocks per game, defensive rebound rate, defensive rating, **DEF WS per game**, defensive disruption, **defensive swing** |
| Efficiency | 12% | TS%, eFG%, efficiency over expected, AST/TO, turnover-ratio suppression |
| Impact | 10% | PIE, net rating, impact over expected, plus/minus per game |

Each ingredient appears **once**; the full list ships in the data as `componentIngredients`.

The weighted composite is shrunk by minutes, then mapped onto 0.0000-9.9999 against **fixed
anchors (composite 30 to 80) — not a percentile rank and not the observed extremes**. Both
distinctions matter. Percentile-ranking at the end made every adjacent gap identical (514 of 581
NBA gaps were exactly 0.0172), so the grade communicated only order. Anchoring to the observed
min and max meant one freak line rescaled everyone and a grade could not be compared between
rebuilds. With fixed anchors a 0.4 difference means the same thing everywhere on the scale and
in every build.

**The documented methodology is generated from the code constants**, not written by hand, and
`npm run audit` fails if the two ever disagree — a previous version told readers K was 60% while
the model used 80%, and described per-36 ingredients for a per-game grade.

Three things are deliberately kept out of the grade:

- **Minutes per game.** Minutes already govern the shrinkage; also rewarding MPG as performance
  would separate two identical per-possession players by how big a role they were given.
- **Offensive events inside the Defense component.** Possession Swing counts offensive rebounds
  and the player's own turnovers, so Defense uses a defence-only variant instead.
- **PIE inside Two-Way Index.** NBA.com's PIE already contains defensive rebounds, steals and
  blocks; including it beside an explicit defensive half counted defence twice.

**A caveat worth stating plainly:** offensive, defensive and net rating and plus/minus are *team*
results while a player is on court, per NBA.com's own definitions — not isolated individual value.
They inform the Impact component (10%) and Two-Way Index. Nothing here is a plus/minus model like
RAPM, and no such data exists for the G League.

The grade also excludes contract status, draft position, awards, age and reputation.

---

---

## Three grades, three questions

| Grade | Question it answers | How |
|---|---|---|
| **`grade`** | How did he perform per game, relative to his league's 2025-26 population? | Weighted percentiles of primitive statistics, shrunk by minutes, fixed anchors |
| **`rateGrade`** | How productive was he while actually on the floor? | Identical model with counting production per 36 |
| **`magnitudeGrade`** | How far from normal was the production itself? | Winsorized **robust z-scores** (median, 1.4826×MAD), so distance survives instead of collapsing to rank order |

`grade` is standing. `magnitudeGrade` is distance. They correlate at ρ≈0.96 but disagree exactly
where you would want them to — when a player is far clear of the field rather than merely first.

**`magnitudeGrade` is a 2025-26 magnitude, not a historically absolute rating.** The anchors are
fixed, but the median and MAD come from this season's population; identical raw numbers in a
different season would land differently. Calling it historically absolute would require
multi-season reference distributions, which do not exist here yet.

### No statistic appears twice

The previous model fed derived composites into components that already contained their own
inputs: `defensiveDisruptionIndex` sat beside STL, BLK, DREB%, DefRtg and DEF WS while being built
from exactly those; Efficiency Over Expected is a TS%-versus-usage residual placed beside TS% and
usage; Impact Over Expected is a PIE residual beside PIE. The declared component weights therefore
were not the real weights.

Every grade ingredient is now a primitive or near-primitive statistic, **23 of them, each
appearing exactly once across the whole model**. The derived composites remain as descriptive
metrics but never as ingredients. `npm run diagnostics` prints the check.

### Ingredient weights, because averaging lied

Averaging a component's ingredients equally sounds neutral and is not. With five equally weighted
Scoring ingredients, actual points was **6.8% of a 30% component** — four volume and role proxies
diluted the thing the component is named after. Each ingredient now carries an explicit share, and
the build publishes the resolved **effective concept weights**:

| Concept | Share of grade |
|---|---|
| Scoring volume | 17.6% |
| Playmaking | 17.3% |
| Defensive rebounding | 8.4% |
| Shooting efficiency | 7.7% |
| Ball security | 6.6% |
| Offensive rebounding | 6.5% |
| Team on-court context | 5.5% |
| Perimeter defence / rim protection | 4.8% each |

The full dependency tree — which statistic is in which component, its share, and the underlying
concepts it draws on, including PIE's declared box-score dependencies — ships in the data as
`gradeModel.dependencyTree` and `gradeModel.effectiveConceptWeights`.

### Coverage instead of silent reformulation

A missing statistic used to change the formula from player to player without saying so. Each
component now declares a minimum ingredient count; a component below it is **dropped and its
weight redistributed**, never quietly averaged over a shorter list. Every player carries
`gradeCoverage`, per-component detail (`defense 4/4`) and `componentsBelowMinimum`. Current build:
median coverage 99.8%, and **zero players fall below any component minimum**.

## Testing

`npm run verify` runs four gates and fails on any of them:

1. `audit` — coverage, identity, grade sanity, stint reconciliation, positional-bias regression,
   documentation-versus-code consistency
2. `audit:presets` — every field declared by every UI preset resolves to real data
3. `verify:artifact` — the published page decoded with the browser's own decoder and
   deep-compared against `data.json` (1.19M value comparisons)
4. `test:browser` — **Playwright**, 16 specs driving the real page: both leagues, every preset
   with populated cells, sorting both directions, accented and accentless search, all filters,
   numeric filters in displayed units, team-only scope-before-filter and blanked season fields,
   scoped detail view, roster-only profile, Formula Lab positive/negative weights and tie
   handling, the mixed-scope guard, hybrid G-F filtering, league switching with active filters,
   reset, three viewport widths, and zero console errors

`npm run diagnostics [previousBuild.json]` prints effective weights, the reuse check, coverage,
the three grades against each other, positional and age bias, minutes correlation, the component
correlation matrix with a redundancy flag, and — against a previous build — Spearman correlation,
top-25 churn and the largest risers and fallers with the component driving each.

## Original metrics

Project-defined composites — not official NBA, G League or Basketball-Reference statistics. All
fifteen are computed from fields that exist in **both** leagues, so the two panels are calculated
identically even though they are ranked separately.

**Carrying real units, readable directly:**

- **Self-Created Points /36** — unassisted twos, unassisted threes and free throws. Separates
  creators from finishers.
- **Chaos Points /36** — fast-break + off-turnover + second-chance points. Scoring produced
  outside settled half-court offence.
- **Possession Swing /36** — steals + offensive rebounds + 0.6×blocks − turnovers − 0.4×own shots
  blocked. Net possessions won.
- **Whistle Differential /36** — fouls drawn minus fouls committed.
- **Disruption per Foul** — (steals + blocks) per personal foul. Rewards defenders who create
  events without fouling.
- **Creation Load /36** — assists + unassisted field goals made. Scoring possessions finished
  through a player's own creation, for himself or a team-mate.
- **Paint Points /36**.
- **Efficiency Over Expected** — TS% minus the TS% the league averages at that usage rate, in TS
  points. The usage-to-efficiency curve is fitted within each league, weighted by minutes so
  garbage-time lines cannot drag the baseline. Positive means beating the efficiency normally
  surrendered when taking on a bigger role.

**0-100 indices:**

- **Shot Diet Index** — share of scoring from the paint, the arc and the line, against long twos.
- **Versatility Index** — *geometric* mean of scoring, rebounding, playmaking, stocks and TS%
  percentiles. Geometric so one elite category cannot mask a missing one.
- **Two-Way Index** — equal blend of offensive and defensive percentile groups.
- **Self-Sufficiency Index** — unassisted-FG share blended with usage.
- **Defensive Disruption Index** — stocks, defensive rebound rate, defensive rating, DEF WS.
- **Role-Adjusted Impact** — PIE per point of usage. Surfaces efficient low-usage contributors.

---

## Interface

Separate NBA and G League panels; every visible column sortable; search across name, team,
position, country and college; filters for team, position, country, minimum games, minimum MPG,
minimum total minutes and minimum grade; a verified-crossover filter and a sample-confidence
filter; arbitrary numeric filter rules over any of the 600+ source and calculated fields;
thirteen column views (Overall, Scoring, Shooting, Playmaking, Rebounding, Defense, Impact &
Ratings, Shot Profile, Custom Metrics, Grade Components, Bio & Draft, Season Splits, Tracking &
Hustle, All Raw Stats — the last two shown only on the panel that has the data); a **Formula Lab**
for weighted percentile composites of up to four metrics, with negative weights to invert;
side-by-side comparison of up to five players; a player detail view grouped by source; and CSV
export of the current filtered and sorted view.

---

## Situational splits

The league dashboard query has always carried `Location`, `Outcome`, `StarterBench` and
`SeasonSegment` parameters — they were simply left blank, so the database only ever held one
season aggregate. Nine splits are now ingested per player, per league, and for the G League they
are summed across both halves of the season so they match the headline line:

home · road · in wins · in losses · as starter · off the bench · pre All-Star · post All-Star ·
clutch (last 5 minutes, within 5 points) · and month by month

That is **210 additional fields per NBA player** and 196 per G League player, on 100% of players,
exposed through the *Splits: scoring*, *Splits: efficiency* and *Splits: by month* views and
available to the Formula Lab and numeric filters like anything else.

Two honest notes on coverage. Month is **season-relative** on this API, not calendar — month 1 is
the season's opening month; the NBA serves seven and the G League five. Showcase Cup
pre/post-All-Star splits are legitimately empty because the Cup finishes before the break. Every
split reconciles: home + road games, wins + losses games, and the sum of all months each equal
season games played, for all 582 NBA and 561 G League players.

Historical **game logs are now ingested separately** for 2015-16 through 2024-25. A compact
player-season history is attached to current player records, and a **145,430-row current-player game
log product** is shipped as `public/history-games.json.gz` and loaded on demand in the Player
workspace. These rows remain deliberately separate from the 2025-26 season-aggregate table and from
TULIP Evidence. Still not covered in the product layer: arbitrary cross-player opponent/date-range
querying, on/off, shot-zone and possession/lineup data.

For the post-handoff state, validation results and known limits, see `docs/TAKEOVER_AUDIT_2026-08-17.md`.

## Historical player record

The repository carries **10 NBA seasons (2015-16 through 2024-25)** of regular-season and playoff
player-game logs. `scripts/build-history-summary.mjs` converts the local immutable cache into a
full local player-season summary plus a compact tracked product artifact for players in the current
NBA/G League database. Players are joined by official NBA person id, never by display name. The
Player workspace shows prior NBA regular-season and playoff phases separately, with teams, games, minutes,
scoring/rebounding/playmaking, true shooting, and starter information where the canonical starter artifact has actually established it.

Starter history is provenance-aware: an unknown starter status stays unknown and is never rendered
as a bench appearance. At takeover, canonical per-game starter coverage is complete for 2023-24
regular season and playoffs and absent elsewhere until the source-specific acceptance gates pass.
This historical layer is **descriptive product data**, not TULIP Forecast training data.

## Roster-only players

The database previously held everyone who recorded an appearance. It now also carries players who
were on a roster and never played, from the season roster endpoint. They have `gp: 0`,
`appeared: false` and **`grade: null` — not 0**, because a zero would rank them below every player
who actually played, which is a different and false claim. They are hidden by default and
surfaced by the "include rostered players who never played" toggle, and the audit fails if one
ever acquires a grade or occupies a rank.

## Team-scoped statistics

Selecting a team offers two genuinely different questions:

- **Played for this team — season totals.** Every player who appeared for the team, showing their
  full-season line.
- **Statistics with this team only.** Multi-team players switch to their *stint* line for that
  team, so a Cleveland view of James Harden shows his 26 Cleveland games, not his 70-game season.

The table toolbar states how many rows are showing stint lines, so the scoping is never silent.

## Age

Age is stated from a real birthdate against fixed reference dates rather than inherited from
whichever source listed one:

- `ageOpeningNight` — exact age on 21 October 2025
- `ageFeb1` — exact age on 1 February 2026, the Basketball-Reference season-age convention
- `age` — NBA.com's listed age, kept for reference
- `seasonAge` — Basketball-Reference's own figure, kept for reference

NBA.com's listed age and Basketball-Reference's season age disagree for 246 of 580 NBA players,
which made "age 22 season" ambiguous. The first two fields are unambiguous.

## Field catalog

604 NBA and 345 G League raw fields is only useful if you can tell them apart — the same concept
appears as an official value, a Basketball-Reference value, a total, a per-game, a per-36 and a
per-100. Every field therefore carries **source, unit, basis, season scope and direction**, built
from the records themselves so it cannot drift from the data. The **Field catalog** button opens a
searchable dictionary; the audit fails if any field lacks an entry.

Season scope matters most. On the G League panel the headline line is Regular Season + Showcase
Cup while Basketball-Reference fields cover the regular season only, so the Formula Lab **blocks**
a composite that mixes scopes unless "allow mixed season scopes" is ticked deliberately.

## Provenance

Every build records the git commit, the grade-model version, both age reference dates, and for
each of the 94 committed source files its row count, byte size, SHA-256 prefix and modification
time. When a number changes later, that is what separates a source correction from a formula
change from a bug.

## Testing

- `npm run audit` — coverage, identity, grade sanity, stint reconciliation, positional-bias
  regression, split/catalog/provenance presence. Non-zero exit on failure.
- `npm run verify:artifact` — decodes the published page with the browser's own decoder and
  deep-compares every value against `data.json` (735k+ comparisons, including nulls, zeros,
  unicode names and stint arrays). The columnar encoding is proved lossless, not assumed.
- `npm run k-sensitivity` — the evidence behind the shrinkage constant.
- `scripts/browser-test.js` — end-to-end functional test of the built page: search, sorting both
  directions, every filter, team-stint scoping, the Formula Lab including ties/negative
  weights/mixed-scope guard, dialogs, compare, the full raw-column view, league switching with
  filters active, and reset. Load it in the page and call `window.__runAppTests()`.

## Layout

```
app.js                     UI
index.html  styles.css
public/data.json           generated, 13.7 MB
scripts/build-v3.mjs       merge, metrics, grades
scripts/audit-v3.mjs       coverage + sanity checks, non-zero exit on failure
scripts/fetch-official.mjs re-pull stats.nba.com dashboards (local only)
scripts/fetch-player-bios.mjs
scripts/lib/sources.mjs    loaders, name normalisation, verified alias map
scripts/lib/combine.mjs    Showcase + Regular Season combination
scripts/lib/metrics.mjs    custom metrics and the grade model
scripts/data/              committed raw source payloads
```

## Name reconciliation

The two sources disagree on a number of spellings. Two classes are handled mechanically in
`nameKey`: hyphenation (`Adama-Alpha Bal` against `Adama Bal`) and Cyrillic lookalikes
(Basketball-Reference writes `Egor Dёmin` with a Cyrillic ё, stats.nba.com writes `Egor Dëmin`
with a Latin ë — ё must be transliterated *before* Unicode decomposition, because stripping its
diaeresis otherwise leaves a Cyrillic е that is not a Latin `e`).

The remaining **16** are genuine nickname and legal-name differences that no normalisation can
derive — `Jeenathan Williams` against `Nate Williams`, `Gregory Jackson II` against `GG Jackson`,
`Esteban Roacho` against `Esteban Ezequiel Roacho Amador`. Each is listed explicitly in
`scripts/lib/sources.mjs` and was confirmed by matching team, games played and minutes on both
sides, not by fuzzy string distance. All 16 are still load-bearing; the build reaches **582/582
NBA and 561/561 G League** cross-source matches.

Identity itself is the official person id wherever both sides have one; names are only used to
attach the Basketball-Reference second opinion.

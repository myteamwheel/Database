# 2025-26 NBA + G League Performance Database

Ranked, filterable database of every player who appeared in the 2025-26 NBA or NBA G League
regular season, with a 0.0000-9.9999 per-game performance grade calculated separately inside
each league.

Run it:

```bash
npm run build && python3 -m http.server 3600
```

Then open <http://localhost:3600>. `npm run audit` validates the generated data.

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

`K` is 60% of the league's median minutes (NBA 567, G League 391). `sampleConfidence` is the
weight a player's own line received — `minutes / (minutes + K)` — so the displayed confidence
and the grade are the same statement rather than two unrelated numbers. The lowest games played
anywhere in the G League top 25 is now 16, and 36 in the NBA top 25.

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
- Multi-team players are one full-season aggregate record, not one row per stint.

---

## The 0.0000-9.9999 grade

Six components, each an average of within-league percentiles, combined with fixed weights:

| Component | Weight | Built from |
|---|---|---|
| Scoring | 30% | points/36, TS%, usage, FT and 3PT pressure, self-created scoring |
| Playmaking | 18% | assists/36, AST%, AST/TO, turnover suppression, creation load |
| Rebounding | 14% | total/offensive/defensive rebounds and their rates |
| Defense | 16% | steals, blocks, defensive rebound rate, defensive rating, DEF WS, disruption, possession swing |
| Efficiency | 12% | TS%, eFG%, efficiency over expected, AST/TO, turnover suppression |
| Impact | 10% | PIE, net rating, offensive rating, plus/minus, minutes |

The weighted composite is shrunk by minutes as described above, then percentile-ranked inside its
own league and mapped onto 0.0000-9.9999.

The grade deliberately excludes contract status, draft position, awards, age and reputation.

---

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

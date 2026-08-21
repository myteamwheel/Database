# TULIP — official definition

**Locked 2026-08-21. This supersedes the previous definition in this file. Written before any
modelling work, deliberately, because this project has twice drifted from the intended question to an
easier-to-validate proxy and then taken the TULIP name with it.**

## The definition

> **TULIP (Team Utilization & Lineup Impact Projection) estimates the change in minutes per game a
> player should receive, relative to his current workload, if his team's objective is to maximize
> expected winning. TULIP is team-relative and zero-sum: additional minutes recommended for one
> player must come from another player. A positive TULIP means the team is likely underutilizing the
> player; a negative TULIP means those minutes are likely more valuable elsewhere.**

## The displayed product

One number:

    TULIP: +3.8 MPG
    Current 19.4 -> Recommended 23.2

Users must not have to understand several competing TULIP concepts. TULIP Score, Role Evidence and
any workload-response curve are INTERNAL INGREDIENTS, not separate headline metrics.

## What TULIP must optimize

Given 240 regulation player-minutes per team per game, redistribute them across the roster to
maximize expected team performance / win probability. This requires the **marginal value of the next
minute** for each player — not merely who is better:

- what happens to expected winning if this player goes 18 -> 19 MPG?
- 25 -> 26?
- 34 -> 35?

TULIP is then the solution to that allocation problem, and the roster ledger must balance:
**sum of positive TULIP minutes = sum of negative TULIP minutes.**

## Worked shape

| player | actual MPG | win-optimal MPG | TULIP |
|---|---:|---:|---:|
| Jokic | 34.8 | 35.6 | +0.8 |
| Starter B | 31.0 | 30.4 | -0.6 |
| Bench C | 17.2 | 22.0 | +4.8 |
| Bench D | 18.5 | 13.5 | -5.0 |

## What TULIP is NOT

- NOT a hypothetical future coach's assignment.
- NOT a trade or acquisition scenario.
- NOT "how many minutes could his body theoretically survive."
- NOT a generic player grade or ranking.
- NOT a per-player recommendation that ignores where the minutes come from.

## The Jokic test

The question is never "what do historically similar 30-year-olds play?" It is: **would Denver's
expected chance of winning improve by moving one minute between Jokic and a team-mate?** If another
Jokic minute is still worth more than the alternative, and there is no meaningful performance
deterioration at that workload, TULIP stays positive until the marginal values converge. An
optimization metric must behave this way.

Symmetrically, a productive 16-MPG bench player does not automatically deserve +8. That requires
evidence about what actually happens when players with his profile take on 20, 24, 28 MPG — which is
where the expanded-role / opportunity-shock research becomes load-bearing.

## Superseded definitions, recorded so they cannot creep back

1. **Team-relative BPM gap x 2.2** (legacy). Retired: arbitrary coefficient, clamped, never
   validated as a win-maximizing magnitude.
2. **"TULIP Capacity" = team-independent sustainable-effective workload.** This was the previous
   contents of this file. It is NOT the definition of TULIP. Capacity may survive as an INGREDIENT
   (does the player hold up at higher workload?), but the headline metric is the allocation answer
   above.
3. **Projected Role MPG** (`TULIP_CAPACITY_V1`, card-sha256:96cb2f34c6cd06c3). Currently shipped.
   Predicts the workload a coach is likely to ASSIGN after an offseason move. Valid, validated, and
   explicitly NOT TULIP. Keep it, keep its name, do not let it reclaim the TULIP label.

## The remaining, unsolved problem — stated plainly

The newer TULIP Score work is conceptually closer to this definition than the Capacity model, because
it asks who deserves minutes relative to the team-mates currently getting them, and its allocator
conserves the roster minute ledger.

But by its own handoff: *TULIP Score is a team-relative direction/ranking signal, while Allocation
Delta is an advisory translation and is not a prospectively validated outcome estimate.*

So current evidence supports **"this player should move UP or DOWN in the rotation"** far better than
**"exactly +4.7 MPG maximizes wins."** The definition above requires the second.

**Therefore: the displayed number may not be presented as the win-maximizing answer until the minute
MAGNITUDE is validated prospectively against team outcomes. Direction and ranking may be presented as
such today; magnitude may not.** Closing that gap is the open work.

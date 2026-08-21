# TULIP — frozen definition

**Frozen 2026-08-21, before any further modelling work. Written first, deliberately, because the
previous attempt drifted from this question to an easier-to-validate proxy and then took this name.**

## The definition

> TULIP estimates a player's team-independent sustainable-and-effective NBA workload. It seeks to
> identify how many minutes the player can productively handle, not how many minutes a coach is
> likely to assign him. Observed future MPG may be evidence about capacity but cannot itself define
> the target.

## What TULIP must output

| field | meaning |
|---|---|
| TULIP Capacity | estimated sustainable EFFECTIVE MPG, independent of current team |
| Current MPG | what he is actually playing |
| TULIP Headroom | Capacity − Current MPG |

Interpretation the metric must support:
- **+6** — evidence he could effectively handle about six more MPG
- **0** — roughly at his sustainable workload
- **−3** — current workload may exceed what his performance/profile supports

## What TULIP is NOT

- NOT a prediction of how many minutes a future coach will assign him.
- NOT observed future MPG, which is contaminated by coach preference, depth chart, roster
  construction, injuries, contract status, team strategy, lineup fit and organisational politics.
- NOT a metric that may change because a player's roster changed. Capacity is team-independent by
  construction; if a roster change moves the number, the number is not capacity.

## The failure this document exists to prevent

TULIP_CAPACITY_V1 (card-sha256:96cb2f34c6cd06c3) was validated against **sustained MPG on a new team
after an offseason move**. That is a legitimate, validated ROLE PROJECTION. It is not capacity, and
naming it "TULIP Capacity" overstated what it measures. Symptom: it rates Nikola Jokic at 32.5 MPG
against 34.8 actual — not a finding that Jokic cannot handle more, but the model learning that
high-minute players regress toward lower minutes after changing teams.

**Rule going forward:** any candidate TULIP target must be defensible as a measure of what the PLAYER
can sustain effectively. If the target is an outcome a coach chooses, it is a role-projection target
and must be named accordingly, no matter how well it validates.

## What is already built and reusable

The opportunity-shock infrastructure was originally pointed at the right question and remains valid:
teammate-absence shocks, expanded-role episodes, pre-event player profiles, opener workload,
sustained workload, starter data, role persistence, performance-retention components, and
out-of-sample validation machinery.

Known complication, recorded honestly: per-minute effectiveness showed **no strong generic decline as
workload increased** once pre-event quality was controlled for. That does not prove capacity does not
exist — it means "find where performance falls off" is not cleanly identifiable from the data used so
far. The original TULIP problem is **partially unsolved**, and saying so is preferable to substituting
a coach-assignment proxy and calling it capacity.

## Current product status

- `TULIP_CAPACITY_V1` — frozen, immutable, KEPT. Internal identifier retains its original string for
  provenance; its USER-FACING name is now **Projected Role MPG**, with no claim of capacity.
- **TULIP Capacity** — reserved. Not shipped. Unsolved.

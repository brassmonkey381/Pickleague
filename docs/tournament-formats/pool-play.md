# Pool Play — Deep Dive (PP-1 through PP-9)

This appendix expands every `pool_play` permutation enumerated in
[`../tournament-formats.md`](../tournament-formats.md). It covers pool
counts **P ∈ {2, 3, 4, 6}**, all current and proposed playoff overlays
(PP-1 through PP-9), match/round-count math, ASCII flow diagrams, edge
cases, and schedule implications.

Cross-references:
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) — used by
  PP-4, PP-6, PP-8.
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — crossover rules
  (A1 vs B2, B1 vs A2, …) for PP-3, PP-5, PP-7, PP-8, PP-9.
- [Schedule Formulas](./schedule-formulas.md) — court counts and parallel
  block sizing.

---

## App descriptions (source of truth)

These are the canonical user-facing strings the app currently shows for
Pool Play. The deep dive below must stay consistent with them.

Format card description (`FORMAT_META.pool_play`):

```text
Balanced pools, then bracket.
```

— `mobile/src/lib/tournament.ts:386`

Pool-count hint shown beneath the "Number of Pools" picker when
`format === 'pool_play'`:

```text
Players are distributed evenly. Snake-draft keeps pools balanced by PLUPR when seeding is on.
```

— `mobile/src/screens/CreateTournamentScreen.tsx:408`

Bracket Seeding hint (applies to both pools and the downstream bracket;
PLUPR-based vs random draw):

```text
Determines bracket structure and which players face off in each round. Players are sorted by PLUPR; pools and brackets use snake-draft so the top seed faces the bottom seed and skill levels stay balanced across pools.
```

```text
Determines bracket structure and which players face off in each round. Players are drawn randomly into pools and bracket slots.
```

— `mobile/src/screens/CreateTournamentScreen.tsx:343-347`

The pool-count picker offers exactly `{2, 3, 4, 6}` for non-MLP
`pool_play` (CreateTournamentScreen.tsx:404), which matches the
`P ∈ {2, 3, 4, 6}` range used throughout this doc.

> **Note on PP-1.** The format card promises "Balanced pools, **then
> bracket**." PP-1 below documents the `playoff_format = none` case for
> completeness (e.g., league nights or pool-only events). When users
> pick Pool Play from the format card they should expect a bracket by
> default; PP-1 is the explicit opt-out, not the headline behaviour.

---

## Notation & Core Formulas

Let:

- `E` = total entrants (players in singles, teams in doubles).
- `P` = pool count (2, 3, 4, or 6).
- `k = E / P` = pool size (when E divides evenly by P).
- `N` = "top N per pool" advancing to playoff (PP-7..PP-9).

### Within-pool round robin

For one pool of size `k`:

```
matches_per_pool   = k * (k - 1) / 2
rounds_per_pool    = k - 1   if k is even
                   = k       if k is odd  (one bye seat per round)
courts_per_pool    = floor(k / 2)         (matches running in parallel)
```

### Total pool play

```
total_pool_matches = P * k * (k - 1) / 2
total_pool_rounds  = rounds_per_pool   (all pools share the same round clock;
                                       pools run in parallel)
```

### Single-elim playoff bracket of size `B` entrants

```
playoff_matches = B - 1                      (winner-take-all)
playoff_rounds  = ceil(log2(B))
```

If `B` is not a power of 2, the bracket needs **byes** (top seeds skip
round 1) or **play-in** matches; round count climbs to
`ceil(log2(B))`.

### Double-elim playoff bracket of size `B` entrants

```
WB matches      = B - 1                      (standard SE bracket)
LB matches      = B - 2                      (each non-champion gets a 2nd loss)
GF matches      = 1 (no reset)  or  1-2 (bracket reset on)
total DE matches = 2*B - 2  (no reset)
                 = 2*B - 1  (reset triggered)
```

See [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for
the exact drop-in cadence; numbers above are the totals only.

---

## PP-1 — Pool Play, No Playoff

`pool_play` + P pools + `playoff_format = none`.

This is the opt-out from the default "balanced pools, then bracket"
behaviour described in the format card. Use it when the event is
pool-only (league nights, social play, seeding round for a later event).
Standings come straight from within-pool order. Cross-pool ranking (e.g.,
"who is the overall #1?") is undefined unless tiebreakers compare pool
winners — see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md).

### Worked example: 16 entrants, P = 4

`k = 4`, so each pool plays a 4-team RR: 6 matches in 3 rounds per pool.

```
total_pool_matches = 4 * (4 * 3 / 2) = 24
total_pool_rounds  = 3
parallel matches per round = 4 pools * 2 = 8   (needs 8 courts to fit
                                                a round in one block)
```

### Flow diagram (P = 4, k = 4)

```
Round 1     Round 2     Round 3
─────────   ─────────   ─────────
Pool A:     Pool A:     Pool A:
 A1-A2       A1-A3       A1-A4
 A3-A4       A2-A4       A2-A3

Pool B:     Pool B:     Pool B:
 B1-B2       B1-B3       B1-B4
 B3-B4       B2-B4       B2-B3

Pool C:     Pool C:     Pool C:
 C1-C2       C1-C3       C1-C4
 C3-C4       C2-C4       C2-C3

Pool D:     Pool D:     Pool D:
 D1-D2       D1-D3       D1-D4
 D3-D4       D2-D4       D2-D3

Final standings = per-pool order; no cross-pool playoff.
```

### Edge cases

- **Uneven pools.** If `E` doesn't divide by `P`, some pools have `k`
  and others have `k+1`. The bigger pools play more matches (`k(k+1)/2`)
  and may need one extra round — schedule the smaller pools with a bye
  in that extra round.
- **Pool of 3.** Only 3 matches, 3 rounds with one team idle each round.
  Avoid when possible; combine with another pool of 3 if feasible.
- **Pool of 1.** Not allowed; merge into another pool or drop the entrant.

### Schedule implications

Pool play is **embarrassingly parallel**: all `P` pools advance through
the same round clock. Courts needed per round = `P * floor(k / 2)`.
With 4 pools of 4 you need 8 courts to run a single round simultaneously;
on 4 courts you'd run 2 sequential half-rounds per logical round.

---

## PP-2 — Pool Play + Top 2 Final (P = 2 only)

`pool_play` + 2 pools + `playoff_format = top_2_final`.

Only meaningful at P = 2 (one winner per pool meets in the Final). With
P > 2 you can't compress 3+ pool winners into a 2-entrant final without
dropping pools, so use PP-3/PP-7 instead.

### Worked example: 8 entrants, P = 2

`k = 4`. Each pool: 6 matches, 3 rounds. Then a single championship
match.

```
pool_matches      = 2 * 6                 = 12
playoff_matches   = 2 - 1                 = 1
total_matches     = 13
total_rounds      = 3 (pool) + 1 (final)  = 4
```

### Flow

```
Pool A (4 teams, RR)        Pool B (4 teams, RR)
   ↓ standings                  ↓ standings
   A1                           B1
       \                       /
        ──────  FINAL  ───────
                  ↓
              Champion
```

### Edge cases

- **Tied A1 / A2** within a pool: resolve via head-to-head, then point
  diff (see Seeding & Tiebreakers). A misseed here directly changes who
  plays the Final.
- **Adding a 3rd-place match**: use `top_2_final_3pm` instead — that
  schedules A2 vs B2 alongside the Final (still PP-2 family).

### Schedule

Pool play parallelizable; the Final is a single isolated court-block
after both pools close. Total elapsed rounds: `rounds_per_pool + 1`.

---

## PP-3 — Pool Play + Top 4 Single Elim

`pool_play` + P pools + `playoff_format = top_4_se`.

Seeds 4 entrants into Semis → Final. Two natural sub-cases:

- **P = 4** → top 1 per pool (A1, B1, C1, D1).
- **P = 2** → top 2 per pool (A1, A2, B1, B2). This is the same shape as
  PP-7 with N=2 over P=2, just named differently for clarity.

P = 3 or P = 6 over-fill or under-fill a 4-bracket; use PP-5 or PP-7.

### Worked example: 16 entrants, P = 4

`k = 4`. Pool play: 24 matches / 3 rounds (see PP-1 numbers).

```
playoff_matches   = 4 - 1                 = 3
playoff_rounds    = log2(4)               = 2
total_matches     = 24 + 3                = 27
total_rounds      = 3 + 2                 = 5
```

### Flow (P = 4, top 1 per pool, crossover seeding)

```
Pool A → A1                       Pool B → B1
Pool C → C1                       Pool D → D1

       Semifinal 1                    Semifinal 2
           A1 ─┐                        B1 ─┐
                ├── SF1.W ─┐                  ├── SF2.W ─┐
           D1 ─┘            \           C1 ─┘            \
                             └───── FINAL ────────────────┐
                                                          ↓
                                                      Champion
```

Crossover rule: A1 plays the lowest seed from the *opposite* half
(here D1) to avoid an immediate rematch between A1/B1 (which would
re-decide pool ordering). For P = 2 with top 2/pool:

```
   SF1: A1 vs B2
   SF2: B1 vs A2
   F:   SF1.W vs SF2.W
```

### Edge cases

- **Same-pool rematch in Final.** If A1 and A2 both win their Semis,
  they meet in the Final — usually acceptable, but some directors enforce
  "no rematch before Final" by adjusting bracket lines.
- **Pool winner tiebreak failures.** With P = 4 and a 3-way tie at the
  top of a pool, the tiebreak chain *must* terminate; otherwise the
  bracket can't be drawn.

### Schedule

Pool play parallel; playoff is sequential (`SF` round, then `F`). With 4
courts you can run both Semis simultaneously, but the Final is solo.

---

## PP-4 — Pool Play + Top 4 Double Elim **(NEW)**

`pool_play` + P pools + `playoff_format = top_4_de`.

Same seeding as PP-3, but the 4 entrants enter a double-elim playoff
bracket. See
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for the
drop-in order.

### Worked example: 16 entrants, P = 4

Pool play: 24 / 3 (same as PP-3).

```
DE_matches (no reset)   = 2 * 4 - 2 = 6
DE_matches (with reset) = 2 * 4 - 1 = 7
DE_rounds               = 4 (WB SF, WB F, LB F, GF [, GF2])
total_matches           = 24 + 6 or 7
total_rounds            = 3 + 4 = 7 (+1 if reset)
```

### Flow (P = 4)

```
Pool standings → A1, B1, C1, D1   (crossover-seeded into WB)

Winners Bracket
  WSF1: A1 vs D1 ─┐
                  ├── WF: WSF1.W vs WSF2.W ── GF1 ─┐
  WSF2: B1 vs C1 ─┘                                │
                                                   │
Losers Bracket                                     │
  LR1: WSF1.L vs WSF2.L                            │
  LF:  LR1.W vs WF.L ──────────────────── GF1.LB ──┤
                                                   │
                                  (optional) GF2 ──┘  if LB wins GF1
```

### Edge cases

- **WB champion has zero losses; LB champion has one loss.** Bracket
  reset toggle decides whether GF1 winner = champ outright, or LB win
  forces GF2.
- **Same-pool entrants meeting in LB.** With crossover seeding, two
  teams from the same pool can still meet in LB after both drop —
  acceptable but may feel like a rematch.

### Schedule

LB matches slot **between** WB rounds; total elapsed playoff rounds is
`ceil(log2(B)) + 1 or 2` depending on reset. With ≥ 2 courts, LR1 can
share a block with one WB round to compress the day.

---

## PP-5 — Pool Play + Top 8 Single Elim

`pool_play` + P pools + `playoff_format = top_8_se`.

Seeds 8 entrants into Quarters → Semis → Final. Natural fits:

- **P = 4** → top 2 per pool (8 entrants exactly).
- **P = 2** → top 4 per pool.
- **P = 8** → top 1 per pool (not in current pool_count set — would need
  P = 8 support).

### Worked example: 16 entrants, P = 4, top 2 per pool

`k = 4`. Pool play same as PP-1 (24 / 3).

```
playoff_matches   = 8 - 1                 = 7
playoff_rounds    = log2(8)               = 3
total_matches     = 24 + 7                = 31
total_rounds      = 3 + 3                 = 6
```

### Flow (P = 4, top 2 per pool, crossover seeded)

```
Seeds (crossover):
  Q1: A1 vs D2          Q2: B1 vs C2
  Q3: C1 vs B2          Q4: D1 vs A2

  Q1 ─┐
       ├── SF1 ─┐
  Q2 ─┘         \
                 ├── FINAL ── Champion
  Q3 ─┐         /
       ├── SF2 ─┘
  Q4 ─┘
```

Crossover principle: each pool's #1 meets a different pool's #2; pool
mates are placed in opposite halves so the only possible rematch is the
Final.

### Worked example: 24 entrants, P = 6, top 2 per pool → 12 entrants

12 entrants does NOT fit an 8-bracket cleanly. Two options:

1. **Truncate to top 1 per pool**, drop the 12-entrant frame — use a
   custom 6-team bracket (see PP-7).
2. **Take top 8 across pools** (best 2 from 4 pools + best 1 from 2
   pools) using cross-pool tiebreakers — controversial; document the
   rule up front.

For clean math, use 16 entrants / P = 4 / N = 2 (the example above) or
8 entrants / P = 2 / N = 4.

### Edge cases

- **Top 2 per pool with P = 3** → 6 entrants, see PP-7 worked example.
- **Top 2 per pool with P = 6** → 12 entrants, see above; not a power of
  2.

### Schedule

8-bracket QF round wants 4 courts; SF needs 2; F needs 1. Pool play
fills courts heavily, playoff tapers — court usage drops by half each
playoff round.

---

## PP-6 — Pool Play + Top 8 Double Elim **(NEW)**

`pool_play` + P pools + `playoff_format = top_8_de`.

Same seeding as PP-5, double-elim playoff. See
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md).

### Worked example: 16 entrants, P = 4, top 2 per pool

Pool play: 24 / 3.

```
DE_matches (no reset)   = 2 * 8 - 2 = 14
DE_matches (with reset) = 2 * 8 - 1 = 15
DE_rounds               = ceil(log2(8)) + LB drop-ins + GF
                        ≈ 7 (+1 if reset)
total_matches           = 24 + 14 or 15
total_rounds            = 3 + 7 = 10 (+1 if reset)
```

### Flow sketch

```
Quarters (WB):  Q1, Q2, Q3, Q4   ────────────────┐
                  │                                │
Semis (WB):     S1, S2                            │
                                                  │
LB drop-ins after each WB round (4 LR1, 2 LR2,    ├──── GF1
1 LR3, LB Semi, LB Final)                         │
                                                  │
                                       (optional) GF2 if LB wins GF1
```

LB has roughly `B - 2 = 6` matches; cadence is:
1. After WB Q-round, 4 losers drop into LR1 (2 matches).
2. After WB SF, 2 losers drop into LR3 (joins LR2 winners).
3. LB Final pits LR-survivor vs WB SF loser ... → GF1.

### Edge cases

Same as PP-4 plus:
- **Long day risk.** 10 elapsed rounds. Consider running pool play and
  early playoff rounds on different days for 16+ entrants.

### Schedule

Court demand peaks during pool play; playoff has interleaved WB/LB
blocks. With 4 courts the playoff day fits in ~5 elapsed blocks of
2 matches each.

---

## PP-7 — Pool Play + Top N per Pool Single Elim **(NEW name)**

`pool_play` + P pools + `playoff_format = top_N_per_pool_se` + `playoff_n = N`.

**This is the user's motivating example.** With P = 3 pools and N = 2,
the playoff has `P * N = 6` entrants — a non-power-of-2 bracket that
needs byes or a play-in round.

### Worked example: 12 entrants, P = 3, N = 2  ← motivating case

`k = 4`. Pool play: 3 * 6 = 18 matches / 3 rounds.

Bracket size: `P * N = 6` entrants. Not a power of 2 ⇒ need 2 byes for
top seeds OR 2 play-in matches.

#### Option A — Byes (recommended)

Seed the 6 entrants 1–6 by aggregate standing (head-to-head W%, then
point diff). The top 2 seeds get a first-round bye.

```
Seeds (after crossover):
  S1 = best pool winner overall          (e.g., A1)
  S2 = next-best pool winner             (e.g., B1)
  S3 = remaining pool winner             (C1)
  S4 = best #2 across pools              (e.g., A2)
  S5, S6 = remaining #2s                 (B2, C2)

Round 1 (play-in for seeds 3-6):
  PI1: S3 vs S6      (rule: never pair pool-mates in round 1; swap to
                      the next valid opponent if seed math collides)
  PI2: S4 vs S5

Round 2 (Semis):
  SF1: S1 (bye) vs PI1.W
  SF2: S2 (bye) vs PI2.W

Round 3 (Final):
  F: SF1.W vs SF2.W
```

Match counts with byes:

```
playoff_matches   = 6 - 1                 = 5
playoff_rounds    = ceil(log2(6))         = 3
total_matches     = 18 + 5                = 23
total_rounds      = 3 + 3                 = 6
```

#### Option B — Play-in only (no byes)

All 6 entrants play round 1; 4 of them play a "play-in" while the other
2 are paired together. Math identical (still 5 playoff matches), but
*everyone* plays a match in round 1 — gives the top seeds an extra game
at the cost of feeling like a "first-round upset" zone.

### Flow diagram (Option A — byes for S1, S2)

```
Pool A     Pool B     Pool C
 ─────      ─────      ─────
  A1         B1         C1
  A2  ──┐    B2  ──┐    C2  ──┐
        │          │          │
        ↓ seeding (crossover + overall pool-winner ranking)
        ↓
   ┌──────────────────────────────────────┐
   │  S1 (A1)  ─────────────────┐         │
   │                            ├── SF1 ──┐
   │  S3 ──┐                    │         │
   │       ├── PI1.W ───────────┘         │
   │  S6 ──┘                              ├── FINAL ── Champion
   │                                      │
   │  S4 ──┐                              │
   │       ├── PI2.W ───────────┐         │
   │  S5 ──┘                    ├── SF2 ──┘
   │                            │
   │  S2 (B1)  ─────────────────┘
   └──────────────────────────────────────┘
```

(Pool labels A/B/C are placeholders — actual seeding uses overall
standing across pool winners and overall standing across pool #2s.)

### Other (P, N) combinations

| P | N | Bracket size | Power of 2? | Strategy |
|---|---|---|---|---|
| 2 | 2 | 4 | yes | Identical to PP-3 (top 4 SE). |
| 2 | 4 | 8 | yes | Identical to PP-5 (top 8 SE). |
| 3 | 2 | 6 | **no** | **Byes for top 2** (or play-ins). ← motivating example |
| 3 | 3 | 9 | no | Bracket of 16 with 7 byes; top 7 seeds skip round 1. |
| 4 | 1 | 4 | yes | Identical to PP-3. |
| 4 | 2 | 8 | yes | Identical to PP-5. |
| 4 | 3 | 12 | no | Bracket of 16 with 4 byes for top 4 seeds. |
| 6 | 1 | 6 | no | Byes for top 2 seeds. |
| 6 | 2 | 12 | no | Bracket of 16 with 4 byes. |

### Edge cases

- **Same-pool rematch in round 1.** Crossover seeding rules in
  [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) explicitly
  forbid this — re-pair if it occurs.
- **Cross-pool seed ranking ties.** When two pool winners have identical
  in-pool records, seeding falls back to point diff, then to a coin
  flip (or PLUPR delta, configurable).
- **N ≥ k.** N can't exceed pool size; UI must clamp.

### Schedule

Pool play parallel, then playoff. Non-power-of-2 brackets compress
nicely with byes: 6-entrant bracket = 3 rounds, same as 8-entrant.
Court needs: round 1 = 2 matches, round 2 = 2, round 3 = 1.

---

## PP-8 — Pool Play + Top N per Pool Double Elim **(NEW)**

`pool_play` + P pools + `playoff_format = top_N_per_pool_de` + `playoff_n = N`.

Same seeding as PP-7, double-elim playoff. See
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md).

### Worked example: 12 entrants, P = 3, N = 2

Same pool play as PP-7: 18 matches / 3 rounds.

```
DE_matches (no reset)   = 2 * 6 - 2 = 10
DE_matches (with reset) = 2 * 6 - 1 = 11
DE_rounds               = ceil(log2(6)) + LB depth
                        ≈ 6 (+1 if reset)
total_matches           = 18 + 10 or 11
total_rounds            = 3 + 6 = 9 (+1 if reset)
```

### Flow sketch (B = 6 entrants)

```
WB (same as PP-7 with byes):
  PI1, PI2 → SF1, SF2 → WF → GF1

LB drop-ins:
  PI1.L, PI2.L → LR1                       (2 entrants, 1 match)
  LR1.W vs SF1.L → LR2a                    (1 match)
  LR2a.W vs SF2.L → LR2b                   (1 match)
  LR2b.W vs WF.L → LB Final → GF1.LB       (1 + 1 + 1 matches)

  GF1: WF.W vs LB Final.W
  GF2 (optional): if LB wins GF1
```

### Edge cases

- **Byes cascading into LB.** Top seeds who took a WB bye and then lose
  drop into LB with a "skipped" round; LB pairings must account for the
  bye so they don't get an automatic LB bye too.
- **GF reset with byes** is unaffected — the reset rule only cares
  about whether the LB finalist had a prior loss (they always do, by
  definition).

### Schedule

Roughly 1.6×–1.8× the matches of PP-7 for the same `(P, N)`. Most
deployments will want to schedule pool play and DE playoff on different
days.

---

## PP-9 — Pool Play + Top N + Consolation Bracket **(NEW)**

`pool_play` + P pools + `playoff_format = top_N_consolation` + `playoff_n = N`.

A lighter-weight alternative to PP-8: top N from each pool enter the
**main** SE bracket, and **first-round losers of the main bracket**
drop into a **consolation** SE bracket. Entrants who lose round 2+ of
the main bracket are eliminated outright (unlike DE, where they'd drop
into LB).

### Worked example: 16 entrants, P = 4, N = 2 (8 in main, 4 in consolation)

`k = 4`. Pool play: 24 / 3.

```
main_matches      = 8 - 1                 = 7
consolation_matches = 4 - 1               = 3  (4 first-round losers form a 4-bracket)
playoff_matches   = 7 + 3                 = 10
playoff_rounds    = max(SE main, SE cons) = 3
total_matches     = 24 + 10               = 34
total_rounds      = 3 + 3                 = 6
```

### Flow

```
Pool standings (top 2 per pool) → 8-entrant MAIN bracket
                                  (PP-5 crossover seeding)

  Q1, Q2, Q3, Q4   (4 matches)
       │
       ├── 4 winners → SF → F      (main bracket champion)
       │
       └── 4 losers → CONSOLATION bracket
                      C-SF1: Q1.L vs Q4.L
                      C-SF2: Q2.L vs Q3.L
                      C-F:   C-SF1.W vs C-SF2.W   (consolation champion)
```

### Edge cases

- **Consolation entrants = first-round main losers only.** Round-2
  losers (SF losers) are eliminated outright. If you want them to keep
  playing, you've reinvented double-elim — use PP-6 / PP-8 instead.
- **Non-power-of-2 main bracket.** If N gives a 6-entrant main (P=3,
  N=2), only 2 teams lose in round 1 — too few for a consolation
  bracket. Fold the round-1 losers into a single consolation Final, or
  skip consolation for this `(P, N)`.
- **Awarding ranks beyond main + consolation.** Pool play standings
  break ties for 9th+ when N=2 / P=4.

### Schedule

Main and consolation run in parallel after round 1 — consolation does
not depend on main's later rounds. Total elapsed playoff rounds
= `ceil(log2(B_main))`, same as PP-5.

---

## Cross-Permutation Summary

For a 16-entrant tournament with P = 4, k = 4:

| Perm | Playoff | Playoff matches | Total matches | Total rounds |
|---|---|---|---|---|
| PP-1 | none | 0 | 24 | 3 |
| PP-3 | Top 4 SE | 3 | 27 | 5 |
| PP-4 | Top 4 DE | 6 (7 w/ reset) | 30 (31) | 7 (8) |
| PP-5 | Top 8 SE (N=2) | 7 | 31 | 6 |
| PP-6 | Top 8 DE (N=2) | 14 (15 w/ reset) | 38 (39) | 10 (11) |
| PP-7 | Top 2/pool SE | 7 (same as PP-5 here) | 31 | 6 |
| PP-8 | Top 2/pool DE | 14 (same as PP-6 here) | 38 | 10 |
| PP-9 | Top 2 + Consolation | 10 | 34 | 6 |

For 12 entrants with P = 3, k = 4 (PP-2 inapplicable, PP-3/PP-5 require
re-seeding):

| Perm | Playoff | Bracket | Playoff matches | Total matches | Total rounds |
|---|---|---|---|---|---|
| PP-1 | none | — | 0 | 18 | 3 |
| PP-7 (N=2) | 6-entrant SE w/ byes | 6 | 5 | 23 | 6 |
| PP-8 (N=2) | 6-entrant DE w/ byes | 6 | 10 (11 w/ reset) | 28 (29) | 9 (10) |
| PP-9 (N=2) | 4-main + 2-cons | 6 | 4 | 22 | 6 |

---

## Schedule Implications (all PP-*)

1. **Pool play is high-parallelism.** All P pools share the round
   clock; `P * floor(k/2)` matches can run simultaneously.
2. **Playoff is sequential.** Each playoff round depends on the prior
   round's results. Court demand drops by half each round.
3. **DE playoffs (PP-4, PP-6, PP-8) interleave LB matches between WB
   rounds.** This re-flattens court demand somewhat — LB blocks can
   share a court-block with WB rounds with appropriate spacing.
4. **Consolation (PP-9) runs in parallel with main playoff** after
   round 1 — does not extend the elapsed round count beyond the main
   bracket.
5. **Court sizing rule of thumb:**
   - Pool play: `courts = P * floor(k / 2)` for one-round-at-a-time.
   - SE playoff: `courts = bracket_size / 2` for round 1.
   - DE playoff: same as SE plus 1 court for LB interleave.

See [Schedule Formulas](./schedule-formulas.md) for the full
court/round math and the multi-day partitioning rules used when total
rounds exceed a single session.

---

## Open Items Specific to PP-*

(Already noted in the index doc, restated here for context.)

- **PP-7/PP-8 with non-power-of-2 bracket size**: choose **byes for top
  seeds** (this doc's recommendation) vs **play-in matches for low
  seeds**. Currently unresolved; affects PP-7 (P=3,N=2), PP-7 (P=3,N=3),
  PP-7 (P=6,N=1), and PP-7 (P=6,N=2).
- **Cross-pool seeding** for `top_N_per_pool_*` when N>1: do we strictly
  alternate pool labels (A1, B1, C1, A2, B2, C2 → seed 1–6) or rank all
  N*P entrants by pool record / point diff? The latter risks all top
  seeds coming from one strong pool.
- **PP-9 consolation seeding** when main bracket has byes: do bye-takers
  who later lose still feed consolation, or only literal "round 1
  losers"?

# Rotating Partners — Deep Dive

> Covers permutations **RP-1 through RP-4** from
> [`../tournament-formats.md`](../tournament-formats.md).
>
> Rotating Partners is a doubles-only format where each player is tracked
> **individually** (no fixed teams). Partners shuffle every match (or every
> round, depending on the Additional Format), so a player's standing reflects
> their own performance across many different partnerships.

---

## The Rotation Algorithm

The current generator is `generateRotatingPartners(seededPlayers, numRounds)`
in `mobile/src/lib/tournament.ts`. Its rules:

1. Pad the player list up to a multiple of 4 with `BYE` placeholders.
2. For each round, walk the array in groups of 4: positions
   `(0, 1)` partner against `(2, 3)`; `(4, 5)` against `(6, 7)`; etc.
3. After each round, **fix player at index 0** and rotate the rest by 1
   (take the last entry and insert it at index 1). This mirrors the circle
   method used by `generateRoundRobin`.
4. Any group of 4 containing a `BYE` is dropped (no match generated).

The fixed player at index 0 acts as the "pin" of the rotation. After `P − 1`
rounds the rotation returns to its starting state, so **`P − 1` is the
natural maximum number of distinct rounds**, similar to a round robin.

### Match-count math

For a clean (multiple-of-4) player count `P`:

```
matches_per_round = P / 4
total_matches     = rounds × (P / 4)
max_distinct_rounds ≈ P − 1   (one player is pinned; circle of size P − 1)
```

For `P = 8`, `rounds = 7`, that's `7 × 2 = 14` total matches, with each
player appearing in exactly 7 matches.

> Note: the algorithm does not de-duplicate partner pairings, so a long
> enough run will eventually repeat partner/opponent pairings. In practice
> RP tournaments cap rounds at `P − 1` (or fewer) to keep variety high.

---

## Worked Example — 8 Players

Let players be seeded `[P0, P1, P2, P3, P4, P5, P6, P7]`. The pin is `P0`.

### Round 1 (initial order)

```
[P0  P1  P2  P3] [P4  P5  P6  P7]
 └──┬──┘  └──┬──┘ └──┬──┘  └──┬──┘
 Team1   Team2   Team1   Team2
 (P0+P1) (P2+P3) (P4+P5) (P6+P7)

Match 1: P0 + P1   vs   P2 + P3
Match 2: P4 + P5   vs   P6 + P7
```

### Rotation step

`P0` stays at index 0. The last entry (`P7`) jumps to index 1 and everyone
else shifts right one slot.

```
Before: P0  P1  P2  P3  P4  P5  P6  P7
After : P0  P7  P1  P2  P3  P4  P5  P6
        └pin┘  └──────── rotated ────────┘
```

### Rounds 1–7 partner/opponent chart

```
Round  Group A (court 1)                Group B (court 2)
─────  ──────────────────────────       ──────────────────────────
  1    P0+P1  vs  P2+P3                 P4+P5  vs  P6+P7
  2    P0+P7  vs  P1+P2                 P3+P4  vs  P5+P6
  3    P0+P6  vs  P7+P1                 P2+P3  vs  P4+P5
  4    P0+P5  vs  P6+P7                 P1+P2  vs  P3+P4
  5    P0+P4  vs  P5+P6                 P7+P1  vs  P2+P3
  6    P0+P3  vs  P4+P5                 P6+P7  vs  P1+P2
  7    P0+P2  vs  P3+P4                 P5+P6  vs  P7+P1
```

After round 7 the array is back to `[P0, P1, P2, P3, P4, P5, P6, P7]` and
the rotation repeats. Notice that `P0` partners with every other player
exactly once across the 7 rounds — that's the property the "pin + circle"
shift guarantees.

---

## RP-1 — Rotating Partners + Rotate Every Match + No Playoff

**Tuple:** `(rotating_partners, partner_rotation = 'every_match', playoff = none)`.

Every entry in the schedule above is a separate match where partners change
**from one match to the next**. In other words, each schedule row (court 1,
court 2 …) is itself a "round" of one match. There is no playoff: final
standings come straight from individual W/L (or game-differential).

### Schedule shape

```
Time slot 1:  P0+P1 vs P2+P3
Time slot 2:  P4+P5 vs P6+P7   ← partners already different from slot 1
Time slot 3:  P0+P7 vs P1+P2
Time slot 4:  P3+P4 vs P5+P6
…
```

- Total matches with `P − 1` rotation cycles: `(P − 1) × (P / 4)`. For 8
  players that's **14 matches**.
- Parallelism: typically **1 court at a time** (because partners must reshuffle
  between matches), so the day is `(P − 1) × (P / 4)` × match length.
  An organizer can run multiple courts concurrently if they're willing to
  pre-publish the whole schedule and accept that a player may need to be on
  two courts back-to-back; the generator already emits `matchOrder` per round
  so the UI can chunk them safely.

### Standings tiebreakers

Individual standings come from each player's match record. Recommended
tiebreaker order (ties are common in rotating-partners because everyone
plays the same number of matches):

1. Individual wins.
2. Game differential (points-for minus points-against across all matches).
3. Head-to-head when feasible (often inconclusive — players were partners as
   often as opponents).

See [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) for the canonical
rules.

---

## RP-2 — Rotating Partners + Rotate Every Round + No Playoff

**Tuple:** `(rotating_partners, partner_rotation = 'every_round', playoff = none)`.

Same generator output, but the **interpretation differs**: all matches with
the same `round` value are played back-to-back as one "round," with partners
held fixed for the full round. Only when the round flips does the pin-and-shift
rotation happen.

### Schedule shape (8 players, every-round)

```
Round 1 (parallel on 2 courts):
  Court 1:  P0+P1  vs  P2+P3
  Court 2:  P4+P5  vs  P6+P7
─── rotate (P0 pinned, P7 jumps to index 1) ───
Round 2 (parallel on 2 courts):
  Court 1:  P0+P7  vs  P1+P2
  Court 2:  P3+P4  vs  P5+P6
…
```

- Total matches: same as RP-1, `(P − 1) × (P / 4)`.
- Parallelism: **`floor(P / 4)` courts** can run simultaneously (2 courts
  for 8 players, 4 courts for 16). This is the big practical difference
  from RP-1.
- Time per "round" ≈ longest match in that round. So **wall-clock time** for
  `R` rounds ≈ `R × match_length`, much shorter than RP-1's serial schedule.

### When to pick RP-2 vs RP-1

- **RP-1 (every match)**: maximizes partner variety per minute, but courts
  cannot run truly in parallel without scheduling acrobatics.
- **RP-2 (every round)**: better fit for clinics, league nights, and any
  venue with multiple courts; partners change less often, but the day is
  much shorter.

---

## RP-3 — Rotating Partners + Either Rotation + Top N Single-Elim Playoff (NEW)

**Tuple:** `(rotating_partners, partner_rotation = either, playoff = top_N_se)`.

After group play, take the top `N` individuals (typically `N ∈ {4, 8}`) and
seed them into a single-elim playoff. The **open design question** is how
you turn individual seeds into doubles teams.

### Pairing strategies

#### Strategy A — Rank-adjacent ("strong pairs")

Pair `#1 + #2`, `#3 + #4`, `#5 + #6`, `#7 + #8`. The top two finishers
team up for a dominant top seed; the next two team up for the #2 seed; etc.

```
Top 8 standings → playoff teams (rank-adjacent)
  ┌─ #1 + #2 ──┐  ← Seed A
  │   #3 + #4  │  ← Seed B
  │   #5 + #6  │  ← Seed C
  └─ #7 + #8 ──┘  ← Seed D
```

- **Pros:** Rewards the strongest performers with the strongest partners.
  Easy to explain.
- **Cons:** The top seed is wildly favored (often two best players in the
  field). Final usually comes down to Seed A vs Seed B with little drama
  in earlier rounds.

#### Strategy B — Rank-spread ("balanced pairs")

Pair `#1 + #8`, `#2 + #7`, `#3 + #6`, `#4 + #5`. Each playoff team has one
high-rated and one low-rated player.

```
Top 8 standings → playoff teams (rank-spread)
  ┌─ #1 + #8 ──┐  ← Seed A
  │   #2 + #7  │  ← Seed B
  │   #3 + #6  │  ← Seed C
  └─ #4 + #5 ──┘  ← Seed D
```

- **Pros:** Much closer matches; bracket outcomes feel less predetermined.
  Mirrors how casual social play "balances" sides.
- **Cons:** Disconnect between group-play performance and playoff success
  ("I finished #1 and got paired with #8 — why bother grinding?").

### Recommendation

Expose the strategy as a tournament setting (`rp_playoff_pairing`:
`adjacent | spread`). Default to **adjacent**: it's the strategy organizers
intuitively reach for ("top finishers get to team up"), and it keeps the
playoff feel "earned."

### Bracket shape (top 4 SE)

Once the 8 individuals are paired into 4 teams, the playoff is a vanilla
single-elim bracket with the existing `generateSingleElim`:

```
  Seed A ─┐
          ├── Final ── Champion
  Seed B ─┘     │
                │  (3PM toggle here)
  Seed C ─┐     │
          ├── Loser of SF1 vs Loser of SF2 → 3rd place
  Seed D ─┘
```

(For top 8 individuals → 4 teams, the bracket is a 4-team SE: Semis →
Final. For larger `N`, scale the bracket size accordingly: 16 individuals
→ 8 teams → QF/SF/F.)

### Schedule implications

- Group-play parallelism is unchanged from RP-1/RP-2.
- Playoff parallelism: standard SE — 2 SF matches in parallel, then 1 F.
- Total playoff matches: `teams − 1` (plus 1 if 3PM is enabled).

---

## RP-4 — Rotating Partners + Either Rotation + Top N Double-Elim Playoff (NEW)

**Tuple:** `(rotating_partners, partner_rotation = either, playoff = top_N_de)`.

Identical to RP-3 up through the "individuals → teams" pairing step, then
the seeded teams enter a **double-elimination playoff** (winners bracket +
losers bracket + Grand Final, with optional bracket reset).

See [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for the
canonical bracket layout, drop rules, and bracket-reset semantics. RP-4
reuses that exact infrastructure (`_advance_double_elim_bracket` trigger)
starting from the top-N seeded teams.

### Bracket shape (top 4 DE — 4 paired teams)

```
Winners Bracket
  WSF1: A vs D ──┐
                 ├── WF: WSF1.W vs WSF2.W ── GF (Grand Final)
  WSF2: B vs C ──┘                              │
                                                │
Losers Bracket                                  │
  LR1: WSF1.L vs WSF2.L                         │
  LF : LR1.W vs WF.L  ──────────────────GF.LB ──┘
                                                │
                                  (optional)  GF2  if LB champ wins GF1
```

### Open question carried into RP-4

The **same pairing-strategy decision from RP-3 applies**, and arguably
matters more here. Double-elim brackets create more rounds, so an "unfair"
pairing has more chances to manifest:

- Under **adjacent** pairing, the top-seeded team often runs the table
  through both brackets, even with a losers-bracket safety net for everyone
  else.
- Under **spread** pairing, upsets are more likely in the early winners
  bracket and the losers bracket becomes very competitive.

The tournament setting should be **shared between RP-3 and RP-4** so an
organizer picks pairing strategy once.

### Match counts (top 4 DE)

- Winners bracket: 2 SF + 1 F = **3 matches**.
- Losers bracket: 1 LR1 + 1 LF = **2 matches**.
- Grand Final: 1 match (or 2 with bracket reset on an upset).
- **Total: 6–7 playoff matches** for 4 teams (vs. 3 for top-4 SE without
  3PM).

For top 8 DE the count roughly doubles; consult the losers-bracket doc.

---

## Edge Case — Odd Player Count

The generator pads the player list up to a multiple of 4 with `BYE`
placeholders, then drops any match that includes a `BYE`. Concretely:

| Players | Pad to | BYEs added | Matches per round | Notes |
|---|---|---|---|---|
| 5 | 8 | 3 | 1 (just the one not-touched-by-BYE group, when it exists) | Often 0 matches/round; format is impractical. |
| 6 | 8 | 2 | 1 most rounds | Half the players sit out each round. |
| 7 | 8 | 1 | 1 | One player sits each round. |
| 8 | 8 | 0 | 2 | Clean. |
| 9 | 12 | 3 | 1–2 depending on rotation | Multiple players sit each round. |
| 10 | 12 | 2 | 2 most rounds | Two sit each round. |
| 11 | 12 | 1 | 2 | One sits each round. |
| 12 | 12 | 0 | 3 | Clean. |

**Rule of thumb:** rotating partners is at its best when `P mod 4 = 0`.
For non-multiples of 4, expect at least one player to be benched each
round, and warn the organizer in the tournament-setup UI.

For the **playoff stage** of RP-3/RP-4, `N` (the number of advancing
individuals) should be even so the pairing rule produces whole teams.
`N ∈ {4, 8, 16}` are the natural choices; `N = 6` works but requires byes
in the playoff bracket (top two paired teams skip round 1).

---

## Schedule Implications Summary

| Permutation | Group-play parallelism | Group-play wall-clock (approx) | Playoff additions |
|---|---|---|---|
| RP-1 | 1 court by default (multi-court possible, see RP-1 above) | `(P − 1) × (P / 4) × match_len` | none |
| RP-2 | `floor(P / 4)` courts | `(P − 1) × match_len` | none |
| RP-3 | same as RP-1 / RP-2 | same | + `teams − 1` SE matches |
| RP-4 | same | same | + 6–7 DE matches (top 4) or ~14 (top 8) |

`match_len` is the typical doubles-match length (commonly 15–25 minutes for
games to 11; longer for best-of-three).

---

## Cross-References

- [Tournament Format Permutations (index)](../tournament-formats.md) — full
  3-axis model and RP-1..RP-4 row entries.
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) — bracket
  layout, advancement triggers, and bracket-reset rules used by RP-4.
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — how individual
  group-play standings collapse to a single seed list, plus the
  rank-adjacent vs rank-spread pairing rules for RP-3/RP-4.

---

## Open Questions Specific to RP-3 / RP-4

1. **Pairing strategy default** — adjacent or spread? (Recommended:
   adjacent, with the setting exposed.)
2. **Tie-breaking the seed list** — when two individuals finish with the
   same record, which one becomes the "high" seed for pairing purposes?
   Suggest: game differential, then head-to-head where both players were
   on opposing teams.
3. **N selection** — RP playoffs work best with `N ∈ {4, 8}` (even
   numbers, power-of-2-team brackets). Should we hide `N = 6` from the UI
   to avoid byes, or allow it with a warning?
4. **Should the pinned player (P0) get a seeding advantage?** — under the
   current rotation, P0 partners with each other player exactly once,
   which can either help or hurt them depending on the field. This is
   probably a non-issue once N ≥ 4, but worth confirming.

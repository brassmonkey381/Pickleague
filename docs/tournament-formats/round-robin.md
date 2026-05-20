# Round Robin Deep-Dive (RR-1 .. RR-8)

## App descriptions (source of truth)

The canonical user-facing copy shown in the Pickleague app is:

```
Round Robin — Every player faces every other player.
```
— [`mobile/src/lib/tournament.ts:383`](../../mobile/src/lib/tournament.ts#L383) (`FORMAT_META.round_robin.description`)

Bracket Seeding hint text (shown when creating a tournament):

```
PLUPR-based: Determines bracket structure and which players face off in
each round. Players are sorted by PLUPR; pools and brackets use
snake-draft so the top seed faces the bottom seed and skill levels stay
balanced across pools.

Random draw: Determines bracket structure and which players face off in
each round. Players are drawn randomly into pools and bracket slots.
```
— [`mobile/src/screens/CreateTournamentScreen.tsx:343-347`](../../mobile/src/screens/CreateTournamentScreen.tsx#L343-L347)

Playoff Format hint text (shown when creating a `round_robin` or `pool_play` tournament — picker lives in the "Playoff Format" section of `CreateTournamentScreen.tsx`, just after the Pool Count section):

```
None:   No playoff — final standings come straight from group play.
Top 2:  Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4).
Top 4:  Semifinals + Finals.
Top 8:  Quarterfinals + Semifinals + Finals.
```
— [`mobile/src/screens/CreateTournamentScreen.tsx`](../../mobile/src/screens/CreateTournamentScreen.tsx) (Playoff Format section)

The picker is backed by the `tournaments.playoff_format` column (NOT NULL, default `'none'`, CHECK in `('none','top_2','top_4','top_8')`), added in [`supabase/migration_add_playoff_format.sql`](../../supabase/migration_add_playoff_format.sql). Only the four single-elim variants are currently in the check constraint; the Double Elim variants discussed below (RR-5, RR-7) are **proposed only** and not yet a valid column value.

The doc below elaborates on these short app descriptions with round-by-round math, schedule formulas, and edge cases. RR-1..RR-7 all use Single RR (each pair plays once); RR-8 swaps in Double RR (each pair plays twice).

---

This appendix covers every permutation built on a **Larger Format = `round_robin`** spine.
It expands codes **RR-1 through RR-8** from [`../tournament-formats.md`](../tournament-formats.md).

Each permutation = `Larger Format` + `Additional Format` + `Playoff Format`.

| Code  | Larger      | Additional | Playoff                       |
|-------|-------------|------------|-------------------------------|
| RR-1  | round_robin | Single RR  | none                          |
| RR-2  | round_robin | Single RR  | Top 2 Final                   |
| RR-3  | round_robin | Single RR  | Top 2 Final + 3rd Place Match |
| RR-4  | round_robin | Single RR  | Top 4 Single Elim             |
| RR-5  | round_robin | Single RR  | Top 4 Double Elim (NEW)       |
| RR-6  | round_robin | Single RR  | Top 8 Single Elim             |
| RR-7  | round_robin | Single RR  | Top 8 Double Elim (NEW)       |
| RR-8  | round_robin | Double RR  | any of the above              |

> Conventions used below
> - **N** = number of entrants (players or doubles teams).
> - Single RR match count: `M_rr = N(N-1)/2`. Round count with optimal pairing: `R_rr = N-1` if N is even, `R_rr = N` if N is odd (one entrant has a BYE each round).
> - All durations assume **30 minutes per match** end-to-end (warmup + play + score entry).
> - Court parallelism is capped at `floor(N/2)` for a single round.

Cross-references:
- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) — RR-5 and RR-7 lean on this.
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — head-to-head, point differential, and BYE handling rules live there.
- [Schedule Formulas](./schedule-formulas.md) — parallelism cross-table and court-count budgeting.

---

## RR-1: Single RR, no playoff

App mapping: `playoff_format = 'none'` in the Playoff Format picker (the default).

The simplest format. Everyone plays everyone once; final standings come straight from RR record. No bracket overhead, no win-and-in pressure — pure aggregate performance.

### Worked example (N = 8)

- Entrants: P1 .. P8.
- Total matches: `8 * 7 / 2 = 28`.
- Rounds: `8 - 1 = 7` (8 is even, perfect pairing each round).
- Final standings = RR record sorted by wins, then tiebreakers (see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md)).

### Math

```
M_total = N(N-1)/2
R_total = N-1   if N even
        = N     if N odd  (one BYE per round)
```

For N = 8: `M_total = 28`, `R_total = 7`.

### Diagram

```
        Round 1   Round 2   Round 3   ...   Round 7
        -------   -------   -------         -------
Court 1 P1-P2     P1-P3     P1-P4     ...   P1-P8
Court 2 P3-P4     P2-P5     P2-P6     ...   P2-P3
Court 3 P5-P6     P4-P8     P3-P5     ...   P4-P5
Court 4 P7-P8     P6-P7     P7-P8     ...   P6-P7
   │
   └── 4 matches/round × 7 rounds = 28 matches → Final Standings

Pairings follow the standard "circle method" (P1 fixed, others rotate);
every entrant meets every other exactly once across the 7 rounds.
```

### Edge cases

- **Odd N**: rotate a virtual BYE; the entrant paired with BYE skips that round. Every entrant still plays the same number of real matches (`N-1`), so a straight win count remains comparable across the field.
- **Ties**: resolved per [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) (head-to-head, point diff, points scored).
- **Withdrawals mid-tournament**: remaining unplayed matches of the withdrawn entrant are typically forfeited (counted as losses for them, wins for opponents) OR voided uniformly — pick one rule before the event starts.

### Schedule implications

- Parallelism: up to `N/2 = 4` matches simultaneously (needs 4 courts).
- Duration with 4 courts: `7 rounds * 30 min = 3.5 h`.
- Duration with 2 courts: `28 matches / 2 = 14 slots * 30 min = 7 h`.
- Duration with 1 court: `28 * 30 min = 14 h` (split over multiple days).

See [Schedule Formulas](./schedule-formulas.md) for the full parallelism cross-table.

---

## RR-2: Single RR + Top 2 Final

App mapping: `playoff_format = 'top_2'` in the Playoff Format picker. Note that the shipped `top_2` hint bundles the Final with the 3rd-place match, so RR-2 as a Final-only variant is conceptual — the picker always produces the RR-3 shape.

After the RR concludes, the top 2 finishers play a one-match Final. Everyone else freezes at their RR-derived rank.

### Worked example (N = 8)

- RR: `28 matches`, `7 rounds`.
- Playoff: **1 match** (#1 RR seed vs #2 RR seed).
- Total: `29 matches`.
- Ranks 3..8 are set by RR record at the close of the round-robin.

### Math

```
M_total = N(N-1)/2 + 1
R_total = (N-1 or N) + 1   playoff is a single additional round
```

For N = 8: `M_total = 29`, `R_total = 8` rounds.

### Diagram

```
       ┌──────────────────────┐
       │  Single Round Robin  │   (28 matches over 7 rounds)
       │      (8 players)     │
       └──────────┬───────────┘
                  │
       Seeds 1, 2 advance
                  │
                  ▼
             ┌─────────┐
             │  FINAL  │   Seed1 vs Seed2 → Champion
             └─────────┘
```

### Edge cases

- **Tie for #1 or #2**: must be broken before seeding the Final — defer to [Seeding & Tiebreakers](./seeding-and-tiebreakers.md). Head-to-head between the tied entrants is the first lever.
- **Withdrawal of a finalist**: next-highest RR seed steps in.
- **Odd N in RR**: BYE rotation only affects RR scheduling, not the Final.

### Schedule implications

- Final is a single match on one court. Other courts idle (or used for a parallel 3rd-place exhibition — but that is RR-3).
- Add `~30 min` to total duration.

---

## RR-3: Single RR + Top 2 Final + 3rd Place Match

App mapping: `playoff_format = 'top_2'` in the Playoff Format picker. The shipped Top 2 hint text — "Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4)" — describes exactly this permutation.

Adds a single bronze-medal match between RR seeds #3 and #4, ideally played in parallel with the Final.

### Worked example (N = 8)

- RR: `28 matches`, `7 rounds`.
- Playoff: **2 matches** (Final + 3rd place), playable in parallel.
- Total: `30 matches`, `8 rounds` (playoff fits in one round if 2 courts available).

### Math

```
M_total = N(N-1)/2 + 2
R_total = R_rr + 1   if >= 2 courts available
        = R_rr + 2   if 1 court (Final and bronze run back-to-back)
```

For N = 8 with 2+ courts: `M_total = 30`, `R_total = 8`.

### Diagram

```
       ┌──────────────────────┐
       │  Single Round Robin  │
       │      (8 players)     │
       └──────────┬───────────┘
                  │
       Seeds 1..4 advance
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   ┌─────────┐         ┌──────────┐
   │  FINAL  │         │  BRONZE  │
   │ S1 vs S2│         │ S3 vs S4 │
   └─────────┘         └──────────┘
```

### Edge cases

- **Tie at #4/#5 boundary**: tiebreak determines who plays the bronze match vs who finishes 5th.
- **Withdrawal**: replacement comes from next RR seed (e.g., S5 fills in for S4).

### Schedule implications

- Parallelism: 2 matches on 2 courts in the same slot.
- Adds `~30 min` (parallel) or `~60 min` (single court) to RR duration.

---

## RR-4: Single RR + Top 4 Single Elim

App mapping: `playoff_format = 'top_4'` in the Playoff Format picker (hint: "Semifinals + Finals.").

Top 4 RR seeds enter a 4-player single-elimination bracket. Standard pairing: **1v4** and **2v3** in semifinals, winners meet in the Final. Most events also schedule a 3rd-place match between the semifinal losers (kept as part of the Top 4 SE convention).

### Worked example (N = 12)

- RR: `12 * 11 / 2 = 66 matches`, `R_rr = 11` rounds.
- Playoff: **4 matches** — 2 semifinals + Final + 3rd-place. (If 3rd-place is omitted, playoff = 3 matches; the format here assumes it is included.)
- Total: `70 matches`.
- Rounds: `11 RR + 2 playoff rounds = 13` (semis in one round on 2 courts, then Final + bronze in another round).

### Math

```
M_playoff = 4    (SF1, SF2, Final, Bronze)
M_total   = N(N-1)/2 + 4
R_playoff = 2    (SFs round, then Final/Bronze round) given >= 2 courts
```

For N = 12: `M_total = 70`, `R_total = 13`.

### Diagram

```
   RR seeds 1..4 enter:

   S1 ──┐
        ├── SF1 ──┐
   S4 ──┘         │
                  ├── FINAL ── Champion
   S2 ──┐         │
        ├── SF2 ──┘
   S3 ──┘

   SF losers ──── BRONZE ── 3rd place
```

### Edge cases

- **Ties at the 4/5 boundary**: tiebreak decides who makes the playoff bracket; see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md).
- **Ties inside top 4 (e.g., 1/2 tied)**: seed by tiebreak rules. Worst case is a "play-in" slot, but with only 4 spots a strict tiebreak is preferred to a play-in match.
- **Withdrawal of a seeded playoff entrant**: next RR seed slides up (S5 → S4 slot), bracket positions stay the same.

### Schedule implications

- Playoff parallelism: 2 simultaneous semifinals, then Final + bronze in parallel.
- Court need: 2 courts comfortably finish the playoff in `~60 min`.
- Total duration on 4 courts for N = 12: `(11 RR rounds + 2 playoff rounds) * 30 min = 6.5 h`.

---

## RR-5: Single RR + Top 4 Double Elim (NEW losers-bracket playoff)

App mapping: **proposed only — not yet in the column enum.** The `tournaments.playoff_format` CHECK constraint currently allows only `('none','top_2','top_4','top_8')`; a `top_4_de` value would need to be added (plus a matching picker pill in `CreateTournamentScreen.tsx`) before this permutation can be created in-app.

Same Top 4 cut as RR-4, but the playoff is a double-elimination bracket: a loss drops you to the losers' bracket; you are out only after a second loss. See [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for the full bracket-management rules (true-final / "if-necessary" match handling, seeding into the losers' side, etc.).

### Worked example (N = 12)

- RR: `66 matches`, `11 rounds`.
- Playoff: **6 or 7 matches** for a 4-team double elim:
  - WB SF1, WB SF2  (2 matches)
  - WB Final        (1 match)
  - LB Round 1 (the 2 WB losers play)  (1 match)
  - LB Final (WB Final loser vs LB R1 winner)  (1 match)
  - Grand Final     (1 match)
  - Grand Final reset (only if LB champion wins) — adds **1 more match** to reach 7.
- Worst-case total: `66 + 7 = 73 matches`.

### Math

```
M_playoff_min = 6   (no reset needed)
M_playoff_max = 7   (reset triggered)
M_total       = N(N-1)/2 + 6 or 7
R_playoff     = 4 to 5 rounds (see diagram)
```

For N = 12: total matches = **72 or 73**; total rounds = **15 or 16**.

### Diagram

```
   Winners Bracket            Losers Bracket
   ----------------           --------------
   S1 ─┐
       WB-SF1 ─┐
   S4 ─┘      │
              WB-FINAL ─── WB Champion ─┐
   S2 ─┐      │                         │
       WB-SF2 ┘                         │
   S3 ─┘                                ▼
                                   ┌────────────┐
   WB-SF1 loser ─┐                 │  GRAND     │
                 LB-R1 ─┐          │  FINAL     │
   WB-SF2 loser ─┘      │          │            │
                        LB-FINAL ──┤            │
   WB-FINAL loser ──────┘          │            │
                                   └─────┬──────┘
                                         │
                              (if LB side wins,
                               play RESET match)
```

### Edge cases

- **Reset match**: required only when the entrant from the losers' bracket wins the first Grand Final (they have one loss; the WB winner has none). This is the canonical double-elim rule; the [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) doc owns the implementation details.
- **Ties at 4/5 boundary**: identical handling to RR-4.
- **Withdrawals during playoff**: a withdrawn entrant forfeits the current match; if they are mid-bracket, the opponent advances and the empty bracket slot is treated as a BYE in subsequent rounds.

### Schedule implications

- Playoff parallelism: 2 matches in WB SF round, then 1 court used per remaining round.
- Court need for playoff: 2 courts comfortably; 1 court works but doubles the playoff duration.
- Total duration on 4 courts for N = 12: `11 RR rounds * 30 min + 4-5 playoff rounds * 30 min = 7.5 - 8 h`.

---

## RR-6: Single RR + Top 8 Single Elim

App mapping: `playoff_format = 'top_8'` in the Playoff Format picker (hint: "Quarterfinals + Semifinals + Finals.").

Same as RR-4 with a wider cut. Top 8 RR seeds enter an 8-team single-elim bracket: 1v8, 4v5, 2v7, 3v6 in QFs (standard re-seeded pairing), then SFs, then Final. A 3rd-place match between the two semi-final losers is included by convention.

### Worked example (N = 16)

- RR: `16 * 15 / 2 = 120 matches`, `R_rr = 15` rounds.
- Playoff: **8 matches** (4 QFs + 2 SFs + Final + Bronze).
- Total: `128 matches`.
- Rounds: `15 RR + 3 playoff rounds = 18`.

### Math

```
M_playoff = 8
M_total   = N(N-1)/2 + 8
R_playoff = 3   (QFs, SFs, Final+Bronze)  given >= 4 courts for QFs and >= 2 for finals
```

For N = 16: `M_total = 128`, `R_total = 18`.

### Diagram

```
   QF round (4 matches, 4 courts)
   ─────────────────────────────────
   S1 ──┐
        QF1 ──┐
   S8 ──┘    │
             SF1 ──┐
   S4 ──┐    │    │
        QF2 ──┘    │
   S5 ──┘         │
                  FINAL ── Champion
   S2 ──┐         │
        QF3 ──┐    │
   S7 ──┘    │    │
             SF2 ──┘
   S3 ──┐    │
        QF4 ──┘
   S6 ──┘

   SF losers ───── BRONZE ── 3rd place
```

### Edge cases

- **Tie at 8/9 boundary**: tiebreak decides who claims the last playoff spot.
- **Multi-way ties in mid-bracket seeds**: resolve before placing into bracket lines; otherwise seedings inside QFs may flip.
- **Withdrawal**: next RR seed slides up into the vacated bracket slot.

### Schedule implications

- Playoff parallelism: 4 simultaneous QFs (4 courts), then 2 SFs (2 courts), then Final + bronze in parallel.
- Total duration on 4 courts for N = 16: `(15 + 3) * 30 min = 9 h`.

---

## RR-7: Single RR + Top 8 Double Elim (NEW)

App mapping: **proposed only — not yet in the column enum.** Like RR-5, this needs a new `top_8_de` value added to the `tournaments.playoff_format` CHECK constraint (and a matching picker pill) before it can be created in-app.

Top 8 RR seeds enter an 8-team double-elim bracket. See [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for bracket plumbing.

### Worked example (N = 16)

- RR: `120 matches`, `15 rounds`.
- Playoff: **14 or 15 matches** for an 8-team double elim:
  - WB: 4 QFs + 2 SFs + 1 WB Final = **7**
  - LB: 6 matches across 4 LB rounds (LB R1 has 2, LB R2 has 2 with WB-QF losers dropping in, LB R3 has 1, LB Final has 1) = **6**
  - Grand Final: 1 (+1 reset if needed) = **1 or 2**
  - Sub-total: **14** without reset, **15** with reset.
- Worst-case total: `120 + 15 = 135 matches`.

### Math

```
M_playoff_min = 14   (no reset)
M_playoff_max = 15   (reset)
M_total       = N(N-1)/2 + 14 or 15
R_playoff     = 7 to 8 rounds (WB and LB rounds interleave)
```

For N = 16: total = **134 or 135 matches**, **22 or 23 rounds**.

### Diagram (compact)

```
   Winners Bracket                    Losers Bracket
   ----------------                   --------------
   S1 ─┐                              QF losers drop in over LB rounds
       QF1 ─┐                         LB R1: lose-QF1 vs lose-QF2
   S8 ─┘   │                          LB R1: lose-QF3 vs lose-QF4
           SF1 ─┐                     LB R2: LB-R1 winners vs SF losers
   S4 ─┐   │   │                      LB R3: LB-R2 winners play
       QF2 ┘   │                      LB Final: LB-R3 winner vs WB-Final loser
   S5 ─┘       │
               WB-FINAL ─── WB champ ─┐
   S2 ─┐       │                      │
       QF3 ─┐  │                      │
   S7 ─┘   │  │                       ▼
           SF2 ┘                  ┌──────────┐
   S3 ─┐   │                      │  GRAND   │
       QF4 ┘                      │  FINAL   │
   S6 ─┘                          │  (+reset │
                                  │  if LB   │
                                  │  wins)   │
                                  └──────────┘
```

The exact LB seeding (which QF loser meets which SF loser, which order LB rounds drop into) is owned by [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) — we keep that out of this doc to avoid duplication.

### Edge cases

- **Reset match**: as in RR-5, triggered only when the entrant emerging from LB wins the first Grand Final.
- **Ties at 8/9 boundary**: same as RR-6.
- **Withdrawal mid-LB**: opponent advances; if a future LB drop-in would land on the withdrawn slot, treat as a BYE.

### Schedule implications

- Playoff parallelism: peaks at 4 courts (QF round). LB and WB rounds can run concurrently mid-bracket if courts are available.
- Court need: 4 courts to finish playoff in `7-8 * 30 min = ~4 h`. 2 courts roughly doubles playoff duration.
- Total duration on 4 courts for N = 16: `15 RR + 7-8 playoff = ~11 - 11.5 h`.

---

## RR-8: Double RR (NEW additional format) + any playoff

The Additional Format slot changes from Single RR to **Double Round Robin**: every entrant plays every other entrant **twice**. Combined record across both RR cycles produces seeds. Any of the playoff formats from RR-2 .. RR-7 (or no playoff at all) can sit on top.

### Worked example (N = 8, no playoff i.e. RR-1 with Double RR)

- Total matches: `2 * (8 * 7 / 2) = 56`.
- Rounds: `2 * 7 = 14` if perfect pairing each round.
- Final standings = combined record sorted by wins, then tiebreakers.

### Worked example (N = 8, with Top 4 Single Elim playoff i.e. RR-4-shaped on top)

- RR matches: `56`.
- Playoff matches: `4` (2 SFs + Final + Bronze).
- Total: `60` matches, `14 RR rounds + 2 playoff rounds = 16 rounds`.

### Math

```
M_rr_double = N(N-1)        (twice the single RR count)
R_rr_double = 2(N-1)        if N even
            = 2N            if N odd

M_total = M_rr_double + M_playoff
        where M_playoff is taken from RR-1..RR-7 (0, 1, 2, 4, 6-7, 8, or 14-15)
R_total = R_rr_double + R_playoff
```

For N = 8 with Top 4 SE playoff: `M_total = 60`, `R_total = 16`.
For N = 12 with Top 8 DE playoff: `M_total = 12*11 + 14-15 = 146 or 147` matches.

### Diagram

```
       ┌─────────────────────────┐
       │   RR Cycle 1            │   N(N-1)/2 matches
       │   (everyone vs everyone)│
       └─────────────┬───────────┘
                     │
                     ▼
       ┌─────────────────────────┐
       │   RR Cycle 2            │   N(N-1)/2 matches
       │   (pairings repeat;     │   (often with swapped sides /
       │    second leg)          │    home-away analog)
       └─────────────┬───────────┘
                     │
            Combined record
                     │
                     ▼
       ┌─────────────────────────┐
       │  Playoff (any of        │   Per the chosen playoff
       │  none, Top2 final,      │   format from RR-1..RR-7
       │  Top2+3rd, Top4 SE,     │
       │  Top4 DE, Top8 SE,      │
       │  Top8 DE)               │
       └─────────────────────────┘
```

### Edge cases

- **Odd N**: BYEs rotate across **both** cycles. Every entrant still ends with `2(N-1)` real RR matches.
- **Ties**: more matches typically mean fewer ties, but the same tiebreak chain applies — see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md).
- **Mid-cycle withdrawal**: same forfeit-vs-void choice as single RR, but the decision affects roughly twice as many unplayed matches; declare the rule before play starts.
- **Asymmetry between cycles** (e.g., one cycle delayed by weather): combined record still works as long as every pairing is played the planned number of times. If the second cycle cannot be completed in full, fall back to single-cycle standings (i.e., treat as RR-1..RR-7).

### Schedule implications

- Parallelism is the same as single RR (`N/2` matches per round), but total rounds **double**.
- For N = 8, 4 courts: `14 RR rounds * 30 min = 7 h` of RR play, plus chosen playoff.
- For N = 12, 4 courts, Top 8 DE: `2 * 11 RR rounds + 7-8 playoff rounds = ~30 rounds * 30 min = 15 h` — typically split across 2-3 days.

See [Schedule Formulas](./schedule-formulas.md) for full parallelism numbers including doubled-RR cases.

---

## Quick reference table

For N = 12 (where applicable; for the Top 8 variants N = 16 is shown):

| Code | RR matches | Playoff matches | Total matches | Rounds (4 courts) |
|------|-----------:|----------------:|--------------:|------------------:|
| RR-1 |         66 |               0 |            66 |                11 |
| RR-2 |         66 |               1 |            67 |                12 |
| RR-3 |         66 |               2 |            68 |                12 |
| RR-4 |         66 |               4 |            70 |                13 |
| RR-5 |         66 |          6 or 7 |     72 or 73 |          15 or 16 |
| RR-6 (N=16) | 120 |               8 |           128 |                18 |
| RR-7 (N=16) | 120 |        14 or 15 |   134 or 135 |          22 or 23 |
| RR-8 (N=12, Top4 SE) | 132 |       4 |           136 |                24 |

Numbers are *upper-bound rounds* assuming 4 courts; with more courts the playoff rounds shrink slightly. For any other N, plug into the formulas above.

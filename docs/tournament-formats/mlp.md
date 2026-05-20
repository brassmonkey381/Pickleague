# MLP Deep-Dive (MLP-1 .. MLP-12)

This appendix expands every MLP permutation enumerated in
[`../tournament-formats.md`](../tournament-formats.md) into worked examples
with match-count math, ASCII diagrams, edge cases, and scheduling
implications. It covers both:

- **`mlp` (Fixed Teams)** — captains build rosters of 4 (2M + 2W). Teams
  are saved in `public.mlp_teams` with `status = 'locked'`.
- **`mlp_random` (Random Teams)** — same shape, but rosters are
  auto-generated from the entrant pool (still 2M + 2W per team).

The only flow difference between the two variants is *how the four-player
rosters are formed*. Once the locked roster set exists, every play
format, standings calculation, and playoff bracket is identical. The rest
of this document treats them as one and does not repeat the distinction
per permutation.

## App descriptions (source of truth)

The Pickleague mobile app shows the canonical user-facing copy when
admins create a tournament. This doc must stay aligned with these
strings. If anything below contradicts the app text, the app wins.

### Format labels (`mobile/src/lib/tournament.ts:387-388`)

```
mlp:        'Teams of 4 (2M + 2W). Captains form rosters and lock in.'
mlp_random: 'Teams of 4 auto-generated from approved players (random or snake-draft) with wacky names.'
```

### MLP Play Format hints (`mobile/src/screens/CreateTournamentScreen.tsx:359-367`)

```
round_robin:          'Every team plays every team once. Final standings by sub-matches won.'
pool_play:            'Teams split into pools, round-robin within each pool. Final standings by combined pool W-L.'
round_robin_playoff:  'Round-robin first, then the top teams advance to a single-elim playoff (quarters / semis / finals).'
pool_play_playoff:    'Pool play first, then the top teams from each pool advance to a single-elim playoff.'
```

### Number of Pools — MLP only (`mobile/src/screens/CreateTournamentScreen.tsx:369-378`)

```
Pool count options: 2, 3, or 4
Hint: 'Teams are snake-drafted into pools by seed so each pool is balanced.'
```

Note: non-MLP `pool_play` exposes `{2, 3, 4, 6}`, but MLP pool play is
capped at **4**. Worked examples below use `P ∈ {2, 4}`.

### Playoff Size hints (`mobile/src/screens/CreateTournamentScreen.tsx:389-393`)

```
Top 2: 'Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4).'
Top 4: 'Semifinals + Finals.'
Top 8: 'Quarterfinals + Semifinals + Finals.'
```

Only **Top 2** declares a Third Place Match in the current app. **Top 4**
is semis-into-final only; **Top 8** is QFs-SFs-Final only. There is no
3PM in MLP-4 / MLP-5 / MLP-9 / MLP-10 today.

MLP tournaments use the dedicated `mlp_playoff_teams` column (2/4/8 — see the existing MLP Playoff Size picker). A separate `playoff_format` column was added in PR #49 (`supabase/migration_add_playoff_format.sql`) for non-MLP `round_robin`/`pool_play` tournaments and does NOT apply to MLP. The two columns are mutually exclusive.

## MLP Vocabulary (read this first)

- **Team meeting** — one team-vs-team encounter. Always produces
  **4 sub-matches**: men's doubles, women's doubles, mixed-doubles #1
  (M1+F1 vs M1+F1), mixed-doubles #2 (M2+F2 vs M2+F2). See
  `_insert_mlp_pairing_matches` in
  `supabase/migration_mlp_play_formats.sql`.
- **Sub-match** — one of the four rows inserted into
  `tournament_matches` for a team meeting. Each is an individual doubles
  match (best-of-N games per the league's match config; see commit
  `4bad293` — W/L counting is per-game).
- **Standings score** — `mlp_team_standings` sums sub-matches won and
  lost. A team that wins 4-0 across a meeting collects four wins; a team
  that wins 3-1 collects three wins and one loss. Final tournament
  standings order by `sub_matches_won DESC, sub_matches_lost ASC, seed`.
- **Court-hungry** — a single team meeting wants **four courts at once**
  to run all sub-matches in parallel. With fewer courts a meeting takes
  multiple time slots.
- **Dreambreaker** — at the actual MLP league level a 2-2 team meeting
  triggers a *Dreambreaker* singles tiebreaker. **The Pickleague schema
  does not currently implement a Dreambreaker** (no fifth match row, no
  singles column on `mlp_teams`). A 2-2 team meeting therefore counts as
  a 2-2 standings split with no overall team-meeting winner. See "Open
  Questions" at the bottom.

## Court & Schedule Cheat Sheet

| Concurrent courts | Time per team meeting (assuming each sub-match = 1 slot) |
|---|---|
| 4 | 1 slot (all 4 sub-matches at once — the MLP ideal) |
| 2 | 2 slots |
| 1 | 4 slots (effectively kills MLP for serious play) |

If a venue cannot guarantee 4 courts during MLP windows, the practical
fallback is to run **2 sub-matches in parallel × 2 time blocks per
meeting**. See [Schedule Formulas](./schedule-formulas.md) for the
court-allocation formula.

---

## MLP-1 — Round Robin + No Playoff

`mlp_play_format = 'round_robin'`, `mlp_playoff_teams = (unused)`.

Every team plays every other team exactly once. Standings come straight
from `mlp_team_standings` (sub-match wins, then losses, then seed).

### Worked Example — 6 teams (24 players)

- 6 teams → 6 × 5 / 2 = **15 team meetings**.
- 15 × 4 = **60 sub-matches** total.
- Team-rounds = N - 1 = **5 rounds** in a perfectly parallelized
  schedule (each round = 3 simultaneous team meetings).

```
                    Round Robin (6 teams)
        T1   T2   T3   T4   T5   T6
   T1    -    M    M    M    M    M
   T2    -    -    M    M    M    M
   T3    -    -    -    M    M    M
   T4    -    -    -    -    M    M
   T5    -    -    -    -    -    M
   T6    -    -    -    -    -    -
                (M = 1 team meeting = 4 sub-matches)
```

### Schedule implications

- A single round of 3 parallel meetings wants 3 × 4 = **12 courts** to
  finish in one slot. Most venues will need to halve that and use two
  time blocks per round.
- 5 rounds × 2 blocks = 10 time blocks minimum for 6 teams on 6 courts.

### Edge cases

- **Odd team count (5, 7, ...):** at least one team draws a bye each
  round. The SQL `generate_mlp_bracket` does not insert a placeholder
  bye row — the bye team simply does not appear in that round's
  meetings.
- **Missing player at a team meeting:** the absent player's sub-matches
  cannot be played as scheduled. Today the admin records those sub-
  matches as a default loss (no forfeit primitive yet — open question).
- **Dreambreaker on 2-2 splits:** not implemented. A 2-2 meeting yields
  +2 / -2 for both teams in standings, and ties cascade through the
  `sub_matches_won DESC, sub_matches_lost ASC, seed` ordering.

See [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) for how
identical W-L records resolve.

---

## MLP-2 — Pool Play + No Playoff

`mlp_play_format = 'pool_play'`, `mlp_pool_count = P` (2, 3, or 4 in the
current app — see ["App descriptions"](#app-descriptions-source-of-truth)).
No playoff.

Teams are snake-drafted into P pools by `seed` (`created_at` order on
locked teams). Within each pool, every team plays every other team in
that pool. **Final standings come from within-pool order only** — there
is no cross-pool merge step in this format.

### Worked Example — 8 teams, P = 2 pools

- Snake draft by seed: Pool A = seeds {1, 4, 5, 8}; Pool B = {2, 3, 6, 7}.
- Within-pool meetings = 4 × 3 / 2 = **6 meetings per pool** × 2 pools =
  **12 meetings** total.
- 12 × 4 = **48 sub-matches**.
- Pool rounds = 4 - 1 = **3 within-pool rounds**.

```
   Pool A (seeds 1,4,5,8)         Pool B (seeds 2,3,6,7)
        T1  T4  T5  T8                T2  T3  T6  T7
    T1   -   M   M   M             T2  -   M   M   M
    T4   -   -   M   M             T3  -   -   M   M
    T5   -   -   -   M             T6  -   -   -   M
    T8   -   -   -   -             T7  -   -   -   -
```

### Schedule implications

- Both pools run in parallel, so a true round wants 2 simultaneous
  meetings × 4 courts = **8 courts**.
- On 4 courts, expect 2 slots per round × 3 rounds = 6 slots.

### Edge cases

- **Odd team count or non-divisible team count:** snake draft assigns
  teams left-to-right then right-to-left in seed order. If the count is
  not a multiple of P, the later pools end up with fewer teams and so
  fewer within-pool meetings.
- **Cross-pool ranking is undefined** in MLP-2 — there's no winner
  declared across pools. Each pool has its own champion. Use MLP-8/9/10
  if you want a unified champion.

---

## MLP-3 — Round Robin → Top 2 Final (+ 3PM)

`mlp_play_format = 'round_robin_playoff'`, `mlp_playoff_teams = 2`.

Full RR, then top 2 in standings play one Final. The migration's
`generate_mlp_playoff` only writes a `finals` round in this branch; a
third-place match exists for the MLP top-2 playoff as a separate round
(see "What Already Exists" in the index doc).

### Worked Example — 4 teams

- RR: 4 × 3 / 2 = **6 meetings = 24 sub-matches**, in 3 rounds.
- Playoff: **Final** (1 meeting) + **3rd-place match** (1 meeting) =
  2 meetings = 8 sub-matches.
- Total: **8 meetings = 32 sub-matches**.

```
   Round Robin standings (after 6 meetings)
        ╔════════════╗
        ║ 1.  Team A ║──┐
        ║ 2.  Team B ║──┼─ Final (A vs B)
        ║ 3.  Team C ║──┼─ 3PM (C vs D)
        ║ 4.  Team D ║──┘
        ╚════════════╝
```

### Schedule implications

- Final + 3PM both want 4 courts each. Run them in parallel only if you
  have 8 courts; otherwise back-to-back.

### Edge cases

- Ties for #2 vs #3 propagate through the standings comparator. If two
  teams tie on W/L and seed, neither has a deterministic placement —
  document the tiebreaker explicitly in [Seeding &
  Tiebreakers](./seeding-and-tiebreakers.md).

---

## MLP-4 — Round Robin → Top 4 (Semifinals SE)

`mlp_play_format = 'round_robin_playoff'`, `mlp_playoff_teams = 4`.

### Worked Example — 6 teams (24 players)

- RR: 15 meetings = **60 sub-matches**, in 5 rounds.
- Playoff: 2 Semis + 1 Final = 3 meetings = 12 sub-matches.
- Total: **18 meetings = 72 sub-matches**.

```
   RR standings →    SF1: 1 vs 4 ──┐
                                   ├── Final: SF1.W vs SF2.W
                     SF2: 2 vs 3 ──┘
```

### Schedule implications

- Two semis in parallel = 8 courts ideal. If only 4 courts, run SF1
  then SF2 back-to-back.

### Edge cases

- Pairings come from `generate_mlp_playoff`: round-1 pairs are 1-vs-N,
  2-vs-(N-1), so top seed always plays bottom seed.

---

## MLP-5 — Round Robin → Top 8 (Quarters SE)

`mlp_play_format = 'round_robin_playoff'`, `mlp_playoff_teams = 8`.

### Worked Example — 10 teams (40 players)

- RR: 10 × 9 / 2 = **45 meetings = 180 sub-matches**, in 9 rounds.
- Playoff: 4 QFs + 2 SFs + 1 Final = 7 meetings = 28 sub-matches.
- Total: **52 meetings = 208 sub-matches**.

```
   QF1: 1 vs 8 ─┐
                ├─ SF1 ─┐
   QF2: 4 vs 5 ─┘       │
                        ├─ Final
   QF3: 2 vs 7 ─┐       │
                ├─ SF2 ─┘
   QF4: 3 vs 6 ─┘
```

### Schedule implications

- Four QFs simultaneously = 16 courts. Realistically, run them in two
  waves of 2 (8 courts) or four singletons.
- MLP-5 is the upper bound of the "pure SE" MLP playoff today —
  a 10-team field on 4 courts is already a multi-day event.

### Edge cases

- Re-seeding between rounds: today the bracket is fixed at QF
  generation; upsets do not change SF pairings.

---

## MLP-6 — Round Robin → Top 4 Double Elim **(NEW)**

`mlp_play_format = 'round_robin_playoff'`, `mlp_playoff_teams = 4`,
proposed `playoff_format = 'top_4_de'`.

Same RR as MLP-4. The 4 advancing teams enter a 4-team double-elim
bracket instead of a single-elim semifinal. See
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for the
full bracket structure and grand-final reset toggle.

### Worked Example — 6 teams

- RR: 15 meetings = 60 sub-matches (same as MLP-4).
- Playoff (4-team DE):
  - WB Semis: 2 meetings
  - WB Final: 1 meeting
  - LB Round 1: 1 meeting (the two WB semi losers play)
  - LB Final: 1 meeting (LB R1 winner vs WB Final loser)
  - Grand Final: 1 meeting (always)
  - Grand Final Reset: 0 or 1 meeting (only if LB-champ wins GF1)
- Total playoff meetings: **6 or 7** = 24 or 28 sub-matches.
- Tournament total: 21 or 22 meetings = **84 or 88 sub-matches**.

```
   Winners Bracket
     WSF1: 1 vs 4 ──┐
                    ├─ WF: WSF1.W vs WSF2.W ─────────┐
     WSF2: 2 vs 3 ──┘                                │
                                                     ├─ GF1
   Losers Bracket                                    │   │
     LR1: WSF1.L vs WSF2.L                           │   │
     LF:  LR1.W vs WF.L  ────────────────────────────┘   │
                                                         │
                                          (optional) GF2─┘
                                          when LB-champ wins GF1
```

### Schedule implications

- DE has 1-2 more rounds than SE, each still wanting 4 courts.
- LB and WB rounds interleave: LR1 cannot start until both WB semis
  finish, and the LB Final cannot start until the WB Final finishes.
- Total court-time roughly **1.5×** the SE equivalent. For a 6-team
  league on 4 courts plan **~1.5 extra time blocks**.

### Edge cases

- **Bracket reset toggle:** the existing `_advance_double_elim_bracket`
  trigger already supports both modes (see DE-1 / DE-2 in the index
  doc). MLP-6 should expose the same toggle.
- **Three-loss safety:** double elim guarantees the champion has at
  most one loss (or two if the bracket resets). For MLP this means
  the champ won at least *two* full team meetings, mitigating the
  single-upset risk that plagues SE playoffs.

---

## MLP-7 — Round Robin → Top 8 Double Elim **(NEW)**

`mlp_play_format = 'round_robin_playoff'`, `mlp_playoff_teams = 8`,
proposed `playoff_format = 'top_8_de'`.

8-team double-elim bracket layered on top of full RR.

### Worked Example — 10 teams

- RR: 45 meetings = 180 sub-matches (same as MLP-5).
- Playoff (8-team DE):
  - WB Quarters: 4 meetings
  - WB Semis: 2 meetings
  - WB Final: 1 meeting
  - LB Round 1: 2 meetings (4 WB-QF losers play)
  - LB Round 2: 2 meetings (LB R1 winners vs 2 WB-SF losers)
  - LB Semi: 1 meeting
  - LB Final: 1 meeting (LB Semi winner vs WB Final loser)
  - Grand Final: 1 meeting
  - GF Reset: 0 or 1 meeting
- Total playoff: **14 or 15 meetings** = 56 or 60 sub-matches.
- Tournament total: 59 or 60 meetings = **236 or 240 sub-matches**.

```
   WB:  QF1 ─┐                        LB drops in at each WB round.
            SF1 ─┐                    LB rounds = 4 (R1, R2, Semi, Final).
        QF2 ─┘   │
                 WF ─────────────┐
        QF3 ─┐                   │
            SF2 ─┐               GF1 ── (optional) GF2
        QF4 ─┘   │               │
                 (WF feeds LB Final loser)
   LB:  R1(2 mtgs) → R2(2 mtgs) → Semi(1) → LF(1)
```

See [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) for
exact LB drop-in rules and round numbering.

### Schedule implications

- 4 WB quarterfinals in parallel = 16 courts. On 4 courts, the QFs
  alone take 4 time blocks. Realistic 8-team DE MLP playoffs are
  effectively a full day on their own.
- LB matches happen between WB rounds. Total court demand stays at
  4 simultaneous matches at a time (one meeting), but the bracket runs
  for **9 distinct meeting-rounds** vs 3 for MLP-5.

### Edge cases

- Same bracket-reset toggle considerations as MLP-6.
- A team that loses its WB quarter-final must win the full LB path
  (LB R1 → R2 → Semi → Final) plus the Grand Final to take the title —
  5 consecutive wins after one loss.

---

## MLP-8 — Pool Play → Top 2 (Final + 3PM)

`mlp_play_format = 'pool_play_playoff'`, `mlp_pool_count = P`,
`mlp_playoff_teams = 2`.

Pool play seeds the top **1 per pool when P = 2** (so 1 total advances
per pool, 2 advance overall). `generate_mlp_playoff` computes
`v_top_per_pool := greatest(1, v_playoff_n / v_pool_count)` and trims to
`v_playoff_n`.

### Worked Example — 8 teams, P = 2 pools

- Pool play: 12 meetings = 48 sub-matches (as MLP-2).
- Playoff: 1 Final + 1 3PM = 2 meetings = 8 sub-matches.
- Total: **14 meetings = 56 sub-matches**.

```
   Pool A top:  A1 ──┐
                     ├── Final
   Pool B top:  B1 ──┘
   Pool A 2nd:  A2 ──┐
                     ├── 3PM
   Pool B 2nd:  B2 ──┘
```

### Edge cases

- **P = 3 + Top 2:** `v_top_per_pool = max(1, 2/3) = 1`, so only the 3
  pool winners qualify and the array gets trimmed to 2 (drops the
  highest seed by pool-rank ordering). This is a **footgun** —
  documenting it here. If admins really want top 2 with 3 pools, they
  should use MLP-9 (Top 4) or extend the SQL.
- **P = 4 + Top 2:** same footgun — only 2 of 4 pool winners advance.
  (`P = 4` is the current cap for MLP pool play.)

---

## MLP-9 — Pool Play → Top 4 (Semis SE)

`mlp_play_format = 'pool_play_playoff'`, `mlp_pool_count = P`,
`mlp_playoff_teams = 4`.

### Worked Example — 8 teams, P = 2 pools

- Pool play: 12 meetings = 48 sub-matches.
- Top-per-pool = max(1, 4 / 2) = **2 per pool** → 4 teams advance.
- Playoff: 2 SFs + 1 Final = 3 meetings = 12 sub-matches.
- Total: **15 meetings = 60 sub-matches**.

```
   Pool A: A1, A2 ─┐    SF1: A1 vs B2 ─┐
   Pool B: B1, B2 ─┘    SF2: B1 vs A2 ─┴─ Final
                        (crossover seeding: 1 vs 4, 2 vs 3)
```

The current SQL builds pairings as `1-vs-N, 2-vs-(N-1)` on the
concatenated advance array. Because the array is ordered by
`(pool_rank, pool_letter)`, the result is naturally crossover when
P = 2.

### Worked Example — 12 teams, P = 4 pools

- Pool play: 4 pools × 3 meetings/pool = 12 meetings = 48 sub-matches.
- Top-per-pool = max(1, 4 / 4) = **1 per pool** → 4 teams advance
  (the 4 pool winners).
- Playoff: 2 SFs + 1 Final = 3 meetings = 12 sub-matches.
- Total: **15 meetings = 60 sub-matches**.

### Edge cases

- **P = 3 + Top 4:** `v_top_per_pool = max(1, 4/3) = 1`, advances 3
  pool winners, trims to 4 (no trim needed because only 3 are picked).
  This **silently drops the 4th team from the bracket** — likely a
  bug, definitely a footgun. Documenting it in
  [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) §"Pool count
  not a clean divisor".
- Top-per-pool ties (1 vs 2 in a single pool tied on W/L) resolve via
  `sub_matches_lost ASC, seed`.

---

## MLP-10 — Pool Play → Top 8 (Quarters SE)

`mlp_play_format = 'pool_play_playoff'`, `mlp_pool_count = P`,
`mlp_playoff_teams = 8`.

### Worked Example — 12 teams, P = 4 pools

- Pool play: 12 meetings = 48 sub-matches.
- Top-per-pool = max(1, 8/4) = **2 per pool** → 8 teams advance.
- Playoff: 4 QFs + 2 SFs + 1 Final = 7 meetings = 28 sub-matches.
- Total: **19 meetings = 76 sub-matches**.

```
   Pool A: A1, A2    QF1: A1 vs (last)  ┐
   Pool B: B1, B2    QF2: A2 vs (...)   ├── SFs ── Final
   Pool C: C1, C2    QF3: B1 vs (...)   │
   Pool D: D1, D2    QF4: B2 vs (...)   ┘
```

### Edge cases

- **P = 2 + Top 8:** `v_top_per_pool = max(1, 8/2) = 4` → top 4 per
  pool. Crossover is mechanical (1-vs-8 on the concatenated array)
  which means **A1 vs B4, A2 vs B3, B1 vs A4, B2 vs A3** — that is the
  intended pool-play crossover seeding.
- **P = 3 + Top 8:** `v_top_per_pool = max(1, 8/3) = 2` → only 6 teams
  advance. The trim branch only runs when the array exceeds
  `v_playoff_n`, so with 6 < 8 the bracket falls into the catch-all
  `'Playoff Round of 6'` label and is **not a clean MLP-10 result**.
  Admins should pick a pool count that divides the playoff size.

---

## MLP-11 — Pool Play → Top 4 Double Elim **(NEW)**

`mlp_play_format = 'pool_play_playoff'`, `mlp_pool_count = P`,
`mlp_playoff_teams = 4`, proposed `playoff_format = 'top_4_de'`.

Same group stage as MLP-9. The 4 advancing teams enter a 4-team
double-elim bracket instead of semis-into-final SE.

### Worked Example — 8 teams, P = 2 pools

- Pool play: 12 meetings = 48 sub-matches (as MLP-9).
- Playoff (4-team DE): 6 or 7 meetings (24 or 28 sub-matches), same
  shape as MLP-6.
- Tournament total: **18 or 19 meetings = 72 or 76 sub-matches**.

```
   Pool A → A1, A2 ─┐
   Pool B → B1, B2 ─┤
                    └─ Seeds 1..4 by (pool_rank, pool_letter):
                       S1=A1, S2=B1, S3=A2, S4=B2
                       … then 4-team DE bracket (see MLP-6 diagram)
```

### Schedule implications

- Same as MLP-6 (1.5× SE court-time) plus the full pool stage upstream.
- Pool play and playoff are completely sequential — playoff cannot
  start until *every* pool sub-match is `completed`
  (`generate_mlp_playoff` enforces this).

### Edge cases

- All MLP-9 pool-count footguns apply unchanged (P = 3 + Top 4 only
  picks pool winners).
- Bracket-reset toggle behaves the same as MLP-6.

---

## MLP-12 — Pool Play → Top 8 Double Elim **(NEW)**

`mlp_play_format = 'pool_play_playoff'`, `mlp_pool_count = P`,
`mlp_playoff_teams = 8`, proposed `playoff_format = 'top_8_de'`.

Same group stage as MLP-10. The 8 advancing teams enter an 8-team
double-elim bracket.

### Worked Example — 16 teams, P = 4 pools

- Pool play: 4 pools × (4 × 3 / 2) = 4 × 6 = **24 meetings = 96
  sub-matches** in 3 within-pool rounds.
- Top-per-pool = max(1, 8/4) = **2 per pool** → 8 advance.
- Playoff (8-team DE): 14 or 15 meetings (56 or 60 sub-matches), same
  shape as MLP-7.
- Tournament total: **38 or 39 meetings = 152 or 156 sub-matches**.

```
   Pool A: A1, A2 ─┐
   Pool B: B1, B2 ─┤      Seeds 1..8 = pool_rank then pool_letter:
   Pool C: C1, C2 ─┤      A1, B1, C1, D1, A2, B2, C2, D2
   Pool D: D1, D2 ─┘      … then 8-team DE bracket (see MLP-7)
```

### Schedule implications

- This is the most court-hungry MLP permutation in the index. 16 teams
  × 4 sub-matches/meeting × ~39 meetings = ~156 sub-matches over the
  full event. On 8 courts (2 parallel meetings) this is comfortably a
  2-day tournament.
- The 8-team DE alone is 9 meeting-rounds, sequential where LB drops
  in.

### Edge cases

- All MLP-10 footguns apply.
- The advance array's order — `(pool_rank, pool_letter)` — sets the
  seeding so that A1 and A2 cannot meet again until at minimum the
  WB Final (good — they already played in pool).

---

## Cross-Cutting Edge Cases (apply to all MLP-1..MLP-12)

1. **Sub-match-game W/L counting.** Commit `4bad293` made each game of a
   best-of-N match count separately for W/L. That applies to the
   individual sub-match level inside each team meeting.
2. **Missing player.** No native forfeit primitive; admins record the
   absent player's sub-matches as a default loss. Open question:
   should the sub-match be marked `forfeit` or `completed` with a
   default score?
3. **Re-running the bracket generator** wipes prior matches —
   `generate_mlp_bracket` does `delete from tournament_matches /
   tournament_rounds` before reseeding (lines 127-128). This is
   destructive; the UI should gate behind a confirm prompt.
4. **Re-running the playoff generator** is blocked once any
   quarterfinals/semifinals/finals round exists. Admin must manually
   delete to retry.
5. **Pool snake-draft formula** lives in lines 180-184 / 194-196 of
   `migration_mlp_play_formats.sql`. Identical formula reused in
   `mlp_team_standings` for labeling.

---

## Open Questions

- **Dreambreaker singles match.** Real MLP league play uses a fifth
  *Dreambreaker* singles game when a team meeting is 2-2. Pickleague
  does not implement this today (no fifth match row inserted by
  `_insert_mlp_pairing_matches`, no singles-only fields on
  `mlp_teams`). For Pickleague MLP, a 2-2 split is recorded as a
  symmetric standings result (each team +2/-2) and the meeting itself
  has no declared winner. Worth deciding: do we add Dreambreaker as a
  follow-up, or stay strictly sub-match-W/L?
- **Pool counts that do not divide the playoff size.** MLP-8 / MLP-9 /
  MLP-10 footguns above all stem from
  `v_top_per_pool := greatest(1, v_playoff_n / v_pool_count)`. Cleaner
  options: error out early, or fall back to flat top-N across pools.
- **Forfeits at the sub-match level.** Today the only path is for the
  admin to enter a final score manually. A dedicated `forfeit` status
  on sub-matches would make standings exports cleaner.

---

## Cross-References

- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) —
  full bracket structure for MLP-6, MLP-7, MLP-11, MLP-12.
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — top-N
  standings rules, pool-count footguns, RR tie resolution.
- [Schedule Formulas](./schedule-formulas.md) — court-allocation
  formula and the 4-courts-per-team-meeting constraint.
- [Tournament Formats Index](../tournament-formats.md) — back to the
  3-axis overview.

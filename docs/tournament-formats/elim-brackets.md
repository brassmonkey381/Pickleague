# Elimination Brackets (No Group Play)

Deep-dive appendix to [Tournament Format Permutations](../tournament-formats.md).
This document covers the five permutations where the bracket *is* the entire
tournament (no round-robin / pool play layer in front):

| # | Larger Format | Additional | Status |
|---|---|---|---|
| SE-1 | `single_elimination` | — | Exists |
| SE-2 | `single_elimination` | 3rd Place Match toggle | **NEW** (non-MLP) |
| SE-3 | `single_elimination` | Consolation bracket | **NEW** |
| DE-1 | `double_elimination` | bracket reset OFF | Exists (toggle NEW) |
| DE-2 | `double_elimination` | bracket reset ON | Exists; UI toggle NEW |

For playoff brackets that *follow* group play (Top-N-after-RR /
Top-N-after-pool-play), see
[Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md).
For 1-vs-N pairing rules, BYE assignment, and tiebreaker fallbacks, see
[Seeding & Tiebreakers](./seeding-and-tiebreakers.md).

---

## Match-Count Cheat Sheet

Let `N` = number of entrants, `B` = next power of 2 at or above `N`
(so `B = 2^ceil(log2(N))`), `byes = B - N`.

| Format | Matches played | Notes |
|---|---|---|
| SE-1 | `N - 1` | One match eliminates one entrant; one survivor. |
| SE-2 | `N - 1 + 1 = N` | +1 for the 3PM between losing semifinalists. |
| SE-3 | `N - 1 + (C - 1)` where `C` = round-1 losers | Consolation is its own SE bracket; if `C` isn't a power of 2 it gets its own BYEs. |
| DE-1 | `2(N - 1)` | Each entrant must be beaten twice to be eliminated; one less because the champ only needs `N-1` wins. |
| DE-2 | `2(N - 1)` or `2N - 1` | +1 iff the LB finalist wins GF1 and forces GF2 ("bracket reset"). |

BYEs themselves don't add matches — a top seed paired with a BYE simply
auto-advances. `_advance_double_elim_bracket` does **not** insert BYE rows;
the SE generator does for visual symmetry only.

---

## SE-1 — Standard Single Elimination

The baseline knockout bracket. One loss and you're out. Final standings
are 1st (champ), 2nd (finalist), and effectively a tie for the rest by
round of elimination (semifinalists tied for 3rd, quarterfinalists tied
for 5th, etc.).

### Worked example — 8 entrants

```
Round of 8        Semifinals       Final
─────────────     ──────────       ───────
Seed 1 ─┐
        ├─QF1─┐
Seed 8 ─┘     │
              ├─SF1─┐
Seed 4 ─┐     │     │
        ├─QF2─┘     │
Seed 5 ─┘           │
                    ├─F─→ Champion
Seed 3 ─┐           │
        ├─QF3─┐     │
Seed 6 ─┘     │     │
              ├─SF2─┘
Seed 2 ─┐     │
        ├─QF4─┘
Seed 7 ─┘
```

Matches: `8 - 1 = 7`. Rounds: `log2(8) = 3` (QF, SF, F).

### Worked example — 12 entrants (BYE padding)

`B = 16`, so `byes = 4` and the top 4 seeds get round-of-16 BYEs.
Round-of-16 effectively shrinks to 4 played matches (seeds 5–12 fight for
the right to meet a top seed).

```
R16 (4 played, 4 byes)   QF            SF           Final
──────────────────────   ──────        ──────       ──────
Seed 1 ──── BYE ────────┐
                        ├─QF1─┐
Seed 8 ─┐               │
        ├─R16a──────────┘     │
Seed 9 ─┘                     ├─SF1─┐
Seed 4 ──── BYE ────────┐     │     │
                        ├─QF2─┘     │
Seed 5 ─┐               │           │
        ├─R16b──────────┘           ├─F─→ Champ
Seed 12 ┘                           │
Seed 3 ──── BYE ────────┐           │
                        ├─QF3─┐     │
Seed 6 ─┐               │     │     │
        ├─R16c──────────┘     ├─SF2─┘
Seed 11 ┘                     │
Seed 2 ──── BYE ────────┐     │
                        ├─QF4─┘
Seed 7 ─┐               │
        ├─R16d──────────┘
Seed 10 ┘
```

Matches: `12 - 1 = 11` (4 in R16 + 4 QF + 2 SF + 1 F).

### Edge cases

- **Mid-bracket withdrawal.** A withdrawing player forfeits their next
  match; their opponent advances. There is no replacement / lucky-loser.
- **Odd entrant counts** (e.g., 5, 7, 11): BYEs are assigned to the top
  seeds by ranking; see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md).
- **Tied standings below 1st/2nd.** SE produces no ranking among
  same-round losers. If you need a true 3rd place, use SE-2.

### Schedule implications

- Highly sequential — each round can't begin until the previous one
  finishes, so the bracket walltime ≈ `(rounds × longest match)` rather
  than scaling with total match count.
- Court demand peaks at round 1 (`B/2` matches), halves each round.

---

## SE-2 — Single Elimination + 3rd Place Match

Same bracket as SE-1, but the two losing semifinalists meet once more for
3rd place. This is the standard for olympics-style brackets and is
already supported for MLP top-2 playoffs — SE-2 brings the same toggle to
non-MLP single-elim tournaments.

DB-side: the round uses `round_type = 'third_place_match'` (the
constraint in `migration_double_elim_advancement.sql` already permits it).

### Worked example — 8 entrants

```
QF      SF              Final
──      ──              ─────
... (same as SE-1) ...

                ┌──────────► Final ──→ 1st / 2nd
   SF losers ──→│
                └──────────► 3PM   ──→ 3rd / 4th
```

Matches: `7 + 1 = 8`.

### Edge cases

- **3PM runs in parallel with the final.** Both matches need only the SF
  results, so a single tournament day can schedule them simultaneously
  if courts allow. The trigger does **not** gate the Final on the 3PM
  finishing.
- **One semifinalist withdraws before 3PM.** Their opponent gets 3rd by
  walkover; 4th is recorded as a forfeit loss.
- **Toggle off** = behave exactly like SE-1; no 3PM round is created.

### Schedule implications

- Adds exactly 1 match (the 3PM), but adds 0 walltime if scheduled in
  parallel with the Final on a separate court.

---

## SE-3 — Single Elimination + Consolation Bracket

A consolation bracket gives every entrant at least two matches. Anyone
who loses their **first** bracket match drops into a parallel single-elim
"consolation" bracket and plays for a consolation championship. This is
the lightweight alternative to full double elim — you can't fight back
into the main bracket, but you're guaranteed a second game.

### Worked example — 8 entrants

```
Main Bracket (SE-1)
   QF1 ─┬─ SF1 ─┐
   QF2 ─┘       ├─ F ──→ Main champ
   QF3 ─┬─ SF2 ─┘
   QF4 ─┘

Consolation Bracket (SE on 4 QF losers)
   QF1.L ─┬─ Csemi1 ─┐
   QF2.L ─┘          ├─ Cfinal ──→ Consolation champ
   QF3.L ─┬─ Csemi2 ─┘
   QF4.L ─┘
```

Matches: `7 (main) + 3 (consolation, since 4 - 1 = 3) = 10`.

### Worked example — 12 entrants

After R16 produces 4 played matches and 4 BYEs:
- Main bracket continues with 8 entrants → 7 more matches.
- Consolation bracket gets the **4 R16 losers only** (the BYEd seeds
  never played a first match, so they have no "first loss" to drop on).
  That's a 4-entrant SE = 3 matches.

Total: `4 (R16) + 7 (rest of main) + 3 (consolation) = 14`.

> Open question for later: should QF losers ALSO drop into consolation?
> The strict interpretation is "first-round losers only" (cleaner, what
> this doc assumes). A "Top-N consolation" variant for group-play
> tournaments is covered in
> [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md).

### Edge cases

- **Non-power-of-2 first round.** Only entrants who actually *played and
  lost* in round 1 are eligible. BYEd top seeds never enter consolation.
- **Consolation bracket isn't a power of 2.** It gets its own BYEs by
  reverse seeding (the entrant who lost to the highest main-bracket seed
  gets the consolation BYE).
- **Withdrawal from consolation.** Walkover, same as main bracket.
- **Runs in parallel with the main bracket.** Consolation R1 can start
  as soon as main R1 finishes. Consolation Final and Main Final can run
  on the same day on different courts.

### Schedule implications

- Adds `(C - 1)` matches where `C` = first-round-loser count
  (typically `N/2` or fewer once BYEs apply).
- Fits in the same total walltime as SE-1 + a small tail if courts are
  available, since consolation rounds can interleave.

---

## DE-1 — Double Elimination, Bracket Reset OFF

A full double-elim bracket: winners (WB) + losers (LB) + grand final.
Every entrant must lose **twice** to be eliminated — except the WB
finalist, who only needs to lose once in the Grand Final to be
eliminated in this variant.

In DE-1, the Grand Final is a single match. The WB finalist enters
0-loss; the LB finalist enters 1-loss. If the LB finalist wins GF1, they
are champion and the WB finalist gets 2nd outright, even though the WB
finalist has only lost once. This is the simpler, faster interpretation
and is conventional for casual / time-boxed events.

`_advance_double_elim_bracket` already handles GF1; "bracket reset OFF"
just means *we never create GF2 even if the LB side wins GF1*. The
infrastructure for this is the same trigger — only the GF1-winner branch
changes (see DE-2 below for the reset path).

### LB round structure (from migration_double_elim_advancement.sql)

```
WB R1 losers      → LB R1 (paired)
WB R(X≥2) losers  → LB R(2X - 2)   "drop-in"
LB R(odd > 1)     = consolidation  (pair LB-prev winners)
LB R(even)        = drop-in        (LB-prev winners vs new WB losers)
```

For an 8-entrant DE, that yields LB R1..R5.

### Worked example — 8 entrants

For N=8 the WB has 3 rounds (R1, R2, R3=WB final). The LB needs exactly
4 rounds because every WB round must drop its losers into the LB before
the LB finalist can be decided.

```
Winners Bracket
  WB R1 (4 matches) ──→ WB R2 (2 matches) ──→ WB R3 / WB final (1 match)
       │                     │                        │
       │ 4 losers            │ 2 losers               │ 1 loser
       ▼                     ▼                        ▼
  ┌─────────┐           ┌─────────┐              ┌─────────┐
  │ LB R1   │ pair      │ LB R2   │ drop-in      │ LB R4   │ drop-in
  │ 2 mtch  │──────────→│ 2 mtch  │─────┐        │ 1 mtch  │
  └─────────┘           └─────────┘     │        └─────────┘
                                        ▼              ▲
                                   ┌─────────┐         │
                                   │ LB R3   │ pair    │ (LB R3 winner
                                   │ 1 mtch  │─────────┘  vs WB R3 loser)
                                   └─────────┘
                                                        │
                                                        ▼
                                              LB finalist (1 survivor)

                  WB finalist ──┐
                                ├──── Grand Final ───→ Champion
                  LB finalist ──┘     (1 match in DE-1, no reset)
```

Round-by-round match counts for 8 entrants:
- WB: 4 + 2 + 1 = 7
- LB: 2 (R1) + 2 (R2) + 1 (R3) + 1 (R4) = 6
- GF: 1
- **Total: 14 = 2·(8 - 1).** (`2(N - 1)` already accounts for the single
  Grand Final; the formula assumes no reset.)

### Worked example — 12 entrants (BYEs)

Pad to 16. WB R1 has 4 played matches (top 4 seeds get BYEs); 4 round-1
losers drop into LB R1 (2 LB R1 matches), then BYEd seeds enter WB R2
where another 4 losers emerge across WB R2/R3/R4. The LB grows to ~7
matches. The trigger's documented limitation: odd LB loser counts are
*dropped* — this only matters at brackets the trigger wasn't sized for
(non-power-of-2 entrants with asymmetric BYE placement). For power-of-2
sizes the LB pairs cleanly throughout.

### Edge cases

- **Mid-bracket withdrawal.** A WB withdrawal forfeits the WB match
  *and* gives the would-be loser (now the walkover winner) the
  advancement; no automatic LB drop is inserted for the withdrawer.
- **Withdrawal in LB.** Walkover. The remaining player advances; on the
  final LB round they become the LB finalist.
- **Odd loser counts in LB.** Per the trigger comments
  (lines 296–303 of `migration_double_elim_advancement.sql`): "odd byes
  in LB are dropped — a documented limitation; brackets sized to powers
  of 2 don't hit this."
- **GF1 is the only Grand Final.** With reset OFF, even if the LB
  finalist wins GF1, no GF2 is created. (UI-side this is the toggle to
  expose; the trigger as written *always* creates GF2 on team2 win — to
  realize DE-1 we'd gate that branch on a new
  `tournaments.de_bracket_reset` column.)

### Schedule implications

- Roughly `2× SE` matches → roughly 2× the total court-hours.
- Walltime is **not** 2× SE — LB rounds interleave between WB rounds
  (drop-ins are gated on the corresponding WB round finishing). A
  well-courted 8-entrant DE runs in roughly the same walltime as a
  16-entrant SE.
- Pairs in LB drop-in rounds need WB losers to be ready, so a slow WB
  round bottlenecks the LB.

---

## DE-2 — Double Elimination, Bracket Reset ON

The "true" double-elim. Same bracket as DE-1, except GF1 is *not*
necessarily the championship. If the LB finalist wins GF1, both
finalists now have exactly one loss, so GF2 (the "reset") is played to
restore the "lose twice = eliminated" property. Whoever wins GF2 is
champion.

The migration trigger already implements this:

```
-- migration_double_elim_advancement.sql, lines 184–207
if v_round_number = 1 then
  if new.winner_team = 'team2' then
    -- Bracket reset: create GF2 with same pair…
    v_gf_round_id := public._de_get_or_create_round(
      new.tournament_id, 2, 'grand_final', 'Grand Final (Reset)');
    …insert GF2 match…
  else
    -- WB finalist won → tournament complete.
    update public.tournaments set status = 'completed' …
```

So DE-2 is the default behavior of the existing trigger; DE-1 is the
*toggled-off* variant that needs the new
`tournaments.de_bracket_reset boolean` column to suppress GF2.

### Worked example — 8 entrants

Identical to DE-1 until GF1. Two outcomes:

```
GF1 result          → next step
────────────────    ──────────────────────────────────────
WB finalist wins    → champion (1 GF match played total)
LB finalist wins    → GF2 forced ("Grand Final (Reset)")
                       Winner of GF2 = champion
                       Loser of GF2 = 2nd (now at 2 losses)
```

Total matches:
- **GF1 = WB finalist wins:** `2(N - 1) = 14` (for N=8) — identical to DE-1.
- **GF1 = LB finalist wins → GF2 played:** `2N - 1 = 15` (for N=8).

### ASCII diagram (GF section only — WB/LB identical to DE-1)

```
                          WB finalist  LB finalist
                              │             │
                              └──── GF1 ────┘
                                     │
                       ┌─────────────┴─────────────┐
                       ▼                           ▼
          WB finalist wins                LB finalist wins
                       │                           │
                       ▼                           ▼
                  Champion              ┌──── GF2 ────┐
                                        │             │
                                        ▼             ▼
                                     Champ         Runner-up
                                   (winner)        (loser, now 2L)
```

### Edge cases

- **GF1 winner = team1 (WB finalist).** Tournament ends; trigger sets
  `tournaments.status = 'completed'`.
- **GF1 winner = team2 (LB finalist).** Trigger creates round
  `(2, 'grand_final', 'Grand Final (Reset)')` and inserts a fresh
  match with the same players. Sides aren't swapped — `team1` stays the
  WB finalist (now at 1 loss) and `team2` stays the LB finalist (also at
  1 loss).
- **Withdrawal in GF1 or GF2.** Walkover. If the WB finalist withdraws
  before GF1, the LB finalist becomes champion (and DE-2 still creates
  no GF2 because there's no opponent).
- **DE-2 toggle off mid-tournament** (i.e., admin flips
  `de_bracket_reset` after GF1 was decided by team2). Out of scope — UI
  should lock the toggle once round 1 of WB starts.

### Schedule implications

- Adds 0 matches in the most common case (WB finalist wins GF1) over
  DE-1; adds exactly 1 match (GF2) when the LB side forces a reset.
- The "reset" is the single highest-leverage match — for wagering
  surfaces it's the most important match to keep open until GF1
  completes.
- Walltime ≈ DE-1; the GF2 (if any) is one extra match on top.

---

## Cross-References

- [Losers-Bracket Playoff Mechanics](./losers-bracket-playoff.md) —
  covers Top-N-after-RR and Top-N-after-pool-play playoff brackets.
  The same trigger (`_advance_double_elim_bracket`) is the underlying
  code path for those variants too; only the *seeding* changes (entrants
  come from group-play standings instead of the registration roster).
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — 1-vs-N
  pairing rules, BYE placement, and what happens when two entrants tie
  on PLUPR / record / head-to-head.
- Index: [Tournament Format Permutations](../tournament-formats.md).

---

*Planning artifact. No `mobile/` or `supabase/` code changes accompany
this doc.*

# Losers-Bracket Playoff Mechanics

This is the canonical reference for the **double-elimination (DE) playoff variants** in the 3-axis tournament format model:

- `top_4_de` — top 4 finishers from group play feed a 4-team DE bracket
- `top_8_de` — top 8 finishers feed an 8-team DE bracket
- `top_N_per_pool_de` — top N from each pool (with crossover seeding) feed a DE bracket

> **Not to be confused with** the standalone `double_elimination` Larger Format (DE-1, DE-2 in the [index](../tournament-formats.md)). That format runs DE on the **full entrant list with no group play**. The variants here run DE only on a **top-N subset after group play** — the bracket mechanics described below apply to both, but the *entrants* are different.

See also: [Round Robin](./round-robin.md), [Pool Play](./pool-play.md), [MLP](./mlp.md), [Rotating Partners](./rotating-partners.md), [Seeding & Tiebreakers](./seeding-and-tiebreakers.md), [Schedule Formulas](./schedule-formulas.md), [Wagering Integration](./wagering-integration.md).

---

## App descriptions (source of truth)

The Playoff Format picker now exists in `CreateTournamentScreen.tsx` (shipped in PR #49) but only exposes the SE variants (`none` / `top_2` / `top_4` / `top_8`). The DE variants this doc proposes (`top_4_de`, `top_8_de`, `top_N_per_pool_de`) are still **NOT** in the `tournaments.playoff_format` column enum.

### Current (shipped) hint text

The picker is shown when the larger format is `round_robin` or `pool_play` and quotes these hints verbatim:

- **None**: "No playoff — final standings come straight from group play."
- **Top 2**: "Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4)."
- **Top 4**: "Semifinals + Finals."
- **Top 8**: "Quarterfinals + Semifinals + Finals."

These are all single-elimination (SE) variants. The closest existing DE precedent in the app is the standalone Double Elim larger format:

> **`FORMAT_META.double_elimination`** (`mobile/src/lib/tournament.ts:385`):
> "Two losses to be eliminated."

The DE playoff variants proposed below share that exact "two losses to be eliminated" semantic — they just apply it to the **top-N seeded entrants after group play**, instead of to the entire entrant list from match 1.

### Proposed hint text (for future UI implementation)

When the DE variants are wired into the picker, the hint copy should match the style of the existing SE entries above. Suggested strings:

- **"Top 4 Double Elim"**: "Top 4 seeds enter a winners + losers bracket. Lose once and you drop to the losers bracket; lose twice and you're eliminated. Includes a Grand Final with optional bracket reset."
- **"Top 8 Double Elim"**: "Top 8 seeds enter a winners + losers bracket. Same drop-in rules as Top 4 DE; longer bracket."
- **"Top N per Pool Double Elim"**: "Top N from each pool cross over into a winners + losers bracket. Lose once → losers bracket; lose twice → eliminated."

These remain the recommended additions when the underlying SQL is wired up and the enum is extended.

---

## Concept

In a **single-elimination (SE) playoff**, a single bad match — a fluky game, a bad call, a tweaked ankle — ends a top-seeded team's run. The #1 seed and the #8 seed are equally one loss away from the door.

A **DE playoff** doubles the depth of the bracket. Every team that loses in the **winners bracket (WB)** drops down into a parallel **losers bracket (LB)**, where they can keep playing. A team is only eliminated on their **second** loss. The LB winner advances to the **Grand Final** against the WB winner.

### Why it's worth the cost

- Top seeds get a buffer for one off-game.
- Underdogs who barely survived group play can mount a comeback run through the LB and still win the title.
- The Grand Final is more meaningful: the WB finalist has played an undefeated tournament, the LB finalist has fought back from a loss.

### What it costs

- **Roughly 2x the matches** of an SE playoff for the same entrant count.
- **Longer day** — total clock time is about SE-playoff + 50% (LB rounds run in parallel to WB rounds where possible, so it's not 2x wall time).
- **More complex scheduling** — LB drop-ins depend on WB round completion.

---

## Mechanics — Top 4 DE Playoff (`top_4_de`)

The simplest DE shape. 4 entrants → 3 WB matches + 2 LB matches + 1-2 GF matches = **6-7 total matches**.

### Seeds

Seeds S1, S2, S3, S4 come from group-play standings. See [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) for how rank within a pool, point differential, and head-to-head map to a single linear seed list.

### Bracket structure

- **WSF1**: S1 vs S4 — winners-bracket semifinal 1
- **WSF2**: S2 vs S3 — winners-bracket semifinal 2
- **WF**: WSF1.W vs WSF2.W — winners-bracket final
- **LR1**: WSF1.L vs WSF2.L — losers-bracket round 1 (the two WB semifinal losers)
- **LF**: LR1.W vs WF.L — losers-bracket final
- **GF1**: WF.W vs LF.W — grand final
- **GF2** (optional, only on bracket reset): if LF.W wins GF1, replay

### ASCII diagram

```
 WINNERS BRACKET                                  GRAND FINAL
 ───────────────                                  ───────────

 S1 ─┐
     ├─ WSF1 ─┐
 S4 ─┘        │
              ├─ WF ──────────────────────────┐
 S2 ─┐        │                               │
     ├─ WSF2 ─┘                               │
 S3 ─┘                                        ├─ GF1 ─[GF2?]─ CHAMPION
              ┌─ LR1 ─┐                       │
 WSF1.L ──────┤       │                       │
 WSF2.L ──────┘       │                       │
                      ├─ LF ──────────────────┘
              WF.L ───┘

 LOSERS BRACKET
 ──────────────
```

### Grand Final reset (`de_bracket_reset` toggle)

The proposed `de_bracket_reset` flag (see index doc) controls whether GF2 is played:

- **Reset enabled** (default, matches TOC/championship convention): the WB finalist enters GF1 undefeated. If they lose GF1, that's their first loss — GF2 is played to give them a chance at the "must-beat-them-twice" finish. First team to a second loss is eliminated.
- **Reset disabled**: whoever wins GF1 wins, period. Faster but silently demotes the WB finalist's earned buffer to nothing.

The existing trigger [`_advance_double_elim_bracket`](../../supabase/migration_double_elim_advancement.sql) already implements bracket reset (see lines 184-225). Disabling reset would be a column-gated branch around that block.

### Edge: Top-4 DE is symmetric

With exactly 4 teams, LR1 has exactly 1 match (the two WSF losers play each other), and LF has exactly 1 match. There are no "drop-in" rounds — the LB is just two consecutive single matches. This makes Top-4 DE the cleanest variant to test against.

---

## Mechanics — Top 8 DE Playoff (`top_8_de`)

8 entrants → 7 WB matches + 6 LB matches + 1-2 GF matches = **14-15 total matches**.

### Seeds

Standard 1v8, 2v7, 3v6, 4v5 pairings in WB round 1. Quadrants are arranged so the #1 and #2 seeds can only meet in the WB final.

### Bracket structure

**Winners bracket** (3 rounds):
- WB R1 (Quarterfinals): WQF1 = S1 vs S8, WQF2 = S4 vs S5, WQF3 = S2 vs S7, WQF4 = S3 vs S6
- WB R2 (Semifinals): WSF1 = WQF1.W vs WQF2.W, WSF2 = WQF3.W vs WQF4.W
- WB R3 (Final): WF = WSF1.W vs WSF2.W

**Losers bracket** (4 rounds):
- LB R1 (consolidation of WB R1 losers): LR1a = WQF1.L vs WQF2.L, LR1b = WQF3.L vs WQF4.L
- LB R2 (drop-in of WB R2 losers): LR2a = LR1a.W vs WSF1.L, LR2b = LR1b.W vs WSF2.L (the trigger pairs LB-prev winners with WB losers by `match_order`)
- LB R3 (consolidation): LR3 = LR2a.W vs LR2b.W
- LB R4 (drop-in of WB R3 loser, aka LB final): LF = LR3.W vs WF.L

**Grand final**: GF1, optional GF2.

### ASCII diagram

```
 WINNERS BRACKET
 ───────────────

 S1 ─┐
     ├─ WQF1 ─┐
 S8 ─┘        │
              ├─ WSF1 ─┐
 S4 ─┐        │        │
     ├─ WQF2 ─┘        │
 S5 ─┘                 │
                       ├─ WF ──────────────────────────────────────┐
 S2 ─┐                 │                                           │
     ├─ WQF3 ─┐        │                                           │
 S7 ─┘        │        │                                           │
              ├─ WSF2 ─┘                                           │
 S3 ─┐        │                                                    │
     ├─ WQF4 ─┘                                                    │
 S6 ─┘                                                             │
                                                                   │
 LOSERS BRACKET                                                    │
 ──────────────                                                    │
                                                                   │
 WQF1.L ─┐                                                         │
         ├─ LR1a ─┐                                                │
 WQF2.L ─┘        │                                                │
                  ├─ LR2a ─┐                                       │
 WSF1.L  ─────────┘        │                                       │
                           ├─ LR3 ─┐                               │
 WQF3.L ─┐                 │       │                               │
         ├─ LR1b ─┐        │       │                               │
 WQF4.L ─┘        │        │       │                               │
                  ├─ LR2b ─┘       │                               │
 WSF2.L  ─────────┘                │                               │
                                   ├─ LF ──────────────────────────┤
                          WF.L ────┘                               │
                                                                   ▼
                                                              GF1 ─[GF2?]─ CHAMPION
```

### Round counts cheat sheet

| Round | Type | # matches | Source |
|------:|:-----|----------:|:-------|
| WB R1 | winners (QF) | 4 | seeds |
| WB R2 | winners (SF) | 2 | WB R1 winners |
| WB R3 | winners (F)  | 1 | WB R2 winners |
| LB R1 | losers (consol) | 2 | WB R1 losers paired |
| LB R2 | losers (drop-in) | 2 | LB R1 winners vs WB R2 losers |
| LB R3 | losers (consol) | 1 | LB R2 winners paired |
| LB R4 | losers (drop-in / LB final) | 1 | LB R3 winner vs WB R3 loser |
| GF1   | grand_final | 1 | WB R3 winner vs LB R4 winner |
| GF2   | grand_final (reset) | 0 or 1 | conditional |

---

## Mechanics — Top N per Pool DE Playoff (`top_N_per_pool_de`)

Trickier because the entrant count is `P x N` (pools x per-pool) which is not always a power of 2.

### When `P*N` is a power of 2

Seed via **crossover** — top seeds from one pool play lower seeds from the other pool(s), so pool-mates can't meet again until late rounds.

**2 pools, top 2 each (P=2, N=2, total = 4)** — top_4_de shape:
- WSF1: A1 vs B2
- WSF2: B1 vs A2
- ...then standard top-4 DE (see above).

**4 pools, top 2 each (P=4, N=2, total = 8)** — top_8_de shape:
- WQF1: A1 vs D2
- WQF2: B1 vs C2
- WQF3: C1 vs B2
- WQF4: D1 vs A2
- ...then standard top-8 DE.

**2 pools, top 4 each (P=2, N=4, total = 8)** — top_8_de shape:
- WQF1: A1 vs B4
- WQF2: B2 vs A3
- WQF3: B1 vs A4
- WQF4: A2 vs B3
- ...then standard top-8 DE.

The shape on the page is identical to the size-matched top_N_de variant; only the seed labels change.

### When `P*N` is NOT a power of 2

Two options. The index doc flags this as an **open question** — both are reasonable; the pick should be a tournament-time toggle.

#### Option A — Byes for top seeds in WB R1

The top `(next_pow2 - P*N)` seeds get a bye into WB R2; everyone else plays a WB R1 match.

**Example: P=3, N=2, total = 6** (`next_pow2 = 8`, so 2 byes):
- WB R1 (2 matches): the bottom 4 seeds play (S3 vs S6, S4 vs S5)
- WB R2 (2 matches): S1 and S2 enter here, vs WB R1 winners

Pros: simple to implement; mirrors the SE bye scheme.
Cons: byes are LB-asymmetric — a top seed who loses in WB R2 drops into LB R2 (a drop-in round) without having a "consolation pair" partner from LB R1.

#### Option B — Play-in round

A separate **play-in round** (effectively a "WB R0") narrows `P*N` down to the next power of 2 before the real bracket starts.

**Example: P=3, N=2, total = 6** (`next_pow2 = 4`, so 2 play-in matches):
- Play-in (2 matches): S3 vs S6, S4 vs S5 — losers eliminated from playoffs entirely
- Then a standard top_4_de bracket with S1, S2, play-in.W1, play-in.W2

Pros: bracket from WB R1 onward is a clean power of 2.
Cons: play-in losers are eliminated without entering the LB (so they have no consolation path even though they qualified for playoffs); harsh for #5/#6 seeds.

### ASCII diagram — P=3, N=2 with play-in (Option B)

```
 PLAY-IN
 ───────

 S3 ─┐
     ├─ PI1 ──┐
 S6 ─┘        │
              │
 S4 ─┐        │   (PI losers eliminated)
     ├─ PI2 ──┤
 S5 ─┘        │
              ▼

 WINNERS BRACKET (top_4_de shape with PI winners filling S3'/S4')

 S1 ─────┐
         ├─ WSF1 ─┐
 PI2.W ──┘        │
                  ├─ WF ─────────────────────────────┐
 S2 ─────┐        │                                  │
         ├─ WSF2 ─┘                                  │
 PI1.W ──┘                                           │
                                                     │
 LOSERS BRACKET                                      ├─ GF1 ─[GF2?]─ CHAMPION
 ──────────────                                      │
                                                     │
 WSF1.L ─┐                                           │
         ├─ LR1 ─┐                                   │
 WSF2.L ─┘       │                                   │
                 ├─ LF ──────────────────────────────┘
         WF.L ───┘
```

### Recommended default

Pick **Option B (play-in)** for `top_N_per_pool_de` when `P*N` is not a power of 2. It keeps the post-play-in bracket as a clean shape we already have ASCII for, and it matches how most pickleball-league operators run it ("the top 2 from each pool make playoffs; first round is sudden death, then we run a regular bracket").

Revisit if the harshness on #5/#6 seeds becomes a real-world complaint — flipping to byes is a small config change.

---

## Trigger Reuse

**No new trigger is needed for any DE playoff variant.**

The existing trigger [`_advance_double_elim_bracket`](../../supabase/migration_double_elim_advancement.sql) (lines 115-664) already implements every advancement rule used by a DE playoff:

- WB round-to-round advancement (lines 392-440)
- WB-loser → LB drop-in (lines 240-390)
- LB consolidation pairing (lines 597-652)
- LB drop-in pairing waiting on WB completion (lines 511-596)
- WB-final + LB-final → Grand Final creation (lines 442-470, 488-508, 669-757)
- Bracket reset GF2 (lines 184-225)

What the new playoff variants change is **only how the WB round-1 matches are loaded**:

- `top_4_de` / `top_8_de`: insert `round_type='winners'`, `round_number=1` matches with the top-N seeds from group play (linear seed list, standard 1v8/2v7/3v6/4v5-style pairings).
- `top_N_per_pool_de`: same, but with crossover seeding and either byes or a play-in round (see above).

Then let the trigger run. The trigger inspects `format='double_elimination'` (line 155) — the cleanest way to wire this in is to have the format column read `double_elimination` for the playoff phase too (or extend the trigger's `if v_format` check to include the new format strings). Either way, the bracket-walking logic is unchanged.

> **Enum note**: when the DE variants (`top_4_de`, `top_8_de`, `top_N_per_pool_de`) are added, the `check (playoff_format in (...))` constraint in [`supabase/migration_add_playoff_format.sql`](../../supabase/migration_add_playoff_format.sql) needs extending to cover them too — today it only allows `'none' | 'top_2' | 'top_4' | 'top_8'`.

---

## Edge Cases

### Team withdraws between group play and playoffs

The bracket has been seeded but a team can't show. Two reasonable behaviors — pick at tournament-create time:

- **Substitution**: the next-best seed who didn't make playoffs is promoted to fill the slot (e.g., S9 fills in for a withdrawn S5 in top_8_de). The substitute keeps the withdrawn team's seed position.
- **Forfeit-in-place**: the bracket runs with the slot present but auto-forfeited. The opponent gets a free WB R1 win and drops a phantom loser into LB R1 (which means LB R1 also auto-forfeits on that pairing). This propagates one "free" win up each bracket — workable but ugly.

Substitution is preferred. The trigger doesn't need to know which — substitution happens before WB R1 is loaded.

### WB SF and LB R1 tie on games count

A best-of-N match can produce a tied games count if the tournament uses a non-standard "first to N games" format and both teams reach N-1. Tiebreaker resolution follows the same rules as group play — see [Seeding & Tiebreakers](./seeding-and-tiebreakers.md). The trigger only cares about `winner_team`; it won't fire until the tiebreaker code has stamped a winner.

### Scheduling

A rough wall-clock estimate for the playoff phase:

- **SE playoff** wall time T (single-bracket round-by-round, courts permitting).
- **DE playoff** wall time ≈ **T + 50%**. LB rounds run in parallel with WB rounds where possible (LB R1 plays at the same time as WB R2; LB R3 plays at the same time as WB R3), but the post-WB-final LB tail (LF + GF1 + GF2) adds 2-3 extra match slots that can't parallelize.

If court count is tight (one or two courts) DE will feel closer to 2x SE. With four+ courts and a well-scheduled tournament, the 50% estimate holds.

### What if WB R1 produces an odd loser count?

Only relevant to non-power-of-2 entrant counts (so `top_N_per_pool_de` with byes — Option A). The trigger documents this at lines 295-303 as a known limitation: an unpaired WB R1 loser is dropped from LB. With our recommended **play-in** approach (Option B), the bracket from WB R1 is always a power of 2, so this case never fires.

---

## Cross-references

- [Round Robin](./round-robin.md) — for RR-5/RR-7 group play that can feed a DE playoff.
- [Pool Play](./pool-play.md) — for PP-4/PP-6/PP-8 group play that feeds `top_N_per_pool_de`.
- [MLP](./mlp.md) — MLP-6/7/11/12 + DE playoff: the entrants are MLP-format teams, but the bracket shape is identical to the variants above.
- [Rotating Partners](./rotating-partners.md) — RP-4 + DE playoff is unusual (rotating-partners doesn't produce stable teams) but supported; seeds map to individuals' point totals, then partners are re-assigned for the playoff phase.
- [Seeding & Tiebreakers](./seeding-and-tiebreakers.md) — how group-play standings become the seed list this doc consumes.
- [Schedule Formulas](./schedule-formulas.md) — total match-count and clock-time math for each variant.
- [Wagering Integration](./wagering-integration.md) — DE playoffs introduce a "second-chance" subject (will team X win out of the LB?) on top of the standard "will team X win the tournament?" subject; see that doc for the catalog of wager subjects.

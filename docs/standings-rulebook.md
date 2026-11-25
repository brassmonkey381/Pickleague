# Standings rulebook (DRAFT, waiting on Brian's sign-off)

PKL-090. This page says how every standings table in PickLeague must read. Brian approves or corrects each rule
and example. Once he signs off, tests check the app against these examples and the golden screens, and only he
changes them. Each rule below is what the app does **today**. Questions for Brian are marked **Q**.

## 0. Two stages, never mixed (Brian, 2026-11-25)

1. **Stage 1, round robin or pool play**, has its own standings table, one per pool. The moment the stage ends, the
   table is **locked and labelled "final"**.
2. **Stage 2, the playoff (optional)**, decides the final places from playoff results. A podium shows 1st (Final
   winner), 2nd (Final loser), 3rd and 4th (from the 3rd-place match, or a shared 3rd if there isn't one), then any
   further playoff rounds the same way.
3. **Then everyone who didn't reach the playoff**, ranked by pool finish: pool place, then W-L, then ±, then the
   organizer's tie order. Teams with the same pool place in different pools are ordered by record. They are never
   shown as one mixed W-L table.
4. **Never one combined "final standings" table** that mixes pool records with playoff places.

Brian approved this layout in the Finished phone mock.

## 1. Every format

1. **Only finished matches count.** A match not yet played, or a cancelled one, adds nothing. Its players still
   show in the table at 0-0.
2. **The order:** most wins, then fewest losses, then point difference (±), then the organizer's tie order, then
   seed.
3. **Never head-to-head.** Beating someone does not put you above them (PKL-052).
4. **± is points scored minus points allowed** in the matches that count.
5. **Tie flag.** "Tie: admin to order" shows only when entrants are level on wins, losses **and** ±, at least one of
   them has played, and the organizer hasn't ordered them. Nobody is flagged before play (PKL-089).

### Example A: round robin, 4 players

Results: Ana beat Ben 11-7. Ana beat Cal 11-9. Dee beat Ana 11-4. Ben beat Cal 11-3. Ben beat Dee 11-8.
Cal beat Dee 11-7.

| # | Player | W-L | ± |
|---|--------|-----|---|
| 1 | Ben | 2-1 | +7 |
| 2 | Ana | 2-1 | -1 |
| 3 | Dee | 1-2 | 0 |
| 4 | Cal | 1-2 | -6 |

Ben is above Ana although Ana beat Ben, because head-to-head never counts (rule 3).

### Example B: the tie flag

After only 2 matches, Ana beat Ben 11-7 and Cal beat Dee 11-7. Ana and Cal are both 1-0, +4, so they are flagged.
Ben and Dee are both 0-1, -4, so they are flagged too. Before any match, nobody is flagged.

## 2. Pools and a playoff

1. **One table per pool**, each ranked on its own by section 1.
2. **Once the playoff exists, the tables count pool or round-robin matches only.** Playoff results go in the final
   places, not the table.
3. **Top 2 per pool with 2 pools: crossed.** Semifinal 1 is A1 v B2, and Semifinal 2 is B1 v A2.
4. **Top 4 from one round robin:** 1 v 4 and 2 v 3. **Top 8:** 1 v 8, 2 v 7, 3 v 6, 4 v 5.
5. **Final places:** the Final gives 1st and 2nd, the 3rd-place match gives 3rd and 4th, and everyone else follows
   the round robin order.

**Q:** Is the crossing in rule 3 what you want?

## 3. Rotating partners

1. **Each player has their own record.** Partners change every match.
2. **A best-of-3 match counts its games.** For example, winning 2-1 adds 2 wins and 1 loss.
3. **Points** are your side's match score.

## 4. MLP (teams of 4)

1. **A matchup is team v team:** 4 games (Men's, Women's, Mixed 1, Mixed 2), then a Dreambreaker if it's 2-2.
2. **The table's W-L is matchups, not games.**
3. **A team wins a matchup as soon as it has 3 game wins**, even if game 4 hasn't been played yet (PKL-089). At
   2-2, the Dreambreaker decides it.
4. **The order:** most matchup wins, fewest matchup losses, ± over every game (Dreambreaker included), most games
   won, fewest games lost, the organizer's tie order, seed.
5. **Pools rank separately**, one table per pool.
6. **The Standings card and the Playoff section always show the same W-L and order.**

### Example C: one pool, 3 teams (Aces, Bolts, Comets)

**After Aces lead Bolts 3-0, with game 4 still to play:**

| # | Team | W-L | Games | ± |
|---|------|-----|-------|---|
| 1 | Aces | 1-0 | 3-0 | +10 |
| 2 | Comets | 0-0 | 0-0 | 0 |
| 3 | Bolts | 0-1 | 0-3 | -10 |

**After Bolts win game 4 (Aces win 3-1), and Aces v Comets reaches 2-2 with the Dreambreaker still to play:**

| # | Team | W-L | Games | ± |
|---|------|-----|-------|---|
| 1 | Aces | 1-0 | 5-3 | +8 |
| 2 | Comets | 0-0 | 2-2 | -4 |
| 3 | Bolts | 0-1 | 1-3 | -4 |

**After all three matchups finish.** Comets win the Dreambreaker 21-18. Bolts beat Comets 3-1 with games 11-2,
11-5, 11-8 and 9-11.

| # | Team | W-L | Games | ± |
|---|------|-----|-------|---|
| 1 | Bolts | 1-1 | 4-4 | +12 |
| 2 | Aces | 1-1 | 5-4 | +5 |
| 3 | Comets | 1-1 | 4-5 | -17 |

All three teams are 1-1, so ± decides the order.

**Q:** Should the Dreambreaker's points count in ± as shown here (21-18 adds +3 and -3)?

## 5. Gender neutral (PKL-088)

1. **A team is any 4 players.** There are no men's or women's slots.
2. **The games are named Doubles 1, Doubles 2, Doubles 3, Doubles 4**, then the Dreambreaker.
3. **Standings follow section 4 exactly.** Gender never affects the table.
4. **Only the overall PLUPR moves.** The gender and mixed-gender ratings never change.

---
Sign-off: ______ (Brian), date ______

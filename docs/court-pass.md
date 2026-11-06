# Court Pass: build spec

Court Pass is Pickleague's monthly reward track. It is Doggle's Park Pass, ported. Base plan:
`expo-foundation/docs/reward-track-plan.md`. Doggle sources it ports: `db/migrations/0497`, `0498`, `0499`,
`0500` (allowlist trim, in the `doggle-trim` worktree), `db/ops/park_pass_catchup_2026_11.sql`,
`db/tests/reward_track_personas.sql`, `app/src/data/rewardTrack.ts`, `lib/rewardTrackRows.ts`,
`hooks/useParkPass.ts`, `screens/ParkPassScreen.tsx`, `lib/parkPassCopy.ts`, `components/ParkPassChip.tsx`,
`components/showcase/ParkRewardArt.tsx`, `lib/parkArt.ts`.

Written 2026-11-03. Three builders work from this page in parallel: SERVER, ART and APP (ownership is in the last section).
Nobody runs SQL against the live database, publishes an OTA or commits. The main session does those.

**Changed later on 2026-11-03 (Brian):** Court Pass launches now, back-dated to **Nov 1**, with new Thanksgiving items for
November (`art/court-pass/2026-11/`). December keeps the winter items. There is **no daily pickleball cap** (as Doggle 0501).
A catch-up counts every earn since Nov 1. The decisions below are the current ones.

## Decisions (Brian, plus what this spec settles)

| Topic | Decision |
|---|---|
| Name | **Court Pass**. The XP unit is **pickleballs** (singular "pickleball"). |
| Start | Nov 1, 2026, Pacific midnight, back-dated: it goes live Nov 3 and a catch-up counts everything since. In SQL this is `'2026-11-01 00:00'::timestamp at time zone 'America/Los_Angeles'` (07:00Z: still PDT at midnight). The time is never hard-coded. |
| Cycles seeded | `2026-11` "November Court Pass" (Thanksgiving harvest items and a premium preview), `2026-12` (December, the winter items and a premium preview, unchanged) and `2027-01` (January, pickles only and no premium lane). |
| Tiers | 30 tiers, the same curve as Doggle. Tier 30 needs 1,360 XP. |
| Free lane | Every tier pays. Plain tiers pay pickles, as a gold bonus row that earns no XP. November and December each have cosmetics at tiers 5, 10, 15 (rare), 20, 25 and 30 (the finale). |
| Premium lane | November and December each show 6 display-only items: rare at tiers 5, 10, 15, 20 and 25, legendary at 30. It is one collapsed row, "Premium track coming soon". It is never granted or sold. It never shows a price, a buy, upgrade or notify button, a date, a web mention, "unlocks when you upgrade" or "you would have earned". |
| XP | Only real, repeatable play earns XP (Brian, 2026-11-03). Each earn gives `floor(pickles paid x 0.5)`, using the amount actually paid after the 500/day play cap. Logging in gives +5 once per Pacific day. |
| Daily XP cap | **None** (Brian, 2026-11-03, as Doggle 0501). `reward_track_cycles.daily_xp_cap` is nullable, null for every cycle, and null means uncapped. `get_reward_track` sends `daily_cap: null`; the app shows "Today: N pickleballs." with no limit and no reset time. `today_xp` counts the Pacific day (`xp_day`), so a viewer whose clock is not on Pacific time sees "This Court Pass: N pickleballs." (`me.xp`) instead (`courtPassEarnedLine`, `viewerOnPacificTime`). The pickles behind play earns keep their own 500/day play cap. A number in `daily_xp_cap` (SQL only) would still cap that cycle per Pacific day. |
| Who earns 0 | Guests (`profiles.is_guest`, so expired guests too) and test accounts (`profiles.is_test_account`). The screen tells them why. |
| Payout | The XP trigger records XP and grant rows only. It never moves pickles or items. A settle step inside `get_reward_track` pays them. That is called when Home opens and when the screen opens. Reason: ledger rows are written by a trigger on `profiles`, and some functions write absolute balances (plan, Pickleague section). |
| Pickle amounts | Plain tiers pay 40 (tiers 1-4), 60 (6-14), 80 (16-24) and 100 (26-29), in November, December and January alike. That is Doggle's bones x4, to match Pickleague prices: a match pays 40 and decor costs 900 to 8,000. January's fifth tiers pay 150, and tier 30 pays 250. Totals: November and December 1,680 pickles plus 6 items each; January 2,680 pickles. |
| January | Pickles only, premium-less (`premium_state 'off'`), like Doggle's December. |
| Catch-up | `supabase/court_pass_catchup_2026_11.sql` replays every `pickle_ledger` row since Nov 1 07:00Z through the trigger's own function, in the same transaction that creates the trigger and seeds the cycles (after `set local lock_timeout = '10s'; lock table public.profiles in exclusive mode;`: EXCLUSIVE also conflicts with the ROW SHARE that `SELECT ... FOR UPDATE` and FK checks take, so no live transaction can hold a profile row the replay will lock; plain SELECTs still run). It skips itself if any XP event exists. Logins since Nov 1 count once per Pacific day, as live. |
| Names | Nothing is named "season": `league_seasons` already uses that word. Tables use Doggle's names (`reward_track_*`, "cycle"). Internal helpers use the `_pl_track_` prefix. The client RPCs keep Doggle's names (`get_reward_track`, `mark_track_rewards_seen`), so app code ports over. |
| Never reversed | XP is never taken back, and granted rewards are never taken back (fix forward). A match deleted after it paid keeps its XP. |

### XP allowlist (exact sources)

`pickle_ledger.source` is the nearest function on the call stack (`migration_pickle_ledger.sql` rule 2). A positive,
non-gold (`not is_bonus`) row from one of these sources earns `floor(delta * xp_ratio)`:

| source (`reward_track_xp_sources.source`) | xp_ratio | Pickles it pays (live SQL) | Pickleballs |
|---|---|---|---|
| `_grant_match_game_bonus` | 0.5 | 40, 40, 40, 35, 30, 25, 20, 15, 10, 5, then 0 (a player's nth paid match of their day; each exact group of players pays at most 3 matches in 12 h). `migration_fair_rewards.sql` §2 | 20, 20, 20, 17, 15, 12, 10, 7, 5, 2 |
| `_grant_new_opponent_bonus` | 0.5 | 50 for each new opponent, at most 3 in 7 days. `migration_fair_rewards.sql` §3 | 25 |
| `_grant_checkin_match_bonus` | 0.5 | 25 once a day, for a match within 4 h of a court check-in. `migration_fair_rewards.sql` §3 | 12 |
| `_grant_tournament_participation_bonus` | 0.5 | 50 per completed tournament with real play (4+ who played). `migration_pickle_economy_guards.sql` §5 | 25 |
| login (code, not a table row): any positive row with `source = 'claim_daily_login_streak'` | n/a | daily login reward | +5 once per Pacific date of `created_at` |
| place stay (code, not a table row): `_pl_settle_place_stay` calls `_pl_track_add_xp(..., 'place_stay', <stay id>, 5)` | n/a | a full 4-hour stay at a friend's My Place (`migration_place_stays.sql`) | +5 per stay; 0 when ended early |

These are left out on purpose. They still earn pickles but no pickleballs:

| Source | Why it's out |
|---|---|
| `_grant_daily_streak_bonus` (play streak) | A streak bonus, not play itself. Doggle leaves streak bonuses out too. At up to 200 a day it would also outweigh play. |
| `_grant_court_bonus` (new court) | Once per court name, and court names can be typed (spammable). |
| `_grant_pickles_on_badge` | One-time per badge. |
| `submit_drill_review` (and `log_session_drill`, which pays through it) | A review that can be saved up for 7 days. Brian's rule: no reviews. |
| `claim_ftue_step`, `claim_welcome_pickles`, `_grant_first_match_bonus`, `_grant_first_doubles_bonus`, `_pl_pay_referral_reward` | One-time. |
| `claim_anniversary_pickles` | A once-a-year gift. |
| Wagers, prizes (`award_pickles_from_pool`, `distribute_*`, `auto_payout_*`) | Prizes and wagers aren't repeatable play. |
| `godmode_*`, `claim_godmode_pickles` | Admin. |
| Shop, refunds, reversals | Not earns. |
| `_grant_season_organiser_bonus` | Gold, and organising isn't playing. |
| `_pl_track_settle` (the track's own payout) | Gold, so tiers can't feed XP. |

Test assumptions: a weekend player (2 days a week, 4 matches a day, a check-in, 1 new opponent a week, 15 logins) earns about
890 XP, which is tier 20. A league regular (3 days a week, 3 matches) earns about 1,190, tier 26. With no pickleball cap, a
grinder is bounded by the 500-pickle play cap: at most about 255 a day (250 from play, 5 from logging in), so tier 30 takes at
least 6 days. Tiers live in SQL: tune them in January if November's and December's numbers say so.

## Server

### Migration files, in apply order

1. `supabase/migration_court_pass_tables.sql`: tables, RLS, `home_items.track_only`, `buy_home_item` (replaced), the settle source's ledger label, account-deletion purge.
2. `supabase/migration_court_pass_xp.sql`: the XP allowlist seed, helpers, the `pickle_ledger` trigger, settle, the two RPCs.
3. `supabase/migration_court_pass_cycles_2026_11.sql`: November's cycle, its 12 harvest items (`shop_items` + `home_items`), tiers, rewards.
4. `supabase/migration_court_pass_cycles_2026_12_2027_01.sql`: December's and January's cycles, December's 12 winter items, tiers, rewards.
5. `supabase/court_pass_catchup_2026_11.sql`: the catch-up (below). Files 2-5 apply in ONE transaction, after `lock table public.profiles in exclusive mode;` (every apply transaction starts with `set local lock_timeout = '10s';`, so a lock blocked by a busy session fails in 10 s and rolls back).
6. `supabase/migration_court_pass_art_2026_11.sql` and `supabase/migration_court_pass_art_2026_12.sql`: **generated** by `node art/court-pass/build.mjs <cycle>`. Each writes `home_item_art` rows and `home_items.art_aspect` for its month's 8 decor items only.
7. Re-run `supabase/migration_rls_hardening_2026q3.sql`, with its allowlist edited to add `'get_reward_track','mark_track_rewards_seen'` under a comment `-- Court Pass (migration_court_pass_xp.sql, which grants them too).`

Every file must:
- be idempotent, with no top-level transaction;
- start with a header in the house style: the quote and date, what changes, new tables, new and replaced functions, locks, how to apply, and the persona test;
- use `create or replace trigger`, never drop + create, on `pickle_ledger` and `profiles`. Enable RLS and create policies only when missing, as `migration_pickle_ledger.sql` does: a re-run must never take ACCESS EXCLUSIVE on a hot table.

Files 2, 3 and 4 each check that the earlier ones are applied (Doggle 0498 and 0499 open with that `do $$` guard).
November started Nov 1 07:00Z, before the SQL went live, so the catch-up always runs with it (`court-pass-apply.ps1`).

### 1. `migration_court_pass_tables.sql`

Port Doggle 0497. Differences from Doggle are marked **PL**.

```
reward_track_cycles   (id text pk 'YYYY-MM', title, starts_at, ends_at, premium_state text default 'coming_soon'
                       check in ('coming_soon','off'), daily_xp_cap int null (null = no cap; no default)
                       check (null or > 0), created_at)
                       + exclusion constraint reward_track_cycles_no_overlap (gist, tstzrange(starts_at, ends_at, '[)') &&)
reward_track_tiers    (cycle_id fk cascade, tier 1..100, xp_required > 0, pk (cycle_id, tier))
reward_track_rewards  (cycle_id, tier, lane 'free'|'premium', kind, amount int, shop_item_slug text
                       references shop_items(slug), home_item_id text references home_items(id), title text not null,
                       rarity text null|'common'|'rare'|'legendary', pk (cycle_id, tier, lane), fk (cycle_id, tier) -> tiers cascade)
                       PL kind check: ('pickles' and amount > 0 and both item columns null)
                                   or ('shop_item' and shop_item_slug not null and home_item_id null)
                                   or ('home_item' and home_item_id not null and shop_item_slug null)
reward_track_xp       (profile_id fk profiles cascade, cycle_id fk cascade, xp int >= 0, tier int >= 0, updated_at, pk (profile_id, cycle_id))
reward_track_xp_events(id identity pk, profile_id, cycle_id, source text check in ('ledger','login') (PL: no 'checkin'),
                       source_ref text, xp_day date (Pacific), pickles int (PL name; Doggle 'points'), xp int >= 0, created_at,
                       unique (profile_id, cycle_id, source, source_ref)); index (profile_id, cycle_id, xp_day)
reward_track_grants   (profile_id, cycle_id, tier, lane default 'free', granted_at default now(), paid_at, seen_at,
                       pk (profile_id, cycle_id, tier, lane)); PL: partial index (profile_id) where paid_at is null
reward_track_xp_sources (PL, in place of Doggle's reward_track_xp_reasons and of the plan's pickle_ledger_sources.track_xp:
                       adding a column to pickle_ledger_sources would take ACCESS EXCLUSIVE on a table the capture
                       trigger reads on every pickles change, for the whole file's transaction)
                       (source text pk, xp_ratio numeric(4,2) not null default 0.5 check (> 0 and <= 5), note text)
```

- **RLS:** the same as Doggle. Signed-in users read cycles, tiers and rewards. A player reads their own xp and grants. `reward_track_xp_events` and `reward_track_xp_sources` have no policies (server only). Revoke insert, update, delete and truncate from public, anon and authenticated on all of them. Grant all to service_role.
- **`alter table public.home_items add column if not exists track_only boolean not null default false`** (comment it). `home_items` is a low-traffic table.
- **`pickle_ledger_sources` row:** `('_pl_track_settle', 1, 'Court Pass reward', 'bonus', 'track', true, 'a Court Pass tier paid out: a reward, not play')`. Use `on conflict (source, sign) do update`, as the ledger file does. The category `track` is new; the app ignores categories.
- **`buy_home_item(text)` replaced.** The body is `migration_my_place.sql`'s, unchanged except for one marked block. The block comes right after the already-owned return and before the `available_from` / `available_until` checks:
  - When `v_item.track_only`, raise `P0001` with HINT `pl:home.track_only`, DETAIL `{item, tier, cycle}`. Find the tier and cycle the same way Doggle 0497 finds them: the newest free-lane reward with `home_item_id = p_item_id`, joined to its cycle.
  - Free lane: `'<Name> is a Court Pass reward, so it isn''t sold in My Place and nothing was spent. Reach tier <N> on the <Cycle title> to earn it.'`
  - Premium only: `'<Name> is on the Court Pass premium track, which is coming soon, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see the free rewards you can earn.'`
  - Neither: `'<Name> is a Court Pass reward, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see how to earn rewards.'`
  - Add `['public.buy_home_item(text)', 'migration_my_place.sql', 'migration_court_pass_tables.sql']` to `supabase/tests/check-replaced-functions.mjs`.
- **Shop items aren't replaced.** Track `shop_items` are seeded `is_active = false`. The Shop lists active items only (`ShopScreen.tsx:130`), and gifting starts there, so `purchase_shop_item` and `gift_shop_item` can't be reached for them from the app. A direct API call gets their existing "Item not available". Both have two candidate live bodies, so replacing them is a drift risk this doesn't need. `equip_shop_item` already accepts an owned inactive item (it checks the purchase row), and so does the profiles column guard.
- **Account deletion:** add `_pl_track_purge()`, a trigger with SECURITY DEFINER and `search_path ''`, that deletes the player's `reward_track_xp`, `reward_track_xp_events` and `reward_track_grants`. Add `trg_profiles_track_purge` (AFTER UPDATE on profiles, `when (old.deleted_at is null and new.deleted_at is not null)`). This is `migration_my_place.sql` §10's pattern. Revoke execute.

### 2. `migration_court_pass_xp.sql`

The allowlist seed: the 4 rows in the table above, each with `xp_ratio 0.5` and a note naming the file that pays it. Use `on conflict (source) do update set xp_ratio = excluded.xp_ratio, note = excluded.note`. The persona test checks the table holds exactly these 4.

Every helper is `security definer set search_path = ''`, with `revoke execute ... from public, anon, authenticated`:

| Function | Port of (Doggle 0498) | Notes |
|---|---|---|
| `_pl_track_pacific_month_start(p_day date) returns timestamptz` | `_track_pacific_month_start` | sql, stable |
| `_pl_track_current_cycle(p_at timestamptz) returns text` | `_track_current_cycle` | |
| `_pl_track_tier_for(p_cycle text, p_xp int) returns int` | `_track_tier_for` | |
| `_pl_track_grant_reached(p_profile uuid, p_cycle text) returns int` | the first half of `_track_sweep` | Locks profiles, then the xp row (`for update`). Re-reads the tier from the XP and updates `reward_track_xp.tier`. Inserts a free-lane `reward_track_grants` row (`on conflict do nothing`, `paid_at` null) for every tier at or below the current one that has none. **Pays nothing.** Returns the rows inserted. |
| `_pl_track_add_xp(p_profile uuid, p_at timestamptz, p_source text, p_source_ref text, p_xp int, p_pickles int default null) returns int` | `_track_add_xp` | Returns 0 when there's no cycle at `p_at`, when `profiles.is_test_account or profiles.is_guest` (**PL**), or for a duplicate event. Locks profiles, then the xp row. No cap: with the cycle's `daily_xp_cap` null (every seeded cycle), `v_add = p_xp`. With a number, the cap is the sum of today's Pacific `xp_day` events under that lock, so `v_add = greatest(0, least(p_xp, cap - today))`, and the event is recorded even at 0 XP. Then calls `_pl_track_grant_reached` (never a payout). |
| `_pl_track_xp_from_ledger(p_row public.pickle_ledger) returns void` | `_track_xp_from_ledger` | `c_login_xp constant int := 5;` (the How-to-earn test greps this exact line). If `p_row.source = 'claim_daily_login_streak'`: add `('login', <Pacific date of created_at>, 5)`. That also covers its streak-badge row, because it has the same key. Else if `not p_row.is_bonus` and the source is in `reward_track_xp_sources`: add `('ledger', p_row.id::text, floor(p_row.delta * xp_ratio)::int, p_row.delta)`. Else nothing. The whole body runs in `begin ... exception when others then raise warning ...; end`: an XP bug never blocks a pickles change. |
| `_pl_track_on_pickle_ledger() returns trigger` | `_track_on_points_ledger` | `perform _pl_track_xp_from_ledger(new); return null;` |
| trigger `trg_pickle_ledger_track_xp` | `on_points_ledger_track_xp` | `create or replace trigger ... after insert on public.pickle_ledger for each row when (new.delta > 0) execute function public._pl_track_on_pickle_ledger();` |
| `_pl_track_settle(p_profile uuid) returns jsonb` | **PL only** (Doggle's sweep pays inside the trigger) | Locks the profiles row first (`for update`, `deleted_at is null`, or return the empty result). Calls `_pl_track_grant_reached` for every cycle the player has a `reward_track_xp` row in where `xp > 0`. Then, for every grant of this player with `paid_at is null` (**any cycle**, so a tier reached on Dec 31 still pays in January), claims it with `update ... set paid_at = now() where ... and paid_at is null returning`, and pays only when a row came back. Pickles: `set_config('pl.pickle_reason', 'Court Pass tier <N>', true)`, `set_config('pl.pickle_bonus', 'true', true)`, `set_config('pl.pickle_meta', '{"cycle_id":..,"tier":..}', true)`, then `update profiles set pickles = coalesce(pickles,0) + amount` (one ledger row per tier), then clear the three settings to `''`. Shop item: `insert into player_shop_purchases (user_id, shop_item_id, cost_paid) select p_profile, s.id, 0 from shop_items s where s.slug = <slug> on conflict (user_id, shop_item_id) do nothing`. Home item: `insert into home_owned_items (owner_id, item_id, cost_paid, source) values (p_profile, <id>, 0, 'grant') on conflict do nothing`. The premium lane is never granted. Returns `{pickles: <sum paid>, grants: [{cycle_id, tier, kind, title}]}`. |

Lock order is the same everywhere: profiles, then `reward_track_xp`. An earn already holds the player's profiles row when the
ledger trigger runs (the change came from an UPDATE of profiles), and settle takes it first. So a match and a screen open
queue up instead of deadlocking.

**Client RPCs** (signed-in only: `revoke all ... from public, anon; grant execute ... to authenticated`):

`get_reward_track(p_cycle text default null) returns jsonb`
- Signed out: P0001, HINT `pl:auth.signed_out`, `'You''re signed out. Sign in to Pickleague and try again.'`
- First, in its own `begin/exception` block, `_pl_track_settle(auth.uid())`. A failed payout logs a warning, shows the screen anyway, and retries on the next open.
- The cycle is `p_cycle`, or else the one running now.
- The JSON is Doggle's shape with the **PL** additions:

```json
{
  "cycle": { "id": "2026-12", "title": "December Court Pass", "starts_at": "...", "ends_at": "...", "premium_state": "coming_soon" },
  "next_starts_at": "2027-01-01T08:00:00+00:00",
  "tiers":   [ { "tier": 1, "xp_required": 10 } ],
  "rewards": [ { "tier": 5, "lane": "free", "kind": "shop_item", "amount": null,
                 "item_key": "cp2612-avatar-snowman", "title": "Snow Day", "rarity": "common",
                 "item": { "id": "<shop_items.id uuid>", "category": "avatar", "slug": "cp2612-avatar-snowman",
                           "icon": "⛄", "payload": { "emoji": "⛄", "bgColor": "#dceefb" } } },
               { "tier": 10, "lane": "free", "kind": "home_item", "amount": null,
                 "item_key": "cp2612_snow_globe", "title": "Court Snow Globe", "rarity": "common",
                 "item": { "id": "cp2612_snow_globe", "slot_group": "shelf_item", "art_aspect": 1, "icon": "❄️" } },
               { "tier": 1, "lane": "free", "kind": "pickles", "amount": 40, "item_key": null,
                 "title": "40 pickles", "rarity": null, "item": null } ],
  "me": { "xp": 0, "tier": 0, "today_xp": 0, "daily_cap": null,
          "can_earn": true, "not_earning": null },
  "grants": [ { "tier": 1, "lane": "free", "granted_at": "...", "seen_at": null } ],
  "paid": { "pickles": 40, "grants": [ { "cycle_id": "2026-12", "tier": 1, "kind": "pickles", "title": "40 pickles" } ] }
}
```

- `item_key` is `coalesce(shop_item_slug, home_item_id)`.
- `rarity` is `coalesce(r.rarity, home_items.rarity)`. Shop items have no rarity column, so the seed sets it on the reward row.
- `me.not_earning` is `'guest' | 'test_account' | null`, and `can_earn = (not_earning is null)`.
- `grants` lists the free lane only, paid rows only (`paid_at is not null`). An unpaid reached tier then reads as the kit's "landing".
- `paid` is what this call's settle paid. It may include grants from an earlier cycle.
- `me.daily_cap` is the cycle's `daily_xp_cap`: null, no cap.
- From Nov 1 to Dec 1 the running cycle is `{ "id": "2026-11", "title": "November Court Pass", ... }`.
- With no cycle: `cycle null`, empty lists, `me` zeros with `daily_cap null`, `paid` still filled, and `next_starts_at` set.

`mark_track_rewards_seen(p_cycle text) returns void`
- Signed out: `pl:auth.signed_out`.
- A null or blank `p_cycle`: `pl:request.bad`, `'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.'`
- Sets `seen_at = now()` on the caller's paid, unseen grants in that cycle.

End with `notify pgrst, 'reload schema';`.

### 3. The cycles files: `migration_court_pass_cycles_2026_11.sql` and `migration_court_pass_cycles_2026_12_2027_01.sql`

Order inside each: cycles, items, tiers, rewards. Catalog rows use `on conflict do nothing`. The items' "not in the shop"
guard is re-asserted on conflict, as in Doggle 0499.

**Cycles**

| id | title | starts_at | ends_at | premium_state | daily_xp_cap |
|---|---|---|---|---|---|
| `2026-11` | November Court Pass | `'2026-11-01 00:00'::timestamp at time zone 'America/Los_Angeles'` (07:00Z) | `'2026-12-01 00:00'` LA (08:00Z) | `coming_soon` | null |
| `2026-12` | December Court Pass | `'2026-12-01 00:00'::timestamp at time zone 'America/Los_Angeles'` (08:00Z) | `'2027-01-01 00:00'` LA (08:00Z) | `coming_soon` | null |
| `2027-01` | January Court Pass | `'2027-01-01 00:00'` LA | `'2027-02-01 00:00'` LA (08:00Z) | `off` | null |

**Tiers** (all three cycles; November's free lane pays exactly December's amounts, with its own items at the fifth tiers): `case when t = 1 then 10 when t <= 5 then 10 + 25*(t-1) else 110 + 50*(t-5) end`.

| Tier | XP | Dec free | Jan free | Dec premium (display only) |
|---|---|---|---|---|
| 1-4 | 10, 35, 60, 85 | 40 pickles each | 40 pickles each | - |
| 5 | 110 | **Snow Day** avatar (common) | 150 pickles | **First Frost Poster** (rare) |
| 6-9 | 160, 210, 260, 310 | 60 pickles each | 60 pickles each | - |
| 10 | 360 | **Court Snow Globe** (common) | 150 pickles | **Reindeer** avatar (rare) |
| 11-14 | 410, 460, 510, 560 | 60 pickles each | 60 pickles each | - |
| 15 | 610 | **Pickleball Ornament Tree** (rare) | 150 pickles | **Icicle Lights** (rare) |
| 16-19 | 660, 710, 760, 810 | 80 pickles each | 80 pickles each | - |
| 20 | 860 | **Snowy Court Window** (common) | 150 pickles | **Holiday Knit Pillow** (rare) |
| 21-24 | 910, 960, 1010, 1060 | 80 pickles each | 80 pickles each | - |
| 25 | 1110 | **Frost** name style, lists (common) | 150 pickles | **Snowflake Court Rug** (rare) |
| 26-29 | 1160, 1210, 1260, 1310 | 100 pickles each | 100 pickles each | - |
| 30 | 1360 | **Snowfall** name style, profile (rare, the finale) | 250 pickles | **Ice Palace Paddle Wall** (legendary) |

Pickles reward titles read `'<n> pickles'`. November and December each pay 1,680 pickles plus 6 items; January pays 2,680
pickles (an earlier draft of this page said 1,820 and 2,820: the per-tier amounts above are right, the totals were 140 high).

**November's 12 items** (`migration_court_pass_cycles_2026_11.sql`; the theme is a harvest court, Thanksgiving and late autumn,
no religious imagery; source of truth `art/court-pass/2026-11/catalog.json`):

| Tier / lane | item_key | Title | Table | Category / slot_group | Aspect | Rarity | Icon | Payload or art |
|---|---|---|---|---|---|---|---|---|
| 5 free | `cp2611-avatar-turkey` | Gobble Gobble | shop_items | `avatar` | - | common | 🦃 | `{"emoji":"🦃","bgColor":"#fbe3c4"}` |
| 10 free | `cp2611_cornucopia` | Pickleball Cornucopia | home_items | `shelf_item` | 1 | common | 🌽 | SVG |
| 15 free | `cp2611_pumpkin_stack` | Harvest Pumpkin Stack | home_items | `accent` | 0.75 | rare | 🍂 | SVG |
| 20 free | `cp2611_window_autumn` | Autumn Court Window | home_items | `window` | 0.9 | common | 🪟 | SVG |
| 25 free | `cp2611-list-harvest` | Harvest | shop_items | `list_name_style` | - | common | 🧡 | `{"kind":"gradient","stops":["#b5451b","#e8a33d"],"direction":"horizontal"}` |
| 30 free | `cp2611-profile-golden-harvest` | Golden Harvest | shop_items | `profile_name_style` | - | rare | ✨ | `{"kind":"animated","effect":"sparkle","base":"#c2571a"}` (the existing sparkle effect) |
| 5 premium | `cp2611_poster_gratitude` | Gratitude Court Poster | home_items | `wall_art` | 0.8 | rare | 🖼️ | SVG |
| 10 premium | `cp2611-avatar-pie` | Pie Time | shop_items | `avatar` | - | rare | 🥧 | `{"emoji":"🥧","bgColor":"#f6e1c3"}` |
| 15 premium | `cp2611_leaf_garland` | Autumn Leaf Garland | home_items | `ceiling` | 4 | rare | 🍁 | SVG |
| 20 premium | `cp2611_pillow_plaid` | Harvest Plaid Pillow | home_items | `couch_pillow` | 1.2 | rare | 🛋️ | SVG |
| 25 premium | `cp2611_rug_harvest` | Woven Harvest Rug | home_items | `rug` | 3 | rare | 🧺 | SVG |
| 30 premium | `cp2611_rack_harvest_hall` | Harvest Hall Paddle Wall | home_items | `paddle_rack` | 1.25 | legendary | 🌾 | SVG |

November's rows follow the December rules below, with `sort_order` 890-893 (Shop), `sort` 890-897 and `season '2026-11'`
(My Place), and `available_until` = Oct 1 (a month before the cycle's start). The Shop rows carry the catalog's descriptions;
`home_items` has no description column, so the catalog's lines for decor are not stored.

**December's 12 items** (`migration_court_pass_cycles_2026_12_2027_01.sql`; the theme is a winter court, unchanged):

| Tier / lane | item_key | Title | Table | Category / slot_group | Aspect | Rarity | Icon | Payload or art |
|---|---|---|---|---|---|---|---|---|
| 5 free | `cp2612-avatar-snowman` | Snow Day | shop_items | `avatar` | - | common | ⛄ | `{"emoji":"⛄","bgColor":"#dceefb"}` |
| 10 free | `cp2612_snow_globe` | Court Snow Globe | home_items | `shelf_item` | 1 | common | ❄️ | SVG (ART) |
| 15 free | `cp2612_ornament_tree` | Pickleball Ornament Tree | home_items | `accent` | 0.75 | rare | 🎄 | SVG (ART) |
| 20 free | `cp2612_window_snow` | Snowy Court Window | home_items | `window` | 0.9 | common | 🌨️ | SVG (ART) |
| 25 free | `cp2612-list-frost` | Frost | shop_items | `list_name_style` | - | common | 🧊 | `{"kind":"gradient","stops":["#2f7fc1","#7cc7ff"],"direction":"horizontal"}` |
| 30 free | `cp2612-profile-snowfall` | Snowfall | shop_items | `profile_name_style` | - | rare | 🌨️ | `{"kind":"animated","effect":"snowfall","base":"#2f7fc1"}` |
| 5 premium | `cp2612_poster_first_frost` | First Frost Poster | home_items | `wall_art` | 0.8 | rare | 🖼️ | SVG (ART) |
| 10 premium | `cp2612-avatar-reindeer` | Reindeer | shop_items | `avatar` | - | rare | 🦌 | `{"emoji":"🦌","bgColor":"#f1e3d3"}` |
| 15 premium | `cp2612_icicle_lights` | Icicle Lights | home_items | `ceiling` | 4 | rare | ✨ | SVG (ART) |
| 20 premium | `cp2612_pillow_knit` | Holiday Knit Pillow | home_items | `couch_pillow` | 1.2 | rare | 🧶 | SVG (ART) |
| 25 premium | `cp2612_rug_snowflake` | Snowflake Court Rug | home_items | `rug` | 3 | rare | ❄️ | SVG (ART) |
| 30 premium | `cp2612_rack_ice_palace` | Ice Palace Paddle Wall | home_items | `paddle_rack` | 1.25 | legendary | 🧊 | SVG (ART) |

- **`shop_items` rows:** `slug` = item_key, `cost 0`, `is_active false`, `sort_order` 900-903. Each needs a one-line `description` in the Shop's voice, for example "Bundled up for the first snow on the courts." Upsert with `on conflict (slug) do update set is_active = false, cost = 0, payload = excluded.payload`.
- **`home_items` rows:** `cost 0`, `season '2026-12'`, `available_from null`, `available_until = <cycle starts_at> - interval '1 month'` (read from the cycle row, already past), `art_key null`, `is_starter false`, `track_only true`, `sort` 900-907. On conflict, re-assert `track_only = true, cost = 0, is_starter = false, available_until = least(coalesce(home_items.available_until, excluded.available_until), excluded.available_until)`. Old clients then hide these items from non-owners (`decorRows` lists an ended item only for its owner), and `buy_home_item` refuses them.
- **Reward rows:** set `rarity` explicitly on every item row; pickles rows leave it null.

### 4. Catch-up (the launch is back-dated to Nov 1)

`supabase/court_pass_catchup_2026_11.sql`. This is not a `migration_` file, so the drift tool ignores it. Port of
`park_pass_catchup_2026_11.sql`: skip if any `reward_track_xp_events` exist; otherwise replay `pickle_ledger` rows with
`created_at >= <2026-11 starts_at> and delta > 0`, in `(created_at, id)` order, through `_pl_track_xp_from_ledger` (the
trigger's own function: half the pickles of the 4 play sources, no cap, logins once per Pacific day, guests and test
accounts 0). Tiers reached get grant rows, paid on each player's next open. It runs in the same transaction as the XP file
and both cycles files, after `lock table public.profiles in exclusive mode;` (profiles, then pickle_ledger: a live
earn's lock order). EXCLUSIVE, not SHARE ROW EXCLUSIVE: SHARE ROW EXCLUSIVE lets a live `SELECT ... FOR UPDATE`
(`buy_home_item`, `purchase_shop_item`) or a match insert's FK check (`FOR KEY SHARE`) take a player's profile row and then
wait on this transaction while the replay waits on that row, a deadlock. EXCLUSIVE waits out every transaction holding a
profile row lock and lets none start until commit; plain SELECTs still run. `lock_timeout = '10s'` bounds the wait. The apply script then prints the totals: people, pickleballs, tiers reached and paid.

### Persona test

`supabase/tests/court_pass_personas.sql` + `supabase/tests/build-court-pass-test.mjs`:

- **Builder:** start from Doggle's `build-reward-track-test.mjs`, with Pickleague's guards from `build-season-rounds-bonus-test.mjs`. It splices files 1-5 (tables, xp, both cycles files, the catch-up), then each art file that exists, then all of them again (re-runnable: the catch-up skips itself), then `migration_rls_hardening_2026q3.sql`. It refuses top-level transaction statements and adds `--applied`. Set `check_function_bodies` off around the splice, like Doggle.
- **Harness:** `pg_temp.ok`, `_results`, and a SUMMARY row first.
- **Persona emails:** use emails outside `@pickleague.test` (for example `cp-w@court-pass.example`). `_pl_mark_new_test_account` marks every `@pickleague.test` profile as a test account, and those earn 0.
- **Cycles:** after T0 and T12 (which read the real cycles), the test moves the seeded ones out of the way (Doggle moves them 500 years) and makes its own cycles around `now()`, with no cap.
- **Launch persona Q:** its ledger rows are written before the files are spliced, dated around Nov 1 07:00Z, so the catch-up (or, with `--applied`, the live trigger) counts them.

Cases. Every row must read `ok = true`.

| # | What it proves |
|---|---|
| T0 | The seed: `2026-11` runs Nov 1 07:00Z to Dec 1 08:00Z, `2026-12` to Jan 1 08:00Z and `2027-01` to Feb 1 08:00Z (from `at time zone`); 06:59:59.999999Z on Nov 1 is no pass. There are 30 tiers, tier 15 = 610 and tier 30 = 1,360, and `daily_xp_cap` is null for all three. Every tier has a free reward. November and December have 6 premium rows each; January has 0 and `premium_state 'off'`. November's items are the cp2611 set and December's the cp2612 set, at the tiers above. Track shop items are `is_active false` with cost 0. Track home items are `track_only`, cost 0, `available_until` in the past and not starters. No premium grant exists. Free pickles total 1,680 (Nov), 1,680 (Dec) and 2,680 (Jan). |
| T1 | Each allowlisted source earns `floor(delta/2)`: rows inserted into `pickle_ledger` with source `_grant_match_game_bonus` 40 → 20, `_grant_new_opponent_bonus` 50 → 25, `_grant_checkin_match_bonus` 25 → 12, `_grant_tournament_participation_bonus` 50 → 25, and a 35 → 17. **End to end:** a real completed singles match between two personas writes a `_grant_match_game_bonus` ledger row and 20 XP each. |
| T2 | Each of these earns 0 XP: `_grant_daily_streak_bonus`, `_grant_court_bonus`, `_grant_pickles_on_badge`, `submit_drill_review`, `claim_ftue_step`, `claim_welcome_pickles`, `_pl_pay_referral_reward`, `godmode_gift_pickles`, `claim_godmode_pickles`, `award_pickles_from_pool`, `_settle_wagers_for_match`, `_pl_track_settle`, a null source, an `is_bonus` row from an allowlisted source, and a negative row. A test account and a guest earn nothing (no xp row, no events). |
| T3 | Login: two `claim_daily_login_streak` calls in one Pacific day give 5 XP and one login event, even across a stored-zone flip (UTC+14). The next Pacific day gives 5 more. |
| T4 | No cap: 8 earns of 40 in one Pacific day give 320, every one in full. A cycle given a number in SQL still caps its day (the earn past it recorded at 0 XP); back to null, the same day earns in full again. |
| T5 | The trigger writes grants with `paid_at` null and moves no pickles. `get_reward_track` pays each tier once: one gold ledger row `'Court Pass tier N'` per pickles tier (source `_pl_track_settle`, 0 XP), items into `player_shop_purchases` (cost 0) and `home_owned_items` (source `grant`). A second open, a replayed earn and two opens change nothing. A deleted grant row is swept and paid on the next open. An unpaid grant from an ended cycle pays on an open during the next cycle and shows in `paid`. |
| T6 | `buy_home_item` on a track item: `pl:home.track_only` with the tier and cycle in the message, nothing charged, no owned row. A premium item's refusal promises nothing. An already-owned track item returns `already_owned true`. The owner equips the track home item (`equip_home_item`) and the track avatar (`equip_shop_item`). A non-owner gets `home.not_owned` / `shop.not_owned`. `purchase_shop_item` / `gift_shop_item` on a track shop item fail with "Item not available" and charge nothing. The Shop's query (`is_active = true`) doesn't return them. |
| T7 | Cycle edges: nothing at or after `ends_at` or before `starts_at`. The boundary instant belongs to the next cycle, which starts from 0. An overlapping cycle is refused. |
| T8 | The re-run changes nothing: XP, tiers, grants, payouts, events and the seed rows stay as they were. There is exactly one XP trigger on `pickle_ledger`. `reward_track_xp_sources` has exactly the 4 sources at 0.5. |
| T9 | The RPC contract follows the JSON shape above: `can_earn` / `not_earning` for a guest and for a test account, no cycle, and `mark_track_rewards_seen` marks only the caller's rows (null cycle → `pl:request.bad`). |
| T10 | Grants and RLS: the RPCs are authenticated-only. Helpers can't be called by clients. Anon can't open the track. A player reads only their own xp and grants. A client can't write any track table or read events or sources. After the hardening re-run, `has_function_privilege('authenticated', 'get_reward_track(text)', 'execute')` is still true. |
| T12 | The launch: Q earns nothing before Nov 1 07:00Z, 20 at 07:00Z, 5 for a login on each Pacific day, and 320 more on Nov 2 with no cap (350, tier 9, 9 unpaid grants). Opening the November pass pays 400 pickles and the Gobble Gobble avatar, reads `daily_cap null`, and `buy_home_item` on a November item names tier 10 of the November Court Pass. When the run applied the files itself, the live ledger since Nov 1 is checked against the catch-up: every allowlisted non-gold earn once at half its pickles, nothing else, one login event per player and Pacific day, XP = the sum of events, a grant per tier. T8 checks the catch-up re-run skipped itself. |
| T11 | Tombstoning a persona (`deleted_at` set) deletes their xp, events and grants. An XP error never blocks a pickles change. To prove it, add `alter table reward_track_xp_events add constraint cp_t11_fail check (xp < 0) not valid`, then confirm an allowlisted ledger row still lands with the pickles changed and 0 XP added. Then drop the constraint. |

### Docs (SERVER)

Update `docs/my-place.md`: add `track_only` to the `home_items` row, `source 'grant'` (Court Pass) to `home_owned_items`,
and a refusal row `home.track_only`.

## Art

December's art follows `art/my-place/catalog.json` `style`: flat, front-on, rounded shapes, no outlines on most shapes,
shading by tints, no gradients in item art. Each SVG uses viewBox `0 0 100 H`, with `H = 100 / aspect`.

The winter palette adds to the My Place palette:

| Name | Hex |
|---|---|
| ice | `#7cc7ff` |
| deep ice | `#2f7fc1` |
| snow | `#f7fbff` |
| holiday red | `#e0533f` |
| pine | `#1b5e20` |

It keeps court green `#2e7d32`, ball yellow `#f2dd4b` and warm wood `#b88a5a`.

**Files (ART owns all of them):**

- `art/court-pass/README.md`: how to build and preview, modelled on `art/my-place/README.md`.
- November (added 2026-11-03) has the same files under `art/court-pass/2026-11/` (catalog, `svg/`, `draw.mjs`, `preview-config.cjs`, `preview/`), with a harvest palette; see its catalog.
- `art/court-pass/2026-12/catalog.json`: all 12 items. Each has id, title, tier, lane, table, slot_group or category, aspect, rarity, icon and a three-sentence `brief`. Write the briefs first, so one artist could draw any of them.
- `art/court-pass/2026-12/svg/<item_key>.svg`: the 8 decor items: `cp2612_snow_globe`, `cp2612_ornament_tree` (a small pine with pickleball ornaments and a paddle topper), `cp2612_window_snow`, `cp2612_poster_first_frost`, `cp2612_icicle_lights`, `cp2612_pillow_knit`, `cp2612_rug_snowflake` (a court-line rug with a snowflake centre) and `cp2612_rack_ice_palace`.
- `art/court-pass/build.mjs`: runs each SVG through the kit's `tools/room-art/import.mjs`, reusing `require('../my-place/lib.cjs').importArt`. It checks each SVG's aspect against the catalog and against SERVER's seed. It takes the cycle as an argument (`node art/court-pass/build.mjs 2026-11`), reads that cycle's seed (`supabase/migration_court_pass_cycles_2026_11.sql`, or `_2026_12_2027_01.sql` for December), and refuses on any id, slot_group, aspect or payload mismatch. It writes **`supabase/migration_court_pass_art_<yyyy>_<mm>.sql`**: upsert `home_item_art (item_id, art_svg)` with `updated_at` moving only on change (like `migration_my_place_items.sql` §3), plus `update home_items set art_aspect = <imported> where id = <id>` for these 8 ids only, guarded by a check that the rows exist. Mark the file "GENERATED, do not edit by hand".
- `art/court-pass/2026-12/preview/items.png` (the kit's `preview.mjs --art ...`, at 160, 80 and 40 px) and `room-winter.png` (a room using the free items, through `art/court-pass/2026-12/preview-config.cjs`, which extends `art/my-place/preview-config.cjs`). Brian reviews these.
- `mobile/src/lib/nameStyles.ts`:
  - Add `'snowfall'` to the `animated` effect union.
  - Add `'cp2612-list-frost': { kind: 'gradient', stops: ['#2f7fc1', '#7cc7ff'], direction: 'horizontal' }`.
  - Add `'cp2612-profile-snowfall': { kind: 'animated', effect: 'snowfall', base: '#2f7fc1' }`.
  - November: `'cp2611-list-harvest': { kind: 'gradient', stops: ['#b5451b', '#e8a33d'], direction: 'horizontal' }` and `'cp2611-profile-golden-harvest': { kind: 'animated', effect: 'sparkle', base: '#c2571a' }` (the existing sparkle effect).
  - These must equal SERVER's payloads.
- `mobile/src/components/NameStyleAnimations.tsx`: `SnowfallName`, with small flakes drifting down across the name, looping. Follow `SparkleName`'s pattern: the RN Animated API, `useNativeDriver` where supported, and it must run on web.
- `mobile/src/components/FlairName.tsx`: dispatch `effect === 'snowfall'` to `SnowfallName`. List mode still degrades to solid `base` (`degradeForList`).
- `mobile/src/lib/courtArt.ts` (pure, types only): the art registry the APP imports. Exported names:
  - `type CourtArtInput = { kind: string; amount?: number | null; itemKey?: string | null; item?: CourtArtItem | null }`
  - `type CourtArtItem = { id: string; category?: string | null; slug?: string | null; slotGroup?: string | null; aspect?: number | null; icon?: string | null; payload?: Record<string, unknown> | null }`
  - `type CourtArtSpec = { kind: 'pickles'; amount: number } | { kind: 'avatar'; shopItemId: string | null; slug: string; emoji: string; bgColor: string } | { kind: 'name_style'; shopItemId: string | null; slug: string; mode: 'list' | 'profile' } | { kind: 'decor'; itemId: string; fits: string; aspect: number | null } | { kind: 'unknown' }`
  - `COURT_ART: Record<string, CourtArtItem & { kind: 'shop_item' | 'home_item' }>`: the 12 December items, a fallback used when `item` is missing. It holds every month's items (November's and December's, 24).
  - `courtArtFor(reward: CourtArtInput): CourtArtSpec`
  - `isEquippableSpec(spec): boolean` (avatar and name_style)
- `mobile/src/lib/__tests__/courtArt.test.ts`: every `COURT_ART` key resolves; avatar and name-style payloads equal the cycles SQL; every name-style slug exists in `NAME_STYLES`; every decor id has `art/court-pass/<its cycle>/svg/<id>.svg`; every cycle folder is checked.
- `mobile/src/components/courtPass/CourtRewardArt.tsx`: `export default function CourtRewardArt(props: { reward: CourtArtInput; size: number; svg?: string | null; name?: string | null })`. It draws:
  - pickles: the `pickle` glyph and `+<n>`;
  - avatar: a round bg colour with the emoji, as `HomeGreeting` draws it;
  - name style: `FlairName` with `styleId` = slug and `mode` from the spec, on `name ?? 'Your name'`;
  - decor: the kit's `RoomArt` with `{ id, name, fits, svg, aspect }` and `createArtResolver()`, or the dashed placeholder when `svg` is null;
  - unknown: the `gift` icon.

## App

The kit goes to `^1.95.0` (it adds `/gamification/rewardTrack`, `RewardTrack`, `ScreenScroll` and `StatStrip`). From 1.93.0 the
kit's `peerDependencies` are unchanged, so no native module is added and this can ship by OTA. `CelebrationHost` is already
mounted (`AppNavigator.tsx:577`).

**`node_modules` is a junction to the main checkout:** do not run a full `npm install` in the worktree. Bump
`mobile/package.json` and refresh the lock with `$env:GITHUB_TOKEN = (gh auth token); npm install --package-lock-only`. The
main session installs 1.95.0 and runs `npx tsc --noEmit` after merge. Vitest works before that, because the new pure modules
import kit **types** only.

**Files (APP owns all of them):**

| File | What |
|---|---|
| `mobile/package.json`, `mobile/package-lock.json` | kit `^1.95.0` |
| `mobile/src/lib/rewardTrackRows.ts` | Pure port of Doggle's file. Exports `RewardTrackCycle`, `RewardTrackData`, `CourtTrackReward` (`TrackReward & { item: CourtArtItem \| null }`), `TrackPaid` (`{ pickles: number; grants: { cycleId; tier; kind; title }[] }`), `mapRewardTrack(raw)` and `unseenGrants(d)`. Defaults: `daily_cap` null (no cap; only a positive number is a cap) and title `'Court Pass'`. It maps `item` (`slot_group` → `slotGroup`, `art_aspect` → `aspect`), `me.can_earn` / `me.not_earning`, and `paid`. |
| `mobile/src/lib/__tests__/rewardTrackRows.test.ts` | Junk rows dropped, defaults, `paid`, `not_earning`. |
| `mobile/src/data/rewardTrack.ts` | `REWARD_TRACK_KEY = 'me:rewardTrack'`, TTL 60 s, `fetchRewardTrack(cycleId?)`, `getRewardTrack()`, `markTrackRewardsSeen(cycleId)`, `invalidateRewardTrack()`. Use `sbCall` from the kit, as in `data/pickleLedger.ts`. When `paid.pickles > 0`: `invalidateQueries(HOME_KEY)` (`components/home/homeData`) and `PICKLE_CALENDAR_CACHE_KEY`. When a home item was paid: `invalidateMyPlace()`. |
| `mobile/src/lib/useCourtPass.ts` | Port of `useParkPass`: `courtPassModel(d, now?)`, `courtPassSummary(d, model)` and `useCourtPass({ enabled })`, re-read on focus. Rain: for each `paid.grants` entry not yet rained this run (module-level `Set` keyed `cycle:tier`), call `rainPayout(paid.pickles, 350)` once from `lib/payoutRain`. If `paid` includes a grant from an earlier cycle, toast `'Your <Month> Court Pass rewards are in your account.'` |
| `mobile/src/lib/courtPassCopy.ts` | Pure. The exact strings are listed below. |
| `mobile/src/lib/__tests__/courtPassCopy.test.ts` | The How-to-earn pin and the premium-words check (below). |
| `mobile/src/screens/CourtPassScreen.tsx` | Port of `ParkPassScreen` (below). |
| `mobile/src/components/home/CourtPassChip.tsx` | Port of `ParkPassChip`: the `pickleball` glyph, `courtPassChipLabel`, and a red dot while a reward is new. It renders nothing while loading, on an error (the server may not be live yet) or with no pass. Props: `{ summary, onPress }`, with theme colours. |
| `mobile/src/screens/HomeScreen.tsx` | A keyed section `key="court-pass"` right after `greeting`: `<CourtPassChip>` → `navigate('CourtPass')`, with `tap('greeting', 'court_pass')`. Add it to the file header's layout sketch. |
| `mobile/src/screens/MyPlaceScreen.tsx` | On my own place only, under the room: the same `CourtPassChip` → `navigate('CourtPass')`. |
| `mobile/src/types/index.ts` | `CourtPass: undefined` in `RootStackParamList`. |
| `mobile/src/navigation/AppNavigator.tsx` | Register `CourtPass` with title `'Court Pass'`, next to `MyPlace`. |
| `mobile/src/navigation/linking.ts` | `CourtPass: 'court-pass'`. |
| `mobile/src/lib/refusals.ts` + `__tests__/refusals.test.ts` | Add `'home.track_only'` (server code, source comment `migration_court_pass_tables.sql`). The copy is the server message as sent (it already names the tier). |
| `docs/app-review-notes.md` | Add the line: "The premium track is not purchasable yet (it shows coming soon); all free-track rewards are earnable." |

### The screen (`CourtPassScreen`)

- Rows come from `useCourtPass` and the model from the kit's `buildRewardTrack` with `COURT_PASS_COPY`. It renders through the kit's `RewardTrack` with `renderRewardArt = (r, size) => <CourtRewardArt reward={r} size={size} svg={art[r.itemKey]} name={firstName} />`, where `art = useItemArt(<decor item keys>)` from `data/myPlace`. The kit's cells hold the reward object as given (`rewardTrack.ts:308`), so `item` survives. Read it as `r as CourtTrackReward`.
- **Header:** the cycle title, `COURT_PASS_INTRO`, `courtPassDailyLine(todayXp, dailyCap)`, then an outline button **"How to earn pickleballs"**.
  - When `me.not_earning` is `'guest'`: a Panel with `COURT_PASS_GUEST` and a "Finish signing up" button → `UpgradeAccount`.
  - When it is `'test_account'`: a Panel with `COURT_PASS_TEST_ACCOUNT`.
- **How-to-earn sheet** (kit `BottomSheet`, title "How to earn pickleballs", icon `pickleball`): one row per `PICKLEBALL_WAYS` entry (title, detail, `+amount` in primary), then `PICKLEBALL_RULES`, then a "Got it" button.
- **New-rewards sheet:** for unseen free grants of this cycle, `celebrate()` once, then a sheet "New Court Pass reward" listing the art, title and tier, with the equip action. Closing it calls `markTrackRewardsSeen` (best effort).
- **Detail sheet:**
  - status, rarity and tier tags, the reason, and the next step;
  - premium shows "Coming soon" and nothing more;
  - an owned free item gets an action:
    - avatar: **"Wear it"** → `equipShopItem({ id: item.id, category, slug, payload })` (`data/cosmetics`), then toast `'You're wearing <title>.'`;
    - name style: **"Use this name style"** → the same call, then toast `'Your name now shows <title>.'`;
    - decor: **"Open My Place"** → `navigate('MyPlace')` (the player picks the slot there);
  - on failure, toast `explainRefusal(e, 'Couldn't put that on just now. Try again, or open your Profile to do it there.')`.
- **Between passes:** `EmptyState` with `nextCourtPassLine(nextStartsAt)`, `COURT_PASS_INTRO` and the action "Open My Place".

### `courtPassCopy.ts` (exact strings)

```ts
export const COURT_PASS_NAME = 'Court Pass';
export const COURT_PASS_COPY: Partial<RewardTrackCopy> = {
  units: 'pickleballs',
  unit: 'pickleball',
  lockedNextStep: () => 'Play matches, new opponents and tournaments, or check in and play, to earn pickleballs.',
  premiumComingSoonReason: 'The premium track is coming soon.',
};
export const COURT_PASS_PREMIUM_TITLE = 'Premium track coming soon';
export const COURT_PASS_PREMIUM_HINT = { collapsed: 'Tap to preview', expanded: 'Tap to hide' };
export const COURT_PASS_PREMIUM_SHEET = 'Coming soon';
export const COURT_PASS_INTRO =
  'Every month a new Court Pass opens. Earn pickleballs by playing matches, new opponents and tournaments, ' +
  'and each tier you reach pays out on its own. Everything you earn is yours to keep.';
export function courtPassDailyLine(todayXp: number, cap: number | null): string;
  // cap null (every pass): `Today: ${n} pickleballs.`
  // a number (SQL only): `Today: ${clamped} / ${cap} pickleballs. The pickleball day resets at midnight Pacific time.`
export function courtPassEarnedLine(me: { todayXp: number; xp: number; dailyCap: number | null }, onPacificTime: boolean): string;
  // the screen's line: courtPassDailyLine when capped or on Pacific time, else `This Court Pass: ${xp} pickleballs.`
export function viewerOnPacificTime(at?: Date): boolean;  // device wall clock == America/Los_Angeles (false if Intl can't tell)
export function courtPassDate(iso: string, locale?: string): string;      // "December 1", viewer's zone
export function nextCourtPassLine(nextStartsAt: string | null, locale?: string): string;
  // 'Next Court Pass starts December 1' | 'The next Court Pass is on its way.'
export type CourtPassSummary =
  | { kind: 'running'; tier: number; xpToNext: number; finished: boolean; newCount: number }
  | { kind: 'next'; startsAt: string };
export function courtPassChipLabel(s: CourtPassSummary, locale?: string): string;
  // 'Court Pass · Tier 7 · 22 to next' | 'Court Pass · Tier 30 · all tiers done' | 'Court Pass · starts December 1'
export function courtPassChipA11y(s: CourtPassSummary, locale?: string): string;
export function newRewardsTitle(count: number): string;   // 'New Court Pass reward' | '3 new Court Pass rewards'
export const NEW_REWARDS_BODY = 'You reached a new tier. It is in your account now, yours to keep.';
export const COURT_PASS_GUEST =
  "Guest passes don't earn pickleballs. Finish signing up and every match from then on counts.";
export const COURT_PASS_TEST_ACCOUNT =
  "Test accounts don't earn pickleballs, so real players' tracks stay fair. Use your real account to earn.";

export type PickleballWay = { title: string; amount: string; detail: string };
export const PICKLEBALL_WAYS: PickleballWay[] = [
  { title: 'Play a match', amount: '20 to 2',
    detail: 'Your first 3 matches a day earn 20 each, then 17, 15, 12, 10, 7, 5 and 2. The same players earn for up to 3 matches in 12 hours.' },
  { title: 'Play someone new', amount: '25', detail: 'Each player you play for the first time, up to 3 a week.' },
  { title: 'Check in, then play', amount: '12', detail: 'Once a day, when you play a match within 4 hours of checking in at a court.' },
  { title: 'Play a tournament', amount: '25', detail: 'Each tournament you finish where 4 or more players played.' },
  { title: 'Open Pickleague', amount: '5', detail: 'Once a day, with your daily login reward.' },
  { title: "Stay at a friend's place", amount: '5', detail: "Each stay at a friend's My Place that lasts the full 4 hours." },
];
export const PICKLEBALL_RULES =
  'Playing earns half the pickles it pays, rounded down; opening Pickleague adds 5 once a day. ' +
  'Badges, play streaks, new courts, drill reviews, gifts, prizes and getting started earn pickles but no pickleballs.';
```

### `courtPassCopy.test.ts` (the pin)

The test reads files under `../../../../supabase/` with `fs`, as `myPlace.test.ts` does.

- `PICKLEBALL_WAYS.length === 5`.
- `migration_fair_rewards.sql` matches each of these:
  - `/v_bonus := case when v_n <= 3 then 40 else greatest\(40 - 5 \* \(v_n - 3\), 0\) end;/`
  - `/if v_group >= 3 then v_bonus := 0; end if;/`
  - `/exit when v_recent >= 3;/`
  - `/v_pay := least\(50, public\._pl_play_cap_left\(v_uid\)\);/`
  - `/v_pay := least\(25, public\._pl_play_cap_left\(v_uid\)\);/`
- `migration_pickle_economy_guards.sql` matches `/v_pay := least\(50, public\._pl_play_cap_left\(v_uid\)\);/`.
- The match row's numbers: compute `[40,40,40,35,30,25,20,15,10,5].map(p => Math.floor(p / 2))`, de-duplicate in order, and expect the numbers in the detail (`20, 17, 15, 12, 10, 7, 5, 2`) and the amount `'20 to 2'`.
- New opponent, check-in and tournament amounts equal `Math.floor(50/2)`, `Math.floor(25/2)` and `Math.floor(50/2)`.
- `migration_court_pass_xp.sql`:
  - matches `/c_login_xp constant int := 5;/`;
  - has an allowlist insert holding exactly `_grant_match_game_bonus`, `_grant_new_opponent_bonus`, `_grant_checkin_match_bonus` and `_grant_tournament_participation_bonus` at `0.5`;
  - names none of `_grant_daily_streak_bonus`, `_grant_court_bonus`, `_grant_pickles_on_badge` or `submit_drill_review` in that block.
- Both cycles files set `daily_xp_cap` null for every cycle; `_pl_track_add_xp` adds `p_xp` in full when the cap is null; `get_reward_track` sends `daily_cap` null with no cycle; the tables file declares the column nullable. `PICKLEBALL_RULES`, the intro and every way's detail name no cap, limit, `125`, reset or midnight.
- Premium words: `COURT_PASS_PREMIUM_TITLE`, `COURT_PASS_PREMIUM_SHEET`, the hint strings and `premiumComingSoonReason` match none of `/price|\$|buy|purchase|upgrade|notify|remind|web|unlock|would have|\d{1,2}(st|nd|rd|th)|\b\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i` (no date in any form: every month name or abbreviation, ordinals and bare day numbers).

## Ownership (no file has two owners)

| Builder | Owns | Others rely on |
|---|---|---|
| **SERVER** | `supabase/migration_court_pass_tables.sql`, `supabase/migration_court_pass_xp.sql`, `supabase/migration_court_pass_cycles_2026_11.sql`, `supabase/migration_court_pass_cycles_2026_12_2027_01.sql`, `supabase/court_pass_catchup_2026_11.sql`, `supabase/migration_rls_hardening_2026q3.sql` (allowlist edit), `supabase/tests/court_pass_personas.sql`, `supabase/tests/build-court-pass-test.mjs`, `supabase/tests/check-replaced-functions.mjs` (one entry), `docs/my-place.md` | The RPC names and JSON shape above. Item keys, slot groups, aspects and payloads exactly as in the December items table (ART's build and APP's copy test read them). The exact SQL lines the copy test greps (`c_login_xp constant int := 5;` and the allowlist insert). |
| **ART** | `art/court-pass/**`, `supabase/migration_court_pass_art_2026_11.sql` and `supabase/migration_court_pass_art_2026_12.sql` (generated by its `build.mjs`), `design/court-pass/render-preview.mjs`, `mobile/src/lib/courtArt.ts`, `mobile/src/lib/__tests__/courtArt.test.ts`, `mobile/src/components/courtPass/CourtRewardArt.tsx`, `mobile/src/lib/nameStyles.ts`, `mobile/src/components/NameStyleAnimations.tsx`, `mobile/src/components/FlairName.tsx` | `CourtRewardArt` (default export, props `{ reward, size, svg?, name? }`), `courtArtFor`, `isEquippableSpec`, `COURT_ART`, and the types `CourtArtInput`, `CourtArtItem`, `CourtArtSpec`. |
| **APP** | `mobile/package.json`, `mobile/package-lock.json`, `mobile/src/lib/rewardTrackRows.ts` (+ test), `mobile/src/data/rewardTrack.ts`, `mobile/src/lib/useCourtPass.ts`, `mobile/src/lib/courtPassCopy.ts` (+ test), `mobile/src/screens/CourtPassScreen.tsx`, `mobile/src/components/home/CourtPassChip.tsx`, `mobile/src/screens/HomeScreen.tsx`, `mobile/src/screens/MyPlaceScreen.tsx`, `mobile/src/types/index.ts`, `mobile/src/navigation/AppNavigator.tsx`, `mobile/src/navigation/linking.ts`, `mobile/src/lib/refusals.ts` (+ test), `docs/app-review-notes.md` | Imports ART's names above. Until ART lands, the screen may import them as written: the names are pinned here. |
| main session | `docs/court-pass.md` (this page), the apply script, `npm install`, tsc, commits, OTA | |

**Cross-builder checks:**

- ART's `build.mjs` and `courtArt.test.ts` read SERVER's cycles SQL.
- APP's `courtPassCopy.test.ts` reads SERVER's xp and cycles SQL and the live earn files.
- A test that can't find a file it needs fails with a message naming the file. It never passes silently.

## Apply (main session, after merge)

1. `node supabase/tests/build-court-pass-test.mjs $env:TEMP\court_pass_test.sql`, then from the linked checkout
   `supabase db query --linked -f $env:TEMP\court_pass_test.sql -o csv`. Every row must read `ok = true`. Also run
   `node supabase/tests/check-replaced-functions.mjs` against live. The unapplied test holds `profiles` (EXCLUSIVE) and
   `home_items` (the ADD COLUMN) until its rollback, so match saves, logins, profile edits and My Place pause on live
   while it runs: run it at a quiet hour (the apply script's step 4 prints how long it held them).
2. `court-pass-apply.ps1` applies file 1, then files 2-5 in one transaction (the lock prelude, the XP file, both cycles
   files, the catch-up), prints the catch-up totals, applies the art files, then re-runs `migration_rls_hardening_2026q3.sql`
   and the persona test with `--applied`.
3. Install kit 1.95.0 in `mobile/`, then `npx tsc --noEmit` and `npm test`. Then OTA. From then on the chip reads
   "Court Pass · Tier N · M to next" for the November pass.

## Not in v1

- Paid premium: Phase 3 in the plan. That needs `react-native-purchases`, a native build and a webhook.
- Catch-up multipliers and weekly challenges.
- Sale copy for shop track items (unreachable).
- A cron job: three months are seeded (November to January), so seed February and March before Jan 31.

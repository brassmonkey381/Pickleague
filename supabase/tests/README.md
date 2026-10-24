# SQL Integration Tests (Tier 3)

This directory holds SQL integration tests for the SECURITY DEFINER bracket
functions and triggers — the third tier of the bracket-verification approach
described in [`docs/tournament-formats/bracket-verification.md`](../../docs/tournament-formats/bracket-verification.md).

| Tier | Where                                              | Status   |
|------|----------------------------------------------------|----------|
| 1    | TS unit tests — `mobile/src/lib/__tests__/`        | shipped  |
| 2    | Godmode read-only verification (in app)            | shipped  |
| 3    | SQL function tests — `supabase/tests/` (this dir)  | this PR  |

Each test file inserts synthetic rows, calls the function under test,
asserts via `SELECT`, and then `ROLLBACK`s so the database is left clean.
No CI runner is wired up yet — these are **human-runnable** today.

## What's covered

- `test_generate_playoff_bracket.sql`
  - **Test A:** `generate_playoff_bracket` with `playoff_format='top_4'` and
    4 entrants — asserts one Semifinals round with two matches seeded 1v4
    and 2v3.
  - **Test B:** `generate_playoff_bracket` with `playoff_format='top_2'` and
    4 entrants — asserts one Finals round (seeds 1v2) AND one Third Place
    Match round (seeds 3v4).
- `test_advance_non_mlp_playoff_bracket.sql`
  - **Test C:** `_advance_non_mlp_playoff_bracket` trigger fires when the
    last Semifinal flips to `completed` — asserts a Finals round is created
    with one match populated from the two SF winners.
- `test_advance_non_mlp_playoff_qf.sql`
  - **Test D:** `_advance_non_mlp_playoff_bracket` driven across a full
    Top-8 bracket — completes 4 Quarterfinals and asserts a Semifinals
    round is seeded with the documented outside-in pairing of the QF
    winners (`mo[0]` vs `mo[3]`, `mo[1]` vs `mo[2]`); then completes both
    Semifinals and asserts a single Finals match pairing the two SF
    winners (one champion). Also asserts no 3PM when
    `playoff_third_place` is false.
  - **Test E:** With `playoff_third_place = true` on a `top_4` bracket,
    completing both Semifinals creates BOTH a Finals round (SF winners)
    AND a Third Place Match (`round_type 'third_place_match'`) pairing the
    two SF losers — pinning the toggle behaviour from PR #62 / #69.

- `presence_p1_personas.sql` (+ `build-presence-test.mjs`)
  - Presence Phase 1 (friends at the courts): applies the five
    `migration_presence_p1_*.sql` files and re-runs
    `migration_rls_hardening_2026q3.sql` inside one rolled-back transaction,
    then checks grants, duplicate courts, location-confirmed check-ins,
    sessions, who sees whom (owner, friend, close friend, closed- and
    open-league mates, stranger, blocked both ways, guest, deleted, unclaimed),
    crowd bands, friend requests, favorites, account deletion and retention.
    Phase 1.5 (`validity_personas.sql`, spliced in at `-- @@VALIDITY@@`)
    applies `migration_validity_rules.sql` too and checks the stay proof
    (counted from the arrival fix, End as a check-out), session validity,
    match links, `my_session_validity`, the 1.0.4 check-out and End call
    shapes, the anti-gaming rules (server-stamped match times and
    confirmations, no overlapping sessions, one session per match or drill,
    drills held during the session, `at_court`), and that a broken validity
    refresh never blocks a match, a drill review or an End.
    `refusal_personas.sql` (`-- @@REFUSALS@@`) and `tap_time_personas.sql`
    (`-- @@TAPTIME@@`) are spliced in the same way.
    Court arrival (`court_arrival_personas.sql`, at `-- @@ARRIVALS@@`)
    applies `migration_court_arrival_settings.sql`,
    `migration_court_arrival_queue.sql` and `migration_court_checkin_prompt.sql`,
    then `migration_court_arrival_two_hours.sql` (arrival check-ins last 2 hours),
    after the other files, again after the re-runs of the older files (which
    put older function bodies back), then re-runs the hardening file. It
    checks the queue's answers, check-in after a minute, the take-back within
    5 minutes (and the check-in it reopens elsewhere), Not here, "Still at",
    the expiry push, no rewards without a real fix, the "Check in nearby?"
    prompt and the app-open scan, settings, sign-out and account deletion,
    one player never touching another's arrival, what re-applying the queue
    file repairs after a re-run of `migration_validity_rules.sql`, and that
    every client RPC (the court outline editor's included) is still
    executable after the hardening re-run. Time is moved by backdating rows:
    `now()` is fixed for the whole transaction.
    It cannot be pasted as is: build it first, then run the output.

    ```sh
    node supabase/tests/build-presence-test.mjs /tmp/presence_p1_test.sql
    # from the linked checkout:
    supabase db query --linked -f /tmp/presence_p1_test.sql -o csv
    ```

    The first row is the summary (`SUMMARY: N passed, 0 failed`). The builder
    refuses any input with a top-level `begin;` / `commit;` / `end;` /
    `rollback;`, which would end the transaction early.

- `court_discovery_personas.sql` (+ `build-court-discovery-p1-test.mjs`)
  - Court discovery Phase 1: applies `migration_venue_data_guards.sql` (Phase 0),
    `migration_court_discovery_p1.sql` twice and re-runs
    `migration_rls_hardening_2026q3.sql` inside one rolled-back transaction, then
    checks `list_courts_nearby` and `get_court` on test courts in the open
    Pacific: the Lincoln Park pair is one row, rejected rows and aliases are
    hidden, a sport matches through an alias, blank facts fill from aliases,
    a private league is counted only for its members, `get_court(alias)`
    opens the facility, the refusals (`pl:court.gone`, `pl:request.bad`,
    `pl:auth.signed_out`), keyset paging, anon denied, and that
    `venues_point_geog_idx` serves the prefilter with seq scans off.

    ```sh
    node supabase/tests/build-court-discovery-p1-test.mjs /tmp/court_discovery_p1_test.sql
    supabase db query --linked -f /tmp/court_discovery_p1_test.sql -o csv
    ```

- `hide_test_accounts_personas.sql` (+ `build-hide-test-accounts-test.mjs`)
  - Hide test accounts from discovery: applies
    `migration_hide_test_accounts.sql` twice and re-runs
    `migration_rls_hardening_2026q3.sql` inside one rolled-back transaction,
    then checks the backfill and the new-account marking, grants, that only a
    God mode admin may read or change the switch or a profile's flag (a clear
    `pl:admin.only` refusal for everyone else, the profiles table included),
    and, with the switch off and on, what an ordinary player, a test account
    and the admin find in `discover_players`, `suggest_friends`,
    `court_presence`, `venue_players_here` and `venue_crowd`; friends lists and
    friend requests are unaffected. Build it first, then run the output:

    ```sh
    node supabase/tests/build-hide-test-accounts-test.mjs /tmp/hide_test_accounts_test.sql
    # from the linked checkout:
    supabase db query --linked -f /tmp/hide_test_accounts_test.sql -o csv
    ```

- `check-replaced-functions.mjs`
  - Run against live right before the court arrival files or
    `migration_hide_test_accounts.sql` are applied. Those
    files rewrite live functions from the repo files that last defined
    them; this builds one read-only SQL file that compares each live body
    with that file's and with the replacing file's (whitespace ignored)
    and fails with `DRIFT: ...` on anything else, so a change made on live by
    hand is merged into the replacing file instead of being reverted.

    ```sh
    node supabase/tests/check-replaced-functions.mjs /tmp/replaced_functions_check.sql
    # from the linked checkout; any drift is an error ("DRIFT: ..."):
    supabase db query --linked -f /tmp/replaced_functions_check.sql
    ```

## How to run

### Option 1 — Supabase MCP `execute_sql`

Open the test file, paste the entire `begin; … rollback;` block into the
MCP `execute_sql` call. Each test asserts via `do $$ begin assert (…), 'msg'
end $$;` — assertion failures raise an exception and the entire transaction
rolls back. A clean run prints `ROLLBACK` and no error.

```sh
# pseudo-invocation via the MCP tool
mcp_supabase_execute_sql --sql "$(cat supabase/tests/test_generate_playoff_bracket.sql)"
```

### Option 2 — `psql` against the project database

```sh
# requires a direct Postgres connection string (Supabase → Project Settings → Database)
psql "$DATABASE_URL" -f supabase/tests/test_generate_playoff_bracket.sql
psql "$DATABASE_URL" -f supabase/tests/test_advance_non_mlp_playoff_bracket.sql
```

A passing run looks like:

```
BEGIN
… (NOTICE lines, INSERTs, function output) …
ROLLBACK
```

A failing run prints `ERROR:  Test X: …` and aborts the transaction.

> **Heads-up (PR landing):** Tests A and B in
> `test_generate_playoff_bracket.sql` currently fail against the live DB
> with `function min(uuid) does not exist` — that's a regression in the
> H2H tiebreaker added by a parallel branch's
> `migration_playoff_tiebreaker_and_3pm.sql`, not a test bug. The tests
> themselves are correct against the canonical
> `migration_generate_playoff_bracket.sql`. Test C passes today and is
> the working demonstration of the framework.

### Option 3 — Supabase SQL Editor (web)

Paste a single test file into the SQL Editor in the Supabase dashboard and
hit Run. The editor will display the assertion message on failure or report
`ROLLBACK` on success.

## How the tests work

- Every test is wrapped in `begin; … rollback;` so synthetic rows never
  persist.
- Auth + profile rows are required because `tournaments.created_by` and
  `tournament_matches.team*_player*` reference `public.profiles(id)`, which
  in turn references `auth.users(id)`. The tests insert minimal rows into
  `auth.users` (just `id` and `email`); the `on_auth_user_created` trigger
  on `auth.users` populates `public.profiles` automatically.
- Score values respect the `tournament_matches_score_sanity_check`
  constraint added in `migration_audit_fixes_2026q2.sql`: the winning score
  is ≥ 11, the win margin is ≥ 2, and the cap is 50. We use `11-5`.
- Assertions use `do $$ begin assert (…), 'message'; end $$;`. PostgreSQL's
  `ASSERT` raises a generic `assert_failure` exception when the predicate
  is false — that aborts the surrounding transaction and surfaces the
  message in the client.

## Adding more tests

1. Copy one of the existing files as a starting point.
2. Decide what behavior you're pinning down. Good candidates:
   - `generate_playoff_bracket` with `playoff_format='top_8'` (8 entrants,
     4 Quarterfinal matches).
   - `_advance_non_mlp_playoff_bracket` after a Quarterfinals round — the
     trigger should create Semifinals with the standard outside-in
     pairing (`mo[0]` vs `mo[3]`, `mo[1]` vs `mo[2]`).
   - Negative tests: `generate_playoff_bracket` should `raise exception`
     when group-play matches are still pending. Wrap the call in a
     `begin … exception when others then assert …; end` block.
3. Wrap setup + function call + assertions in `begin; … rollback;`.
4. Run via one of the options above and confirm the assertion message
   would surface a real regression.

## Promoting to CI later

This tier is intentionally manual today. If we want to automate it:

- **`pg-tap`** is the standard Postgres testing tool — would let us write
  tests as `select is(...)` / `select ok(...)` and use `pg_prove` as the
  runner. Adopting it is non-trivial (extension install + test runner
  rework) and isn't justified yet.
- A lighter intermediate step is a small GitHub Action that runs each
  `*.sql` file against a Supabase preview branch (created via the
  `mcp_supabase_create_branch` tool) and fails the job if `psql` exits
  non-zero. The current `assert`-based pattern works fine for that — no
  test-framework rewrite required.

Until then, run these tests manually before merging any change to
`migration_generate_playoff_bracket.sql`,
`migration_advance_non_mlp_playoff.sql`, or any other migration that
touches playoff bracket generation or advancement.

- `referral_personas.sql` (+ `build-referral-test.mjs`)
  - Referrals (`migration_referrals.sql`, Doggle parity): applies the
    migration twice and re-runs `migration_rls_hardening_2026q3.sql` inside
    one rolled-back transaction, then checks grants, the claim refusals (self,
    double, 30-day age, guest, unknown, blank, unclaimed), pay-on-claim,
    metadata link at sign-up with pay on confirmation, the guest upgrade path,
    idempotent re-pay, a confirmation that survives a broken payout, the 1/5/10
    milestones, stats, preview, RLS, the column guard, the daily nudge and the
    click purge.

- `profiles_guard_personas.sql` (+ `build-profiles-guard-test.mjs`)
  - Profiles column guard (`migration_profiles_column_guard.sql`): applies
    `migration_referrals.sql` and then the guard twice inside one rolled-back
    transaction, then checks: every column the app writes still saves; every
    other live column (read from the catalog) is refused with
    `pl:profile.server_owned`; another player's row, anon, client inserts and
    deletes are refused; player_location_ratings is read-only for players; and
    the server paths still write (welcome grant, Shop purchase, daily streak,
    match confirm with ratings / counters / first-match bonus, referral payout,
    service_role).

- `players_near_personas.sql` (+ `build-players-near-test.mjs`)
  - Players near a search area (`migration_discover_players_near.sql`): applies
    the migration twice inside one rolled-back transaction (it does NOT re-run
    `migration_rls_hardening_2026q3.sql`; the builder refuses unless that
    file's allowlist names `discover_players_near`), then checks: grants and
    attributes, no phone / email column, the signed-out and bad-centre
    refusals; who is found by where they play (open-league home courts; a
    closed league only when the viewer is in it; starred and frequent courts
    only when presence privacy names them; expired guest passes, blocks both
    ways, deleted accounts and the viewer left out); the radius and its 50 mi
    cap; nearest first with the place columns; a pause and a new friendship
    changing what the starred court reveals; drilling only, name / @username
    search with literal `%`; and the God mode test-account switch.

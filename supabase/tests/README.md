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

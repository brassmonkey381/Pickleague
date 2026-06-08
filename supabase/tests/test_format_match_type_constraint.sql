-- ============================================================
-- Tier-3 SQL test for the tournaments format × match_type CHECK
-- constraint (`tournaments_format_match_type_check`, defined in
-- `migration_format_match_type_check.sql`).
--
-- The constraint enforces:
--     match_type = 'doubles'
--     OR format NOT IN ('mlp', 'mlp_random', 'rotating_partners')
--
-- i.e. mlp / mlp_random / rotating_partners are DOUBLES-ONLY.
--
-- This test:
--   * ILLEGAL combos — asserts each INSERT raises a check_violation
--     (SQLSTATE 23514). The violation is caught per-row in an
--     `exception when check_violation` handler that sets a flag;
--     we then assert the flag fired.
--   * LEGAL combos — asserts each INSERT succeeds (row count 1).
--
-- Everything is wrapped in a single `begin … rollback;` so no
-- synthetic rows persist. A clean run prints `ROLLBACK` and no error;
-- any failed assertion raises `assert_failure` and aborts.
--
-- Setup notes:
--   * tournaments.created_by references public.profiles(id), which
--     references auth.users(id). We insert ONE minimal auth.users row
--     (id + unique email) and let the `on_auth_user_created` trigger
--     (`public.handle_new_user`) populate the profile — the current
--     trigger supplies username / full_name / gender defaults, so a
--     bare auth.users insert is sufficient.
--   * tournaments NOT NULL columns satisfied: name, created_by,
--     format, match_type (seeding/status/etc. have defaults).
--   * Requires a role that may insert into auth.users (the MCP
--     service_role or the postgres role).
--
-- See `supabase/tests/README.md` for how to run.
-- ============================================================

begin;

do $constraint_test$
declare
  v_creator   uuid := gen_random_uuid();
  v_email     text := 'fmt-mt-' || gen_random_uuid()::text || '@example.invalid';
  v_violated  boolean;
  v_count     integer;
  -- ILLEGAL: the three doubles-only formats paired with 'singles'.
  v_illegal   text[] := array['mlp', 'mlp_random', 'rotating_partners'];
  -- LEGAL non-restricted formats (allowed with EITHER match_type).
  v_any_mt    text[] := array['round_robin', 'single_elimination',
                              'double_elimination', 'pool_play'];
  v_fmt       text;
  v_mt        text;
begin
  -- ── Setup: one creator profile via the auth trigger ──────────
  insert into auth.users (id, email) values (v_creator, v_email);

  -- Sanity: the trigger created the profile so the FK below resolves.
  select count(*) into v_count from public.profiles where id = v_creator;
  assert v_count = 1,
    'Setup: expected on_auth_user_created to create exactly 1 profile';

  -- ── ILLEGAL combos: doubles-only format + singles → 23514 ────
  foreach v_fmt in array v_illegal loop
    v_violated := false;
    begin
      insert into public.tournaments (name, created_by, format, match_type)
      values ('illegal ' || v_fmt || ' singles', v_creator, v_fmt, 'singles');
    exception
      when check_violation then
        v_violated := true;
    end;
    assert v_violated,
      format('ILLEGAL combo (format=%s, match_type=singles) should have raised '
             'a check_violation but the INSERT was accepted', v_fmt);
  end loop;

  -- ── LEGAL combos #1: doubles-only formats WITH doubles ───────
  foreach v_fmt in array v_illegal loop
    insert into public.tournaments (name, created_by, format, match_type)
    values ('legal ' || v_fmt || ' doubles', v_creator, v_fmt, 'doubles');
    get diagnostics v_count = row_count;
    assert v_count = 1,
      format('LEGAL combo (format=%s, match_type=doubles) should have inserted '
             '1 row but inserted %s', v_fmt, v_count);
  end loop;

  -- ── LEGAL combos #2: unrestricted formats × {singles,doubles} ─
  foreach v_fmt in array v_any_mt loop
    foreach v_mt in array array['singles', 'doubles'] loop
      insert into public.tournaments (name, created_by, format, match_type)
      values ('legal ' || v_fmt || ' ' || v_mt, v_creator, v_fmt, v_mt);
      get diagnostics v_count = row_count;
      assert v_count = 1,
        format('LEGAL combo (format=%s, match_type=%s) should have inserted '
               '1 row but inserted %s', v_fmt, v_mt, v_count);
    end loop;
  end loop;

  -- ── Final tally: 3 doubles-only + (4 formats × 2 match types) = 11 rows ─
  select count(*) into v_count
    from public.tournaments where created_by = v_creator;
  assert v_count = 11,
    format('Expected 11 successfully-inserted tournaments (3 doubles-only + '
           '8 unrestricted), got %s', v_count);

  raise notice 'PASS — format x match_type constraint: 3 illegal singles '
               'combos rejected, 11 legal combos accepted.';
end
$constraint_test$;

rollback;

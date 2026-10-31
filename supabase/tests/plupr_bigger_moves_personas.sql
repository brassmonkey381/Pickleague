-- ============================================================
-- PLUPR moves bigger: persona tests (migration_plupr_bigger_moves.sql).
--
-- NOT runnable on its own: build-plupr-bigger-moves-test.mjs puts, at the
-- marker line below, migration_plupr_bigger_moves.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql. Everything runs
-- inside the begin / rollback below, so the linked (live) database is left
-- untouched:
--   node supabase/tests/build-plupr-bigger-moves-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   PA, PB  established players (20 matches), both PLUPR 3.500
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);

create temp table _ids (k text primary key, id uuid not null);
insert into _ids values
  ('PA', 'a9f20000-0000-4000-8000-000000000001'), ('PB', 'a9f20000-0000-4000-8000-000000000002'),
  ('L',  'a9f21000-0000-4000-8000-000000000001');

create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

-- @@MIGRATION@@


-- ════ M1 the move sizes ══════════════════════════════════════════════════
do $$
declare
  got text;
begin
  got := concat_ws(' ',
    public._plupr_delta(20, 0.4), public._plupr_delta(20, 1.1), public._plupr_delta(20, -2.0),
    public._plupr_delta(10, 0.4), public._plupr_delta(3, 0.4), public._plupr_delta(3, 2.0),
    public._plupr_delta(null, 0.4));
  perform pg_temp.ok('M1 K x5 with the cap: 0.300 0.600 -0.600 0.440 0.700 0.800 0.700',
    got = '0.300 0.600 -0.600 0.440 0.700 0.800 0.700', got);
exception when others then
  perform pg_temp.ok('M1 block crashed', false, sqlerrm);
end $$;


-- ════ M2 a real match: established, even, 11-7 ═══════════════════════════
do $$
declare
  m record;
begin
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'pm-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'PM Player ' || k), now()
    from _ids where k in ('PA', 'PB');
  update public.profiles set rating = 3.500, total_matches_played = 20
   where id in (pg_temp.i('PA'), pg_temp.i('PB'));
  insert into public.leagues (id, name, is_open, created_by)
  values (pg_temp.i('L'), 'PM League', true, pg_temp.i('PA'));
  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.i('L'), pg_temp.i('PA'), 'admin', null), (pg_temp.i('L'), pg_temp.i('PB'), 'member', null)
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;

  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline)
  values (pg_temp.i('L'), pg_temp.i('PA'), pg_temp.i('PB'), 11, 7, 'singles',
          pg_temp.i('PA'), 'team1', 'pending', now() + interval '1 hour')
  returning pending_delta1, pending_delta2, player1_rating_after, player2_rating_after into m;

  perform pg_temp.ok('M2 an even 11-7 between established players: League 0.300, overall 0.150',
    m.pending_delta1 = 0.300 and m.pending_delta2 = -0.300
      and m.player1_rating_after = 3.650 and m.player2_rating_after = 3.350,
    concat_ws(' ', m.pending_delta1, m.pending_delta2, m.player1_rating_after, m.player2_rating_after));
exception when others then
  perform pg_temp.ok('M2 block crashed', false, sqlerrm);
end $$;


-- ════ M3 every rating path uses the new rule ═════════════════════════════
do $$
declare
  f text;
  bad text := '';
begin
  foreach f in array array['update_plupr_ratings()', 'update_plupr_for_tournament_match()', 'recompute_all_plupr()'] loop
    if pg_get_functiondef(('public.' || f)::regprocedure) not like '%public._plupr_delta(%'
       or pg_get_functiondef(('public.' || f)::regprocedure) ~ 'k_factor\s*:=' then
      bad := bad || f || ' ';
    end if;
  end loop;
  perform pg_temp.ok('M3 the live, tournament and replay paths all use _plupr_delta', bad = '', nullif(bad, ''));
  perform pg_temp.ok('M4 _plupr_delta is internal (not callable by the app)',
    not has_function_privilege('authenticated', 'public._plupr_delta(integer, numeric)', 'EXECUTE')
    and not has_function_privilege('anon', 'public._plupr_delta(integer, numeric)', 'EXECUTE'));
exception when others then
  perform pg_temp.ok('M3-M4 block crashed', false, sqlerrm);
end $$;


-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;

rollback;

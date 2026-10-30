-- godmode_grant_pickles persona checks. Rolled back: nothing is kept.
--   supabase db query --linked -f supabase/tests/godmode_grant_pickles_personas.sql -o csv
-- Prints (test, ok, detail) rows and a SUMMARY row.
begin;

-- The temp helpers must stay callable after switching to authenticated.
alter default privileges for role postgres grant execute on functions to public;

create temp table t_results (n serial, test text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated;
grant usage on sequence t_results_n_seq to authenticated;

create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

do $$
declare
  god   constant uuid := '252a36e1-5d89-4ad2-8a3e-b786579f019a';
  other uuid;
  before_bal integer;
  r record;
  led record;
begin
  select id into other from public.profiles where id <> god limit 1;
  select pickles into before_bal from public.profiles where id = god;

  -- G1 God mode grants itself 1,234.
  perform pg_temp.as_user(god);
  select * into r from public.godmode_grant_pickles(1234);
  perform pg_temp.as_admin();
  insert into t_results (test, ok, detail) values
    ('G1 God mode grants itself 1,234', r.success and r.new_balance = before_bal + 1234, r.message);

  -- G2 the ledger names it.
  select l.reason, l.kind, l.is_bonus into led
    from public.pickle_ledger l where l.profile_id = god order by l.created_at desc, l.id desc limit 1;
  insert into t_results (test, ok, detail) values
    ('G2 ledger: God mode top-up, gold', led.reason = 'God mode top-up' and led.kind = 'bonus' and led.is_bonus, coalesce(led.reason, 'no row'));

  -- G3 out of range is refused, balance unchanged.
  perform pg_temp.as_user(god);
  select * into r from public.godmode_grant_pickles(0);
  insert into t_results (test, ok, detail) values ('G3 0 is refused', not r.success, r.message);
  select * into r from public.godmode_grant_pickles(10000001);
  insert into t_results (test, ok, detail) values ('G3 over 10M is refused', not r.success, r.message);
  perform pg_temp.as_admin();

  -- G4 anyone else is refused.
  perform pg_temp.as_user(other);
  select * into r from public.godmode_grant_pickles(100);
  perform pg_temp.as_admin();
  insert into t_results (test, ok, detail) values ('G4 another player is refused', not r.success, r.message);

  -- G5 anon can't call it; authenticated can.
  insert into t_results (test, ok, detail) values
    ('G5 grants: authenticated yes, anon no',
     has_function_privilege('authenticated', 'public.godmode_grant_pickles(integer)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.godmode_grant_pickles(integer)', 'EXECUTE'), null);
exception when others then
  perform pg_temp.as_admin();
  insert into t_results (test, ok, detail) values ('suite crashed', false, sqlerrm);
end $$;

select test, ok, detail from t_results
union all
select format('SUMMARY: %s/%s passed', count(*) filter (where ok), count(*)), bool_and(ok), null from t_results;

rollback;

-- ============================================================
-- Profiles column guard persona tests (migration_profiles_column_guard.sql).
--
-- NOT runnable on its own: build-profiles-guard-test.mjs puts, at the marker
-- line below, migration_referrals.sql (a no-op once it is live), then
-- migration_profiles_column_guard.sql twice (it must be re-runnable) and
-- then migration_anon_audit_rest.sql (referral_code / invited_by live in the
-- owner-only profile_private since; it also undoes a referrals re-run).
-- Everything runs inside the begin / rollback below, so the linked (live)
-- database is left untouched:
--   node supabase/tests/build-profiles-guard-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction; the signup
-- trigger makes each profile):
--   GA a player who edits their profile, buys in the Shop, claims the daily
--      streak, plays a match         GB the opponent (another player's row)
--   GC a brand-new player who claims the welcome pickles
--   GR a referrer (90 days old)      GN a new, confirmed player who claims
--                                       GR's referral code
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('GA', 'a8100000-0000-4000-8000-000000000001'), ('GB', 'a8100000-0000-4000-8000-000000000002'),
  ('GC', 'a8100000-0000-4000-8000-000000000003'), ('GR', 'a8100000-0000-4000-8000-000000000004'),
  ('GN', 'a8100000-0000-4000-8000-000000000005');
grant select on _p to authenticated, anon;

-- The columns the app writes directly (the migration's allowlist).
create temp table _editable (col text primary key);
insert into _editable values
  ('full_name'), ('username'), ('tagline'), ('gender'), ('selected_tags'), ('avatar_id'), ('avatar_url'),
  ('badges_public'), ('avatar_emoji'), ('avatar_bg_color'), ('name_color'), ('list_name_style_id'),
  ('profile_name_style_id'), ('availability'), ('drilling_enabled'), ('drill_availability'),
  ('drill_shot_prefs'), ('drill_partner_prefs'), ('drill_custom_tags'),
  ('referral_code'), ('invited_by');

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql as the current role; {rows} when it went through, else
-- {state, msg, hint, detail}.
create function pg_temp.run(p_sql text) returns jsonb language plpgsql as $$
declare
  v_n      bigint;
  v_state  text;
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return jsonb_build_object('rows', v_n);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint,
                          v_detail = pg_exception_detail;
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;

-- p_sql as persona k, back to admin after.
create function pg_temp.run_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := pg_temp.run(p_sql);
  perform pg_temp.as_admin();
  return j;
end $$;

-- A persona's whole profile row (read as admin).
create function pg_temp.row_of(k text) returns jsonb language sql stable as $$
  select to_jsonb(p) from public.profiles p where p.id = pg_temp.p(k) $$;
create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select pickles from public.profiles where id = pg_temp.p(k) $$;

-- @@MIGRATION@@

-- (again: migration_anon_audit_rest.sql, spliced above, takes the default away)
alter default privileges for role postgres grant execute on functions to public;


-- ════ Setup (after the migrations, so every trigger is live) ═════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'guard-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Guard Player ' || k), now()
    from _p;
  update public.profiles set created_at = now() - interval '90 days' where id = pg_temp.p('GR');
  update public.profiles set created_at = now() - interval '30 days' where id in (pg_temp.p('GA'), pg_temp.p('GB'));
  update public.profiles set gender = 'male' where id in (pg_temp.p('GA'), pg_temp.p('GB'));

  insert into public.leagues (id, name, is_open, created_by)
  values ('b8100000-0000-4000-8000-000000000001', 'Guard Test League', true, pg_temp.p('GA'));
  insert into public.league_members (league_id, user_id, role) values
    ('b8100000-0000-4000-8000-000000000001', pg_temp.p('GA'), 'admin'),
    ('b8100000-0000-4000-8000-000000000001', pg_temp.p('GB'), 'member')
  on conflict do nothing;
end $$;


-- ════ G1 the guard is installed the way the house rules want ═════════════
do $$
declare
  v_def  boolean;
  v_conf text[];
  v_tg   text;
begin
  select p.prosecdef, p.proconfig into v_def, v_conf
    from pg_proc p where p.oid = 'public._pl_profiles_column_guard()'::regprocedure;
  perform pg_temp.ok('G1 the guard function is SECURITY INVOKER (it reads the caller''s role) with search_path pinned to ''''',
    not v_def and v_conf @> array['search_path=""'], coalesce(v_conf::text, 'no config'));
  perform pg_temp.ok('G1 nobody but the owner may call the guard function directly',
    not has_function_privilege('authenticated', 'public._pl_profiles_column_guard()', 'execute')
    and not has_function_privilege('anon', 'public._pl_profiles_column_guard()', 'execute'), null);

  select pg_get_triggerdef(t.oid) into v_tg
    from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_column_guard';
  perform pg_temp.ok('G1 trg_profiles_column_guard is BEFORE INSERT OR UPDATE, for each row',
    v_tg like '%BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW%', v_tg);
  perform pg_temp.ok('G1 the old referral guard went with the columns (migration_anon_audit_rest.sql)',
    not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_referral_guard'), null);

  perform pg_temp.ok('G1 anon can''t insert, update or delete profiles',
    not has_table_privilege('anon', 'public.profiles', 'insert')
    and not has_table_privilege('anon', 'public.profiles', 'update')
    and not has_table_privilege('anon', 'public.profiles', 'delete'), null);
  perform pg_temp.ok('G1 signed-in players keep update (their own row, guarded) but can''t insert or delete profiles',
    has_table_privilege('authenticated', 'public.profiles', 'update')
    and not has_table_privilege('authenticated', 'public.profiles', 'insert')
    and not has_table_privilege('authenticated', 'public.profiles', 'delete'), null);
  perform pg_temp.ok('G1 everyone can still read profiles',
    has_table_privilege('anon', 'public.profiles', 'select') and has_table_privilege('authenticated', 'public.profiles', 'select'), null);

  perform pg_temp.ok('G1 player_location_ratings: the player write policy is gone, reads stay',
    not exists (select 1 from pg_policies where tablename = 'player_location_ratings' and cmd <> 'SELECT')
    and exists (select 1 from pg_policies where tablename = 'player_location_ratings' and cmd = 'SELECT'), null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G1 block crashed', false, sqlerrm);
end $$;


-- ════ G2 a player edits what the app lets them edit ══════════════════════
do $$
declare
  j      jsonb;
  r      public.profiles;
  v_slug text;
begin
  -- EditProfileSheet's save: the whole payload in one update.
  j := pg_temp.run_as('GA', format($q$
    update public.profiles
       set full_name = 'Guard Renamed', username = 'guard_renamed', tagline = 'Dinks all day',
           gender = 'female', selected_tags = array['lefty', 'early-bird'], avatar_id = 7,
           avatar_url = 'https://example.test/a.png', avatar_emoji = 'unicorn', avatar_bg_color = '#123456',
           badges_public = false
     where id = %L$q$, pg_temp.p('GA')));
  select * into r from public.profiles where id = pg_temp.p('GA');
  perform pg_temp.ok('G2 Edit profile: name, username, tagline, gender, tags, avatar, photo, badges toggle all save',
    j ->> 'rows' = '1' and r.full_name = 'Guard Renamed' and r.username = 'guard_renamed' and r.tagline = 'Dinks all day'
    and r.gender = 'female' and r.selected_tags = array['lefty', 'early-bird'] and r.avatar_id = 7
    and r.avatar_url = 'https://example.test/a.png' and r.avatar_emoji = 'unicorn' and r.avatar_bg_color = '#123456'
    and not r.badges_public, j::text);

  -- ProfileScreen / ShopScreen equips (one column each, as the app sends them).
  select slug into v_slug from public.shop_items where slug is not null order by slug limit 1;
  j := pg_temp.run_as('GA', format('update public.profiles set name_color = %L where id = %L', '#ff00aa', pg_temp.p('GA')));
  perform pg_temp.ok('G2 equip a name color', j ->> 'rows' = '1'
    and (select name_color from public.profiles where id = pg_temp.p('GA')) = '#ff00aa', j::text);
  j := pg_temp.run_as('GA', format('update public.profiles set list_name_style_id = %L where id = %L', v_slug, pg_temp.p('GA')));
  perform pg_temp.ok('G2 equip a list name style', j ->> 'rows' = '1'
    and (select list_name_style_id from public.profiles where id = pg_temp.p('GA')) = v_slug, j::text);
  j := pg_temp.run_as('GA', format('update public.profiles set profile_name_style_id = %L where id = %L', v_slug, pg_temp.p('GA')));
  perform pg_temp.ok('G2 equip a profile name style', j ->> 'rows' = '1'
    and (select profile_name_style_id from public.profiles where id = pg_temp.p('GA')) = v_slug, j::text);
  j := pg_temp.run_as('GA', format('update public.profiles set avatar_emoji = null, avatar_bg_color = null where id = %L', pg_temp.p('GA')));
  perform pg_temp.ok('G2 unequip the Shop avatar', j ->> 'rows' = '1'
    and (select avatar_emoji is null and avatar_bg_color is null from public.profiles where id = pg_temp.p('GA')), j::text);

  -- Availability grid (ProfileScreen).
  j := pg_temp.run_as('GA', format('update public.profiles set availability = array_fill(true, array[336]) where id = %L', pg_temp.p('GA')));
  perform pg_temp.ok('G2 the availability grid saves', j ->> 'rows' = '1'
    and (select availability[1] and availability[336] from public.profiles where id = pg_temp.p('GA')), j::text);

  -- DrillScreen, one column per write.
  j := pg_temp.run_as('GA', format($q$
    update public.profiles
       set drilling_enabled = true, drill_availability = '{"mon": [18]}'::jsonb, drill_shot_prefs = array['dinks'],
           drill_partner_prefs = array['similar-level'], drill_custom_tags = array['third-shot']
     where id = %L$q$, pg_temp.p('GA')));
  select * into r from public.profiles where id = pg_temp.p('GA');
  perform pg_temp.ok('G2 drilling settings save',
    j ->> 'rows' = '1' and r.drilling_enabled and r.drill_availability = '{"mon": [18]}'::jsonb
    and r.drill_shot_prefs = array['dinks'] and r.drill_partner_prefs = array['similar-level']
    and r.drill_custom_tags = array['third-shot'], j::text);

  -- A row sent back with its server-owned values unchanged still saves.
  j := pg_temp.run_as('GA', format($q$
    update public.profiles
       set tagline = 'Unchanged rest', pickles = pickles, rating = rating, total_matches_played = total_matches_played,
           welcome_pickles_granted = welcome_pickles_granted, created_at = created_at, is_guest = is_guest
     where id = %L$q$, pg_temp.p('GA')));
  perform pg_temp.ok('G2 an update that sends server-owned columns back unchanged still saves the rest',
    j ->> 'rows' = '1' and (select tagline from public.profiles where id = pg_temp.p('GA')) = 'Unchanged rest', j::text);

  -- referral_code / invited_by live in the owner-only profile_private since
  -- migration_anon_audit_rest.sql, where the owner may update the phone only.
  j := pg_temp.run_as('GA', format($q$
    update public.profile_private set referral_code = 'hacked', invited_by = %L where id = %L$q$,
    pg_temp.p('GR'), pg_temp.p('GA')));
  perform pg_temp.ok('G2 referral_code / invited_by: not on profiles, and the owner can''t write them in profile_private',
    j ? 'state'
    and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
                     and column_name in ('referral_code', 'invited_by'))
    and (select referral_code <> 'hacked' and invited_by is null from public.profile_private where id = pg_temp.p('GA')),
    j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G2 block crashed', false, sqlerrm);
end $$;


-- ════ G3 every server-owned column is refused ════════════════════════════
-- Every live column outside the allowlist, one update each, with a value that
-- differs from the stored one. Columns come from the live catalog, so a
-- column added later is covered (and refused) without editing this test.
do $$
declare
  c        record;
  v_expr   text;
  j        jsonb;
  v_before jsonb;
  v_n      integer := 0;
  v_ok     boolean;
begin
  v_before := pg_temp.row_of('GA');
  for c in
    select column_name, udt_name
      from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name not in (select col from _editable)
     order by ordinal_position
  loop
    v_expr := case c.udt_name
      when 'numeric'     then format('coalesce(%I, 0) + 1', c.column_name)
      when 'int4'        then format('coalesce(%I, 0) + 1', c.column_name)
      when 'int8'        then format('coalesce(%I, 0) + 1', c.column_name)
      when 'bool'        then format('not coalesce(%I, false)', c.column_name)
      when 'timestamptz' then format('coalesce(%I, now()) - interval ''1 day''', c.column_name)
      when 'text'        then format('coalesce(%I, '''') || ''-x''', c.column_name)
      when 'uuid'        then 'gen_random_uuid()'
      when '_text'       then format('coalesce(%I, ''{}'') || ''x''::text', c.column_name)
      when 'jsonb'       then format('coalesce(%I, ''{}'') || ''{"x": 1}''::jsonb', c.column_name)
      else null
    end;
    if v_expr is null then
      perform pg_temp.ok(format('G3 %s: no test value for type %s (add one)', c.column_name, c.udt_name), false, null);
      continue;
    end if;
    j := pg_temp.run_as('GA', format('update public.profiles set %I = %s where id = %L', c.column_name, v_expr, pg_temp.p('GA')));
    v_ok := j ->> 'state' = 'P0001' and j ->> 'hint' = 'pl:profile.server_owned'
            and (j ->> 'detail')::jsonb -> 'columns' ? c.column_name and coalesce(j ->> 'msg', '') <> '';
    perform pg_temp.ok(format('G3 a player can''t change their own %s', c.column_name), v_ok, j::text);
    v_n := v_n + 1;
  end loop;

  perform pg_temp.ok('G3 ...that covered the server-owned columns (pickles, ratings, counters, flags, guest/claim state)',
    v_n >= 17 and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
                           and column_name = 'pickles'), format('%s columns tried', v_n));
  perform pg_temp.ok('G3 ...and none of those attempts changed anything', pg_temp.row_of('GA') = v_before,
    case when pg_temp.row_of('GA') = v_before then null else pg_temp.row_of('GA')::text end);

  -- The attack that motivated this: a big pickles PATCH bundled with a real edit. Nothing saves.
  j := pg_temp.run_as('GA', format('update public.profiles set tagline = %L, pickles = 999999, rating = 8 where id = %L',
                                   'Rich now', pg_temp.p('GA')));
  perform pg_temp.ok('G3 a pickles + rating PATCH bundled with a tagline is refused as a whole (tagline not saved either)',
    j ->> 'hint' = 'pl:profile.server_owned' and (j ->> 'detail')::jsonb -> 'columns' = '["pickles", "rating"]'::jsonb
    and pg_temp.row_of('GA') = v_before, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G3 block crashed', false, sqlerrm);
end $$;


-- ════ G4 someone else's row, anon, client inserts and deletes ════════════
do $$
declare
  j        jsonb;
  v_before jsonb;
begin
  v_before := pg_temp.row_of('GB');
  j := pg_temp.run_as('GA', format('update public.profiles set tagline = %L where id = %L', 'Hijacked', pg_temp.p('GB')));
  perform pg_temp.ok('G4 a player can''t edit another player''s profile (matches no row)',
    j ->> 'rows' = '0' and pg_temp.row_of('GB') = v_before, j::text);
  j := pg_temp.run_as('GA', format('update public.profiles set pickles = 0, rating = 1 where id = %L', pg_temp.p('GB')));
  perform pg_temp.ok('G4 ...nor zero another player''s pickles or rating',
    j ->> 'rows' = '0' and pg_temp.row_of('GB') = v_before, j::text);

  perform pg_temp.as_anon();
  j := pg_temp.run(format('update public.profiles set pickles = 999999 where id = %L', pg_temp.p('GB')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('G4 anon can''t update profiles at all (permission denied)',
    j ->> 'state' = '42501' and pg_temp.row_of('GB') = v_before, j::text);

  j := pg_temp.run_as('GA', $q$insert into public.profiles (id, username, full_name, gender, pickles)
                               values (gen_random_uuid(), 'forged', 'Forged', 'male', 999999)$q$);
  perform pg_temp.ok('G4 a player can''t insert a profile (permission denied)', j ->> 'state' = '42501', j::text);
  j := pg_temp.run_as('GA', format('delete from public.profiles where id = %L', pg_temp.p('GA')));
  perform pg_temp.ok('G4 a player can''t delete a profile row directly (permission denied)',
    j ->> 'state' = '42501' and pg_temp.row_of('GA') is not null, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G4 block crashed', false, sqlerrm);
end $$;


-- ════ G5 player_location_ratings: read-only for players ══════════════════
do $$
declare
  j    jsonb;
  v_id uuid;
begin
  insert into public.player_location_ratings (user_id, location_name, match_type, rating, wins, losses)
  values (pg_temp.p('GA'), 'Guard Test Court', 'singles', 3.25, 1, 1)
  returning id into v_id;

  j := pg_temp.run_as('GA', format('update public.player_location_ratings set rating = 8, wins = 99 where id = %L', v_id));
  perform pg_temp.ok('G5 a player can''t raise their own court rating (permission denied)',
    j ->> 'state' = '42501' and (select rating = 3.25 and wins = 1 from public.player_location_ratings where id = v_id), j::text);
  j := pg_temp.run_as('GA', format($q$insert into public.player_location_ratings (user_id, location_name, match_type, rating)
                                      values (%L, 'Guard Fake Court', 'singles', 8)$q$, pg_temp.p('GA')));
  perform pg_temp.ok('G5 ...or invent a court rating', j ->> 'state' = '42501', j::text);
  j := pg_temp.run_as('GA', format('delete from public.player_location_ratings where id = %L', v_id));
  perform pg_temp.ok('G5 ...or delete one', j ->> 'state' = '42501'
    and exists (select 1 from public.player_location_ratings where id = v_id), j::text);
  j := pg_temp.run_as('GB', format('select 1 from public.player_location_ratings where id = %L', v_id));
  perform pg_temp.ok('G5 court ratings are still readable', j ->> 'rows' = '1', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G5 block crashed', false, sqlerrm);
end $$;


-- ════ G6 server paths still write the server-owned columns ═══════════════
-- Welcome pickles (claim_welcome_pickles).
do $$
declare
  r  record;
  b  integer;
  j  jsonb;
begin
  b := pg_temp.pickles('GC');
  perform pg_temp.as_user(pg_temp.p('GC'));
  select * into r from public.claim_welcome_pickles();
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 the welcome grant pays 1000 and sets its flag',
    r.granted and pg_temp.pickles('GC') = b + 1000
    and (select welcome_pickles_granted from public.profiles where id = pg_temp.p('GC')),
    format('granted %s, pickles %s -> %s', r.granted, b, pg_temp.pickles('GC')));

  -- The old loop: reset the flag, claim again. The reset is refused, so a
  -- second claim pays nothing.
  j := pg_temp.run_as('GC', format('update public.profiles set welcome_pickles_granted = false where id = %L', pg_temp.p('GC')));
  b := pg_temp.pickles('GC');
  perform pg_temp.as_user(pg_temp.p('GC'));
  select * into r from public.claim_welcome_pickles();
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 ...and a player can''t reset the flag to claim it again',
    j ->> 'hint' = 'pl:profile.server_owned' and not r.granted and pg_temp.pickles('GC') = b,
    format('%s; second claim granted %s, pickles %s -> %s', j, r.granted, b, pg_temp.pickles('GC')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 welcome block crashed', false, sqlerrm);
end $$;

-- A Shop purchase (purchase_shop_item) and the daily streak (claim_daily_login_streak).
do $$
declare
  it  record;
  r   record;
  s   record;
  b   integer;
begin
  select id, cost, name into it
    from public.shop_items
   where is_active and unlock_badge_id is null and category <> 'real_world' and cost > 0
   order by cost, id limit 1;
  update public.profiles set pickles = it.cost + 100 where id = pg_temp.p('GA');
  perform pg_temp.as_user(pg_temp.p('GA'));
  select * into r from public.purchase_shop_item(it.id);
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 a Shop purchase deducts its cost from pickles',
    r.success and pg_temp.pickles('GA') = 100
    and exists (select 1 from public.player_shop_purchases where user_id = pg_temp.p('GA') and shop_item_id = it.id),
    format('%s (%s): %s / %s, pickles now %s', it.name, it.cost, r.success, r.message, pg_temp.pickles('GA')));

  b := pg_temp.pickles('GA');
  perform pg_temp.as_user(pg_temp.p('GA'));
  select * into s from public.claim_daily_login_streak();
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 the daily streak claim adds its pickles',
    s.claimed_today and pg_temp.pickles('GA') = b + s.daily_pickles + s.milestone_pickles,
    format('claimed %s, pickles %s -> %s', s.claimed_today, b, pg_temp.pickles('GA')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 shop / streak block crashed', false, sqlerrm);
end $$;

-- A played match: GA records, GB confirms (ratings, counters, first-match bonus).
do $$
declare
  v_m   uuid;
  a0    public.profiles;
  b0    public.profiles;
  a1    public.profiles;
  b1    public.profiles;
begin
  select * into a0 from public.profiles where id = pg_temp.p('GA');
  select * into b0 from public.profiles where id = pg_temp.p('GB');

  perform pg_temp.as_user(pg_temp.p('GA'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status)
  values ('b8100000-0000-4000-8000-000000000001', pg_temp.p('GA'), pg_temp.p('GB'), 11, 5, 'singles',
          pg_temp.p('GA'), 'team1', 'pending')
  returning id into v_m;
  perform pg_temp.as_user(pg_temp.p('GB'));
  perform public.confirm_match(v_m);
  perform pg_temp.as_admin();

  select * into a1 from public.profiles where id = pg_temp.p('GA');
  select * into b1 from public.profiles where id = pg_temp.p('GB');
  perform pg_temp.ok('G6 a confirmed match completes', (select status from public.matches where id = v_m) = 'completed', null);
  perform pg_temp.ok('G6 ...moves both players'' ratings (winner up, loser down)',
    a1.rating > a0.rating and b1.rating < b0.rating and a1.singles_rating > a0.singles_rating and b1.singles_rating < b0.singles_rating,
    format('GA %s -> %s, GB %s -> %s', a0.rating, a1.rating, b0.rating, b1.rating));
  perform pg_temp.ok('G6 ...counts the match and stamps last_match_at for both',
    a1.total_matches_played = a0.total_matches_played + 1 and b1.total_matches_played = b0.total_matches_played + 1
    and a1.last_match_at is not null and b1.last_match_at is not null,
    format('GA %s -> %s, GB %s -> %s', a0.total_matches_played, a1.total_matches_played, b0.total_matches_played, b1.total_matches_played));
  perform pg_temp.ok('G6 ...and pays the first-match bonus to both',
    exists (select 1 from public.first_match_bonus_grants where user_id = pg_temp.p('GA'))
    and exists (select 1 from public.first_match_bonus_grants where user_id = pg_temp.p('GB'))
    and a1.pickles >= a0.pickles + 500 and b1.pickles >= b0.pickles + 500,
    format('GA %s -> %s, GB %s -> %s', a0.pickles, a1.pickles, b0.pickles, b1.pickles));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 match block crashed', false, sqlerrm);
end $$;

-- A referral payout (claim_referral -> _pl_pay_referral_reward), and its invited_by link.
do $$
declare
  r   jsonb;
  bR  integer := pg_temp.pickles('GR');
  bN  integer := pg_temp.pickles('GN');
  -- Read as admin: GR's private row is GR's alone.
  c   text := (select referral_code from public.profile_private where id = pg_temp.p('GR'));
begin
  perform pg_temp.as_user(pg_temp.p('GN'));
  r := public.claim_referral(c);
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 a referral claim links and pays both sides (2500 each, at least)',
    (r ->> 'linked')::boolean and (r ->> 'rewarded')::boolean
    and pg_temp.pickles('GR') >= bR + 2500 and pg_temp.pickles('GN') = bN + 2500
    and (select invited_by from public.profile_private where id = pg_temp.p('GN')) = pg_temp.p('GR'),
    format('%s; GR %s -> %s, GN %s -> %s', r, bR, pg_temp.pickles('GR'), bN, pg_temp.pickles('GN')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 referral block crashed', false, sqlerrm);
end $$;

-- Edge functions (service_role) and the owner write freely.
do $$
declare
  j     jsonb;
  v_sql text := format('update public.profiles set pickles = 4242, is_guest = false where id = %L', pg_temp.p('GB'));
begin
  perform pg_temp.as_service();
  j := pg_temp.run(v_sql);
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 service_role (edge functions, scripts) can still set server-owned columns',
    j ->> 'rows' = '1' and pg_temp.pickles('GB') = 4242, j::text);
  j := pg_temp.run(format('update public.profiles set pickles = 4343 where id = %L', pg_temp.p('GB')));
  perform pg_temp.ok('G6 ...and so can the owner (migrations, SQL editor)', j ->> 'rows' = '1' and pg_temp.pickles('GB') = 4343, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 service block crashed', false, sqlerrm);
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

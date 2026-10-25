-- ============================================================
-- Plan sharing: friends see a planned check-in only once its owner shares it
-- (foundation @just-messin-around/expo-foundation 1.70.0, README "Plan
-- sharing contract (1.70)"; this file is Pickleague's side of that contract).
--
-- The user, 2026-10-24: "For both apps, let's keep the functionality that we
-- never show routines automatically, since people may often change their
-- schedules ad hoc, and forget to." Chosen: once a day the app lists today's
-- routine stops (Confirm / Skip / Change time), and a setting, default OFF,
-- "Share my routine stops automatically". Friends should see planned
-- check-ins (Doggle parity: "Yea").
--
-- ── The contract, as Pickleague implements it ──────────────────────────────
--   1. A plan says where someone will be. Friends see one only once its owner
--      has shared it.
--   2. court_plans.shared_at (null = only the owner sees it) and
--      court_plans.share_source:
--        'plan'     a one-off plan, shared when made;
--        'confirm'  a routine stop the owner confirmed (or moved from the
--                   confirm sheet, or shared from its chip);
--        'auto'     shared by the owner's auto-share setting;
--        'hidden'   the owner chose "Only you"; auto-share never overrides it.
--      court_plans_share_chk: shared_at is set exactly when share_source is
--      plan / confirm / auto. No backfill: every row made before this file
--      stays private (the shipped app says "Only you see your planned
--      check-ins.").
--   3. presence_settings.auto_share_routines (default false), read by
--      get_court_routine_settings, written by set_auto_share_routines (NOT
--      set_presence_settings: migration_refusal_messages.sql re-creates that
--      one, which would drop or confuse a new argument). On: the owner's
--      routine stops still in play with no share_source become 'auto' (a
--      skipped one too, so Undo skip brings it back shared); a stop made
--      while it is on is 'auto' (trg_court_plans_auto_share, BEFORE INSERT, so
--      the materializer, re-created by two older files, needs no change). Off:
--      only the 'auto' ones go back to private; 'confirm' and 'hidden' stay.
--   4. One-off plans are shared at creation only when the client asks
--      (plan_court_checkin p_share, default false: an old build's plan stays
--      private, as its copy promised).
--   5. Routine stops are shared by confirm_court_plans, by a "Change time"
--      from the confirm sheet (the client moves, then confirms) or by
--      set_court_plan_shared. Moving, skipping or un-skipping never changes
--      shared_at (those functions don't touch it); a skipped stop is hidden
--      by its status. Editing a routine (save_court_routine) re-makes its
--      stops still in play: a 'hidden' one stays hidden, a 'confirm' one stays
--      shared while the routine keeps its court.
--   6. confirm_court_plans(p_plan_ids uuid[]): owner-only, 1 to 50 ids, only
--      routine stops still planned and in play (their time no more than 30
--      minutes ago); shared_at kept if set, else now(); share_source
--      'confirm'. Idempotent. Ids that aren't eligible are ignored; none
--      eligible is pl:plan.gone. Answers list_my_court_routines(). No push.
--   7. set_court_plan_shared(p_plan_id, p_shared): my planned plan in play.
--      true: 'plan' (one-off) or 'confirm' (routine); false: 'hidden'. No push.
--   8. Friend visibility (_pl_plan_visible; the foundation's
--      isVisibleToFriends mirrors it). Someone other than the owner sees a
--      plan only when all hold: status planned; shared_at set; its time no
--      more than 30 minutes ago and no more than 7 days ahead; the owner's
--      plan privacy names this viewer (_pl_can_see_presence 'plans' =
--      'named': plans_level, pause, hidden-from, blocks either way, guests,
--      deleted accounts); a routine stop's routine still active at a court
--      the owner still stars. A rejected row is absent, not anonymised.
--   9. Friend push only when a one-off plan is created shared, within 7
--      days: 1 per owner per court per 6 hours (pl_throttle kind
--      'friend_plan'), to accepted friends who starred the owner
--      (close_friends) and may see the plan under rule 8, whose push and
--      "Friends on the way" switch allow it (category notifyFriendsOnTheWay:
--      send-push only honours the categories it knows, and that one already
--      means "a friend is heading to a court"). None for routine stops,
--      confirms, moves, toggles, or a one-off shared later.
--  10. list_my_court_plans and list_my_court_routines return shared_at and
--      share_source (list_my_court_plans also kind).
--
-- ── New client RPCs (granted to authenticated, in the hardening allowlist) ─
--   confirm_court_plans(p_plan_ids uuid[])            -> list_my_court_routines()
--   set_court_plan_shared(p_plan_id uuid, p_shared boolean)
--                                                     -> {plan_id, kind, shared_at, share_source}
--   set_auto_share_routines(p_on boolean)             -> get_court_routine_settings()
--   list_friend_court_plans(p_venue text default null, p_days integer default 7)
--                                                     -> [{plan_id, user_id, full_name, avatar_url,
--                                                         avatar_emoji, avatar_bg_color, is_friend,
--                                                         is_close_friend, venue_id, venue_name,
--                                                         lat, lng, planned_at, planned_end_at, kind}]
--      Friends and closed-league mates (friends_at_courts' candidates), each
--      row passing rule 8, time order, at most 200; p_days clamped to 1..7;
--      p_venue any row of a facility (unknown: []). No windows, no
--      closed-group members.
-- New internal helpers (execute revoked from public, anon, authenticated):
--   _pl_plan_visible(uuid, court_plans), _pl_friend_plan_push(uuid),
--   _pl_court_plan_auto_share() (the trigger function).
--
-- ── Replaced (each copied from the LATEST file that defines it) ───────────
--   plan_court_checkin          (migration_court_oneoff_plans.sql) 3 args -> 4
--                               (p_share boolean default false); the old one
--                               is dropped first, as send_on_my_way's was
--   list_my_court_plans         (migration_court_oneoff_plans.sql) + kind,
--                               shared_at, share_source
--   list_my_court_routines      (migration_court_routines.sql) + shared_at,
--                               share_source on next and each occurrence
--   get_court_routine_settings  (migration_court_routines.sql) + auto_share_routines
--   save_court_routine          (migration_court_routines_planned_end.sql)
--                               a re-made stop keeps 'confirm' / 'hidden'
-- NOT replaced, on purpose: move_court_routine_occurrence,
-- unskip_court_routine_occurrence, skip_court_routine_occurrence,
-- move_court_plan, cancel_court_plan (none touches shared_at),
-- friends_at_courts ("now" check-ins; plans have their own read),
-- list_profile_court_routines (the weekly pattern), set_presence_settings.
-- supabase/tests/check-replaced-functions.mjs has the five.
--
-- APPLY ORDER: after migration_court_oneoff_plans.sql is live
-- (state\checkin-plans-apply.ps1 printed DONE), then re-run
-- migration_rls_hardening_2026q3.sql (its allowlist names the four new
-- RPCs). RE-APPLY THIS FILE after any re-run of migration_court_routines.sql,
-- migration_court_routines_planned_end.sql or
-- migration_court_oneoff_plans.sql: each puts older bodies of the functions
-- above back, and the one-off file makes the 3-argument plan_court_checkin
-- again, beside this 4-argument one, so a call by name without p_share would
-- be ambiguous to PostgREST. The test builders do this. Re-runnable; no
-- begin/commit.
--   state\plan-sharing-apply.ps1 (tests rolled back, apply, hardening, verify)
-- Test first: node supabase/tests/build-plan-sharing-test.mjs
-- ============================================================


-- ── 1. Columns, constraint, index, setting ─────────────────────────────────
alter table public.court_plans add column if not exists shared_at    timestamptz;
alter table public.court_plans add column if not exists share_source text;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'court_plans_share_chk' and conrelid = 'public.court_plans'::regclass) then
    -- A CASE, not ORs: with share_source null an OR of comparisons is null,
    -- which a CHECK lets through (shared_at set with no source).
    alter table public.court_plans add constraint court_plans_share_chk
      check (case when share_source is null then shared_at is null
                  when share_source = 'hidden' then shared_at is null
                  when share_source in ('plan', 'confirm', 'auto') then shared_at is not null
                  else false end);
  end if;
end $$;
create index if not exists court_plans_shared_idx
  on public.court_plans (planned_at) where status = 'planned' and shared_at is not null;
alter table public.presence_settings add column if not exists auto_share_routines boolean not null default false;

comment on column public.court_plans.shared_at is
  'When the owner shared this plan with friends (who see it under plans_level: list_friend_court_plans). '
  'Null: only the owner sees it.';
comment on column public.court_plans.share_source is
  '''plan'': a one-off shared when made; ''confirm'': a routine stop the owner confirmed or shared; ''auto'': '
  'shared by presence_settings.auto_share_routines; ''hidden'': the owner chose "Only you" (auto-share never '
  'overrides it); null: never shared.';
comment on column public.presence_settings.auto_share_routines is
  'Share my routine stops automatically (default off): each routine stop is shared (share_source ''auto'') as '
  'soon as it is planned, instead of when the owner confirms it that day.';
comment on table public.court_plans is
  'Planned check-ins (Doggle dog_place_checkin_plans): routine occurrences (kind routine) and one-off plans '
  '(kind once). windows are absolute ({starts_at, ends_at, mode, hint, group}). Owner-only rows; friends read '
  'shared ones (shared_at) through list_friend_court_plans. rewarded_at is reserved for the kept-plan pickles.';


-- ── 2. Auto-share for routine stops (contract rule 3) ──────────────────────
-- A BEFORE INSERT trigger rather than a new materializer:
-- _pl_materialize_court_routines is re-created by migration_court_routines.sql
-- and migration_court_routines_planned_end.sql, and a trigger survives their
-- re-runs.
create or replace function public._pl_court_plan_auto_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select s.auto_share_routines from public.presence_settings s where s.user_id = new.user_id), false) then
    new.shared_at := now();
    new.share_source := 'auto';
  end if;
  return new;
end $$;
revoke all on function public._pl_court_plan_auto_share() from public, anon, authenticated;

drop trigger if exists trg_court_plans_auto_share on public.court_plans;
create trigger trg_court_plans_auto_share
  before insert on public.court_plans
  for each row when (new.kind = 'routine' and new.shared_at is null and new.share_source is null)
  execute function public._pl_court_plan_auto_share();


-- ── 3. Internal helpers ────────────────────────────────────────────────────

-- Contract rule 8: may p_viewer (not the owner) see this plan? The
-- foundation's isVisibleToFriends mirrors it (audience = the privacy answer).
create or replace function public._pl_plan_visible(p_viewer uuid, p_plan public.court_plans)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
         p_plan.id is not null
     and p_viewer is not null and p_viewer <> p_plan.user_id
     and p_plan.status = 'planned'
     and p_plan.shared_at is not null
     and p_plan.planned_at >  now() - interval '30 minutes'
     and p_plan.planned_at <= now() + interval '7 days'
     and (p_plan.kind = 'once'
          or (p_plan.routine_id is not null
              and exists (select 1 from public.court_routines cr where cr.id = p_plan.routine_id and cr.active)
              and public._pl_is_starred(p_plan.user_id, p_plan.venue_id)))
     and public._pl_can_see_presence(p_viewer, p_plan.user_id, 'plans') = 'named', false);
$$;
revoke all on function public._pl_plan_visible(uuid, public.court_plans) from public, anon, authenticated;

-- Contract rule 9: the friend push for a one-off plan just made shared.
-- Never raises (a push must never undo the plan); returns how many pushes
-- were queued.
create or replace function public._pl_friend_plan_push(p_plan_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pl    public.court_plans;
  v_name  text;
  v_canon text;
  v_title text;
  v_to    uuid;
  v_n     int := 0;
begin
  select * into v_pl from public.court_plans pl where pl.id = p_plan_id;
  if v_pl.id is null or v_pl.kind <> 'once' or v_pl.status <> 'planned' or v_pl.shared_at is null
     or v_pl.planned_at <= now() or v_pl.planned_at > now() + interval '7 days' then
    return 0;
  end if;
  select nullif(btrim(v.name), '') into v_name from public.venues v where v.id = v_pl.venue_id;
  v_canon := coalesce(public._pl_canonical_venue(v_pl.venue_id), v_pl.venue_id);
  -- 1 per owner per court per 6 hours: cancel and plan again stays quiet.
  if not public._pl_throttle_ok(v_pl.user_id::text, 'friend_plan', v_canon, interval '6 hours') then
    return 0;
  end if;
  v_title := public._pl_display_name(v_pl.user_id) || ' plans to play at ' || coalesce(v_name, 'a court');
  for v_to in
    select cf.user_id
      from public.close_friends cf
     where cf.friend_id = v_pl.user_id and cf.user_id <> v_pl.user_id
       and public.are_friends(cf.user_id, v_pl.user_id)
       and public._pl_friendable(cf.user_id)
       and public._pl_plan_visible(cf.user_id, v_pl)
     order by cf.user_id
  loop
    -- Their switches: no phone, push off or "Friends on the way" off.
    continue when not public._pl_push_reaches(v_to, 'notifyFriendsOnTheWay');
    begin
      insert into public.push_outbox
        (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
      values (v_to, 'info', 'notifyFriendsOnTheWay', v_title,
              public._pickleague_local_label(v_pl.planned_at, public._pickleague_tz_for(v_to)) || '. Tap to see the court.',
              'home/-', v_pl.planned_at,
              jsonb_build_object('kind', 'friend_plan', 'plan_id', v_pl.id, 'venue_id', v_canon,
                                 'venue_name', v_name, 'sender_id', v_pl.user_id,
                                 'planned_at', v_pl.planned_at));
      v_n := v_n + 1;
    exception when others then
      raise warning 'friend plan push for % not queued: %', v_to, sqlerrm;
    end;
  end loop;
  return v_n;
exception when others then
  -- Everything this call queued is rolled back with it.
  raise warning '_pl_friend_plan_push: plan % failed: %', p_plan_id, sqlerrm;
  return 0;
end $$;
revoke all on function public._pl_friend_plan_push(uuid) from public, anon, authenticated;


-- ── 4. Replaced: the owner's reads carry the share ─────────────────────────

-- list_my_court_plans: from migration_court_oneoff_plans.sql (the latest).
-- Changed: each plan adds kind, shared_at, share_source.
create or replace function public.list_my_court_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'plan_id',        pl.id,
             'venue_id',       pl.venue_id,
             'venue_name',     v.name,
             'lat',            v.lat,
             'lng',            v.lng,
             'planned_at',     pl.planned_at,
             'planned_end_at', pl.planned_end_at,
             'status',         pl.status,
             'starred',        public._pl_is_starred(v_me, pl.venue_id),
             'kind',           pl.kind,
             'shared_at',      pl.shared_at,
             'share_source',   pl.share_source)
             order by pl.planned_at, pl.id)
      from public.court_plans pl
      join public.venues v on v.id = pl.venue_id
     where pl.user_id = v_me and pl.kind = 'once'
       and pl.status in ('planned', 'completed')
       and pl.planned_at > now() - interval '30 minutes'), '[]'::jsonb);
end $$;
revoke all on function public.list_my_court_plans() from public, anon;
grant execute on function public.list_my_court_plans() to authenticated;

-- list_my_court_routines: from migration_court_routines.sql (the latest).
-- Changed: 'next' and each of 'occurrences' add shared_at, share_source.
create or replace function public.list_my_court_routines()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',           cr.id,
             'venue_id',     cr.venue_id,
             'venue_name',   v.name,
             'lat',          v.lat,
             'lng',          v.lng,
             'radius_m',     case when v.area_sqm > 0 then round(sqrt(v.area_sqm / pi()))::int end,
             'starred',      public._pl_is_starred(v_me, cr.venue_id),
             'auto_checkin', coalesce((select bool_or(f.auto_checkin) from public.court_favorites f
                                        where f.user_id = v_me
                                          and f.venue_id in (select x.id from public.venues x
                                                              where x.id = cr.venue_id or x.canonical_id = cr.venue_id)), false),
             'local_time',   to_char(cr.local_time, 'HH24:MI'),
             'days',         cr.days,
             'tz',           cr.tz,
             'length_min',   cr.length_min,
             'windows',      cr.windows,
             'active',       cr.active,
             'next', (
               select jsonb_build_object('plan_id', pl.id, 'planned_at', pl.planned_at,
                                         'planned_end_at', pl.planned_end_at, 'status', pl.status,
                                         'shared_at', pl.shared_at, 'share_source', pl.share_source)
                 from public.court_plans pl
                where pl.routine_id = cr.id
                  and pl.planned_at > now() - interval '30 minutes'
                  and pl.status in ('planned', 'cancelled', 'completed')
                order by pl.planned_at
                limit 1),
             'occurrences', coalesce((
               select jsonb_agg(jsonb_build_object('plan_id', pl.id, 'planned_at', pl.planned_at,
                                                   'planned_end_at', pl.planned_end_at, 'status', pl.status,
                                                   'windows', pl.windows,
                                                   'shared_at', pl.shared_at, 'share_source', pl.share_source)
                                order by pl.planned_at)
                 from public.court_plans pl
                where pl.routine_id = cr.id
                  and pl.planned_at > now() - interval '30 minutes'
                  and pl.status in ('planned', 'cancelled', 'completed')), '[]'::jsonb))
             order by cr.local_time, v.name, cr.id)
      from public.court_routines cr
      join public.venues v on v.id = cr.venue_id
     where cr.user_id = v_me), '[]'::jsonb);
end $$;
revoke all on function public.list_my_court_routines() from public, anon;
grant execute on function public.list_my_court_routines() to authenticated;

-- get_court_routine_settings: from migration_court_routines.sql (the latest).
-- Changed: adds auto_share_routines ("Share my routine stops automatically").
create or replace function public.get_court_routine_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return jsonb_build_object(
    'routine_auto_checkin',
      coalesce((select s.routine_auto_checkin from public.presence_settings s where s.user_id = v_me), true),
    'auto_share_routines',
      coalesce((select s.auto_share_routines from public.presence_settings s where s.user_id = v_me), false));
end $$;
revoke all on function public.get_court_routine_settings() from public, anon;
grant execute on function public.get_court_routine_settings() to authenticated;


-- ── 5. Replaced: an edited routine keeps its stops' shares ─────────────────
-- save_court_routine: from migration_court_routines_planned_end.sql (the
-- latest). Changed: before its stops still in play are deleted and re-made,
-- their 'confirm' / 'hidden' choices are kept by date and put back on the
-- re-made stop of that date ('hidden' always; 'confirm' only while the routine
-- keeps its court: a confirmation said "I'll be at THIS court"). Without it,
-- editing a routine silently un-shared today's confirmed stop and shared a
-- stop made "Only you" under auto-share.
create or replace function public.save_court_routine(
  p_routine_id uuid,
  p_venue      text,
  p_local_time time,
  p_days       integer,
  p_tz         text,
  p_length_min integer,
  p_windows    jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_id      uuid := p_routine_id;
  v_venue   text;
  v_tz      text;
  v_time    time;
  v_windows jsonb;
  v_k_dates  date[];
  v_k_at     timestamptz[];
  v_k_source text[];
  v_k_venue  text[];
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_venue is null or btrim(p_venue) = '' then
    raise exception using message = 'Couldn''t save your routine because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  if v_id is not null and not exists (select 1 from public.court_routines where id = v_id and user_id = v_me) then
    raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
  end if;
  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so it can''t be in your routine. Pick another court.', hint = 'pl:court.gone';
  end if;
  if not public._pl_is_starred(v_me, v_venue) then
    raise exception using message = 'Routines are for your starred courts. Star this court first, then add it to your routine.', hint = 'pl:routine.not_starred';
  end if;
  if p_days is null or p_days < 1 or p_days > 127 then
    raise exception using message = 'Pick at least one day for this routine.', hint = 'pl:routine.bad_days';
  end if;
  if p_local_time is null then
    raise exception using message = 'Pick a time for this routine.', hint = 'pl:routine.bad_time';
  end if;
  if p_length_min is null or p_length_min < 30 or p_length_min > 240 or p_length_min % 15 <> 0 then
    raise exception using message = 'Pick how long you play: 30 minutes to 4 hours.', hint = 'pl:routine.bad_length';
  end if;
  v_time := make_time(extract(hour from p_local_time)::int, extract(minute from p_local_time)::int, 0);
  v_tz := case when public._pickleague_valid_tz(p_tz)
                    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz
               else public._pickleague_tz_for(v_me) end;
  v_windows := public._pl_clean_windows(v_me, p_windows, p_length_min);

  if v_id is null then
    -- One at a time per player, so two saves can't both pass the cap.
    perform pg_advisory_xact_lock(hashtext('court_routines:' || v_me::text));
    if (select count(*) from public.court_routines where user_id = v_me) >= 12 then
      raise exception using message = 'You can have up to 12 routine check-ins. Delete one to add this one.', hint = 'pl:routine.limit';
    end if;
    insert into public.court_routines (user_id, venue_id, local_time, days, tz, length_min, windows)
    values (v_me, v_venue, v_time, p_days, v_tz, p_length_min, v_windows)
    returning id into v_id;
  else
    update public.court_routines
       set venue_id = v_venue, local_time = v_time, days = p_days, tz = v_tz,
           length_min = p_length_min, windows = v_windows, updated_at = now()
     where id = v_id and user_id = v_me;
    if not found then
      raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
    end if;
  end if;

  -- The share choices of the stops about to be re-made (contract rule 5).
  select coalesce(array_agg(pl.routine_date order by pl.routine_date), '{}'),
         coalesce(array_agg(pl.shared_at order by pl.routine_date), '{}'),
         coalesce(array_agg(pl.share_source order by pl.routine_date), '{}'),
         coalesce(array_agg(pl.venue_id order by pl.routine_date), '{}')
    into v_k_dates, v_k_at, v_k_source, v_k_venue
    from public.court_plans pl
   where pl.routine_id = v_id and pl.status = 'planned' and pl.planned_at > now() - interval '30 minutes'
     and pl.share_source in ('confirm', 'hidden');

  -- Still in play: ahead, or in its window (today's, during an edit at 9:40
  -- of a 9:34 routine). Re-made below with the new settings.
  delete from public.court_plans
   where routine_id = v_id and status = 'planned' and planned_at > now() - interval '30 minutes';
  perform public._pl_materialize_court_routines(v_id, now());

  if cardinality(v_k_dates) > 0 then
    update public.court_plans pl
       set shared_at = k.shared_at, share_source = k.share_source
      from unnest(v_k_dates, v_k_at, v_k_source, v_k_venue) as k(routine_date, shared_at, share_source, venue_id)
     where pl.routine_id = v_id and pl.routine_date = k.routine_date and pl.status = 'planned'
       and (k.share_source = 'hidden' or pl.venue_id = k.venue_id);
  end if;
  return public.list_my_court_routines();
end $$;
revoke all on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) from public, anon;
grant execute on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) to authenticated;


-- ── 6. Replaced: plan_court_checkin gains p_share ──────────────────────────
-- From migration_court_oneoff_plans.sql (its only definition), every plan
-- rule unchanged; p_share (contract rule 4) last, default false, so every
-- existing caller (named or positional, 2 or 3 arguments) reaches the new
-- function and plans privately, as before. The 3-argument function goes
-- first (beside a 4-argument one with a default, a call by name without
-- p_share would be ambiguous to PostgREST), then any other signature but the
-- new one.
drop function if exists public.plan_court_checkin(text, timestamptz, integer);
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'plan_court_checkin'
       and p.oid is distinct from to_regprocedure('public.plan_court_checkin(text,timestamptz,integer,boolean)')::oid
  loop
    execute format('drop function %s', f);
  end loop;
end $$;

-- Doggle schedule_dog_place_checkin: plan a check-in at a court for later.
create or replace function public.plan_court_checkin(
  p_venue      text,
  p_at         timestamptz,
  p_length_min integer default 120,
  p_share      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_at     timestamptz := date_trunc('minute', p_at);
  v_len    int := coalesce(p_length_min, 120);
  v_share  boolean := coalesce(p_share, false);
  v_venue  text;
  v_name   text;
  v_status text;
  v_near   public.court_plans;
  v_rt     record;
  v_tz     text;
  v_id     uuid;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_venue is null or btrim(p_venue) = '' then
    raise exception using message = 'Couldn''t plan your check-in because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  v_venue := public._pl_canonical_venue(p_venue);
  select nullif(btrim(v.name), ''), v.confirmation_status into v_name, v_status
    from public.venues v where v.id = v_venue;
  if v_venue is null or not found or v_status = 'rejected' then
    raise exception using message = 'That court isn''t in Pickleague any more, so you can''t plan a check-in there. Find your court again.', hint = 'pl:court.gone';
  end if;
  if v_at is null or v_at < now() - interval '15 minutes' then
    raise exception using message = 'Pick a time later than now for your check-in.', hint = 'pl:visit.bad_time';
  end if;
  if v_at > now() + interval '60 days' then
    raise exception using message = 'You can plan a check-in up to 60 days ahead. Pick an earlier day.', hint = 'pl:visit.too_far';
  end if;
  if v_len < 30 or v_len > 240 or v_len % 15 <> 0 then
    raise exception using message = 'Pick how long you play: 30 minutes to 4 hours.', hint = 'pl:visit.bad_length';
  end if;

  -- One write at a time per player, so two quick taps can't both pass the
  -- checks below.
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  if (select count(*) from public.court_plans pl
       where pl.user_id = v_me and pl.kind = 'once' and pl.status = 'planned'
         and pl.planned_at > now() - interval '30 minutes') >= 20 then
    raise exception using message = 'You have 20 planned check-ins coming up. Cancel one to plan another.', hint = 'pl:visit.limit';
  end if;
  v_near := public._pl_plan_near(v_me, v_venue, v_at, null);
  if v_near.id is not null then
    v_tz := coalesce((select cr.tz from public.court_routines cr where cr.id = v_near.routine_id), public._pickleague_tz_for(v_me));
    raise exception using
      message = case when v_near.kind = 'routine'
                     then format('Your routine already has you at %s at %s. Change that stop''s time instead.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz))
                     else format('You already plan to check in at %s at %s. Change that time instead.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz)) end,
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', v_near.id, 'planned_at', v_near.planned_at,
                                  'routine', v_near.kind = 'routine')::text;
  end if;
  -- A routine stop not made yet (more than a day ahead) holds its time too.
  select * into v_rt from public._pl_routine_time_near(v_me, v_venue, v_at);
  if v_rt.routine_id is not null then
    raise exception using
      message = format('Your routine already has you at %s at %s that day. Pick another time.',
                       coalesce(v_name, 'this court'), public._pl_clock(v_rt.stop_at, v_rt.tz)),
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', null, 'planned_at', v_rt.stop_at, 'routine', true)::text;
  end if;

  insert into public.court_plans (user_id, venue_id, planned_at, planned_end_at, windows, status, kind,
                                  shared_at, share_source)
  values (v_me, v_venue, v_at, v_at + make_interval(mins => v_len),
          public._pl_windows_at(public._pl_clean_windows(v_me, null, v_len), v_at), 'planned', 'once',
          case when v_share then now() end, case when v_share then 'plan' end)
  returning id into v_id;
  -- Contract rule 9: friends who starred me hear of a plan shared when made.
  if v_share then
    perform public._pl_friend_plan_push(v_id);
  end if;
  return public.list_my_court_plans();
end $$;
revoke all on function public.plan_court_checkin(text, timestamptz, integer, boolean) from public, anon;
grant execute on function public.plan_court_checkin(text, timestamptz, integer, boolean) to authenticated;


-- ── 7. New client RPCs ─────────────────────────────────────────────────────

-- Contract rule 6: share today's routine stops (the daily confirm sheet's
-- Confirm / Confirm all, and the second half of its Change time).
create or replace function public.confirm_court_plans(p_plan_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_plan_ids is null or coalesce(cardinality(p_plan_ids), 0) = 0 or cardinality(p_plan_ids) > 50 then
    raise exception using message = 'Couldn''t share your plans because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  update public.court_plans
     set shared_at = coalesce(shared_at, now()), share_source = 'confirm', updated_at = now()
   where id = any (p_plan_ids) and user_id = v_me
     and kind = 'routine' and routine_id is not null and status = 'planned'
     and planned_at > now() - interval '30 minutes';
  if not found then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  return public.list_my_court_routines();
end $$;
revoke all on function public.confirm_court_plans(uuid[]) from public, anon;
grant execute on function public.confirm_court_plans(uuid[]) to authenticated;

-- Contract rule 7: a plan's Shared / Only you chip.
create or replace function public.set_court_plan_shared(p_plan_id uuid, p_shared boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_out jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_plan_id is null or p_shared is null then
    raise exception using message = 'Couldn''t change who sees your plan because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  update public.court_plans
     set shared_at    = case when p_shared then coalesce(shared_at, now()) end,
         share_source = case when not p_shared then 'hidden'
                             when kind = 'once' then 'plan' else 'confirm' end,
         updated_at   = now()
   where id = p_plan_id and user_id = v_me and status = 'planned'
     and planned_at > now() - interval '30 minutes'
  returning jsonb_build_object('plan_id', id, 'kind', kind, 'shared_at', shared_at, 'share_source', share_source)
    into v_out;
  if v_out is null then
    if exists (select 1 from public.court_plans pl where pl.id = p_plan_id and pl.user_id = v_me and pl.kind = 'once') then
      raise exception using message = 'That planned check-in is over or was cancelled, so it can''t be changed. Pull to refresh.', hint = 'pl:visit.gone';
    end if;
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  return v_out;
end $$;
revoke all on function public.set_court_plan_shared(uuid, boolean) from public, anon;
grant execute on function public.set_court_plan_shared(uuid, boolean) to authenticated;

-- Contract rule 3: "Share my routine stops automatically".
create or replace function public.set_auto_share_routines(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_on boolean := coalesce(p_on, false);
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  insert into public.presence_settings (user_id) values (v_me) on conflict (user_id) do nothing;
  update public.presence_settings
     set auto_share_routines = v_on, updated_at = now()
   where user_id = v_me;
  if v_on then
    -- My routine stops still in play that I never shared nor hid (a skipped
    -- one too: Undo skip brings it back shared, as a stop made now would be).
    update public.court_plans
       set shared_at = now(), share_source = 'auto', updated_at = now()
     where user_id = v_me and kind = 'routine' and routine_id is not null
       and status in ('planned', 'cancelled') and planned_at > now() - interval '30 minutes'
       and share_source is null;
  else
    -- Only what auto-share shared; confirmed and "Only you" stops stay.
    update public.court_plans
       set shared_at = null, share_source = null, updated_at = now()
     where user_id = v_me and share_source = 'auto';
  end if;
  return public.get_court_routine_settings();
end $$;
revoke all on function public.set_auto_share_routines(boolean) from public, anon;
grant execute on function public.set_auto_share_routines(boolean) to authenticated;

-- Contract rule 8: friends' shared plans for the feed (all courts) and a
-- court's page (p_venue, any row of the facility), p_days ahead (1 to 7).
create or replace function public.list_friend_court_plans(p_venue text default null, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_days  int := greatest(1, least(coalesce(p_days, 7), 7));
  v_canon text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_venue is not null then
    v_canon := public._pl_canonical_venue(p_venue);
    if v_canon is null then return '[]'::jsonb; end if;
  end if;
  return coalesce((
    with cand as (
      select case when f.requester_id = v_me then f.addressee_id else f.requester_id end as uid
        from public.friendships f
       where f.status = 'accepted' and v_me in (f.requester_id, f.addressee_id)
      union
      select mb.user_id
        from public.league_members ma
        join public.leagues l on l.id = ma.league_id and not l.is_open
        join public.league_members mb on mb.league_id = ma.league_id and mb.user_id <> v_me
       where ma.user_id = v_me
         and ma.admitted_closed and mb.admitted_closed
         and (ma.expires_at is null or ma.expires_at > now())
         and (mb.expires_at is null or mb.expires_at > now())
    ),
    seen as (
      select pl.id, pl.user_id, pl.planned_at, pl.planned_end_at, pl.kind,
             coalesce(v.canonical_id, v.id) as canon, v.name as venue_name, v.lat, v.lng,
             p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color
        from cand
        join public.court_plans pl on pl.user_id = cand.uid
        join public.profiles p on p.id = pl.user_id and p.deleted_at is null
        join public.venues v on v.id = pl.venue_id
       where pl.status = 'planned'
         and pl.shared_at is not null
         and pl.planned_at > now() - interval '30 minutes'
         and pl.planned_at <= now() + make_interval(days => v_days)
         and (v_canon is null
              or pl.venue_id in (select x.id from public.venues x where x.id = v_canon or x.canonical_id = v_canon))
         and public._pl_plan_visible(v_me, pl)
       order by pl.planned_at, pl.id
       limit 200
    )
    select jsonb_agg(jsonb_build_object(
             'plan_id',         s.id,
             'user_id',         s.user_id,
             'full_name',       s.full_name,
             'avatar_url',      s.avatar_url,
             'avatar_emoji',    s.avatar_emoji,
             'avatar_bg_color', s.avatar_bg_color,
             'is_friend',       public.are_friends(v_me, s.user_id),
             'is_close_friend', exists (select 1 from public.close_friends cf
                                         where cf.user_id = v_me and cf.friend_id = s.user_id),
             'venue_id',        s.canon,
             'venue_name',      s.venue_name,
             'lat',             s.lat,
             'lng',             s.lng,
             'planned_at',      s.planned_at,
             'planned_end_at',  s.planned_end_at,
             'kind',            s.kind)
             order by s.planned_at, s.id)
      from seen s), '[]'::jsonb);
end $$;
revoke all on function public.list_friend_court_plans(text, integer) from public, anon;
grant execute on function public.list_friend_court_plans(text, integer) to authenticated;

notify pgrst, 'reload schema';

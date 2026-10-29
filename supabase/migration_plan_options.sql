-- ============================================================
-- Plan options (2026-10-29): a one-off planned check-in gets the length and
-- play windows a routine has, and Drill joins Closed group and Open play.
--
--   1. 'drill' is a window mode everywhere windows are checked or worded:
--      _pl_windows_problem (routines, one-off plans), _pl_clean_abs_windows
--      (a check-in's own windows, set_checkin_plan) and _pl_windows_summary
--      ("Drill until 6 PM, then open play"). _pl_window_hint_ok needs no
--      change: a mode with no hint list takes no hint, so a drill window's
--      hint must be null. Drill is not open to play: the open-to-play reads
--      count mode 'open' only, so a drilling player is never counted as
--      joinable (court_play_modes reports their mode_now as 'drill').
--   2. list_my_court_plans adds length_min and windows (absolute), so the app
--      can edit them.
--   3. set_court_plan_details(p_plan_id, p_length_min, p_windows), new: the
--      owner sets a one-off plan's length (30 minutes to 4 hours, step 15:
--      pl:visit.bad_length) and windows (offsets from its start, as a
--      routine's; [] or null = the whole length, nothing said; a bad list is
--      pl:windows.bad). Only while the plan is still in play (planned, its
--      time no more than 30 minutes ago): else pl:visit.gone. Answers with
--      list_my_court_plans.
--
-- Replaced from their latest files (check-replaced-functions.mjs):
--   _pl_windows_problem, _pl_clean_abs_windows, _pl_windows_summary
--   (migration_court_routines.sql); list_my_court_plans
--   (migration_plan_sharing.sql).
-- Re-runnable.
-- ============================================================


-- ── 1. Drill ───────────────────────────────────────────────────────────────

create or replace function public._pl_windows_problem(p_windows jsonb, p_length int)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  n    int;
  i    int;
  w    jsonb;
  s    numeric;
  e    numeric;
  prev numeric := 0;
  m    text;
  h    text;
begin
  if p_length is null or p_length <= 0 or p_length % 15 <> 0 then
    return jsonb_build_object('problem', 'bad_length', 'index', -1);
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then
    return jsonb_build_object('problem', 'empty', 'index', -1);
  end if;
  n := jsonb_array_length(p_windows);
  if n > 6 then return jsonb_build_object('problem', 'too_many', 'index', -1); end if;
  for i in 0 .. n - 1 loop
    w := p_windows -> i;
    if jsonb_typeof(w) is distinct from 'object'
       or jsonb_typeof(w -> 'start_min') is distinct from 'number'
       or jsonb_typeof(w -> 'end_min') is distinct from 'number' then
      return jsonb_build_object('problem', 'off_step', 'index', i);
    end if;
    s := (w ->> 'start_min')::numeric;
    e := (w ->> 'end_min')::numeric;
    if s <> trunc(s) or e <> trunc(e) or mod(s, 15) <> 0 or mod(e, 15) <> 0 then
      return jsonb_build_object('problem', 'off_step', 'index', i);
    end if;
    if e - s < 15 then return jsonb_build_object('problem', 'too_short', 'index', i); end if;
    if i = 0 and s <> 0 then return jsonb_build_object('problem', 'not_from_start', 'index', 0); end if;
    if i > 0 and s > prev then return jsonb_build_object('problem', 'gap', 'index', i); end if;
    if i > 0 and s < prev then return jsonb_build_object('problem', 'overlap', 'index', i); end if;
    m := public._pl_json_str(w -> 'mode');
    if m is not null and m not in ('closed', 'open', 'drill') then
      return jsonb_build_object('problem', 'bad_mode', 'index', i);
    end if;
    h := public._pl_json_str(w -> 'hint');
    if not public._pl_window_hint_ok(m, h) then
      return jsonb_build_object('problem', 'bad_hint', 'index', i);
    end if;
    if jsonb_typeof(w -> 'group') = 'array' and jsonb_array_length(w -> 'group') > 7 then
      return jsonb_build_object('problem', 'group_too_big', 'index', i);
    end if;
    prev := e;
  end loop;
  if prev <> p_length then return jsonb_build_object('problem', 'not_to_end', 'index', n - 1); end if;
  return null;
end $$;
revoke all on function public._pl_windows_problem(jsonb, int) from public, anon, authenticated;

create or replace function public._pl_clean_abs_windows(p_uid uuid, p_windows jsonb, p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n     int;
  i     int;
  w     jsonb;
  v_s   timestamptz;
  v_e   timestamptz;
  v_prv timestamptz;
  m     text;
  h     text;
  v_out jsonb := '[]'::jsonb;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then
    perform public._pl_raise_windows(jsonb_build_object('problem', 'empty', 'index', -1));
  end if;
  n := jsonb_array_length(p_windows);
  if n > 6 then perform public._pl_raise_windows(jsonb_build_object('problem', 'too_many', 'index', -1)); end if;
  for i in 0 .. n - 1 loop
    w := p_windows -> i;
    begin
      v_s := (w ->> 'starts_at')::timestamptz;
      v_e := (w ->> 'ends_at')::timestamptz;
    exception when others then
      v_s := null;
    end;
    if jsonb_typeof(w) is distinct from 'object' or v_s is null or v_e is null then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'malformed', 'index', i));
    end if;
    if i = 0 then
      v_s := p_start;
    elsif v_s > v_prv + interval '1 minute' then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'gap', 'index', i));
    elsif v_s < v_prv - interval '1 minute' then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'overlap', 'index', i));
    else
      v_s := v_prv;
    end if;
    if i = n - 1 then v_e := p_end; end if;
    if v_e <= v_s then perform public._pl_raise_windows(jsonb_build_object('problem', 'too_short', 'index', i)); end if;
    m := public._pl_json_str(w -> 'mode');
    if m is not null and m not in ('closed', 'open', 'drill') then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'bad_mode', 'index', i));
    end if;
    h := public._pl_json_str(w -> 'hint');
    if not public._pl_window_hint_ok(m, h) then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'bad_hint', 'index', i));
    end if;
    if jsonb_typeof(w -> 'group') = 'array' and jsonb_array_length(w -> 'group') > 7 then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'group_too_big', 'index', i));
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'starts_at', v_s, 'ends_at', v_e, 'mode', m, 'hint', h,
      'group', public._pl_clean_group(p_uid, w -> 'group')));
    v_prv := v_e;
  end loop;
  return v_out;
end $$;
revoke all on function public._pl_clean_abs_windows(uuid, jsonb, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public._pl_windows_summary(p_windows jsonb, p_at timestamptz, p_tz text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v     jsonb := public._pl_windows_now(p_windows, p_at);
  v_lbl text;
  v_nxt text;
begin
  if v is null or v ->> 'position' = 'after' then return null; end if;
  v_lbl := case v ->> 'mode' when 'closed' then 'Closed group' when 'open' then 'Open play' when 'drill' then 'Drill' end;
  v_nxt := case v ->> 'next_mode' when 'closed' then 'closed group' when 'open' then 'open play' when 'drill' then 'drill' end;
  if v_lbl is null then
    if v_nxt is null then return null; end if;
    return initcap(left(v_nxt, 1)) || substr(v_nxt, 2) || ' from ' || public._pl_clock((v ->> 'next_at')::timestamptz, p_tz);
  end if;
  return v_lbl || ' until ' || public._pl_clock((v ->> 'until')::timestamptz, p_tz)
      || coalesce(', then ' || v_nxt, '');
end $$;
revoke all on function public._pl_windows_summary(jsonb, timestamptz, text) from public, anon, authenticated;


-- ── 2. The owner's plans carry length and windows ─────────────────────────

-- list_my_court_plans: from migration_plan_sharing.sql (the latest).
-- Changed: each plan adds length_min and windows.
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
             'share_source',   pl.share_source,
             'length_min',     (extract(epoch from (pl.planned_end_at - pl.planned_at)) / 60)::int,
             'windows',        pl.windows)
             order by pl.planned_at, pl.id)
      from public.court_plans pl
      join public.venues v on v.id = pl.venue_id
     where pl.user_id = v_me and pl.kind = 'once'
       and pl.status in ('planned', 'completed')
       and pl.planned_at > now() - interval '30 minutes'), '[]'::jsonb);
end $$;
revoke all on function public.list_my_court_plans() from public, anon;
grant execute on function public.list_my_court_plans() to authenticated;

-- ── 3. Edit a one-off plan's length and windows ───────────────────────────

create or replace function public.set_court_plan_details(
  p_plan_id    uuid,
  p_length_min integer,
  p_windows    jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_len  int := p_length_min;
  v_plan public.court_plans;
  v_w    jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_plan_id is null or v_len is null then
    raise exception using message = 'Couldn''t change your plan because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  if v_len < 30 or v_len > 240 or v_len % 15 <> 0 then
    raise exception using message = 'Pick how long you play: 30 minutes to 4 hours.', hint = 'pl:visit.bad_length';
  end if;

  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  select * into v_plan from public.court_plans pl
   where pl.id = p_plan_id and pl.user_id = v_me and pl.kind = 'once'
     and pl.status = 'planned' and pl.planned_at > now() - interval '30 minutes'
   for update;
  if v_plan.id is null then
    raise exception using message = 'That planned check-in is over or was cancelled, so it can''t be changed. Pull to refresh.', hint = 'pl:visit.gone';
  end if;

  -- Checked against the length (pl:windows.bad), group cleaned.
  v_w := public._pl_clean_windows(v_me, p_windows, v_len);
  update public.court_plans
     set planned_end_at = v_plan.planned_at + make_interval(mins => v_len),
         windows        = public._pl_windows_at(v_w, v_plan.planned_at),
         updated_at     = now()
   where id = v_plan.id;
  return public.list_my_court_plans();
end $$;
revoke all on function public.set_court_plan_details(uuid, integer, jsonb) from public, anon;
grant execute on function public.set_court_plan_details(uuid, integer, jsonb) to authenticated;

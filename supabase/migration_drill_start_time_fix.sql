-- ============================================================
-- Drill sessions start at the right time (2026-10-11 audit; verified
-- 2026-10-12 with read-only queries). Needs migration_time_zones.sql first.
-- Idempotent.
--
-- THE BUG: create_drill_session_on_accept built starts_at as
--   (session_date)::timestamp + slot * 30 min
-- a timestamp WITHOUT a zone, cast to timestamptz in the session zone. The
-- database zone is UTC (show timezone = UTC; no role or database override),
-- so a 9:00 AM slot (slots are wall-clock half hours on the requester's
-- device, 0 = midnight) was stored as 09:00 UTC = 2:00 AM Pacific (PDT).
-- Everything that reads starts_at fired about 7 hours early (8 in winter):
-- the 24 h / 2 h reminders, send-push's "upcoming" check for the On my way
-- buttons, and the app's local "starting now" notice. The app's own labels
-- were right, because they print session_date + session_slot.
--
-- THE FIX: read the wall-clock slot in the REQUESTER's time zone (their 7-day
-- grid produced the dates), via _pickleague_tz_for (America/Los_Angeles until
-- the app has reported a zone). The backfill of upcoming sessions is a
-- separate, reviewable step: supabase/backfill_drill_start_times.sql.
--
-- Apply:  supabase db query --linked -f supabase/migration_drill_start_time_fix.sql
-- ============================================================

-- A wall-clock slot on a date, in a zone -> the real instant.
create or replace function public._drill_slot_starts_at(p_date date, p_slot integer, p_tz text default null)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp := p_date::timestamp + (p_slot * interval '30 minutes');
begin
  if p_date is null or p_slot is null then return null; end if;
  begin
    return v_local at time zone coalesce(nullif(p_tz, ''), public._pickleague_default_tz());
  exception when others then
    return v_local at time zone public._pickleague_default_tz();
  end;
end $$;
revoke all on function public._drill_slot_starts_at(date, integer, text) from public, anon, authenticated;

-- "Sat Oct 18, 9 AM" / "Sat Oct 18, 9:30 AM" for a wall-clock slot: the same
-- format as the foundation's formatOptionLabel and _pickleague_local_label.
-- No zone involved: the slot already is local time.
create or replace function public._drill_slot_label(p_date date, p_slot integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_date is null or p_slot is null then null else
    to_char(t, 'Dy Mon FMDD, FMHH12')
    || case when extract(minute from t) = 0 then '' else to_char(t, ':MI') end
    || ' ' || to_char(t, 'AM')
  end
  from (select p_date::timestamp + (coalesce(p_slot, 0) * interval '30 minutes') as t) s;
$$;
revoke all on function public._drill_slot_label(date, integer) from public, anon, authenticated;

-- Production definition (2026-10-12) with starts_at computed in the
-- requester's zone, and an explicit search_path.
create or replace function public.create_drill_session_on_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_date text;
  v_slot integer;
  v_len  integer;
begin
  if old.status = 'pending' and new.status = 'accepted' and new.accepted_slot is not null then
    v_date := new.accepted_slot ->> 'date';
    v_slot := (new.accepted_slot ->> 'slot')::int;
    v_len  := coalesce(new.length_minutes, 60);
    if v_date is null or v_slot is null then return new; end if;

    insert into public.drill_sessions (
      request_id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes
    ) values (
      new.id, new.from_user_id, new.to_user_id,
      v_date::date, v_slot,
      public._drill_slot_starts_at(v_date::date, v_slot, public._pickleague_tz_for(new.from_user_id)),
      v_len
    )
    on conflict do nothing;
  end if;
  return new;
end;
$function$;

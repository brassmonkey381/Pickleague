-- ============================================================
-- Per-user time zones (foundation server kit time_zone.template.sql, filled
-- with prefix 'pickleague', recipients public.profiles). Idempotent.
--
-- Why now: drill_sessions.starts_at was built from the wall-clock slot as if
-- it were UTC (migration_drill_start_time_fix.sql uses _pickleague_tz_for),
-- and push bodies that print times need the recipient's zone. The app
-- reports its zone through set_pickleague_time_zone after sign-in
-- (mobile/src/lib/timeZoneSync.ts). No stored zone = America/Los_Angeles.
--
-- Apply:  supabase db query --linked -f supabase/migration_time_zones.sql
-- ============================================================

-- Vendored from @just-messin-around/expo-foundation@1.37.0 (server kit). Edit upstream, then re-vendor.
-- Each user's time zone, for local times in push bodies (foundation server kit).
-- Placeholders: pickleague, public.profiles.
--
-- Push bodies are built in SQL by the producer and sent as is, so a time in a
-- body has to be formatted in the RECIPIENT's zone at enqueue time. The device
-- reports its IANA zone (deviceTimeZone() in /platform/push) through
-- set_pickleague_time_zone; producers read it with _pickleague_tz_for and
-- format with _pickleague_local_label / _pickleague_option_list. A user with
-- no stored zone, or an invalid one, gets America/Los_Angeles
-- (_pickleague_default_tz: change it there).
--
-- Its own table, not a column on public.profiles: the zone stays private to its
-- owner (profiles are often world-readable), and the recipients table's
-- policies and guard triggers are not touched.
--
-- _pickleague_local_label formats exactly like formatOptionLabel() in
-- /push/optionVote ("Sat Oct 18, 9 AM", "Sat Oct 18, 9:30 AM"), so a body built
-- here and a confirmation notice built on the device read the same.

create table if not exists public.pickleague_time_zones (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  tz         text not null,
  updated_at timestamptz not null default now()
);
alter table public.pickleague_time_zones enable row level security;
drop policy if exists pickleague_time_zones_own on public.pickleague_time_zones;
create policy pickleague_time_zones_own on public.pickleague_time_zones for select to authenticated
  using (profile_id = (select auth.uid()));
-- Writes go through set_pickleague_time_zone only (it validates the zone).

create or replace function public._pickleague_default_tz()
returns text language sql immutable set search_path = '' as $$ select 'America/Los_Angeles'::text $$;

-- True for a zone Postgres knows by IANA name ('America/New_York', 'Etc/GMT+5').
-- POSIX strings ('UTC+5', 'EST5EDT'-style offsets) are refused: Postgres reads
-- their sign the opposite way round from the device.
create or replace function public._pickleague_valid_tz(p_tz text)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  if p_tz is null or length(p_tz) > 64 or p_tz !~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$' then
    return false;
  end if;
  perform now() at time zone p_tz;
  return true;
exception when others then
  return false;
end $$;

-- The caller's device zone. Returns false (stores nothing) for an invalid zone.
create or replace function public.set_pickleague_time_zone(p_tz text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public._pickleague_valid_tz(p_tz) then return false; end if;
  insert into public.pickleague_time_zones (profile_id, tz, updated_at)
  values (auth.uid(), p_tz, now())
  on conflict (profile_id) do update set tz = excluded.tz, updated_at = now()
  where pickleague_time_zones.tz is distinct from excluded.tz;
  return true;
end $$;
revoke execute on function public.set_pickleague_time_zone(text) from public, anon;
grant execute on function public.set_pickleague_time_zone(text) to authenticated;

-- A recipient's zone, else the default. For producers (service role / definer code).
create or replace function public._pickleague_tz_for(p_profile uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select z.tz from public.pickleague_time_zones z where z.profile_id = p_profile),
    public._pickleague_default_tz()
  );
$$;
revoke execute on function public._pickleague_tz_for(uuid) from public, anon, authenticated;
grant execute on function public._pickleague_tz_for(uuid) to service_role;

-- "Sat Oct 18, 9 AM" / "Sat Oct 18, 9:30 AM" in p_tz (an invalid or null zone
-- uses the default). English names regardless of lc_time (no TM prefix).
create or replace function public._pickleague_local_label(p_at timestamptz, p_tz text default null)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp;
begin
  if p_at is null then return null; end if;
  begin
    v_local := p_at at time zone coalesce(nullif(p_tz, ''), public._pickleague_default_tz());
  exception when others then
    v_local := p_at at time zone public._pickleague_default_tz();
  end;
  return to_char(v_local, 'Dy Mon FMDD, FMHH12')
      || case when extract(minute from v_local) = 0 then '' else to_char(v_local, ':MI') end
      || ' ' || to_char(v_local, 'AM');
end $$;

-- The numbered list for a vote body, like formatOptionList(): "1) ...\n2) ...".
-- Pass the times in button order (order by starts_at, id).
create or replace function public._pickleague_option_list(p_starts timestamptz[], p_tz text default null, p_sep text default E'\n')
returns text language sql stable set search_path = '' as $$
  select string_agg(s.n::text || ') ' || public._pickleague_local_label(s.t, p_tz), p_sep order by s.n)
  from unnest(p_starts) with ordinality as s(t, n);
$$;

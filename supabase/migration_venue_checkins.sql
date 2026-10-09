-- ============================================================
-- Court check-in + "players here now" (work order Phase 7e).
--
-- A check-in says "I'm at this court until <expires_at>". It is social
-- presence: every signed-in player can see who is checked in where. Writes go
-- through the RPCs below only, and every one of them is idempotent:
--   - checkin_venue takes a client-generated id, so an offline check-in that
--     the mutation queue replays (or a lock-screen button pressed twice) lands
--     once. A queued check-in carries the time it really happened (p_at).
--   - extend_checkin sets an absolute end time (not "+1 hour"), so a replay
--     cannot extend twice.
--   - checkout_venue closes what is open and is a no-op after that.
-- One open check-in per player: checking in somewhere closes the previous one.
--
-- Apply:  supabase db query --linked -f supabase/migration_venue_checkins.sql
-- ============================================================

create table if not exists public.venue_checkins (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  venue_id       text not null references public.venues (id) on delete cascade,
  checked_in_at  timestamptz not null default now(),
  expires_at     timestamptz not null,
  checked_out_at timestamptz,
  source         text not null default 'manual' check (source in ('manual', 'geofence', 'session')),
  created_at     timestamptz not null default now(),
  check (expires_at > checked_in_at)
);
create index if not exists venue_checkins_open_venue_idx on public.venue_checkins (venue_id, expires_at)
  where checked_out_at is null;
create index if not exists venue_checkins_open_user_idx on public.venue_checkins (user_id)
  where checked_out_at is null;
alter table public.venue_checkins enable row level security;

drop policy if exists venue_checkins_read on public.venue_checkins;
create policy venue_checkins_read on public.venue_checkins
  for select to authenticated using (true);
-- No insert/update/delete policies: writes go through the RPCs.

create or replace function public.checkin_venue(
  p_id      uuid,
  p_venue   text,
  p_minutes int default 120,
  p_source  text default 'manual',
  p_at      timestamptz default null
) returns public.venue_checkins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz;
  v_row public.venue_checkins;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_id is null then raise exception 'Missing check-in id'; end if;
  if p_source not in ('manual', 'geofence', 'session') then raise exception 'Bad source'; end if;
  if not exists (select 1 from public.venues where id = p_venue) then raise exception 'Court not found'; end if;

  -- Replay of a check-in that already landed.
  select * into v_row from public.venue_checkins where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then raise exception 'Not your check-in'; end if;
    return v_row;
  end if;

  -- Honest time for a queued (offline) check-in, never in the future and
  -- never more than 6 hours back.
  v_at := greatest(least(coalesce(p_at, now()), now()), now() - interval '6 hours');

  -- One open check-in per player.
  update public.venue_checkins
     set checked_out_at = greatest(v_at, checked_in_at + interval '1 second')
   where user_id = v_uid and checked_out_at is null;

  insert into public.venue_checkins (id, user_id, venue_id, checked_in_at, expires_at, source)
  values (p_id, v_uid, p_venue, v_at,
          v_at + make_interval(mins => greatest(15, least(coalesce(p_minutes, 120), 240))),
          p_source)
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public.checkin_venue(uuid, text, int, text, timestamptz) from public, anon;
grant execute on function public.checkin_venue(uuid, text, int, text, timestamptz) to authenticated;

-- Absolute end time: a replay cannot extend twice. Capped 4 hours from now.
create or replace function public.extend_checkin(p_id uuid, p_until timestamptz)
returns public.venue_checkins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.venue_checkins;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  update public.venue_checkins
     set expires_at = greatest(expires_at, least(p_until, now() + interval '4 hours'))
   where id = p_id and user_id = v_uid and checked_out_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'Check-in is no longer open'; end if;
  return v_row;
end $$;
revoke execute on function public.extend_checkin(uuid, timestamptz) from public, anon;
grant execute on function public.extend_checkin(uuid, timestamptz) to authenticated;

-- Close one check-in (p_id) or, with null, every open one of mine. With
-- p_source, only check-ins that source opened (geofence exit must not close a
-- manual check-in). Returns how many were closed; 0 on a replay.
create or replace function public.checkout_venue(p_id uuid default null, p_source text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  update public.venue_checkins
     set checked_out_at = greatest(least(now(), expires_at), checked_in_at + interval '1 second')
   where user_id = v_uid
     and checked_out_at is null
     and (p_id is null or id = p_id)
     and (p_source is null or source = p_source);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.checkout_venue(uuid, text) from public, anon;
grant execute on function public.checkout_venue(uuid, text) to authenticated;

-- Who is here now, with the profile fields a roster needs.
create or replace function public.venue_players_here(p_venue text)
returns table (
  checkin_id     uuid,
  user_id        uuid,
  full_name      text,
  avatar_url     text,
  avatar_emoji   text,
  avatar_bg_color text,
  rating         numeric,
  doubles_rating numeric,
  checked_in_at  timestamptz,
  expires_at     timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.user_id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color,
         p.rating, p.doubles_rating, c.checked_in_at, c.expires_at
    from public.venue_checkins c
    join public.profiles p on p.id = c.user_id
   where c.venue_id = p_venue
     and c.checked_out_at is null
     and c.expires_at > now()
     and p.deleted_at is null
   order by c.checked_in_at;
$$;
revoke execute on function public.venue_players_here(text) from public, anon;
grant execute on function public.venue_players_here(text) to authenticated;

-- Close lapsed check-ins so "open" in the table matches reality.
create or replace function public.expire_venue_checkins() returns void
language sql security definer set search_path = '' as $$
  update public.venue_checkins set checked_out_at = expires_at
   where checked_out_at is null and expires_at <= now();
$$;
revoke execute on function public.expire_venue_checkins() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-expire-venue-checkins') then
    perform cron.unschedule('pickleague-expire-venue-checkins');
  end if;
  perform cron.schedule('pickleague-expire-venue-checkins', '*/10 * * * *',
    $c$ select public.expire_venue_checkins(); $c$);
end $$;

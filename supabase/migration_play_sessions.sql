-- ============================================================
-- Live play sessions (work order Phase 7d): "I'm playing right now".
-- Powers the floating play island. One open session per player.
--
-- Writes go through two idempotent RPCs, so the app's offline queue can
-- replay them: the client generates the session id, start is a no-op if that
-- id already exists, and end only closes a session that is still open.
-- Both take the time the user actually acted (p_at), so a queued End records
-- when they stopped, not when the phone got signal back.
--
-- Apply:  supabase db query --linked -f supabase/migration_play_sessions.sql
-- ============================================================

create table if not exists public.play_sessions (
  id         uuid primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('open_play', 'drill', 'match', 'event')),
  source_id  uuid,                                   -- drill session / match / event id
  venue_id   text references public.venues (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists play_sessions_open_idx on public.play_sessions (user_id) where ended_at is null;
alter table public.play_sessions enable row level security;

drop policy if exists play_sessions_read on public.play_sessions;
create policy play_sessions_read on public.play_sessions
  for select to authenticated using (true);
-- No write policies: writes go through the RPCs.

create or replace function public.start_play_session(
  p_id     uuid,
  p_kind   text,
  p_source uuid default null,
  p_venue  text default null,
  p_at     timestamptz default null
) returns public.play_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz := greatest(least(coalesce(p_at, now()), now()), now() - interval '12 hours');
  v_row public.play_sessions;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_id is null then raise exception 'Missing session id'; end if;

  select * into v_row from public.play_sessions where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then raise exception 'Not your session'; end if;
    return v_row;  -- replay
  end if;

  -- One open session per player.
  update public.play_sessions set ended_at = greatest(v_at, started_at)
   where user_id = v_uid and ended_at is null;

  insert into public.play_sessions (id, user_id, kind, source_id, venue_id, started_at)
  values (p_id, v_uid, p_kind, p_source,
          case when p_venue is not null and exists (select 1 from public.venues where id = p_venue) then p_venue end,
          v_at)
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public.start_play_session(uuid, text, uuid, text, timestamptz) from public, anon;
grant execute on function public.start_play_session(uuid, text, uuid, text, timestamptz) to authenticated;

create or replace function public.end_play_session(p_id uuid, p_at timestamptz default null)
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
  update public.play_sessions
     set ended_at = greatest(least(coalesce(p_at, now()), now()), started_at)
   where id = p_id and user_id = v_uid and ended_at is null;
  get diagnostics v_n = row_count;
  return v_n;  -- 0 on a replay
end $$;
revoke execute on function public.end_play_session(uuid, timestamptz) from public, anon;
grant execute on function public.end_play_session(uuid, timestamptz) to authenticated;

-- Close sessions nobody ended (phone died, app deleted) after 6 hours.
create or replace function public.expire_play_sessions() returns void
language sql security definer set search_path = '' as $$
  update public.play_sessions set ended_at = started_at + interval '6 hours'
   where ended_at is null and started_at < now() - interval '6 hours';
$$;
revoke execute on function public.expire_play_sessions() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-expire-play-sessions') then
    perform cron.unschedule('pickleague-expire-play-sessions');
  end if;
  perform cron.schedule('pickleague-expire-play-sessions', '25 * * * *',
    $c$ select public.expire_play_sessions(); $c$);
end $$;

-- ============================================================
-- Group sessions for league events and tournaments (2026-10-30).
--
-- The user: "Build group sessions, for tournaments and league events" (the
-- Pickleague take on Doggle's group live walk). A group is every play session
-- whose source is the same league event or tournament: no party links.
--
--   1. play_sessions.kind gains 'tournament' (source_id = the tournament).
--      'event' already existed (source_id = the league event).
--   2. A Start for an event or tournament the player isn't in, or one that was
--      cancelled, is kept as plain open play (kind 'open_play', no source)
--      rather than refused: start_play_session is unchanged (1.0.4 calls it
--      by named arguments, and a queued Start must not fail on replay); a
--      BEFORE INSERT trigger on play_sessions does it.
--   3. list_group_session(kind, id): who played in the group today, one row
--      per player (playing now first). Only for people in the event or
--      tournament (the album rule, _pl_album_member, by user), blocks hidden.
--   4. notify_group_session(session id): "Let everyone know" when I start.
--      Only my own open event or tournament session. Goes to the people
--      going (an event's confirmed-time voters who haven't said Can't make it,
--      else the league's members; a tournament's approved players and its
--      creator), never to me, anyone blocked either way, anyone already in an
--      open session for it, or anyone with the Group sessions push off; at
--      most once per person per event or tournament every 2 hours, 60 people
--      a call. Returns how many were told.
--
-- Re-runnable. The client RPCs grant themselves and are on the allowlist in
-- migration_rls_hardening_2026q3.sql; the helpers are internal.
--
-- Apply:  state/group-sessions-apply.ps1
-- ============================================================

-- 1. kind ---------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.play_sessions'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.play_sessions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.play_sessions add constraint play_sessions_kind_check
  check (kind in ('open_play', 'drill', 'match', 'event', 'tournament'));

create index if not exists play_sessions_source_idx
  on public.play_sessions (source_id, started_at desc) where kind in ('event', 'tournament');

-- 2. Who's in a group ---------------------------------------------------------
-- The album rule (_pl_album_member) for any user, not only auth.uid():
-- an event's creator and its league's current members; a tournament's
-- creator, approved players and its league's admins. God mode is in all.
create or replace function public._pl_group_member(p_user uuid, p_kind text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_id is null then return false; end if;
  if public.is_godmode_user(p_user) then
    return (p_kind = 'event' and exists (select 1 from public.league_events where id = p_id))
        or (p_kind = 'tournament' and exists (select 1 from public.tournaments where id = p_id));
  end if;
  if p_kind = 'event' then
    return exists (
      select 1 from public.league_events e
       where e.id = p_id
         and (e.created_by = p_user
              or exists (select 1 from public.league_members m
                          where m.league_id = e.league_id and m.user_id = p_user
                            and (m.expires_at is null or m.expires_at > now())))
    );
  elsif p_kind = 'tournament' then
    return exists (
      select 1 from public.tournaments t
       where t.id = p_id
         and (t.created_by = p_user
              or exists (select 1 from public.tournament_registrations r
                          where r.tournament_id = t.id and r.user_id = p_user and r.status = 'approved')
              or (t.league_id is not null and exists (
                    select 1 from public.league_members m
                     where m.league_id = t.league_id and m.user_id = p_user
                       and m.role in ('admin', 'co-admin'))))
    );
  end if;
  return false;
end $$;
revoke all on function public._pl_group_member(uuid, text, uuid) from public, anon, authenticated;

-- A group you can join: you're in it and it wasn't cancelled.
create or replace function public._pl_group_joinable(p_user uuid, p_kind text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._pl_group_member(p_user, p_kind, p_id)
     and case p_kind
           when 'event' then exists (select 1 from public.league_events e
                                      where e.id = p_id and e.status <> 'cancelled')
           when 'tournament' then exists (select 1 from public.tournaments t
                                           where t.id = p_id and t.status <> 'cancelled')
           else false
         end;
$$;
revoke all on function public._pl_group_joinable(uuid, text, uuid) from public, anon, authenticated;

-- 3. A Start for a group I can't join is plain open play ------------------------
create or replace function public._pl_play_sessions_group_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('event', 'tournament')
     and (new.source_id is null or not public._pl_group_joinable(new.user_id, new.kind, new.source_id)) then
    new.kind := 'open_play';
    new.source_id := null;
  end if;
  return new;
end $$;
revoke all on function public._pl_play_sessions_group_guard() from public, anon, authenticated;

drop trigger if exists trg_play_sessions_group_guard on public.play_sessions;
create trigger trg_play_sessions_group_guard
  before insert on public.play_sessions
  for each row execute function public._pl_play_sessions_group_guard();

-- 4. The group ------------------------------------------------------------------
-- {can_view, can_join, players: [{user_id, full_name, avatar_url, avatar_emoji,
--  avatar_bg_color, started_at, ended_at (null: playing now), played_s, is_me}]}
-- Sessions that started in the last 12 hours, or are still open; an open one
-- older than 6 hours counts as ended at 6 hours (the hourly expiry closes it).
-- One row per player; playing now first, then the latest to stop. 100 at most.
create or replace function public.list_group_session(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_kind not in ('event', 'tournament')
     or not public._pl_group_member(v_uid, p_kind, p_id) then
    return jsonb_build_object('can_view', false, 'can_join', false, 'players', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'can_view', true,
    'can_join', public._pl_group_joinable(v_uid, p_kind, p_id),
    'players', coalesce((
      with s as (
        select s.user_id, s.started_at,
               case when s.ended_at is null and s.started_at > now() - interval '6 hours' then null
                    else coalesce(s.ended_at, s.started_at + interval '6 hours') end as ended_at
          from public.play_sessions s
         where s.kind = p_kind and s.source_id = p_id
           and (s.ended_at is null or s.started_at > now() - interval '12 hours')
           and s.started_at > now() - interval '24 hours'
      ),
      per as (
        select s.user_id,
               min(s.started_at) as started_at,
               case when bool_or(s.ended_at is null) then null else max(s.ended_at) end as ended_at,
               sum(extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)))::bigint as played_s
          from s
         group by s.user_id
      )
      select jsonb_agg(jsonb_build_object(
               'user_id', p.id, 'full_name', p.full_name, 'avatar_url', p.avatar_url,
               'avatar_emoji', p.avatar_emoji, 'avatar_bg_color', p.avatar_bg_color,
               'started_at', per.started_at, 'ended_at', per.ended_at,
               'played_s', greatest(per.played_s, 0), 'is_me', p.id = v_uid)
             order by (per.ended_at is null) desc, coalesce(per.ended_at, per.started_at) desc, p.id)
        from (select * from per
               order by (per.ended_at is null) desc, coalesce(per.ended_at, per.started_at) desc, per.user_id
               limit 100) per
        join public.profiles p on p.id = per.user_id and p.deleted_at is null
       where p.id = v_uid or not public.blocked_between(v_uid, p.id)
    ), '[]'::jsonb));
end $$;
revoke all on function public.list_group_session(text, uuid) from public, anon;
grant execute on function public.list_group_session(text, uuid) to authenticated, service_role;

-- 5. "Let everyone know" --------------------------------------------------------
create table if not exists public.group_session_notices (
  source_id    uuid not null,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  sent_at      timestamptz not null default now(),
  primary key (source_id, recipient_id)
);
alter table public.group_session_notices enable row level security;
-- No policies: only notify_group_session reads and writes it.

create or replace function public.notify_group_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_s     public.play_sessions;
  v_title text;
  v_name  text;
  v_slot  uuid;
  v_n     integer := 0;
  r       record;
begin
  if v_uid is null or p_session_id is null then return 0; end if;
  select * into v_s from public.play_sessions s
   where s.id = p_session_id and s.user_id = v_uid and s.ended_at is null
     and s.kind in ('event', 'tournament') and s.source_id is not null
     and s.started_at > now() - interval '6 hours';
  if v_s.id is null then return 0; end if;
  if not public._pl_group_joinable(v_uid, v_s.kind, v_s.source_id) then return 0; end if;
  -- One sender at a time per group, so two Starts can't both pass the 2 hours.
  perform pg_advisory_xact_lock(hashtext('group_notice:' || v_s.source_id::text));

  v_name := public._pl_display_name(v_uid);
  if v_s.kind = 'event' then
    select e.title, e.confirmed_slot_id into v_title, v_slot from public.league_events e where e.id = v_s.source_id;
  else
    select t.name into v_title from public.tournaments t where t.id = v_s.source_id;
  end if;

  for r in
    with going as (
      -- An event with a time picked: who voted for that time, and the organizer.
      select v.user_id from public.event_slot_votes v
       where v_s.kind = 'event' and v_slot is not null and v.slot_id = v_slot
      union
      select e.created_by from public.league_events e
       where v_s.kind = 'event' and e.id = v_s.source_id and e.created_by is not null
      -- No time picked yet: the league.
      union
      select m.user_id from public.league_members m
        join public.league_events e on e.league_id = m.league_id
       where v_s.kind = 'event' and v_slot is null and e.id = v_s.source_id
         and (m.expires_at is null or m.expires_at > now())
      -- A tournament: its approved players and its creator.
      union
      select reg.user_id from public.tournament_registrations reg
       where v_s.kind = 'tournament' and reg.tournament_id = v_s.source_id and reg.status = 'approved'
      union
      select t.created_by from public.tournaments t
       where v_s.kind = 'tournament' and t.id = v_s.source_id and t.created_by is not null
    )
    select g.user_id
      from going g
      join public.profiles p on p.id = g.user_id and p.deleted_at is null
     where g.user_id <> v_uid
       and public._pl_group_member(g.user_id, v_s.kind, v_s.source_id)
       and not public.blocked_between(v_uid, g.user_id)
       and not (v_s.kind = 'event' and exists (
             select 1 from public.event_declines d where d.event_id = v_s.source_id and d.user_id = g.user_id))
       and not exists (
             select 1 from public.play_sessions o
              where o.user_id = g.user_id and o.kind = v_s.kind and o.source_id = v_s.source_id
                and o.ended_at is null and o.started_at > now() - interval '6 hours')
       and not exists (
             select 1 from public.group_session_notices n
              where n.source_id = v_s.source_id and n.recipient_id = g.user_id
                and n.sent_at > now() - interval '2 hours')
       and not exists (
             select 1 from public.user_preferences up
              where up.user_id = g.user_id and up.prefs ->> 'notifyGroupSessions' = 'false')
     order by g.user_id
     limit 60
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🏓 ' || v_name || ' started the group session',
      coalesce(v_title, case when v_s.kind = 'event' then 'Your event' else 'Your tournament' end)
        || ': they''re playing now. Tap to join.',
      case when v_s.kind = 'event' then 'league' else 'tournament' end,
      v_s.source_id,
      v_s.kind,
      'notifyGroupSessions',
      jsonb_build_object('kind', 'group_session', 'session_id', v_s.id)
    );
    insert into public.group_session_notices (source_id, recipient_id, sent_at)
    values (v_s.source_id, r.user_id, now())
    on conflict (source_id, recipient_id) do update set sent_at = excluded.sent_at;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.notify_group_session(uuid) from public, anon;
grant execute on function public.notify_group_session(uuid) to authenticated, service_role;

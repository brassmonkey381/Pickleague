-- ============================================================
-- Play session history and Discard (2026-10-29, PKL-011;
-- docs/play-sessions-presence.md Phase 2).
--
--   1. play_sessions.discarded_at: the player threw the session away. It
--      leaves the history and never counts again (valid = false,
--      valid_reason 'discarded'), whatever is recorded later. A match or
--      drill it held may count for a neighbouring session instead, so
--      _pl_match_session and _pl_drill_session skip discarded sessions.
--      The session's check-in (presence history) is left as it was.
--   2. discard_play_session(p_id), new: the owner discards an ENDED session
--      (an open one: pl:session.open, End it first; unknown:
--      pl:session.gone; someone else's: pl:session.not_yours). Returns 1, or
--      0 when it was discarded already (a retry). Re-judges the sessions
--      around it.
--   3. list_my_play_sessions(p_before, p_limit), new: my ended sessions that
--      aren't discarded, newest first (keyset on started_at), with the
--      court's name, the stored verdict and how many matches count for each.
--
-- Replaced from their latest files (check-replaced-functions.mjs):
--   _pl_refresh_session_validity, _pl_match_session, _pl_drill_session
--   (migration_validity_rules.sql).
-- Re-runnable.
-- ============================================================


-- ── 1. Discarded ───────────────────────────────────────────────────────────

alter table public.play_sessions add column if not exists discarded_at timestamptz;
comment on column public.play_sessions.discarded_at is
  'When its player discarded it (discard_play_session): out of the history, never counts again.';

alter table public.play_sessions drop constraint if exists play_sessions_valid_reason_check;
alter table public.play_sessions add constraint play_sessions_valid_reason_check check (
  valid_reason is null
  or valid_reason in ('open', 'too_short', 'no_match_or_drill', 'linked_match', 'match_in_window', 'drill_in_window',
                      'discarded'));

create index if not exists play_sessions_history_idx
  on public.play_sessions (user_id, started_at desc)
  where ended_at is not null and discarded_at is null;

-- _pl_refresh_session_validity: from migration_validity_rules.sql. Changed: a
-- discarded session is stored not valid ('discarded') before anything else.
create or replace function public._pl_refresh_session_validity(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_discarded timestamptz;
begin
  -- Discarded by its player: never counts again.
  select ps.discarded_at into v_discarded from public.play_sessions ps where ps.id = p_session;
  if v_discarded is not null then
    update public.play_sessions ps
       set valid                        = false,
           valid_reason                 = 'discarded',
           rewards_pending_confirmation = false,
           validated_at                 = null
     where ps.id = p_session
       and (ps.valid, ps.valid_reason, ps.rewards_pending_confirmation)
           is distinct from (false, 'discarded', false);
    return jsonb_build_object(
      'valid', false,
      'reason', 'discarded',
      'needs', null,
      'window_ends_at', null,
      'rewards_pending_confirmation', false,
      'at_court', false);
  end if;

  select * into v from public._pl_session_validity(p_session);
  if v.reason is null then return null; end if;
  update public.play_sessions ps
     set valid                        = v.valid,
         valid_reason                 = v.reason,
         rewards_pending_confirmation = v.pending,
         at_court                     = v.at_court,
         validated_at                 = case when not v.valid then null
                                             when ps.valid then coalesce(ps.validated_at, now())
                                             else now() end
   where ps.id = p_session
     and (ps.valid, ps.valid_reason, ps.rewards_pending_confirmation, ps.at_court)
         is distinct from (v.valid, v.reason, v.pending, v.at_court);
  return jsonb_build_object(
    'valid', v.valid,
    'reason', v.reason,
    'needs', v.needs,
    'window_ends_at', v.window_ends_at,
    'rewards_pending_confirmation', v.pending,
    'at_court', v.at_court);
end $$;
revoke all on function public._pl_refresh_session_validity(uuid) from public, anon, authenticated;

-- _pl_match_session: from migration_validity_rules.sql. Changed: a discarded
-- session never takes a match (it falls to the next one).
create or replace function public._pl_match_session(p_user uuid, p_linked uuid, p_at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.play_sessions s
   where s.user_id = p_user
     and s.discarded_at is null
     and (s.ended_at is null or s.ended_at - s.started_at >= interval '5 minutes')
     and (s.id = p_linked
          or p_at between s.started_at and coalesce(s.ended_at, now()) + interval '2 hours')
   order by (s.id = p_linked) desc nulls last,
            (p_at <= coalesce(s.ended_at, now())) desc nulls last,
            s.ended_at desc nulls first,
            s.id
   limit 1
$$;
revoke all on function public._pl_match_session(uuid, uuid, timestamptz) from public, anon, authenticated;

-- _pl_drill_session: from migration_validity_rules.sql. Changed: a discarded
-- session never takes a drill.
create or replace function public._pl_drill_session(
  p_user        uuid,
  p_drill       uuid,
  p_reviewed_at timestamptz,
  p_starts_at   timestamptz,
  p_length_min  int
) returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.play_sessions s
   where s.user_id = p_user
     and s.discarded_at is null
     and (s.ended_at is null or s.ended_at - s.started_at >= interval '5 minutes')
     and p_reviewed_at between s.started_at and coalesce(s.ended_at, now()) + interval '2 hours'
     and p_starts_at < coalesce(s.ended_at, now()) + interval '30 minutes'
     and p_starts_at + make_interval(mins => coalesce(p_length_min, 60)) > s.started_at - interval '30 minutes'
   order by (s.kind = 'drill' and s.source_id = p_drill) desc nulls last,
            abs(extract(epoch from (s.started_at - p_starts_at))),
            s.id
   limit 1
$$;
revoke all on function public._pl_drill_session(uuid, uuid, timestamptz, timestamptz, int) from public, anon, authenticated;


-- ── 2. Discard ─────────────────────────────────────────────────────────────

create or replace function public.discard_play_session(p_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.play_sessions;
  v_near uuid;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  select * into v_row from public.play_sessions ps where ps.id = p_id;
  if v_row.id is null then
    raise exception using message = 'That play session is gone, so there is nothing to discard.', hint = 'pl:session.gone';
  end if;
  if v_row.user_id <> v_me then
    raise exception using message = 'Not your session', hint = 'pl:session.not_yours';
  end if;
  if v_row.ended_at is null then
    raise exception using message = 'End your play session first, then discard it.', hint = 'pl:session.open';
  end if;
  if v_row.discarded_at is not null then return 0; end if;

  update public.play_sessions ps set discarded_at = now() where ps.id = p_id;

  -- It and the sessions around it: a match or drill it held may count for a
  -- neighbour now. A failed re-judge only warns; the discard stands.
  for v_near in
    select ps.id
      from public.play_sessions ps
     where ps.user_id = v_me
       and ps.ended_at is not null
       and ps.started_at < v_row.ended_at + interval '2 hours'
       and ps.ended_at + interval '2 hours' > v_row.started_at
  loop
    begin
      perform public._pl_refresh_session_validity(v_near);
    exception when others then
      raise warning 'session validity not refreshed: %', sqlerrm;
    end;
  end loop;
  return 1;
end $$;
revoke all on function public.discard_play_session(uuid) from public, anon;
grant execute on function public.discard_play_session(uuid) to authenticated;


-- ── 3. History ─────────────────────────────────────────────────────────────

create or replace function public.list_my_play_sessions(p_before timestamptz default null, p_limit integer default 30)
returns table (
  session_id      uuid,
  kind            text,
  venue_id        text,
  venue_name      text,
  started_at      timestamptz,
  ended_at        timestamptz,
  valid           boolean,
  valid_reason    text,
  at_court        boolean,
  rewards_pending boolean,
  match_count     integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  return query
  select ps.id, ps.kind, ps.venue_id, vn.name, ps.started_at, ps.ended_at,
         ps.valid, ps.valid_reason, ps.at_court, ps.rewards_pending_confirmation,
         (select count(*)::int
            from public.matches m
           where m.status in ('pending', 'completed')
             and v_me in (m.player1_id, m.player2_id, m.partner1_id, m.partner2_id)
             and (m.play_session_id = ps.id
                  or m.created_at between ps.started_at and ps.ended_at + interval '2 hours')
             and public._pl_match_session(v_me, m.play_session_id, m.created_at) = ps.id)
    from public.play_sessions ps
    left join public.venues vn on vn.id = ps.venue_id
   where ps.user_id = v_me
     and ps.ended_at is not null
     and ps.discarded_at is null
     and (p_before is null or ps.started_at < p_before)
   order by ps.started_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 100));
end $$;
revoke all on function public.list_my_play_sessions(timestamptz, integer) from public, anon;
grant execute on function public.list_my_play_sessions(timestamptz, integer) to authenticated;

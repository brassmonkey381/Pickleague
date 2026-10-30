-- ============================================================
-- Log a drill for a play session, and add a match or drill to a past one
-- (2026-10-30). The user: "i received an in app banner to record a match or
-- drill for my sesssion, but was only offered a match score entering. i
-- actually did drilling! And then when i look for it in my play history, i
-- cant edit it to add a match score or drill session. please enable all of
-- this".
--
-- Until now a drill counted for a session only through a SCHEDULED drill
-- (drill_requests -> drill_sessions with a partner) that the player reviewed
-- within 2 hours of the session's end, and a match only when it was linked or
-- recorded within those 2 hours. A player who just drilled had nothing to
-- record, and nothing could be added from Play history afterwards.
--
--   1. drill_sessions.play_session_id: a drill logged for a play session.
--      One per play session (unique), so a session's drill is paid once.
--      A logged drill is the player's own: player1_id = player2_id = them
--      (the app shows it as a solo drill and leaves it out of the drill
--      lists, which are for drills with a partner).
--   2. log_session_drill(p_play_session, the five facets, p_notes), new:
--      the owner logs the drill they did in an ENDED session (5+ minutes,
--      not discarded, ended in the last 7 days) and reviews it in one step:
--        * stores the drill (starts at the session's start, as long as it,
--          capped at 8 hours) linked to the session,
--        * reviews it through submit_drill_review, so the pay is exactly a
--          review's (5 per facet, 0.1 per character up to 50, inside the
--          500/day play cap, "Drill review" in pickle history),
--        * dates the review to the session's end when it is logged later,
--          so _pl_session_validity / _pl_drill_session (which want a review
--          within 2 hours of the end) count it for this session,
--        * makes an open-play session (or a drill timer with no drill) a
--          drill session (kind 'drill', source_id = the drill), so it reads
--          "Drill" in Play history and counts toward drill time,
--        * re-judges the session.
--      Refused (success = false, with why): someone else's or an unknown
--      session, an open one, a discarded one, under 5 minutes, more than 7
--      days ago, a drill already logged for it, or a reviewed drill that
--      already counts for it (that one was paid already).
--      Returns success, pickles_granted, new_balance, message, drill_session_id.
--   3. _pl_matches_link_session: a match may be linked to my session up to
--      7 days after it ended (was 2 hours), so "Add a match" from Play history
--      counts. A linked match already counts whenever it was recorded
--      (_pl_session_validity); only this trigger dropped late links.
--
-- Replaced from their latest files:
--   _pl_matches_link_session (migration_validity_rules.sql, its only definition).
-- Re-runnable. Grants log_session_drill to authenticated and adds it to the
-- allowlist in migration_rls_hardening_2026q3.sql.
-- ============================================================


-- ── 1. A drill logged for a play session ──────────────────────────────────────
alter table public.drill_sessions
  add column if not exists play_session_id uuid references public.play_sessions (id) on delete set null;
comment on column public.drill_sessions.play_session_id is
  'A drill logged for this play session (log_session_drill): the player''s own, player1_id = player2_id.';
create unique index if not exists drill_sessions_play_session_uidx
  on public.drill_sessions (play_session_id) where play_session_id is not null;


-- ── 2. log_session_drill ───────────────────────────────────────────────────────
create or replace function public.log_session_drill(
  p_play_session   uuid,
  p_consistency    integer,
  p_effort         integer,
  p_organization   integer,
  p_intentionality integer,
  p_fun            integer,
  p_notes          text
) returns table (success boolean, pickles_granted integer, new_balance integer, message text, drill_session_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  s         public.play_sessions;
  v_balance integer;
  v_tz      text;
  v_local   timestamp;
  v_minutes integer;
  v_drill   uuid;
  v_review  record;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  select coalesce(p.pickles, 0) into v_balance from public.profiles p where p.id = v_uid;
  v_balance := coalesce(v_balance, 0);

  select * into s from public.play_sessions ps where ps.id = p_play_session for update;
  if s.id is null or s.user_id <> v_uid then
    return query select false, 0, v_balance, 'That play session isn''t in your history.'::text, null::uuid; return;
  end if;
  if s.ended_at is null then
    return query select false, 0, v_balance, 'End your play session first, then log your drill.'::text, null::uuid; return;
  end if;
  if s.discarded_at is not null then
    return query select false, 0, v_balance, 'You discarded this session, so a drill can''t be added to it.'::text, null::uuid; return;
  end if;
  if s.ended_at - s.started_at < interval '5 minutes' then
    return query select false, 0, v_balance, 'This session lasted under 5 minutes, so a drill can''t count for it.'::text, null::uuid; return;
  end if;
  if s.ended_at < now() - interval '7 days' then
    return query select false, 0, v_balance,
      'This session ended more than 7 days ago. Drills can be added for 7 days after a session.'::text, null::uuid; return;
  end if;
  if exists (select 1 from public.drill_sessions d where d.play_session_id = s.id) then
    return query select false, 0, v_balance, 'You already logged a drill for this session.'::text, null::uuid; return;
  end if;
  -- A drill I reviewed already counts for it (and was paid for).
  if exists (
    select 1
      from public.drill_session_reviews r
      join public.drill_sessions d on d.id = r.session_id
     where r.user_id = v_uid
       and d.starts_at is not null
       and public._pl_drill_session(v_uid, d.id, r.created_at, d.starts_at, d.length_minutes) = s.id) then
    return query select false, 0, v_balance, 'A drill you reviewed already counts for this session.'::text, null::uuid; return;
  end if;
  if p_consistency is null and p_effort is null and p_organization is null
     and p_intentionality is null and p_fun is null then
    return query select false, 0, v_balance, 'Rate at least one thing to send your review.'::text, null::uuid; return;
  end if;

  v_tz      := public._pickleague_tz_for(v_uid);
  v_local   := s.started_at at time zone v_tz;
  v_minutes := least(greatest(round(extract(epoch from (s.ended_at - s.started_at)) / 60)::integer, 1), 480);

  begin
    insert into public.drill_sessions
      (player1_id, player2_id, session_date, session_slot, starts_at, length_minutes, play_session_id)
    values
      (v_uid, v_uid, v_local::date,
       least(greatest(floor((extract(hour from v_local) * 60 + extract(minute from v_local)) / 30)::integer, 0), 47),
       s.started_at, v_minutes, s.id)
    returning id into v_drill;

    -- The review and its pay, exactly as a scheduled drill's.
    select * into v_review
      from public.submit_drill_review(v_drill, p_consistency, p_effort, p_organization, p_intentionality, p_fun, p_notes);
    if not coalesce(v_review.success, false) then
      raise exception using message = coalesce(v_review.message, 'Your drill wasn''t saved. Try again.');
    end if;

    -- Logged later than the session's 2 hours: dated to its end, so the
    -- validity rules (a review within 2 hours of the end) count it here.
    update public.drill_session_reviews r
       set created_at = s.ended_at
     where r.session_id = v_drill and r.user_id = v_uid
       and r.created_at > s.ended_at + interval '2 hours';

    -- Open play (or a drill timer with no drill) becomes this drill's session.
    if s.kind = 'open_play' or (s.kind = 'drill' and s.source_id is null) then
      update public.play_sessions ps set kind = 'drill', source_id = v_drill where ps.id = s.id;
    end if;
  exception when others then
    -- Nothing in this block is kept (no drill, no review, no pickles).
    return query select false, 0, v_balance, sqlerrm::text, null::uuid; return;
  end;

  perform public._pl_refresh_session_validity(s.id);
  return query select true, coalesce(v_review.pickles_granted, 0), coalesce(v_review.new_balance, v_balance),
                      'Drill logged'::text, v_drill;
end $$;
revoke all on function public.log_session_drill(uuid, integer, integer, integer, integer, integer, text) from public, anon;
grant execute on function public.log_session_drill(uuid, integer, integer, integer, integer, integer, text)
  to authenticated, service_role;


-- ── 3. A match may be linked up to 7 days after the session ───────────────────
-- _pl_matches_link_session: from migration_validity_rules.sql. Changed: the
-- link is kept for a session that ended in the last 7 days (was 2 hours).
create or replace function public._pl_matches_link_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid;
  v_ended  timestamptz;
  v_caller uuid;
begin
  if new.play_session_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.play_session_id is not distinct from old.play_session_id then return new; end if;
  begin
    v_caller := auth.uid();
    select s.user_id, s.ended_at into v_owner, v_ended
      from public.play_sessions s where s.id = new.play_session_id;
    if v_owner is null                                     -- not stored (yet): its Start may still be queued
       or (v_caller is not null and v_owner <> v_caller)   -- only my own session
       or not coalesce(v_owner = any (array_remove(
            array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null)), false)
       or v_ended < now() - interval '7 days' then         -- too late to say it was played then
      new.play_session_id := null;
    end if;
  exception when others then
    raise warning 'matches: play session link dropped: %', sqlerrm;
    new.play_session_id := null;
  end;
  return new;
end $$;
revoke all on function public._pl_matches_link_session() from public, anon, authenticated;

notify pgrst, 'reload schema';

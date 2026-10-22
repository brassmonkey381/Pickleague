-- ============================================================
-- schedule_league_match: the one way a client puts a future league match on
-- the calendar (ScheduleMatchScreen).
--
-- Before this file, ScheduleMatchScreen inserted into public.matches directly
-- ({league_id, player1_id, player2_id, status 'scheduled', scheduled_at}).
-- On the live database that insert never landed: player1_score and
-- player2_score are NOT NULL there (schema.sql and matches_score_sanity_check
-- both expect them nullable; live drifted), so no scheduled row exists. Had
-- it landed, nothing checked it:
--   * any league member could write status 'scheduled' straight to the REST
--     API with scores and a winner filled in, past every confirmation, and
--     the client stats that don't filter on status (calendar W/L, partner
--     chemistry, streaks, match counts) would read it as played;
--   * the players didn't have to be league members, the time could be in the
--     past, and a retried request booked the match twice;
--   * update_plupr_ratings ran its INSERT branch on the row: no scores, no
--     winner, so it stored a made-up 7-11 loss for player 1 in
--     player1/2_rating_after and pending_delta1/2 (never applied, but the
--     rating history reads rating_after);
--   * on_match_player_stats (migration_add_match_metadata.sql, live)
--     counted it as played: total_matches_played + 1 (which also lowers the
--     PLUPR K-factor) and last_match_at = now for both players. Fixed for
--     every status in migration_match_count_fix.sql (a match counts once,
--     when it's confirmed).
--
-- This file:
--   0. Scores: NOT NULL dropped on player1/2_score; a new check keeps them
--      required on every match that isn't 'scheduled' (all existing rows
--      have both, so it validates).
--   1. schedule_league_match(p_league_id, p_player1_id, p_player2_id,
--      p_scheduled_at) -> the match id. SECURITY DEFINER. The caller must be
--      a current member of the league (the rule the old insert policy
--      applied); both players must be current members and different; the
--      time must be in the future (5 minutes of slack for the phone's clock)
--      and within a year. A replay of the same booking (same league, same two
--      players, same time, still scheduled) returns the existing match
--      instead of booking it twice. The row stores no rating snapshot.
--   2. _pl_matches_client_insert_guard: a direct client insert with status
--      'scheduled' is refused (pl:schedule.use_rpc); only the RPC above (it
--      sets pl.schedule_match_rpc for its own insert, a setting PostgREST
--      never lets a request set) and godmode may write one. Everything else
--      as in migration_validity_rules.sql.
--
-- Refusal codes (HINT 'pl:<code>', mobile/src/lib/refusals.ts):
--   auth.signed_out, request.bad (missing arguments),
--   schedule.not_member, schedule.player_not_member, schedule.same_player,
--   schedule.in_past, schedule.too_far, schedule.use_rpc
--
-- Apply AFTER migration_validity_rules.sql and re-apply after any re-run of
-- it (that file puts the old guard back). Then re-run
-- migration_rls_hardening_2026q3.sql (schedule_league_match is on its
-- allowlist). Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_schedule_match_rpc.sql
-- Tested by supabase/tests/schedule_match_personas.sql.
-- ============================================================


-- ── 0. Scores: empty only while scheduled ─────────────────────────────────
alter table public.matches alter column player1_score drop not null;
alter table public.matches alter column player2_score drop not null;
alter table public.matches drop constraint if exists matches_scores_unless_scheduled;
alter table public.matches add constraint matches_scores_unless_scheduled
  check (status = 'scheduled' or (player1_score is not null and player2_score is not null));


-- ── 1. schedule_league_match ───────────────────────────────────────────────
create or replace function public.schedule_league_match(
  p_league_id    uuid,
  p_player1_id   uuid,
  p_player2_id   uuid,
  p_scheduled_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception using
      message = 'You''re signed out. Sign in to Pickleague and try again.',
      hint = 'pl:auth.signed_out';
  end if;
  if p_league_id is null or p_player1_id is null or p_player2_id is null or p_scheduled_at is null then
    raise exception using
      message = 'Couldn''t schedule the match because the app sent an incomplete request. Update Pickleague, then try again.',
      hint = 'pl:request.bad';
  end if;

  if not exists (
    select 1 from public.league_members lm
     where lm.league_id = p_league_id
       and lm.user_id = v_uid
       and (lm.expires_at is null or lm.expires_at > now())
  ) then
    raise exception using
      message = 'You''re not a member of this league, so you can''t schedule matches in it.',
      hint = 'pl:schedule.not_member';
  end if;

  if p_player1_id = p_player2_id then
    raise exception using
      message = 'Pick two different players for the match.',
      hint = 'pl:schedule.same_player';
  end if;

  if (select count(*) from public.league_members lm
       where lm.league_id = p_league_id
         and lm.user_id in (p_player1_id, p_player2_id)
         and (lm.expires_at is null or lm.expires_at > now())) < 2 then
    raise exception using
      message = 'Both players need to be members of this league. Pick players from the league.',
      hint = 'pl:schedule.player_not_member';
  end if;

  if p_scheduled_at < now() - interval '5 minutes' then
    raise exception using
      message = 'That time has already passed. Pick a time in the future.',
      hint = 'pl:schedule.in_past';
  end if;
  if p_scheduled_at > now() + interval '366 days' then
    raise exception using
      message = 'That''s more than a year away. Pick a time within the next year.',
      hint = 'pl:schedule.too_far';
  end if;

  -- One booking per league, pair and time: a replay returns the first one.
  perform pg_advisory_xact_lock(hashtext('schedule_match:' || p_league_id::text || ':'
    || least(p_player1_id, p_player2_id)::text || ':' || greatest(p_player1_id, p_player2_id)::text));
  select m.id into v_id
    from public.matches m
   where m.league_id = p_league_id
     and m.status = 'scheduled'
     and m.scheduled_at = p_scheduled_at
     and least(m.player1_id, m.player2_id) = least(p_player1_id, p_player2_id)
     and greatest(m.player1_id, m.player2_id) = greatest(p_player1_id, p_player2_id)
   limit 1;
  if v_id is not null then return v_id; end if;

  -- The client insert guard lets a scheduled row through only with this set.
  perform set_config('pl.schedule_match_rpc', 'on', true);
  insert into public.matches (league_id, match_type, player1_id, player2_id, status, scheduled_at)
  values (p_league_id, 'singles', p_player1_id, p_player2_id, 'scheduled', p_scheduled_at)
  returning id into v_id;
  perform set_config('pl.schedule_match_rpc', '', true);

  -- update_plupr_ratings ran its INSERT branch on a match with no score: drop
  -- the made-up snapshot it stored (nothing was applied). The UPDATE fires
  -- only on_match_completed, which does nothing for a scheduled row.
  update public.matches
     set player1_rating_before = null, player2_rating_before = null,
         player1_rating_after  = null, player2_rating_after  = null,
         pending_delta1 = null, pending_delta2 = null
   where id = v_id;

  return v_id;
end $$;
revoke all on function public.schedule_league_match(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.schedule_league_match(uuid, uuid, uuid, timestamptz) to authenticated;


-- ── 2. The client insert guard: scheduled rows only through the RPC ───────
-- From migration_validity_rules.sql; only the 'scheduled' branch changed.
create or replace function public._pl_matches_client_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;
  new.created_at := now();
  if public.is_godmode_user(v_uid) then return new; end if;
  if new.status = 'scheduled' then
    if coalesce(current_setting('pl.schedule_match_rpc', true), '') <> 'on' then
      raise exception using
        message = 'Couldn''t schedule the match because this version of Pickleague sent an outdated request. Update Pickleague, then try again.',
        hint = 'pl:schedule.use_rpc';
    end if;
    new.confirm_deadline   := null;
    new.team1_confirmed_by := null;
    new.team2_confirmed_by := null;
    return new;
  end if;
  new.status             := 'pending';
  new.confirm_deadline   := now() + interval '1 hour';
  new.team1_confirmed_by := case when v_uid in (new.player1_id, new.partner1_id) then v_uid end;
  new.team2_confirmed_by := case when new.team1_confirmed_by is null
                                  and v_uid in (new.player2_id, new.partner2_id) then v_uid end;
  return new;
end $$;
revoke all on function public._pl_matches_client_insert_guard() from public, anon, authenticated;

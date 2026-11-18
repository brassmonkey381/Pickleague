-- ============================================================
-- PKL-036: tournament notices while it is played (in-app row + push).
--
-- Found in the PKL-034 live run (2026-11-18): a whole 8-player tournament
-- sent Brian 4 notices (new tournament, invite, Bracket Set, +50 pickles).
-- Nothing in the database inserts a notification when a match becomes
-- ready, a score is entered, the round robin ends, the playoff is drawn or
-- the tournament finishes (triage-studio/state/pkl-034/push-expectations.md
-- §2.7-2.12). Brian (2026-11-18): "many more" notices during a tournament,
-- in-app and push.
--
-- Every notice here is a public.notifications row: trg_notification_push
-- turns it into a push (push_outbox -> send-push). All of them:
--   type 'tournament', entity tournament/<id> (a tap opens TournamentDetail),
--   category 'notifyTournamentUpdates' (the existing tournament push pref;
--   in-app rows always appear), push_data.kind = the notice kind.
-- Each (kind, thing, player) is sent at most once: reminder_log is the
-- dedupe ledger (its primary key is (kind, entity_id, user_id)).
--
-- Notices (doubles: every player on both teams, partners included):
--   tm_ready      "Your first match" when the draw is locked in (tournament
--                 -> active), and "Up next" each time a player's next match
--                 changes: after their match is scored, or when a new match
--                 with them appears in an active tournament (a bracket
--                 advance, a later playoff round). One per player per match.
--   tm_score      a match is scored: every player on it except whoever
--                 entered the score gets "you won 11-7 / you lost 7-11",
--                 who entered it, the match pay (PKL-042) and their next
--                 match. The one who entered it gets only "Up next" (and the
--                 match pay) since they already saw "recorded".
--   tm_fix_<s1>_<s2> a completed score was corrected (godmode / service
--                 role): every player except the editor.
--   tm_rr_done    round robin / pool play with a playoff configured: the
--                 last group match is scored. Each player gets their RR
--                 place and "the host draws the playoff next";
--   tm_draw_due   ... and the tournament's admins get "draw the playoff".
--   tm_playoff    the playoff is drawn (round robin / pool play): players in
--                 it get "You're in the Final / Third Place Match / Semi-
--                 finals vs ...", everyone else gets their RR place and the
--                 playoff pairings. Sent once, at commit of the draw.
--   tm_finished   the tournament completes: each player gets their final
--                 placement ("You won X!", "2nd place", "You finished 5th of
--                 8"), their RR place when there was a playoff, and their
--                 placement pay (PKL-042).
--
-- Triggers:
--   trg_tm_score_notices       AFTER UPDATE on tournament_matches (score in,
--                              score corrected, RR done). Sorts after
--                              trg_advance_* (the next bracket match exists)
--                              and trg_tm_match_pay (the pay is known).
--   trg_tm_new_match_notices   DEFERRED constraint trigger, AFTER INSERT or a
--                              lineup UPDATE on tournament_matches: at commit,
--                              so a playoff draw is announced once with all
--                              its matches in place. Skips tournaments not
--                              active (lock-in inserts the draw before it
--                              flips the tournament to active).
--   trg_tournament_status_notices AFTER UPDATE OF status on tournaments:
--                              active -> first matches; completed -> final
--                              placement. Sorts after trg_settle_wagers_
--                              tournament (ranks) and trg_tournament_
--                              placement_pay (PKL-042).
-- Every notice is best effort: a failure never blocks a score or a status
-- change. All functions are internal (EXECUTE revoked).
-- Depends on: migration_tournament_staged_placement.sql
-- (_pl_tournament_group_order), migration_tournament_rewards.sql (grants).
-- Apply: supabase db query --linked -f supabase/migration_tournament_play_notices.sql
-- Test:  state/pkl-035-036-037-test.sql (begin ... rollback).
-- ============================================================


-- ── Helpers ─────────────────────────────────────────────────────────────────

create or replace function public._pl_ordinal(n integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select n::text || case
    when n % 100 between 11 and 13 then 'th'
    when n % 10 = 1 then 'st'
    when n % 10 = 2 then 'nd'
    when n % 10 = 3 then 'rd'
    else 'th' end
$$;
revoke all on function public._pl_ordinal(integer) from public, anon, authenticated;

-- One side of a match as words: "You & Sam", "Alex Kim & Jo Park", "Alex Kim".
create or replace function public._pl_tm_side(p_a uuid, p_b uuid, p_viewer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with ids as (
    select u, ord from (values (p_a, 1), (p_b, 2)) v(u, ord) where u is not null
  )
  select coalesce(string_agg(
           case when i.u = p_viewer then 'You'
                else coalesce(nullif(trim(p.full_name), ''), 'a player') end,
           ' & ' order by (i.u = p_viewer) desc, i.ord), 'TBD')
    from ids i
    left join public.profiles p on p.id = i.u
$$;
revoke all on function public._pl_tm_side(uuid, uuid, uuid) from public, anon, authenticated;

-- "You & Sam vs Alex & Jo": the viewer's side first when they play in it.
create or replace function public._pl_tm_line(p_match uuid, p_viewer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_viewer in (m.team2_player1, m.team2_player2)
      then public._pl_tm_side(m.team2_player1, m.team2_player2, p_viewer) || ' vs '
        || public._pl_tm_side(m.team1_player1, m.team1_player2, p_viewer)
    else public._pl_tm_side(m.team1_player1, m.team1_player2, p_viewer) || ' vs '
      || public._pl_tm_side(m.team2_player1, m.team2_player2, p_viewer)
    end
    from public.tournament_matches m where m.id = p_match
$$;
revoke all on function public._pl_tm_line(uuid, uuid) from public, anon, authenticated;

-- A player's open matches in schedule order (round, then match order).
create or replace function public._pl_tm_player_matches(p_tournament uuid, p_user uuid)
returns table (match_id uuid, pos integer, total integer, is_open boolean, round_label text, round_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id,
         (row_number() over (order by coalesce(r.round_number, 0), m.match_order, m.created_at, m.id))::int,
         (count(*) over ())::int,
         m.status not in ('completed', 'cancelled'),
         r.label, r.round_type
    from public.tournament_matches m
    left join public.tournament_rounds r on r.id = m.round_id
   where m.tournament_id = p_tournament
     and m.team1_player1 is not null and m.team2_player1 is not null
     and p_user in (m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2)
$$;
revoke all on function public._pl_tm_player_matches(uuid, uuid) from public, anon, authenticated;

-- One notice, once. Returns true when it was sent now.
create or replace function public._pl_tm_notice(
  p_user uuid, p_kind text, p_ref uuid, p_tournament uuid, p_title text, p_body text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_user is null then return false; end if;
  insert into public.reminder_log (kind, entity_id, user_id)
  values (p_kind, p_ref, p_user)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
  values (p_user, p_title, p_body, 'tournament', p_tournament, 'tournament', 'notifyTournamentUpdates',
          jsonb_build_object('kind', regexp_replace(p_kind, '_[0-9]+_[0-9]+$', '')));
  return true;
exception when others then
  raise warning 'tournament notice % for % failed: %', p_kind, p_user, sqlerrm;
  return false;
end $$;
revoke all on function public._pl_tm_notice(uuid, text, uuid, uuid, text, text) from public, anon, authenticated;

-- "Up next: You & Sam vs Alex & Jo (your match 3 of 7)." for the player's
-- next open match, or null when they have none. Marks that match as
-- announced (tm_ready) when p_mark, so it is never announced again.
create or replace function public._pl_tm_next_text(p_tournament uuid, p_user uuid, p_mark boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public._pl_tm_player_matches(p_tournament, p_user) x
   where x.is_open order by x.pos limit 1;
  if v.match_id is null then return null; end if;
  if p_mark then
    insert into public.reminder_log (kind, entity_id, user_id)
    values ('tm_ready', v.match_id, p_user) on conflict do nothing;
  end if;
  return 'Up next'
      || case when v.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match', 'grand_final', 'losers')
              then ' (' || coalesce(v.round_label, 'playoff') || ')' else '' end
      || ': ' || public._pl_tm_line(v.match_id, p_user)
      || ' (your match ' || v.pos || ' of ' || v.total || ').';
end $$;
revoke all on function public._pl_tm_next_text(uuid, uuid, boolean) from public, anon, authenticated;

-- tm_ready for a player's next open match, if it hasn't been announced.
create or replace function public._pl_tm_ready_notice(p_tournament uuid, p_user uuid, p_first boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      record;
  v_name text;
begin
  select * into v from public._pl_tm_player_matches(p_tournament, p_user) x
   where x.is_open order by x.pos limit 1;
  if v.match_id is null then return false; end if;
  select name into v_name from public.tournaments where id = p_tournament;
  return public._pl_tm_notice(
    p_user, 'tm_ready', v.match_id, p_tournament,
    case when p_first then '🏓 ' || v_name || ' is on: your first match'
         when v.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match', 'grand_final', 'losers')
           then '🏓 Up next in ' || v_name || ': ' || coalesce(v.round_label, 'playoff')
         else '🏓 Up next in ' || v_name end,
    public._pl_tm_line(v.match_id, p_user)
      || ' (your match ' || v.pos || ' of ' || v.total || '). Open the tournament to play.');
end $$;
revoke all on function public._pl_tm_ready_notice(uuid, uuid, boolean) from public, anon, authenticated;

-- A player's round-robin place (team place in fixed doubles), or null.
create or replace function public._pl_tm_rr_place(p_tournament uuid, p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select g.rr_rank from public._pl_tournament_group_order(p_tournament) g
   where p_user in (g.lo, g.hi) limit 1
$$;
revoke all on function public._pl_tm_rr_place(uuid, uuid) from public, anon, authenticated;


-- ── Score in / corrected / round robin done ─────────────────────────────────
create or replace function public._pl_tm_score_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t        record;
  v_actor    uuid := auth.uid();
  v_actor_nm text;
  v_uid      uuid;
  v_won      boolean;
  v_mine     integer;
  v_theirs   integer;
  v_pay      integer;
  v_next     text;
  v_body     text;
  v_place    integer;
  v_open     integer;
begin
  if new.team1_player1 is null or new.team2_player1 is null then return null; end if;
  if new.status <> 'completed' or new.winner_team not in ('team1', 'team2') then return null; end if;
  begin
    select id, name, format, status, coalesce(playoff_format, 'none') as playoff, created_by
      into v_t from public.tournaments where id = new.tournament_id;
    if v_t.id is null then return null; end if;
    select nullif(trim(full_name), '') into v_actor_nm from public.profiles where id = v_actor;

    -- 1. A score went in.
    if old.status is distinct from 'completed' then
      foreach v_uid in array array_remove(array[new.team1_player1, new.team1_player2,
                                                 new.team2_player1, new.team2_player2], null) loop
        begin
          v_won := (v_uid in (new.team1_player1, new.team1_player2)) = (new.winner_team = 'team1');
          if v_uid in (new.team1_player1, new.team1_player2) then
            v_mine := coalesce(new.team1_score, 0); v_theirs := coalesce(new.team2_score, 0);
          else
            v_mine := coalesce(new.team2_score, 0); v_theirs := coalesce(new.team1_score, 0);
          end if;
          v_pay := null;
          begin
            select g.paid into v_pay from public.tournament_match_bonus_grants g
             where g.match_id = new.id and g.user_id = v_uid;
          exception when undefined_table then v_pay := null;
          end;
          v_next := case when v_t.status = 'active' then public._pl_tm_next_text(v_t.id, v_uid, true) end;

          if v_actor is not null and v_uid = v_actor then
            -- The one who entered it: only what's new to them.
            if v_next is not null or coalesce(v_pay, 0) > 0 then
              perform public._pl_tm_notice(
                v_uid, 'tm_score', new.id, v_t.id,
                case when v_next is not null then '🏓 Up next in ' || v_t.name
                     else '✅ Score saved in ' || v_t.name end,
                concat_ws(' ',
                  case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 for the match.' end,
                  v_next));
            end if;
          else
            v_body := concat_ws(' ',
              public._pl_tm_line(new.id, v_uid) || ', ' || v_mine || '-' || v_theirs || '.',
              case when v_actor_nm is not null then 'Entered by ' || v_actor_nm || '.' end,
              case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 for the match.' end,
              v_next);
            perform public._pl_tm_notice(
              v_uid, 'tm_score', new.id, v_t.id,
              case when v_won then '✅ ' || v_t.name || ': you won ' || v_mine || '-' || v_theirs
                   else '📝 ' || v_t.name || ': you lost ' || v_mine || '-' || v_theirs end,
              v_body);
          end if;
        exception when others then
          raise warning 'score notice for % on % failed: %', v_uid, new.id, sqlerrm;
        end;
      end loop;

      -- 2. Round robin done, playoff still to draw.
      if v_t.status = 'active' and v_t.format in ('round_robin', 'pool_play') and v_t.playoff <> 'none'
         and not exists (select 1 from public.tournament_rounds r
                          where r.tournament_id = v_t.id and r.round_type not in ('winners', 'pool')) then
        select count(*) into v_open
          from public.tournament_matches m
          left join public.tournament_rounds r on r.id = m.round_id
         where m.tournament_id = v_t.id and m.status <> 'completed'
           and (r.id is null or r.round_type in ('winners', 'pool'));
        if v_open = 0 then
          for v_uid in
            select tr.user_id from public.tournament_registrations tr
             where tr.tournament_id = v_t.id and tr.status = 'approved' and tr.user_id is not null
          loop
            v_place := public._pl_tm_rr_place(v_t.id, v_uid);
            perform public._pl_tm_notice(
              v_uid, 'tm_rr_done', v_t.id, v_t.id,
              '📊 ' || v_t.name || ': round robin done',
              case when v_place is not null
                   then 'You finished ' || public._pl_ordinal(v_place) || ' in the round robin. '
                   else '' end
              || 'The host draws the playoff next; we''ll tell you when it''s set.');
          end loop;
          for v_uid in
            select distinct u from (
              select v_t.created_by as u
              union
              select tr.user_id from public.tournament_registrations tr
               where tr.tournament_id = v_t.id and tr.status = 'approved' and tr.role in ('admin', 'co-admin')
            ) a where u is not null
          loop
            perform public._pl_tm_notice(
              v_uid, 'tm_draw_due', v_t.id, v_t.id,
              '🏆 Draw the playoff: ' || v_t.name,
              'Every round-robin match is scored. Open the tournament and tap Generate the playoff.');
          end loop;
        end if;
      end if;

    -- 3. A completed score was corrected.
    elsif (new.team1_score, new.team2_score, new.winner_team)
          is distinct from (old.team1_score, old.team2_score, old.winner_team) then
      foreach v_uid in array array_remove(array[new.team1_player1, new.team1_player2,
                                                 new.team2_player1, new.team2_player2], null) loop
        if v_actor is not null and v_uid = v_actor then continue; end if;
        if v_uid in (new.team1_player1, new.team1_player2) then
          v_mine := coalesce(new.team1_score, 0); v_theirs := coalesce(new.team2_score, 0);
        else
          v_mine := coalesce(new.team2_score, 0); v_theirs := coalesce(new.team1_score, 0);
        end if;
        perform public._pl_tm_notice(
          v_uid, 'tm_fix_' || coalesce(new.team1_score, 0) || '_' || coalesce(new.team2_score, 0), new.id, v_t.id,
          '✏️ Score corrected in ' || v_t.name,
          public._pl_tm_line(new.id, v_uid) || ' is now ' || v_mine || '-' || v_theirs || '.');
      end loop;
    end if;
  exception when others then
    raise warning 'tournament score notices failed for match %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_tm_score_notices() from public, anon, authenticated;

drop trigger if exists trg_tm_score_notices on public.tournament_matches;
create trigger trg_tm_score_notices
  after update of status, team1_score, team2_score, winner_team on public.tournament_matches
  for each row execute function public._pl_tm_score_notices();


-- ── New matches: playoff drawn, next bracket match ──────────────────────────
create or replace function public._pl_tm_new_match_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m      record;
  v_t      record;
  v_uid    uuid;
  v_pm     record;
  v_place  integer;
  v_pairs  text;
  v_in     boolean;
begin
  begin
    -- At commit: read the row as it is now (it may have changed or gone).
    select m.*, r.round_type, r.label as round_label
      into v_m
      from public.tournament_matches m
      left join public.tournament_rounds r on r.id = m.round_id
     where m.id = new.id;
    if v_m.id is null or v_m.team1_player1 is null or v_m.team2_player1 is null then return null; end if;
    if v_m.status in ('completed', 'cancelled') then return null; end if;

    select id, name, format, status into v_t from public.tournaments where id = v_m.tournament_id;
    if v_t.id is null or v_t.status <> 'active' then return null; end if;

    -- The playoff of a round robin / pool play was just drawn: announce it once.
    if v_t.format in ('round_robin', 'pool_play')
       and v_m.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
       and not exists (select 1 from public.reminder_log
                        where kind = 'tm_playoff' and entity_id = v_t.id) then
      select string_agg(coalesce(r.label, 'Playoff') || ': '
                        || public._pl_tm_side(m.team1_player1, m.team1_player2, null) || ' vs '
                        || public._pl_tm_side(m.team2_player1, m.team2_player2, null),
                        '. ' order by r.round_number, m.match_order)
        into v_pairs
        from public.tournament_matches m
        join public.tournament_rounds r on r.id = m.round_id
       where m.tournament_id = v_t.id
         and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
         and m.team1_player1 is not null and m.team2_player1 is not null;

      for v_uid in
        select tr.user_id from public.tournament_registrations tr
         where tr.tournament_id = v_t.id and tr.status = 'approved' and tr.user_id is not null
      loop
        begin
          v_place := public._pl_tm_rr_place(v_t.id, v_uid);
          select m.id, r.label into v_pm
            from public.tournament_matches m
            join public.tournament_rounds r on r.id = m.round_id
           where m.tournament_id = v_t.id
             and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
             and m.status not in ('completed', 'cancelled')
             and v_uid in (m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2)
           order by r.round_number, m.match_order limit 1;
          v_in := v_pm.id is not null;
          if v_in then
            -- Their playoff match is announced here; no separate "Up next".
            insert into public.reminder_log (kind, entity_id, user_id)
            values ('tm_ready', v_pm.id, v_uid) on conflict do nothing;
            perform public._pl_tm_notice(
              v_uid, 'tm_playoff', v_t.id, v_t.id,
              '🏆 You''re in the ' || coalesce(v_pm.label, 'playoff') || '!',
              v_t.name || ': ' || public._pl_tm_line(v_pm.id, v_uid) || '.'
              || case when v_place is not null
                      then ' You finished ' || public._pl_ordinal(v_place) || ' in the round robin.' else '' end);
          else
            perform public._pl_tm_notice(
              v_uid, 'tm_playoff', v_t.id, v_t.id,
              '🏆 Playoff drawn in ' || v_t.name,
              case when v_place is not null
                   then 'You finished ' || public._pl_ordinal(v_place) || ' in the round robin. ' else '' end
              || coalesce(v_pairs || '.', ''));
          end if;
        exception when others then
          raise warning 'playoff notice for % failed: %', v_uid, sqlerrm;
        end;
      end loop;
      return null;
    end if;

    -- Otherwise: a player whose next match this is hears about it.
    foreach v_uid in array array_remove(array[v_m.team1_player1, v_m.team1_player2,
                                               v_m.team2_player1, v_m.team2_player2], null) loop
      if exists (select 1 from public._pl_tm_player_matches(v_t.id, v_uid) x
                  where x.is_open and x.match_id = v_m.id
                    and x.pos = (select min(y.pos) from public._pl_tm_player_matches(v_t.id, v_uid) y where y.is_open)) then
        perform public._pl_tm_ready_notice(v_t.id, v_uid, false);
      end if;
    end loop;
  exception when others then
    raise warning 'new match notices failed for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_tm_new_match_notices() from public, anon, authenticated;

drop trigger if exists trg_tm_new_match_notices on public.tournament_matches;
create constraint trigger trg_tm_new_match_notices
  after insert or update of team1_player1, team1_player2, team2_player1, team2_player2
  on public.tournament_matches
  deferrable initially deferred
  for each row execute function public._pl_tm_new_match_notices();


-- ── Tournament goes active / completes ──────────────────────────────────────
create or replace function public._pl_tournament_status_notices()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid;
  v_rank    integer;
  v_places  integer;
  v_rr      integer;
  v_pay     integer;
  v_staged  boolean;
  v_title   text;
begin
  if new.status is not distinct from old.status then return null; end if;
  begin
    -- Lock-in: everyone's first match.
    if new.status = 'active' then
      for v_uid in
        select tr.user_id from public.tournament_registrations tr
         where tr.tournament_id = new.id and tr.status = 'approved' and tr.user_id is not null
      loop
        perform public._pl_tm_ready_notice(new.id, v_uid, true);
      end loop;
    end if;

    -- Finished: final placement.
    if new.status = 'completed' then
      if not exists (select 1 from public.tournament_final_ranks where tournament_id = new.id) then
        perform public.compute_tournament_final_ranks(new.id);
      end if;
      select count(distinct final_rank) into v_places from public.tournament_final_ranks where tournament_id = new.id;
      v_staged := new.format in ('round_robin', 'pool_play')
                  and exists (select 1 from public.tournament_rounds r
                               where r.tournament_id = new.id and r.round_type not in ('winners', 'pool'));
      for v_uid in
        select tr.user_id from public.tournament_registrations tr
         where tr.tournament_id = new.id and tr.status = 'approved' and tr.user_id is not null
      loop
        begin
          select fr.final_rank into v_rank from public.tournament_final_ranks fr
           where fr.tournament_id = new.id and fr.user_id = v_uid;
          v_pay := null;
          begin
            select g.paid into v_pay from public.tournament_placement_grants g
             where g.tournament_id = new.id and g.user_id = v_uid;
          exception when undefined_table then v_pay := null;
          end;
          v_rr := case when v_staged then public._pl_tm_rr_place(new.id, v_uid) end;
          v_title := case
            when v_rank = 1 then '🥇 You won ' || new.name || '!'
            when v_rank = 2 then '🥈 2nd place in ' || new.name
            when v_rank = 3 then '🥉 3rd place in ' || new.name
            when v_rank is not null then '🏁 ' || new.name || ': you finished ' || public._pl_ordinal(v_rank)
            else '🏁 ' || new.name || ' is finished' end;
          perform public._pl_tm_notice(
            v_uid, 'tm_finished', new.id, new.id, v_title,
            concat_ws(' ',
              case when v_rank is not null
                   then 'Final placement: ' || public._pl_ordinal(v_rank) || ' of ' || v_places || '.' end,
              case when v_rr is not null
                   then 'Round robin: ' || public._pl_ordinal(v_rr) || '.' end,
              case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 placement pay.' end,
              'Open the tournament for the final table.'));
        exception when others then
          raise warning 'finish notice for % failed: %', v_uid, sqlerrm;
        end;
      end loop;
    end if;
  exception when others then
    raise warning 'tournament status notices failed for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_tournament_status_notices() from public, anon, authenticated;

-- Name sorts after trg_settle_wagers_tournament and trg_tournament_placement_pay.
drop trigger if exists trg_tournament_status_notices on public.tournaments;
create trigger trg_tournament_status_notices
  after update of status on public.tournaments
  for each row execute function public._pl_tournament_status_notices();

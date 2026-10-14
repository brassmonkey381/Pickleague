-- ============================================================
-- Local times in notices (time-zone audit, 2026-10-14). Needs
-- migration_time_zones.sql, migration_drill_start_time_fix.sql,
-- migration_push_actions_events.sql, migration_push_actions_drill.sql,
-- migration_league_join_resolution.sql, migration_prod_reconcile_2026q3.sql
-- (the badge triggers) and migration_award_time_based_badges.sql (the cron
-- job) first. Idempotent: create or replace, and cron.alter_job only sets
-- the schedule.
--
-- The database runs in UTC, so every date a notice printed, and every "same
-- day" rule, was the UTC day: a denial at 6:30 PM PDT said "after October
-- 22", an 11-0 win at 6:30 PM PDT was "on 2026-10-19", and a 9 AM event got
-- "is today" at 11 PM the night before. Now each one uses the zone of the
-- person it is about (_pickleague_tz_for; no stored zone =
-- America/Los_Angeles):
--
--   1. _league_join_request_resolved   the denial says when the requester
--                                      can ask again, in THEIR zone: "You can
--                                      ask again from Wed Oct 21, 6:30 PM."
--   2. remind_event_organizer_nudges   "is tomorrow" / "is today" follow the
--                                      organizer's calendar day, and go out in
--                                      the daytime only (organizer's zone)
--   3. notify_on_drill_request         the proposed times are the requester's
--                                      wall clock; the invitee now reads them
--                                      in their own zone
--   4. _award_match_badges, _award_marathon_badge,
--      _award_triple_crown_badge, _award_cinderella_badge,
--      _award_underdog_badge          the date in a badge's context is the
--                                      winner's local day ('YYYY-MM-DD', the
--                                      format Triple Crown dedupes on), and
--                                      Triple Crown's "same day" is that day
--   5. cron 'pickleague-award-progress-badges'   08:00 UTC (1 AM Pacific) ->
--                                      17:00 UTC (10 AM PDT / 9 AM PST). Its
--                                      badges push "+N pickles".
--   6. client RPCs                     og_card_tz (anon + authenticated: the
--                                      zone a link preview prints in) and
--                                      drill_request_slot_starts
--                                      (authenticated: the real instant of
--                                      each proposed drill time)
--
-- Each function below is the production definition (2026-10-14) plus these
-- changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_local_times_in_notices.sql
-- ============================================================


-- ── 1. Join denied: the retry time in the requester's zone ─────────────────
create or replace function public._league_join_request_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_league text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'pending' then
      perform public._clear_league_join_notices(old.league_id, old.user_id);
    end if;
    return old;
  end if;

  if old.status = 'pending' and new.status is distinct from 'pending' then
    perform public._clear_league_join_notices(old.league_id, old.user_id);
  end if;

  -- Denied (deny_league_join_request, or an old build's direct update): ONE
  -- notice to the requester, replacing any earlier one for this league.
  if new.status = 'denied' and old.status is distinct from 'denied' then
    begin
      select name into v_league from public.leagues where id = new.league_id;
      if v_league is not null then
        delete from public.notifications
         where user_id = new.user_id and entity_type = 'league' and entity_id = new.league_id
           and push_data ->> 'kind' = 'league_join_denied';
        insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
        values (
          new.user_id,
          'Your request to join ' || v_league || ' wasn''t approved',
          -- The exact moment request_league_join lets them ask again, in the
          -- requester's zone ("Wed Oct 21, 6:30 PM").
          'You can ask again from '
            || public._pickleague_local_label(coalesce(new.denied_at, now()) + public._league_join_deny_cooldown(),
                                              public._pickleague_tz_for(new.user_id)) || '.',
          'league', new.league_id, 'league', 'notifyLeagueUpdates',
          jsonb_build_object('kind', 'league_join_denied')
        );
      end if;
    exception when others then
      raise warning '_league_join_request_resolved: deny notice failed: %', sqlerrm;
    end;
  end if;
  return new;
end $function$;
revoke execute on function public._league_join_request_resolved() from public, anon, authenticated;


-- ── 2. Organizer nudges: the organizer's calendar day, daytime only ────────
-- "Tomorrow": the event is on the organizer's local tomorrow; sent 9 AM to
-- 8:59 PM their time. "Today": it is on their local today and still ahead;
-- sent 7 AM to 9:59 PM. The hour gates sit inside `due`, so a row outside
-- them never reaches reminder_log and the next hourly run tries it again. An
-- event confirmed late gets whichever word is true by then: a same-day event
-- confirmed at 2 PM gets "today"; one confirmed at 10 PM for tomorrow morning
-- gets "today" at 7 AM. An event before 7 AM gets only "tomorrow".
create or replace function public.remind_event_organizer_nudges()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with due as (
      select le.id            as event_id,
             le.created_by    as user_id,
             'event_nudge_vote'::text as kind,
             le.title         as title,
             le.league_id     as league_id
      from public.league_events le
      where le.status = 'voting'
        and le.created_by is not null
        and le.vote_ends_at >  now()
        and le.vote_ends_at <= now() + interval '2 hours'
        and exists (select 1 from public.event_slots s where s.event_id = le.id)
      union all
      select le.id, le.created_by, 'event_nudge_tomorrow', le.title, le.league_id
      from public.league_events le
      join public.event_slots es on es.id = le.confirmed_slot_id
      cross join lateral (select public._pickleague_tz_for(le.created_by) as tz) z
      where le.status = 'scheduled'
        and le.created_by is not null
        and es.starts_at >  now()
        and es.starts_at <= now() + interval '48 hours'
        and (es.starts_at at time zone z.tz)::date = (now() at time zone z.tz)::date + 1
        and extract(hour from now() at time zone z.tz) between 9 and 20
      union all
      select le.id, le.created_by, 'event_nudge_today', le.title, le.league_id
      from public.league_events le
      join public.event_slots es on es.id = le.confirmed_slot_id
      cross join lateral (select public._pickleague_tz_for(le.created_by) as tz) z
      where le.status = 'scheduled'
        and le.created_by is not null
        and es.starts_at >  now()
        and es.starts_at <= now() + interval '24 hours'
        and (es.starts_at at time zone z.tz)::date = (now() at time zone z.tz)::date
        and extract(hour from now() at time zone z.tz) between 7 and 21
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, event_id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select f.kind, f.user_id, f.entity_id as event_id, d.title, d.league_id
    from fresh f
    join due d on d.event_id = f.entity_id and d.kind = f.kind
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      case r.kind
        when 'event_nudge_vote'     then '📣 Voting closes soon: ' || r.title
        when 'event_nudge_tomorrow' then '📣 ' || r.title || ' is tomorrow'
        else                             '📣 ' || r.title || ' is today'
      end,
      case r.kind
        when 'event_nudge_vote'     then 'Tap to text your group a reminder to lock in their times.'
        when 'event_nudge_tomorrow' then 'Tap to text your group the confirmed time.'
        else                             'Tap to text your group that it is happening today.'
      end,
      'league', r.event_id, 'event', 'notifyEventReminders',
      -- The body says "Tap to text your group": the 1.0.4 app reads the kind and
      -- opens the composer (EventDetail with the nudge open). The link stays
      -- event/<id>, so a 1.0.3 phone still opens the event.
      jsonb_build_object('kind', r.kind, 'league_id', r.league_id)
    );
  end loop;
exception when others then null;
end $function$;
revoke execute on function public.remind_event_organizer_nudges() from public, anon, authenticated;


-- ── 3. New drill request: the times in the invitee's zone ──────────────────
create or replace function public.notify_on_drill_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sender_name text;
  v_n           integer;
  v_list        text;
  v_first       text;
  v_body        text;
  v_msg         text := nullif(trim(coalesce(new.message, '')), '');
  -- A slot is a wall-clock half hour in the requester's zone; the body goes
  -- to the invitee, so it prints the same instant in theirs.
  v_from_tz     text := public._pickleague_tz_for(new.from_user_id);
  v_to_tz       text := public._pickleague_tz_for(new.to_user_id);
begin
  select full_name into v_sender_name from public.profiles where id = new.from_user_id;

  -- Numbered by time: the same order as the buttons (send-push) and as
  -- accept_drill_slot's index. At most 5 are listed: nothing caps how many
  -- times a request proposes, and Expo drops a whole push over 4 KB.
  select count(*),
         string_agg(s.n::text || ') ' || s.label, E'\n' order by s.n) filter (where s.n <= 5),
         min(s.label) filter (where s.n = 1)
    into v_n, v_list, v_first
    from (
      select row_number() over (order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord) as n,
             public._pickleague_local_label(
               public._drill_slot_starts_at((e.value ->> 'date')::date, (e.value ->> 'slot')::int, v_from_tz),
               v_to_tz) as label
        from jsonb_array_elements(coalesce(new.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
       where jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
    ) s;

  v_body := case
    when coalesce(v_n, 0) = 0 then 'Open Pickleague to see the proposed times.'
    when v_n = 1 then v_first
    when v_n <= 3 then 'Which time works?' || E'\n' || v_list
    else 'Pick a time in the app:' || E'\n' || v_list
         || case when v_n > 5 then E'\n' || '+' || (v_n - 5)::text || ' more, pick in the app' else '' end
  end;
  if v_msg is not null then
    v_body := v_body || E'\n' || '"' || left(v_msg, 80) || '"';
  end if;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    new.to_user_id,
    '🥒 ' || coalesce(v_sender_name, 'Someone') || ' wants to drill',
    v_body,
    'drill',
    new.id,
    'drill',
    false,
    jsonb_build_object('kind', 'drill_request')
  );
  return new;
end;
$function$;
revoke execute on function public.notify_on_drill_request() from public, anon, authenticated;


-- ── 4. Badge context dates: the winner's local day ─────────────────────────
-- v_played is set per winner (two winners of a doubles match can be in
-- different zones). It stays a date, so the context still prints
-- 'YYYY-MM-DD'.
create or replace function public._award_match_badges()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_pg_id    uuid;
  v_cn_id    uuid;
  v_played   date;
  v_winners  uuid[];
  v_uid      uuid;
  v_count    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_pg_id from public.badges where name = 'Perfect Game';
  select id into v_cn_id from public.badges where name = 'Century';

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_pg_id is not null and v_winners is not null then
    if (new.winner_team = 'team1' and new.player1_score = 11 and new.player2_score = 0)
       or (new.winner_team = 'team2' and new.player2_score = 11 and new.player1_score = 0) then
      foreach v_uid in array v_winners loop
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_pg_id, null, format('11-0 shutout on %s', v_played));
      end loop;
    end if;
  end if;

  if v_cn_id is not null then
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(*) into v_count
        from public.matches m
       where m.player1_id  = v_uid or m.partner1_id = v_uid
          or m.player2_id  = v_uid or m.partner2_id = v_uid;
      if v_count > 0 and v_count % 100 = 0 then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_cn_id, null, format('Hit %s career matches', v_count));
      end if;
    end loop;
  end if;

  return new;
end;
$function$;
revoke execute on function public._award_match_badges() from public, anon, authenticated;

create or replace function public._award_marathon_badge()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_winning int;
  v_losing  int;
  v_played  date;
  v_winners uuid[];
  v_uid     uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.winner_team is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winning := new.player1_score;
    v_losing  := new.player2_score;
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winning := new.player2_score;
    v_losing  := new.player1_score;
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  else
    return new;
  end if;

  if v_winning is null or v_winning < 12 then return new; end if;

  begin
    foreach v_uid in array v_winners loop
      v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
      perform public.award_profile_badge(
        v_uid, 'Marathon',
        format('%s-%s on %s', v_winning, coalesce(v_losing, 0), v_played)
      );
    end loop;
  exception when others then null;
  end;

  return new;
end;
$function$;
revoke execute on function public._award_marathon_badge() from public, anon, authenticated;

create or replace function public._award_triple_crown_badge()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_tc_id    uuid;
  v_played   date;
  v_tz       text;
  v_winners  uuid[];
  v_uid      uuid;
  v_ctx      text;
  v_has_s    boolean;
  v_has_g    boolean;
  v_has_m    boolean;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_tc_id from public.badges where name = 'Triple Crown';
  if v_tc_id is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_winners is null then return new; end if;

  foreach v_uid in array v_winners loop
    begin
      -- "Same day" is the winner's local calendar day.
      v_tz     := public._pickleague_tz_for(v_uid);
      v_played := (coalesce(new.played_at, now()) at time zone v_tz)::date;
      v_ctx := format('Triple Crown on %s', v_played);

      if exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_tc_id and context = v_ctx
      ) then continue; end if;

      select
        bool_or(m.match_type = 'singles'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'gendered'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'mixed')
        into v_has_s, v_has_g, v_has_m
        from public.matches m
       where (coalesce(m.played_at, now()) at time zone v_tz)::date = v_played
         and (
           (m.winner_team = 'team1' and (m.player1_id  = v_uid or m.partner1_id = v_uid))
           or
           (m.winner_team = 'team2' and (m.player2_id  = v_uid or m.partner2_id = v_uid))
         );

      if coalesce(v_has_s, false) and coalesce(v_has_g, false) and coalesce(v_has_m, false) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_tc_id, null, v_ctx);
      end if;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$function$;
revoke execute on function public._award_triple_crown_badge() from public, anon, authenticated;

create or replace function public._award_cinderella_badge()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 200 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        perform public.award_profile_badge(
          v_uid, 'Cinderella',
          format('Beat a +%s favorite on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;
revoke execute on function public._award_cinderella_badge() from public, anon, authenticated;

create or replace function public._award_underdog_badge()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 100 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        v_played := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
        perform public.award_profile_badge(
          v_uid, 'Underdog',
          format('Beat a +%s opponent on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;
revoke execute on function public._award_underdog_badge() from public, anon, authenticated;


-- ── 5. Progress-badge sweep in the daytime ─────────────────────────────────
-- 17:00 UTC = 10 AM PDT / 9 AM PST (was 08:00 UTC = 1 AM PDT). Every badge
-- it grants pushes "+N pickles". Re-running sets the same schedule.
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'pickleague-award-progress-badges';
  if v_jobid is not null then
    perform cron.alter_job(v_jobid, schedule := '0 17 * * *');
  end if;
end $$;


-- ── 6a. og_card_tz: the zone a link preview prints its time in ──────────────
-- The creator's zone for an event or tournament ('event' | 'tournament': the
-- cards in mobile/api/_lib/cards.tsx that print a time); anything else, or no
-- stored zone, gets the default. Anon: the Vercel card renderer calls it
-- with the anon key. It returns only an IANA zone name, for an entity whose
-- link the reader already has (events and tournaments are world-readable).
create or replace function public.og_card_tz(p_type text, p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case p_type
      when 'event'      then (select public._pickleague_tz_for(e.created_by)
                                from public.league_events e
                               where e.id = p_id and e.created_by is not null)
      when 'tournament' then (select public._pickleague_tz_for(t.created_by)
                                from public.tournaments t
                               where t.id = p_id and t.created_by is not null)
    end,
    public._pickleague_default_tz()
  );
$$;
revoke execute on function public.og_card_tz(text, uuid) from public;
grant execute on function public.og_card_tz(text, uuid) to anon, authenticated;


-- ── 6b. drill_request_slot_starts: each proposed time's real instant ────────
-- A proposed slot is a wall-clock half hour in the REQUESTER's zone, so the
-- invitee's device can't turn {date, slot} into a time on its own. One row
-- per proposed slot of each request the caller is a party to (and can see:
-- same rule as the drill_requests select policy). idx is 0-based in time
-- order (date, then slot, then position): exactly accept_drill_slot's
-- p_slot_index, and the push body's "N)" is idx + 1.
create or replace function public.drill_request_slot_starts(p_request_ids uuid[])
returns table (request_id uuid, idx integer, slot_date date, slot integer, starts_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id,
         (row_number() over (partition by r.id
                             order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord) - 1)::integer,
         (e.value ->> 'date')::date,
         (e.value ->> 'slot')::int,
         public._drill_slot_starts_at((e.value ->> 'date')::date, (e.value ->> 'slot')::int,
                                      public._pickleague_tz_for(r.from_user_id))
    from public.drill_requests r
   cross join lateral jsonb_array_elements(coalesce(r.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
   where r.id = any(p_request_ids)
     and (select auth.uid()) in (r.from_user_id, r.to_user_id)
     and not public.blocked_between(r.from_user_id, r.to_user_id)
     and jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
   order by 1, 2;
$$;
revoke execute on function public.drill_request_slot_starts(uuid[]) from public, anon;
grant execute on function public.drill_request_slot_starts(uuid[]) to authenticated;

-- ============================================================
-- More badges + stackable badge instances
--
-- Three things in one migration:
--   1. Drops the unique indexes on player_badges so the same badge
--      can be earned multiple times (e.g. ten 1st-place finishes
--      => ten rows; the UI groups them into "Badge ×10").
--   2. Seeds new badge types — Tournament gold/silver/bronze,
--      Perfect Game, and Century.
--   3. Wires triggers to award the new badges automatically AND
--      back-fills them from existing data.
--
-- Run AFTER:
--   migration_add_badges.sql
--   migration_add_season_badges.sql
--   migration_tournament_auto_close_payout.sql
--   migration_payout_notifications_split.sql
-- ============================================================


-- 1. Allow stacking -------------------------------------------------------
--    The two unique indexes used to enforce "one of each badge per
--    (user, league)". With stacking enabled they become regular indexes
--    so per-user/per-badge lookups still hit an index.
drop index if exists public.idx_pb_profile;
drop index if exists public.idx_pb_league;

create index if not exists idx_pb_user_badge        on public.player_badges(user_id, badge_id);
create index if not exists idx_pb_user_badge_league on public.player_badges(user_id, badge_id, league_id);


-- 2. New badge definitions ------------------------------------------------
insert into public.badges (name, description, icon, category, criteria, sort_order) values
  -- Tournament podium (awarded by auto_payout_mlp_tournament)
  ('Tournament Champion', 'Finished 1st in a tournament. Stacks — every gold-medal finish earns another.', '🥇', 'profile', '{"type":"tournament_place","place":1}', 30),
  ('Tournament Silver',   'Finished 2nd in a tournament. Stacks per finish.',                              '🥈', 'profile', '{"type":"tournament_place","place":2}', 31),
  ('Tournament Bronze',   'Finished 3rd in a tournament. Stacks per finish.',                              '🥉', 'profile', '{"type":"tournament_place","place":3}', 32),
  -- Match-driven (stackable)
  ('Perfect Game',        'Won a match 11-0. Stacks — one per shutout.',                                   '🎯', 'profile', '{"type":"shutout_win"}',               34),
  ('Century',             'Crossed another 100-match milestone (100, 200, 300, ...). Stacks per century.', '💯', 'profile', '{"type":"match_century"}',             35)
on conflict (name) do nothing;


-- 3. Helper: award a profile (non-league) badge ---------------------------
--    No conflict suppression — we want stacking.
create or replace function public.award_profile_badge(
  p_user_id    uuid,
  p_badge_name text,
  p_context    text default null
) returns void language plpgsql security definer as $$
declare
  v_badge_id uuid;
begin
  select id into v_badge_id from public.badges where name = p_badge_name;
  if v_badge_id is null then return; end if;

  insert into public.player_badges (user_id, badge_id, league_id, context)
  values (p_user_id, v_badge_id, null, p_context);
end;
$$;
grant execute on function public.award_profile_badge(uuid, text, text) to authenticated;


-- 4. Wire tournament podium into the auto-payout RPC ----------------------
--    Replaces the previous body wholesale. Same Pickle + PLUPR behavior,
--    plus a player_badges row per podium finisher. Idempotent via the
--    existing tournament_champion_badges + champion_payout_applied_at
--    guards.
create or replace function public.auto_payout_mlp_tournament(p_tournament_id uuid)
returns table (success boolean, total_distributed integer, recipients integer, message text)
language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_already         timestamptz;
  v_status          text;
  v_tournament_name text;
  v_total           integer := 0;
  v_recipients      integer := 0;
  v_row             record;
  v_uid_inner       uuid;
  v_place_label     text;
  v_emoji           text;
  v_summary_body    text;
  v_context         text;
  v_podium_badge    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may pay out prizes';
  end if;

  select status, champion_payout_applied_at, name
    into v_status, v_already, v_tournament_name
    from public.tournaments where id = p_tournament_id;
  if v_status <> 'completed' then
    return query select false, 0, 0, 'Tournament not yet completed.'::text; return;
  end if;
  if v_already is not null then
    return query select false, 0, 0, 'Payout already applied for this tournament.'::text; return;
  end if;

  for v_row in select * from public.preview_mlp_tournament_payout(p_tournament_id) loop
    if v_row.uids is null or array_length(v_row.uids, 1) = 0 then continue; end if;

    v_emoji := case v_row.place when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else '🏅' end;
    v_place_label := case v_row.place
                       when 1 then '1st'
                       when 2 then '2nd'
                       when 3 then '3rd'
                       else v_row.place::text || 'th'
                     end;
    v_context := format('finishing %s with %s in %s', v_place_label, v_row.team_name, v_tournament_name);

    v_podium_badge := case v_row.place
                        when 1 then 'Tournament Champion'
                        when 2 then 'Tournament Silver'
                        when 3 then 'Tournament Bronze'
                        else null end;

    foreach v_uid_inner in array v_row.uids loop
      -- Pickle payout
      if v_row.share_per_user > 0 then
        update public.profiles set pickles = pickles + v_row.share_per_user where id = v_uid_inner;
        insert into public.pickle_pot_payouts
          (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
        values ('tournament', p_tournament_id, v_uid_inner, v_row.share_per_user,
                format('Tournament #%s · %s', v_row.place, v_row.team_name), v_uid, true);
        v_total := v_total + v_row.share_per_user;
      end if;

      -- Legacy champion-badge ledger (unchanged)
      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner, v_row.team_id, v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      -- New: stackable player_badges row for the podium finish.
      if v_podium_badge is not null then
        perform public.award_profile_badge(
          v_uid_inner,
          v_podium_badge,
          format('%s — %s', v_tournament_name, v_row.team_name)
        );
      end if;

      -- PLUPR bonus
      if v_row.plupr_bonus > 0 then
        insert into public.tournament_plupr_bonuses
          (tournament_id, user_id, bonus_value, place)
        values (p_tournament_id, v_uid_inner, v_row.plupr_bonus, v_row.place)
        on conflict (tournament_id, user_id) do nothing;

        update public.profiles
           set rating = coalesce(rating, 0) + v_row.plupr_bonus
         where id = v_uid_inner;
      end if;

      -- Notifications (unchanged from migration_payout_notifications_split.sql)
      v_summary_body := format('You finished %s with %s in %s.',
                               v_place_label, v_row.team_name, v_tournament_name);
      if v_row.share_per_user > 0 then
        v_summary_body := v_summary_body || format(E'\n• 🥒 %s pickles', v_row.share_per_user);
      end if;
      v_summary_body := v_summary_body || E'\n• 🏅 Champion badge added to your profile';
      if v_row.plupr_bonus > 0 then
        v_summary_body := v_summary_body || format(E'\n• +%s PLUPR rating bonus', v_row.plupr_bonus);
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('%s Prize: %s place!', v_emoji, v_place_label),
        v_summary_body,
        p_tournament_id,
        'tournament'
      );

      if v_row.share_per_user > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('🥒 +%s pickles!', v_row.share_per_user),
          format('You received %s 🥒 for %s. Tap to see your shop balance.',
                 v_row.share_per_user, v_context),
          p_tournament_id,
          'shop'
        );
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('🏅 %s Place Badge', v_place_label),
        format('A %s champion badge was added to your profile for %s. Tap to view it.',
               v_place_label, v_context),
        v_uid_inner,
        'profile'
      );

      if v_row.plupr_bonus > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('📈 +%s PLUPR bonus', v_row.plupr_bonus),
          format('A one-time PLUPR boost of +%s was applied for %s. Tap to see your PLUPR history.',
                 v_row.plupr_bonus, v_context),
          v_uid_inner,
          'plupr_history'
        );
      end if;

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players, awarded badges + PLUPR bonus, sent notifications.',
           v_total, v_recipients);
end;
$$;
grant execute on function public.auto_payout_mlp_tournament(uuid) to authenticated;


-- 5. Trigger: Perfect Game + Century on match completion ------------------
create or replace function public._award_match_badges()
returns trigger language plpgsql security definer as $$
declare
  v_pg_id    uuid;
  v_cn_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_count    integer;
begin
  select id into v_pg_id from public.badges where name = 'Perfect Game';
  select id into v_cn_id from public.badges where name = 'Century';

  -- Resolve the winning team's player IDs.
  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  -- Perfect Game — winning team scored 11, losing team scored 0
  if v_pg_id is not null and v_winners is not null then
    if (new.winner_team = 'team1' and new.player1_score = 11 and new.player2_score = 0)
       or (new.winner_team = 'team2' and new.player2_score = 11 and new.player1_score = 0) then
      foreach v_uid in array v_winners loop
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_pg_id, null, format('11-0 shutout on %s', v_played));
      end loop;
    end if;
  end if;

  -- Century — every player who hits a 100-multiple match count on this match.
  -- Counted across all four slots so doubles partners both qualify.
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
$$;

drop trigger if exists trg_award_match_badges on public.matches;
create trigger trg_award_match_badges
  after insert on public.matches
  for each row execute procedure public._award_match_badges();


-- 6. Backfill -------------------------------------------------------------

-- 6a. Tournament podium — convert prior tournament_champion_badges rows.
insert into public.player_badges (user_id, badge_id, league_id, context, earned_at)
select
  tcb.user_id,
  (select id from public.badges where name = case tcb.place
     when 1 then 'Tournament Champion'
     when 2 then 'Tournament Silver'
     when 3 then 'Tournament Bronze'
   end),
  null,
  format('%s — %s', t.name, coalesce(tcb.team_name, 'Champion')),
  coalesce(tcb.awarded_at, now())
  from public.tournament_champion_badges tcb
  join public.tournaments                t   on t.id = tcb.tournament_id
 where tcb.place between 1 and 3;

-- 6b. Perfect Game — every historical 11-0 win.
insert into public.player_badges (user_id, badge_id, league_id, context, earned_at)
select
  uid,
  (select id from public.badges where name = 'Perfect Game'),
  null,
  format('11-0 shutout on %s', m.played_at::date),
  m.played_at
  from public.matches m
  cross join lateral (
    select unnest(case
      when m.winner_team = 'team1' and m.player1_score = 11 and m.player2_score = 0
        then array_remove(array[m.player1_id, m.partner1_id], null)
      when m.winner_team = 'team2' and m.player2_score = 11 and m.player1_score = 0
        then array_remove(array[m.player2_id, m.partner2_id], null)
      else array[]::uuid[]
    end) as uid
  ) winners
 where uid is not null;

-- 6c. Century — one badge per 100-match milestone every player has crossed.
with player_match_counts as (
  select uid as user_id, count(*) as n
    from public.matches m
    cross join lateral (
      select unnest(array_remove(
        array[m.player1_id, m.partner1_id, m.player2_id, m.partner2_id], null
      )) as uid
    ) p
   group by uid
),
milestones as (
  select pmc.user_id, gs.century * 100 as count_at
    from player_match_counts pmc
    cross join lateral generate_series(1, pmc.n / 100) as gs(century)
   where pmc.n >= 100
)
insert into public.player_badges (user_id, badge_id, league_id, context)
select
  m.user_id,
  (select id from public.badges where name = 'Century'),
  null,
  format('Hit %s career matches', m.count_at)
  from milestones m
 where exists (select 1 from public.badges where name = 'Century');


-- 7. Reload PostgREST schema cache so the new RPC name is callable.
notify pgrst, 'reload schema';

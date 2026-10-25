-- ============================================================================
-- Signed-out (anon) audit fixes, 2026-10.
--
-- A read-only audit of the live database as a signed-out visitor found:
--
--   1. CRITICAL  profiles.phone was readable by everyone, signed out included
--                ("Public profiles are viewable by everyone" is using (true)
--                and anon holds SELECT on profiles). The phone moves to
--                public.profile_private, readable and editable by its owner
--                only, and the column is dropped from profiles. Writers:
--                redeem_guest_invite and complete_guest_upgrade (guest
--                invite -> real account). _purge_account (account deletion)
--                now deletes the private row.
--   2. HIGH      generate_playoff_bracket(uuid) is SECURITY DEFINER with no
--                caller check, and anon could execute it. It now needs a
--                signed-in tournament admin (creator, league admin/co-admin,
--                or an approved admin/co-admin registration), godmode or the
--                service role; anon loses EXECUTE.
--   3. HIGH      invite_codes: every tournament code (token included) was
--                listable by anyone ("Closed league privacy: tournament codes"
--                using scope_type = 'tournament', the successor of "Invite
--                codes lookup"). Both go. Scope admins keep "Scope admins
--                manage codes"; a tournament's approved admin/co-admin
--                registrants (who the app shows "Invite via code" to) get a
--                read policy of their own. Redemption is unchanged: the
--                redeem_invite_code RPC (SECURITY DEFINER) reads the code.
--   4. MEDIUM    get_wagers_on_player returned bettors' names to anyone,
--                closed leagues included. Signed in only now, and only for
--                leagues the caller can see (public._pl_can_see_league, from
--                migration_closed_league_privacy.sql; a league-less
--                tournament stays visible; your own wagers always are). The
--                three wager-total RPCs are signed in only too.
--
-- Re-runnable: every step checks or replaces. Needs
-- migration_closed_league_privacy.sql applied first (_pl_can_see_league).
-- The functions it replaces were last defined by:
--   complete_guest_upgrade, redeem_guest_invite  migration_guest_upgrade.sql
--   generate_playoff_bracket, get_wagers_on_player  migration_prod_reconcile_2026q3.sql
--   _purge_account                                migration_court_routines.sql
-- (supabase/tests/check-replaced-functions.mjs checks live against those.)
--
-- RE-RUN HAZARD: re-running migration_guest_upgrade.sql would add
-- profiles.phone back and point the guest RPCs at it; re-running
-- migration_closed_league_privacy.sql would re-create the open tournament
-- codes policy; re-running migration_presence_p1_hygiene.sql,
-- migration_court_arrival_queue.sql or migration_court_routines.sql would
-- put back an _purge_account that sets the dropped profiles.phone (account
-- deletion would then fail). Re-run this file after any of them.
-- ============================================================================


-- ── 1. profile_private: the owner-only half of a profile ───────────────────
create table if not exists public.profile_private (
  id         uuid primary key references public.profiles (id) on delete cascade,
  phone      text,
  updated_at timestamptz not null default now()
);

comment on table public.profile_private is
  'Contact details of a profile, readable and editable by its owner only (never by other players or signed-out visitors). Written by redeem_guest_invite / complete_guest_upgrade; deleted by _purge_account.';

alter table public.profile_private enable row level security;

-- Supabase's default privileges hand anon and authenticated everything on a
-- new public table: take it all back, then give the owner's two verbs.
revoke all on table public.profile_private from public, anon, authenticated;
grant select on table public.profile_private to authenticated;
grant update (phone) on table public.profile_private to authenticated;
grant all on table public.profile_private to service_role;

drop policy if exists "Profile private: owner reads" on public.profile_private;
create policy "Profile private: owner reads" on public.profile_private
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "Profile private: owner updates" on public.profile_private;
create policy "Profile private: owner updates" on public.profile_private
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));


-- ── 2. The guest RPCs write the phone there ────────────────────────────────
create or replace function public.redeem_guest_invite(p_token text, p_name text)
returns table (
  league_id   uuid,
  league_name text,
  event_id    uuid,
  event_title text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_inv   public.guest_invites;
  v_name  text;
  v_phone text;
  i       int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    raise exception 'Only a guest session can redeem a guest invite';
  end if;

  select * into v_inv
  from public.guest_invites
  where upper(token) = upper(p_token)
  limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    raise exception 'This guest invite is no longer valid';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');

  -- Best-effort: match the chosen name to a roster phone (exact, case-insensitive).
  v_phone := null;
  if v_name is not null then
    for i in 1 .. coalesce(array_length(v_inv.invited_names, 1), 0) loop
      if lower(trim(v_inv.invited_names[i])) = lower(v_name)
         and i <= coalesce(array_length(v_inv.invited_phones, 1), 0) then
        v_phone := nullif(trim(v_inv.invited_phones[i]), '');
        exit;
      end if;
    end loop;
  end if;

  update public.profiles
  set full_name        = coalesce(v_name, full_name),
      is_guest         = true,
      guest_expires_at = v_inv.expires_at
  where id = auth.uid();

  -- The phone is the owner's alone (migration_anon_audit_fixes.sql).
  if v_phone is not null then
    insert into public.profile_private (id, phone, updated_at)
    values (auth.uid(), v_phone, now())
    on conflict (id) do update set phone = excluded.phone, updated_at = excluded.updated_at;
  end if;

  insert into public.league_members (league_id, user_id, role, expires_at)
  values (v_inv.league_id, auth.uid(), 'member', v_inv.expires_at)
  on conflict (league_id, user_id) do nothing;

  return query
    select l.id, l.name, e.id, e.title
    from public.leagues l
    join public.league_events e on e.id = v_inv.event_id
    where l.id = v_inv.league_id;
end;
$$;

revoke execute on function public.redeem_guest_invite(text, text) from public, anon;
grant execute on function public.redeem_guest_invite(text, text) to authenticated, service_role;

create or replace function public.complete_guest_upgrade(
  p_full_name text,
  p_gender    text,
  p_phone     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_guest  boolean;
  v_full      text;
  v_base      text;
  v_candidate text;
  v_n         int := 1;
  v_gender    text;
  v_phone     text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select is_guest into v_is_guest from public.profiles where id = auth.uid();
  if not coalesce(v_is_guest, false) then
    return;  -- only guests upgrade
  end if;

  v_full := nullif(trim(coalesce(p_full_name, '')), '');

  -- Username from the name (mirrors handle_new_user), deduped against OTHERS.
  v_base := lower(regexp_replace(coalesce(v_full, ''), '[^a-z0-9]', '', 'g'));
  if length(coalesce(v_base, '')) = 0 then
    v_base := 'player';
  end if;
  v_candidate := v_base;
  while exists (select 1 from public.profiles where username = v_candidate and id <> auth.uid()) loop
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  end loop;

  v_gender := coalesce(p_gender, 'prefer-not-to-say');
  if v_gender not in ('male','female','other','prefer-not-to-say') then
    v_gender := 'prefer-not-to-say';
  end if;

  update public.profiles
  set full_name        = coalesce(v_full, full_name),
      username         = v_candidate,
      gender           = v_gender,
      is_guest         = false,
      guest_expires_at = null
  where id = auth.uid();

  -- The phone is the owner's alone (migration_anon_audit_fixes.sql). A blank
  -- one keeps whatever the invite captured.
  v_phone := nullif(trim(coalesce(p_phone, '')), '');
  if v_phone is not null then
    insert into public.profile_private (id, phone, updated_at)
    values (auth.uid(), v_phone, now())
    on conflict (id) do update set phone = excluded.phone, updated_at = excluded.updated_at;
  end if;

  -- Temporary memberships become permanent now that they're a real member.
  update public.league_members
  set expires_at = null
  where user_id = auth.uid();
end;
$$;

revoke execute on function public.complete_guest_upgrade(text, text, text) from public, anon;
grant execute on function public.complete_guest_upgrade(text, text, text) to authenticated, service_role;


-- ── 3. Account deletion removes the private row ────────────────────────────
-- The profile survives as a tombstone (migration_delete_account_tombstone.sql),
-- so its cascade never fires: delete profile_private explicitly.
create or replace function public._purge_account(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_uid is null then
    raise exception 'No account given';
  end if;

  -- Waiting arrivals first: one the court arrival job has already taken
  -- (deleted, not yet committed) makes this wait for the job's commit, so the
  -- check-in it lands is there for the venue_checkins delete below, and its
  -- push for the push_outbox one (each statement sees what committed before
  -- it). Deleted last, that check-in would outlive the account.
  delete from public.pl_pending_arrivals           where user_id      = p_uid;

  delete from public.push_tokens                   where user_id      = p_uid;
  delete from public.notifications                 where user_id      = p_uid;
  delete from public.drill_request_messages        where sender_id    = p_uid;
  delete from public.drill_requests                where from_user_id = p_uid or to_user_id = p_uid;
  delete from public.drill_session_reviews         where user_id      = p_uid;
  delete from public.doubles_pair_join_requests    where user_id      = p_uid;
  delete from public.league_join_requests          where user_id      = p_uid;
  delete from public.mlp_team_join_requests        where user_id      = p_uid;
  delete from public.tournament_partner_requests   where requester_id = p_uid or requested_id = p_uid;
  delete from public.profile_claims                where profile_id   = p_uid;
  delete from public.venue_submission_affirmations where profile_id   = p_uid;
  delete from public.event_slot_votes              where user_id      = p_uid;
  delete from public.player_paddles                where user_id      = p_uid;
  delete from public.match_paddle_usage            where user_id      = p_uid;
  delete from public.player_shop_purchases         where user_id      = p_uid;
  delete from public.redemption_orders             where user_id      = p_uid;
  delete from public.ftue_grants                   where user_id      = p_uid;
  delete from public.league_members                where user_id      = p_uid;
  delete from public.user_blocks where blocker_id = p_uid or blocked_id = p_uid;

  -- Contact details (migration_anon_audit_fixes.sql): the phone left profiles.
  delete from public.profile_private               where id           = p_uid;

  -- Routine check-ins (migration_court_routines.sql): a weekly pattern is
  -- predictive location data.
  delete from public.court_plans          where user_id   = p_uid;
  delete from public.court_routines       where user_id   = p_uid;

  -- Presence and friends (migration_presence_p1_*.sql).
  delete from public.venue_checkins       where user_id   = p_uid;
  delete from public.play_sessions        where user_id   = p_uid;
  delete from public.presence_settings    where user_id   = p_uid;
  delete from public.presence_hidden_from where user_id   = p_uid or hidden_user_id = p_uid;
  delete from public.close_friends        where user_id   = p_uid or friend_id      = p_uid;
  delete from public.friendships          where requester_id = p_uid or addressee_id = p_uid;
  delete from public.friend_request_log   where sender_id = p_uid or addressee_id   = p_uid;
  delete from public.court_favorites      where user_id   = p_uid;
  delete from public.presence_closed_ids  where user_id   = p_uid;
  delete from public.notifications
   where entity_type = 'friend' and entity_id = p_uid
     and push_data ->> 'kind' in ('friend_request', 'friend_accepted');

  -- Court arrivals (migration_court_arrival_queue.sql; the waiting ones went
  -- first, above).
  delete from public.pl_throttle          where scope        = p_uid::text;
  delete from public.push_outbox          where recipient_id = p_uid;

  update public.profiles set
    full_name             = '[deleted account]',
    username              = 'deleted_' || left(replace(p_uid::text, '-', ''), 12),
    avatar_url            = null,
    avatar_emoji          = null,
    avatar_bg_color       = null,
    profile_frame         = null,
    name_color            = null,
    list_name_style_id    = null,
    profile_name_style_id = null,
    tagline               = null,
    dupr_id               = null,
    selected_tags         = '{}',
    availability          = '{}',
    drill_availability    = '{}'::jsonb,
    drill_shot_prefs      = '{}',
    drill_partner_prefs   = '{}',
    drill_custom_tags     = '{}',
    drilling_enabled      = false,
    badges_public         = false,
    pickles               = 0,
    is_unclaimed          = false,
    claim_source          = null,
    guest_expires_at      = null,
    deleted_at            = now()
  where id = p_uid;

  delete from auth.users where id = p_uid;
end;
$$;

revoke execute on function public._purge_account(uuid) from public, anon, authenticated;
grant execute on function public._purge_account(uuid) to service_role;


-- ── 4. Move the phones, then drop profiles.phone ───────────────────────────
-- Only when the column is still there (a re-run finds it gone). Live readers
-- of it were exactly the three functions replaced above; no view, trigger or
-- app code reads it (the app's select('*') reads keep working).
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone'
  ) then
    execute $sql$
      insert into public.profile_private (id, phone, updated_at)
      select p.id, nullif(btrim(p.phone), ''), now()
        from public.profiles p
       where nullif(btrim(p.phone), '') is not null
      on conflict (id) do update set phone = excluded.phone, updated_at = excluded.updated_at
    $sql$;
    execute 'alter table public.profiles drop column phone';
  end if;
end $$;


-- ── 5. generate_playoff_bracket: tournament admins only ────────────────────
create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_format         text;
  v_match_type     text;
  v_playoff        text;
  v_playoff_n      integer;
  v_uncompleted    integer;
  v_round_id       uuid;
  v_round_type     text;
  v_round_label    text;
  v_match_order    integer := 0;
  v_matches        integer := 0;
  v_i              integer;
  v_seeds          uuid[][];
  v_pool_count     integer;
  v_bracket_size   integer;
  v_per_pool_n     integer;
  v_pairings       integer[][];
  v_padded_size    integer;
begin
  -- Admins only (migration_anon_audit_fixes.sql): anyone, signed out
  -- included, could draw any tournament's playoff. The service role (sims,
  -- scripts) passes; nothing in the database calls this.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_uid is null then
      raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.',
                            hint = 'pl:auth.signed_out';
    end if;
    if not (
      public._is_tournament_admin(p_tournament_id, v_uid)
      or exists (
        select 1 from public.tournament_registrations r
         where r.tournament_id = p_tournament_id
           and r.user_id = v_uid
           and r.status = 'approved'
           and r.role in ('admin', 'co-admin')
      )
      or coalesce(public.is_godmode_user(), false)
    ) then
      raise exception 'Only tournament admins can generate the playoff';
    end if;
  end if;

  select format, match_type, coalesce(playoff_format, 'none')
    into v_format, v_match_type, v_playoff
    from public.tournaments where id = p_tournament_id;

  if v_format is null then raise exception 'Tournament % not found', p_tournament_id; end if;
  if v_playoff = 'none' then raise exception 'Tournament has no playoff configured (playoff_format=none)'; end if;
  if v_format not in ('round_robin', 'pool_play') then
    raise exception 'Playoff generation supported for round_robin / pool_play only, not %', v_format;
  end if;

  if v_playoff in ('top_1_per_pool', 'top_2_per_pool') and v_format <> 'pool_play' then
    raise exception 'Playoff format % requires format=pool_play, not %', v_playoff, v_format;
  end if;

  v_per_pool_n := case v_playoff
    when 'top_1_per_pool' then 1
    when 'top_2_per_pool' then 2
    else null
  end;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals','semifinals','finals','third_place_match')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type not in ('quarterfinals','semifinals','finals','third_place_match','consolation','losers')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % group-play matches still pending', v_uncompleted;
  end if;

  if v_per_pool_n is not null then
    select count(distinct upper(substring(tr.label from 'Pool ([A-Z])')))::int
      into v_pool_count
      from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id and tr.label ~ '^Pool [A-Z]';
    if v_pool_count is null or v_pool_count < 2 then
      raise exception 'top_N_per_pool requires at least 2 labelled pool rounds (found %)', coalesce(v_pool_count, 0);
    end if;

    v_bracket_size := v_pool_count * v_per_pool_n;
    if v_bracket_size not in (2, 4, 6, 8) then
      raise exception
        'top_%_per_pool with % pools yields % entrants — supported sizes are 2/4/6/8. Pick top_2/top_4/top_8 instead.',
        v_per_pool_n, v_pool_count, v_bracket_size;
    end if;

    with pool_matches as (
      select tm.*, upper(substring(tr.label from 'Pool ([A-Z])')) as pool_letter
        from public.tournament_matches tm
        join public.tournament_rounds tr on tr.id = tm.round_id
       where tm.tournament_id = p_tournament_id
         and tm.status = 'completed'
         and tr.label ~ '^Pool [A-Z]'
    ),
    raw as (
      select pool_letter,
             least(team1_player1, coalesce(team1_player2, team1_player1))    as lo,
             greatest(team1_player1, coalesce(team1_player2, team1_player1)) as hi,
             coalesce(team1_score, 0) as pf,
             coalesce(team2_score, 0) as pa,
             case when winner_team = 'team1' then 1 else 0 end as wins,
             case when winner_team = 'team2' then 1 else 0 end as losses
        from pool_matches
      union all
      select pool_letter,
             least(team2_player1, coalesce(team2_player2, team2_player1)),
             greatest(team2_player1, coalesce(team2_player2, team2_player1)),
             coalesce(team2_score, 0), coalesce(team1_score, 0),
             case when winner_team = 'team2' then 1 else 0 end,
             case when winner_team = 'team1' then 1 else 0 end
        from pool_matches
    ),
    agg as (
      select pool_letter, lo, hi,
             sum(wins)::int as wins, sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw group by pool_letter, lo, hi
    ),
    with_seed as (
      select a.pool_letter, a.lo, a.hi, a.wins, a.losses, a.point_diff,
             coalesce((
               select min(tr.seed) from public.tournament_registrations tr
                where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)
             ), 999) as seed
        from agg a
    ),
    pre as (
      select pool_letter, lo, hi, wins, losses, point_diff, seed,
             row_number() over (partition by pool_letter order by wins desc, point_diff desc, seed asc) as rn
        from with_seed
    ),
    wins_pairs as (
      select pool_letter, wins from with_seed group by pool_letter, wins having count(*) = 2
    ),
    pool_ranked_pairs as (
      select p.*, row_number() over (partition by p.pool_letter, p.wins order by p.rn) as rn_within
        from pre p
    ),
    ties_2 as (
      select w.pool_letter, w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
        from wins_pairs w
        join pool_ranked_pairs e1 on e1.pool_letter = w.pool_letter and e1.wins = w.wins and e1.rn_within = 1
        join pool_ranked_pairs e2 on e2.pool_letter = w.pool_letter and e2.wins = w.wins and e2.rn_within = 2
    ),
    h2h as (
      select t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
             coalesce(sum(case
               when (
                 (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                  and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                  and pm.winner_team = 'team1')
                 or
                 (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                  and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                  and pm.winner_team = 'team2')
               ) then 1 else 0 end)::int, 0) as h2h_wins_1,
             coalesce(sum(case
               when (
                 (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                  and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                  and pm.winner_team = 'team1')
                 or
                 (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                  and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                  and pm.winner_team = 'team2')
               ) then 1 else 0 end)::int, 0) as h2h_wins_2
        from ties_2 t left join pool_matches pm on pm.pool_letter = t.pool_letter
       group by t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2
    ),
    h2h_per_entrant as (
      select p.pool_letter, p.lo, p.hi, p.wins, p.point_diff, p.seed,
             coalesce(case
               when h.h2h_wins_1 = h.h2h_wins_2 then 0
               when (p.lo = h.lo1 and p.hi = h.hi1) then
                 case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
               when (p.lo = h.lo2 and p.hi = h.hi2) then
                 case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
               else 0 end, 0) as h2h_score
        from pre p
        left join h2h h on h.pool_letter = p.pool_letter and h.wins = p.wins
                       and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
    ),
    pool_ranked as (
      select pool_letter, lo, hi,
             row_number() over (partition by pool_letter order by wins desc, h2h_score desc, point_diff desc, seed asc) as pool_rank
        from h2h_per_entrant
    )
    select array_agg(array[lo, coalesce(hi, lo)] order by pool_rank, ascii(pool_letter))
      into v_seeds from pool_ranked where pool_rank <= v_per_pool_n;

    if v_seeds is null or array_length(v_seeds, 1) < v_bracket_size then
      raise exception
        'Not enough entrants in pool standings to seed top % per pool across % pools (need %, got %)',
        v_per_pool_n, v_pool_count, v_bracket_size, coalesce(array_length(v_seeds, 1), 0);
    end if;

    if v_bracket_size = 2 then
      v_pairings := array[ array[1, 2] ]; v_padded_size := 2;
    elsif v_bracket_size = 4 and v_pool_count = 2 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 4 and v_pool_count = 4 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 6 and v_pool_count = 3 then
      -- P=3, N=2: snake [A1, B1, C1, A2, B2, C2]. Apply doc §3 slot-5/slot-6
      -- swap to avoid C1 vs C2 round 1: pairs are 3v5 (C1 vs B2) and 4v6
      -- (A2 vs C2). Match orders: 0=A1-BYE, 1=B1-BYE, 2=C1 vs B2, 3=A2 vs C2.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 5], array[4, 6] ]; v_padded_size := 8;
    elsif v_bracket_size = 6 and v_pool_count = 6 then
      -- P=6, N=1: snake [A1..F1]. No same-pool conflicts.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 6], array[4, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 4 then
      v_pairings := array[ array[1, 8], array[4, 6], array[2, 7], array[3, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 2 then
      v_pairings := array[ array[1, 8], array[4, 5], array[2, 7], array[3, 6] ]; v_padded_size := 8;
    else
      raise exception 'Unsupported top_N_per_pool bracket shape (pools=%, N=%)', v_pool_count, v_per_pool_n;
    end if;

    v_round_label := case v_padded_size when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals' end;
    v_round_type  := case v_padded_size when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals' end;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1000, v_round_label, v_round_type)
      returning id into v_round_id;

    -- Two-pass insert to keep the trigger from prematurely advancing. See
    -- comments in the migration source.
    declare
      v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
      v_pass integer;
      v_is_bye boolean;
    begin
      for v_pass in 1..2 loop
        for v_i in 1..array_length(v_pairings, 1) loop
          v_is_bye := v_pairings[v_i][2] = 0;
          continue when (v_pass = 1 and v_is_bye) or (v_pass = 2 and not v_is_bye);

          v_a1 := v_seeds[v_pairings[v_i][1]][1];
          v_a2 := v_seeds[v_pairings[v_i][1]][2];

          if v_is_bye then
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status, winner_team
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              'bye',
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              null, null,
              'completed', 'team1'
            );
          else
            v_b1 := v_seeds[v_pairings[v_i][2]][1];
            v_b2 := v_seeds[v_pairings[v_i][2]][2];
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              v_b1,
              case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
              'pending'
            );
          end if;
          v_matches := v_matches + 1;
        end loop;
      end loop;
    end;

    return v_matches;
  end if;

  v_playoff_n := case v_playoff when 'top_2' then 2 when 'top_4' then 4 when 'top_8' then 8 else null end;
  if v_playoff_n is null then raise exception 'Unknown playoff_format %', v_playoff; end if;

  with raw as (
    select
      least(team1_player1, coalesce(team1_player2, team1_player1))             as lo,
      greatest(team1_player1, coalesce(team1_player2, team1_player1))          as hi,
      coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
      case when winner_team = 'team1' then 1 else 0 end as wins,
      case when winner_team = 'team2' then 1 else 0 end as losses
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
    union all
    select
      least(team2_player1, coalesce(team2_player2, team2_player1)),
      greatest(team2_player1, coalesce(team2_player2, team2_player1)),
      coalesce(team2_score, 0), coalesce(team1_score, 0),
      case when winner_team = 'team2' then 1 else 0 end,
      case when winner_team = 'team1' then 1 else 0 end
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
  ),
  agg as (
    select lo, hi, sum(wins)::int as wins, sum(losses)::int as losses,
           sum(pf)::int - sum(pa)::int as point_diff
      from raw group by lo, hi
  ),
  with_seed as (
    select a.lo, a.hi, a.wins, a.losses, a.point_diff,
           coalesce((select min(tr.seed) from public.tournament_registrations tr
                      where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)), 999) as seed
      from agg a
  ),
  pre as (
    select lo, hi, wins, losses, point_diff, seed,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
  ),
  wins_pairs as (select wins from with_seed group by wins having count(*) = 2),
  ranked_pairs as (
    select p.*, row_number() over (partition by p.wins order by p.rn) as rn_within from pre p
  ),
  ties_2 as (
    select w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
      from wins_pairs w
      join ranked_pairs e1 on e1.wins = w.wins and e1.rn_within = 1
      join ranked_pairs e2 on e2.wins = w.wins and e2.rn_within = 2
  ),
  h2h as (
    select t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
           coalesce(sum(case
             when (
               (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                and m.winner_team = 'team1')
               or
               (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                and m.winner_team = 'team2')
             ) then 1 else 0 end)::int, 0) as h2h_wins_1,
           coalesce(sum(case
             when (
               (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                and m.winner_team = 'team1')
               or
               (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                and m.winner_team = 'team2')
             ) then 1 else 0 end)::int, 0) as h2h_wins_2
      from ties_2 t left join public.tournament_matches m
        on m.tournament_id = p_tournament_id and m.status = 'completed'
     group by t.wins, t.lo1, t.hi1, t.lo2, t.hi2
  ),
  h2h_per_entrant as (
    select p.lo, p.hi, p.wins, p.point_diff, p.seed,
           coalesce(case
             when h.h2h_wins_1 = h.h2h_wins_2 then 0
             when (p.lo = h.lo1 and p.hi = h.hi1) then
               case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
             when (p.lo = h.lo2 and p.hi = h.hi2) then
               case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
             else 0 end, 0) as h2h_score
      from pre p
      left join h2h h on h.wins = p.wins
                     and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
  ),
  ranked as (
    select lo, hi,
           row_number() over (order by wins desc, h2h_score desc, point_diff desc, seed asc) as rn
      from h2h_per_entrant
  )
  select array_agg(array[lo, coalesce(hi, lo)] order by rn)
    into v_seeds from ranked where rn <= greatest(v_playoff_n, 4);

  if v_seeds is null or array_length(v_seeds, 1) < v_playoff_n then
    raise exception 'Not enough entrants in standings to seed Top % (got %)',
      v_playoff_n, coalesce(array_length(v_seeds, 1), 0);
  end if;

  v_round_label := case v_playoff_n
    when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals'
    else format('Playoff Round of %s', v_playoff_n) end;
  v_round_type := case v_playoff_n
    when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals'
    else 'winners' end;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (p_tournament_id, 1000, v_round_label, v_round_type)
    returning id into v_round_id;

  declare
    v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
  begin
    for v_i in 0..(v_playoff_n / 2 - 1) loop
      v_a1 := v_seeds[v_i + 1][1];
      v_a2 := v_seeds[v_i + 1][2];
      v_b1 := v_seeds[v_playoff_n - v_i][1];
      v_b2 := v_seeds[v_playoff_n - v_i][2];

      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2, team2_player1, team2_player2, status
      )
      values (
        p_tournament_id, v_round_id, v_match_order,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_match_order := v_match_order + 1;
      v_matches := v_matches + 1;
    end loop;

    if v_playoff_n = 2 and array_length(v_seeds, 1) >= 4 then
      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (p_tournament_id, 1100, 'Third Place Match', 'third_place_match')
        returning id into v_round_id;

      v_a1 := v_seeds[3][1]; v_a2 := v_seeds[3][2];
      v_b1 := v_seeds[4][1]; v_b2 := v_seeds[4][2];
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2, team2_player1, team2_player2, status
      )
      values (
        p_tournament_id, v_round_id, 0,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_matches := v_matches + 1;
    end if;
  end;

  return v_matches;
end;
$$;

revoke execute on function public.generate_playoff_bracket(uuid) from public, anon;
grant execute on function public.generate_playoff_bracket(uuid) to authenticated, service_role;


-- ── 6. invite_codes: no open lookup ────────────────────────────────────────
drop policy if exists "Invite codes lookup" on public.invite_codes;
drop policy if exists "Closed league privacy: tournament codes" on public.invite_codes;

-- The app shows "Invite via code" (InviteCodeManager) to a tournament's
-- approved admin and co-admin registrants; is_scope_admin (which "Scope admins
-- manage codes" uses) knows only the creator and league admins, so those
-- registrants read their tournament's codes through this. The subquery's
-- columns are all qualified (r.*, invite_codes.scope_id).
drop policy if exists "Tournament staff read codes" on public.invite_codes;
create policy "Tournament staff read codes" on public.invite_codes
  for select to authenticated
  using (
    invite_codes.scope_type = 'tournament'
    and exists (
      select 1 from public.tournament_registrations r
       where r.tournament_id = invite_codes.scope_id
         and r.user_id = (select auth.uid())
         and r.status = 'approved'
         and r.role in ('admin', 'co-admin')
    )
  );


-- ── 7. Wagers: signed in, and only leagues you can see ─────────────────────
create or replace function public.get_wagers_on_player(
  p_user_id    uuid,
  p_scope_type text default null,
  p_scope_id   uuid default null
)
returns table (
  wager_id uuid, bettor_id uuid, bettor_name text, stake integer, potential_payout integer, odds numeric,
  status text, rank integer, subject_type text, scope_name text, placed_at timestamptz,
  expected_end_at timestamptz, league_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.user_id,
    coalesce(p.full_name, 'Someone'),
    w.stake,
    w.potential_payout,
    w.odds,
    w.status,
    coalesce((w.predicate->>'rank')::int, 1),
    w.subject_type,
    case w.subject_type
      when 'tournament_rank' then (select t.name from public.tournaments t where t.id = w.subject_id)
      else (select coalesce(ls.name, l.name || ' season')
              from public.league_seasons ls
              join public.leagues l on l.id = ls.league_id
             where ls.id = w.subject_id)
    end,
    w.placed_at,
    case w.subject_type
      when 'tournament_rank' then (select case when t.start_time is null then null
                                          else t.start_time + (coalesce(t.expected_length_hours, 0) * interval '1 hour') end
        from public.tournaments t where t.id = w.subject_id)
      when 'season_rank' then (select ls.end_date::timestamptz
        from public.league_seasons ls where ls.id = w.subject_id)
      when 'period_rank' then (select (ls.start_date
          + (coalesce((w.predicate->>'period_number')::int, 0) * ls.lock_frequency_weeks) * interval '1 week')::timestamptz
        from public.league_seasons ls where ls.id = w.subject_id)
    end as expected_end_at,
    case w.subject_type
      when 'tournament_rank' then (select l.name from public.tournaments t
        left join public.leagues l on l.id = t.league_id where t.id = w.subject_id)
      else (select l.name from public.league_seasons ls
        join public.leagues l on l.id = ls.league_id where ls.id = w.subject_id)
    end as league_name
  from public.wagers w
  left join public.profiles p on p.id = w.user_id
  -- The league the wager is in: a tournament's (null when it has none), or a
  -- season's.
  cross join lateral (
    select case w.subject_type
             when 'tournament_rank' then (select t.league_id from public.tournaments t where t.id = w.subject_id)
             else (select ls.league_id from public.league_seasons ls where ls.id = w.subject_id)
           end as league_id
  ) sc
  where auth.uid() is not null
    and w.subject_type in ('tournament_rank','period_rank','season_rank')
    and w.predicate->>'user_id' = p_user_id::text
    and w.status <> 'cancelled'
    -- Closed league privacy: a league you can't see keeps its bettors to
    -- itself. A league-less tournament is open; your own wagers always show.
    and (
      w.user_id = auth.uid()
      or (w.subject_type = 'tournament_rank' and sc.league_id is null)
      or public._pl_can_see_league(sc.league_id)
    )
    and (
      p_scope_type is null
      or (p_scope_type = 'tournament'
          and w.subject_type = 'tournament_rank'
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'season'
          and w.subject_type in ('period_rank','season_rank')
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'league'
          and w.subject_type in ('period_rank','season_rank')
          and exists (select 1 from public.league_seasons ls
                       where ls.id = w.subject_id and ls.league_id = p_scope_id))
    )
  order by w.placed_at desc;
$$;

revoke execute on function public.get_wagers_on_player(uuid, text, uuid) from public, anon;
grant execute on function public.get_wagers_on_player(uuid, text, uuid) to authenticated, service_role;

-- Signed in only: every app caller is (the whole navigator is behind a session).
revoke execute on function public.get_league_wager_totals(uuid) from public, anon;
revoke execute on function public.get_season_wager_totals(uuid) from public, anon;
revoke execute on function public.get_tournament_wager_totals(uuid) from public, anon;
grant execute on function public.get_league_wager_totals(uuid) to authenticated, service_role;
grant execute on function public.get_season_wager_totals(uuid) to authenticated, service_role;
grant execute on function public.get_tournament_wager_totals(uuid) to authenticated, service_role;

-- PostgREST: profiles lost a column, profile_private is new.
notify pgrst, 'reload schema';

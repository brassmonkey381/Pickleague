-- ============================================================
-- MLP teams (teams of 4 — 2M + 2W)
--
-- Two tournament formats use this:
--   * format='mlp'         — Fixed Teams. Players self-organize. Anyone
--                            approved can create a team (becomes captain),
--                            invite or accept join requests, set member
--                            slots, and lock in.
--   * format='mlp_random'  — Random Teams. Admin clicks "Generate Random
--                            Teams" after registration closes; the RPC
--                            shuffles approved members into teams and
--                            assigns a wacky team name from the names
--                            seed table.
--
-- Each team-vs-team matchup produces 4 doubles sub-matches:
--   1. Men's:    A.M1+A.M2 vs B.M1+B.M2
--   2. Women's:  A.W1+A.W2 vs B.W1+B.W2
--   3. Mixed 1:  A.M1+A.W1 vs B.M1+B.W1
--   4. Mixed 2:  A.M2+A.W2 vs B.M2+B.W2
-- The existing classify_doubles_match trigger buckets these into
-- 'gendered' / 'mixed' automatically.
-- ============================================================

-- 1. Tournament format check needs to allow mlp_random ---------------------
do $$
declare
  con_name text;
begin
  select conname into con_name
    from pg_constraint
   where conrelid = 'public.tournaments'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) like '%format%mlp%';
  if con_name is not null then
    execute format('alter table public.tournaments drop constraint %I', con_name);
  end if;
end $$;
alter table public.tournaments
  add constraint tournaments_format_check
  check (format in ('round_robin','single_elimination','double_elimination','pool_play','mlp','mlp_random','rotating_partners'));

-- 2. mlp_teams ------------------------------------------------------------
create table if not exists public.mlp_teams (
  id            uuid default gen_random_uuid() primary key,
  tournament_id uuid references public.tournaments(id) on delete cascade not null,
  name          text not null,
  captain_id    uuid references public.profiles(id) on delete set null,
  male_1_id     uuid references public.profiles(id) on delete set null,
  male_2_id     uuid references public.profiles(id) on delete set null,
  female_1_id   uuid references public.profiles(id) on delete set null,
  female_2_id   uuid references public.profiles(id) on delete set null,
  status        text not null default 'forming' check (status in ('forming','locked')),
  seed          integer,
  is_random_generated boolean not null default false,
  created_at    timestamptz default now(),
  unique (tournament_id, name)
);

alter table public.mlp_teams enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mlp_teams' and policyname='Teams viewable by everyone') then
    create policy "Teams viewable by everyone" on public.mlp_teams for select using (true);
  end if;
end $$;

-- 3. join requests / invites (one table, direction marker) ----------------
create table if not exists public.mlp_team_join_requests (
  id          uuid default gen_random_uuid() primary key,
  team_id     uuid references public.mlp_teams(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  -- 'invite'  = captain invited the player; player accepts/declines
  -- 'request' = player asked to join; captain accepts/declines
  direction   text not null check (direction in ('invite','request')),
  status      text not null default 'pending' check (status in ('pending','accepted','declined','cancelled')),
  message     text,
  created_at  timestamptz default now(),
  responded_at timestamptz,
  unique (team_id, user_id, direction)
);

alter table public.mlp_team_join_requests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mlp_team_join_requests' and policyname='Requests viewable by everyone') then
    create policy "Requests viewable by everyone" on public.mlp_team_join_requests for select using (true);
  end if;
end $$;

-- 4. Wacky pickleball team names -----------------------------------------
create table if not exists public.mlp_team_name_pool (
  id    uuid default gen_random_uuid() primary key,
  name  text not null unique
);

insert into public.mlp_team_name_pool (name) values
  ('Dink Dynasty'), ('Kitchen Cabinet'), ('Banana Republic'), ('The Lobsters'),
  ('Smash Mouth'), ('Net Profits'), ('Court Jesters'), ('Pickle Wizards'),
  ('Volley Llamas'), ('Slice Squad'), ('The Spin Doctors'), ('Erne''s Heroes'),
  ('Third Shot Drops'), ('Paddle Pirates'), ('Brine Time'), ('The Crunchy Kings'),
  ('Side Out Sirens'), ('Jelly Lobs'), ('Shake & Bakers'), ('Reset Republic'),
  ('Nasty Nelsons'), ('The ATPs'), ('Wagon Wheels'), ('The Backspinners'),
  ('Saucy Servers'), ('Drillers Anonymous'), ('Pickle Paddlers'), ('Crosscourt Cowboys'),
  ('Topspin Tornadoes'), ('Banger Brigade'), ('The Pickleforks'), ('Drop Shot Royalty'),
  ('Briny Bandits'), ('No Mans Land Crew'), ('Rally Cats'), ('Spin Class'),
  ('The Underdinks'), ('Volley Ranchers'), ('Thunder Pickles'), ('The Smash Bros'),
  ('Kitchen Conspirators'), ('Lob Lords'), ('Drill Sergeants'), ('Sour Patch Kids'),
  ('The Net Worth')
on conflict (name) do nothing;

-- 5. Helper: am-I-an-admin-of-this-tournament ----------------------------
create or replace function public._is_tournament_admin(p_tournament_id uuid, p_uid uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.tournaments t
     where t.id = p_tournament_id
       and (
         t.created_by = p_uid
         or (t.league_id is not null and exists (
           select 1 from public.league_members
            where league_id = t.league_id and user_id = p_uid and role in ('admin','co-admin')
         ))
       )
  );
$$;

-- 6. create_mlp_team — caller becomes captain ----------------------------
create or replace function public.create_mlp_team(
  p_tournament_id uuid,
  p_name          text
) returns uuid language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_format  text;
  v_team_id uuid;
  v_existing_team uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'Team name required'; end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format is null then raise exception 'Tournament not found'; end if;
  if v_format <> 'mlp' then raise exception 'Only MLP Fixed Teams tournaments accept self-formed teams'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = p_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into this tournament before creating a team';
  end if;

  -- A user can only captain / be slotted on one team per tournament
  select id into v_existing_team from public.mlp_teams
   where tournament_id = p_tournament_id
     and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
   limit 1;
  if v_existing_team is not null then
    raise exception 'You''re already on a team in this tournament';
  end if;

  insert into public.mlp_teams (tournament_id, name, captain_id)
  values (p_tournament_id, trim(p_name), v_uid)
  returning id into v_team_id;

  return v_team_id;
end;
$$;

-- 7. mlp_invite — captain invites a player -------------------------------
create or replace function public.mlp_invite(
  p_team_id uuid,
  p_user_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_captain uuid;
  v_status  text;
  v_tournament_id uuid;
  v_req_id  uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select captain_id, status, tournament_id into v_captain, v_status, v_tournament_id
    from public.mlp_teams where id = p_team_id;
  if v_captain is null then raise exception 'Team not found'; end if;
  if v_uid <> v_captain then raise exception 'Only the captain can invite'; end if;
  if v_status <> 'forming' then raise exception 'Team is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_tournament_id and user_id = p_user_id and status = 'approved'
  ) then
    raise exception 'Invitee must be approved into the tournament first';
  end if;

  insert into public.mlp_team_join_requests (team_id, user_id, direction, message, status)
  values (p_team_id, p_user_id, 'invite', p_message, 'pending')
  on conflict (team_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  return v_req_id;
end;
$$;

-- 8. mlp_request_join — player asks to join a team ------------------------
create or replace function public.mlp_request_join(
  p_team_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid    uuid := auth.uid();
  v_status text;
  v_tournament_id uuid;
  v_req_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select status, tournament_id into v_status, v_tournament_id
    from public.mlp_teams where id = p_team_id;
  if v_status is null then raise exception 'Team not found'; end if;
  if v_status <> 'forming' then raise exception 'Team is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into the tournament before requesting to join a team';
  end if;

  -- Already on a team?
  if exists (
    select 1 from public.mlp_teams
     where tournament_id = v_tournament_id
       and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
  ) then
    raise exception 'You''re already on a team in this tournament';
  end if;

  insert into public.mlp_team_join_requests (team_id, user_id, direction, message, status)
  values (p_team_id, v_uid, 'request', p_message, 'pending')
  on conflict (team_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  return v_req_id;
end;
$$;

-- 9. mlp_respond_to_join — accept/decline an invite or request ------------
--    For 'invite': only the invitee may respond.
--    For 'request': only the team captain may respond.
--    On accept, the user is slotted into the first matching free slot
--    (M1/M2 if male, F1/F2 if female). If no slot is open, accept fails.
create or replace function public.mlp_respond_to_join(
  p_request_id uuid,
  p_accept     boolean
) returns void language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_req     record;
  v_team    record;
  v_gender  text;
  v_target_slot text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.mlp_team_join_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request already %', v_req.status; end if;

  select * into v_team from public.mlp_teams where id = v_req.team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  if v_req.direction = 'invite' then
    if v_uid <> v_req.user_id then raise exception 'Only the invitee can respond'; end if;
  else  -- request
    if v_uid <> v_team.captain_id then raise exception 'Only the captain can respond'; end if;
  end if;

  if not p_accept then
    update public.mlp_team_join_requests
       set status = 'declined', responded_at = now()
     where id = p_request_id;
    return;
  end if;

  -- Accepting → ensure user is approved + not already on another team
  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_team.tournament_id and user_id = v_req.user_id and status = 'approved'
  ) then
    raise exception 'User is no longer approved into the tournament';
  end if;
  if exists (
    select 1 from public.mlp_teams
     where tournament_id = v_team.tournament_id
       and id <> v_team.id
       and v_req.user_id in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
  ) then
    raise exception 'User is already on another team';
  end if;

  -- Determine target slot from gender
  select gender into v_gender from public.profiles where id = v_req.user_id;
  if v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Player must set their gender (male/female/other) before joining a team';
  end if;

  if v_gender = 'female' then
    if v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else raise exception 'Both female slots are full';
    end if;
  else  -- male / other → fill male slots
    if v_team.male_1_id is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id is null then v_target_slot := 'male_2';
    else raise exception 'Both male slots are full';
    end if;
  end if;

  execute format(
    'update public.mlp_teams set %I_id = $1 where id = $2',
    v_target_slot
  ) using v_req.user_id, v_team.id;

  update public.mlp_team_join_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id;
end;
$$;

-- 10. mlp_set_slot — captain manually moves a player between slots --------
create or replace function public.mlp_set_slot(
  p_team_id  uuid,
  p_slot     text,        -- 'male_1' | 'male_2' | 'female_1' | 'female_2'
  p_user_id  uuid         -- nullable: passing null clears the slot
) returns void language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_team record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_slot not in ('male_1','male_2','female_1','female_2') then
    raise exception 'Invalid slot %', p_slot;
  end if;

  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_uid <> v_team.captain_id and not public._is_tournament_admin(v_team.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can change slots';
  end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  execute format('update public.mlp_teams set %I_id = $1 where id = $2', p_slot)
    using p_user_id, p_team_id;
end;
$$;

-- 11. mlp_lock_team — captain locks when 4 slots filled -------------------
create or replace function public.mlp_lock_team(p_team_id uuid)
returns void language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_team record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_uid <> v_team.captain_id and not public._is_tournament_admin(v_team.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can lock';
  end if;
  if v_team.male_1_id is null or v_team.male_2_id is null
     or v_team.female_1_id is null or v_team.female_2_id is null then
    raise exception 'All four slots must be filled to lock the team';
  end if;

  update public.mlp_teams set status = 'locked' where id = p_team_id;
end;
$$;

-- 12. generate_random_mlp_teams — admin one-shot for mlp_random format ---
create or replace function public.generate_random_mlp_teams(
  p_tournament_id uuid,
  p_mode          text default 'random'   -- 'random' or 'snake'
) returns integer language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_format text;
  v_teams_created integer := 0;
  v_males uuid[];
  v_females uuid[];
  v_male_count integer;
  v_female_count integer;
  v_team_count integer;
  v_remaining_names text[];
  v_team_name text;
  v_male_1 uuid; v_male_2 uuid; v_female_1 uuid; v_female_2 uuid;
  i integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate teams';
  end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format <> 'mlp_random' then
    raise exception 'Use this only for MLP / Random Teams tournaments (got %)', v_format;
  end if;

  -- Wipe any existing teams (admin can re-roll)
  delete from public.mlp_teams where tournament_id = p_tournament_id;

  -- Pull approved members and split by gender
  if p_mode = 'snake' then
    -- Snake: order by current PLUPR descending so balanced teams form
    select array_agg(tr.user_id order by p.rating desc)
      into v_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender in ('male','other');
    select array_agg(tr.user_id order by p.rating desc)
      into v_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender = 'female';
  else
    -- Pure random: shuffle by random()
    select array_agg(tr.user_id order by random())
      into v_males
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender in ('male','other');
    select array_agg(tr.user_id order by random())
      into v_females
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and p.gender = 'female';
  end if;

  v_male_count   := coalesce(array_length(v_males, 1), 0);
  v_female_count := coalesce(array_length(v_females, 1), 0);
  v_team_count   := least(v_male_count, v_female_count) / 2;

  if v_team_count < 2 then
    raise exception 'Need at least 4 men and 4 women approved (got % men, % women) for at least 2 teams', v_male_count, v_female_count;
  end if;

  -- Pull a shuffled batch of unique team names from the pool
  select array_agg(name order by random())
    into v_remaining_names
    from public.mlp_team_name_pool
    limit greatest(v_team_count, 1);

  for i in 1 .. v_team_count loop
    if p_mode = 'snake' then
      -- Snake-draft pairing across the rating-sorted arrays
      -- Round 1 (top tier): take v_males[i] and v_males[2*v_team_count - i + 1]
      -- Same for women — pair high with low so each team gets one strong + one weak per gender
      v_male_1   := v_males[i];
      v_male_2   := v_males[2 * v_team_count - i + 1];
      v_female_1 := v_females[i];
      v_female_2 := v_females[2 * v_team_count - i + 1];
    else
      v_male_1   := v_males[(i - 1) * 2 + 1];
      v_male_2   := v_males[(i - 1) * 2 + 2];
      v_female_1 := v_females[(i - 1) * 2 + 1];
      v_female_2 := v_females[(i - 1) * 2 + 2];
    end if;

    v_team_name := coalesce(v_remaining_names[i], 'Team ' || i);

    insert into public.mlp_teams (
      tournament_id, name, status, is_random_generated,
      male_1_id, male_2_id, female_1_id, female_2_id
    ) values (
      p_tournament_id, v_team_name, 'locked', true,
      v_male_1, v_male_2, v_female_1, v_female_2
    );
    v_teams_created := v_teams_created + 1;
  end loop;

  return v_teams_created;
end;
$$;

-- 13. generate_mlp_bracket — round-robin pair every locked team -----------
--     For each pair, insert 4 tournament_matches: M's, W's, Mixed 1, Mixed 2
create or replace function public.generate_mlp_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_round_id uuid;
  v_team_count integer;
  v_matches_created integer := 0;
  v_team_a record;
  v_team_b record;
  v_round_no integer;
  v_match_order integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate the bracket';
  end if;

  select count(*) into v_team_count
    from public.mlp_teams
   where tournament_id = p_tournament_id and status = 'locked';

  if v_team_count < 2 then
    raise exception 'Need at least 2 locked teams (got %)', v_team_count;
  end if;

  -- Wipe any prior MLP-generated matches/rounds for this tournament
  delete from public.tournament_matches where tournament_id = p_tournament_id;
  delete from public.tournament_rounds   where tournament_id = p_tournament_id;

  -- Assign seeds to teams (just in-order for now)
  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
  )
  update public.mlp_teams t
     set seed = s.rn
    from seeded s
   where t.id = s.id;

  v_round_no := 0;
  -- Walk every (i, j) pair where i < j
  for v_team_a in (
    select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
     order by seed
  ) loop
    for v_team_b in (
      select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
        from public.mlp_teams
       where tournament_id = p_tournament_id and status = 'locked'
         and seed > v_team_a.seed
       order by seed
    ) loop
      v_round_no := v_round_no + 1;

      insert into public.tournament_rounds (tournament_id, round_number, label)
      values (p_tournament_id, v_round_no, format('%s vs %s', v_team_a.name, v_team_b.name))
      returning id into v_round_id;

      -- 1. Men's
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_1_id, v_team_a.male_2_id, v_team_b.male_1_id, v_team_b.male_2_id
      );
      v_matches_created := v_matches_created + 1;

      -- 2. Women's
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.female_1_id, v_team_a.female_2_id, v_team_b.female_1_id, v_team_b.female_2_id
      );
      v_matches_created := v_matches_created + 1;

      -- 3. Mixed 1
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_1_id, v_team_a.female_1_id, v_team_b.male_1_id, v_team_b.female_1_id
      );
      v_matches_created := v_matches_created + 1;

      -- 4. Mixed 2
      v_match_order := v_match_order + 1;
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type, status,
        team1_player1, team1_player2, team2_player1, team2_player2
      ) values (
        p_tournament_id, v_round_id, v_match_order, 'doubles', 'pending',
        v_team_a.male_2_id, v_team_a.female_2_id, v_team_b.male_2_id, v_team_b.female_2_id
      );
      v_matches_created := v_matches_created + 1;
    end loop;
  end loop;

  -- Mark tournament as active
  update public.tournaments set status = 'active' where id = p_tournament_id and status = 'registration';

  return v_matches_created;
end;
$$;

-- 14. Grants -------------------------------------------------------------
grant execute on function public.create_mlp_team(uuid, text)                   to authenticated;
grant execute on function public.mlp_invite(uuid, uuid, text)                  to authenticated;
grant execute on function public.mlp_request_join(uuid, text)                  to authenticated;
grant execute on function public.mlp_respond_to_join(uuid, boolean)            to authenticated;
grant execute on function public.mlp_set_slot(uuid, text, uuid)                to authenticated;
grant execute on function public.mlp_lock_team(uuid)                           to authenticated;
grant execute on function public.generate_random_mlp_teams(uuid, text)         to authenticated;
grant execute on function public.generate_mlp_bracket(uuid)                    to authenticated;

-- ============================================================
-- Doubles partnership flow for regular doubles tournaments
-- (round-robin / single-elim / double-elim / pool-play).
--
-- Mirrors the MLP team flow but with 2 slots, no gender semantics,
-- and no captain-vs-roster distinction beyond "captain creates the
-- pair and invites the partner."
--
-- MLP (4 players, gender-balanced) still uses mlp_teams.  Rotating-
-- partners and singles tournaments don't need any of this.
-- ============================================================


-- 1. doubles_pairs --------------------------------------------------------
create table if not exists public.doubles_pairs (
  id                  uuid default gen_random_uuid() primary key,
  tournament_id       uuid references public.tournaments(id) on delete cascade not null,
  name                text not null,
  captain_id          uuid references public.profiles(id) on delete set null,
  partner_1_id        uuid references public.profiles(id) on delete set null,
  partner_2_id        uuid references public.profiles(id) on delete set null,
  status              text not null default 'forming'
                        check (status in ('forming', 'locked')),
  seed                integer,
  is_random_generated boolean not null default false,
  created_at          timestamptz not null default now()
);

create index if not exists doubles_pairs_tournament_idx on public.doubles_pairs (tournament_id);

alter table public.doubles_pairs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='doubles_pairs' and policyname='Pairs viewable by everyone') then
    create policy "Pairs viewable by everyone" on public.doubles_pairs for select using (true);
  end if;
end $$;
-- No public insert/update; goes through SECURITY DEFINER RPCs.


-- 2. doubles_pair_join_requests ------------------------------------------
create table if not exists public.doubles_pair_join_requests (
  id            uuid default gen_random_uuid() primary key,
  pair_id       uuid references public.doubles_pairs(id) on delete cascade not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  direction     text not null check (direction in ('invite', 'request')),
  message       text,
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  responded_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (pair_id, user_id, direction)
);

alter table public.doubles_pair_join_requests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='doubles_pair_join_requests' and policyname='Pair requests viewable by everyone') then
    create policy "Pair requests viewable by everyone" on public.doubles_pair_join_requests for select using (true);
  end if;
end $$;


-- 3. Helper: check tournament admin/co-admin (mirror of _is_tournament_admin) --
-- The _is_tournament_admin function already exists from migration_add_mlp_teams,
-- so we just reuse it here.


-- 4. create_doubles_pair --------------------------------------------------
create or replace function public.create_doubles_pair(
  p_tournament_id uuid,
  p_name          text
) returns uuid language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_format    text;
  v_match     text;
  v_pair_id   uuid;
  v_existing  uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'Pair name required'; end if;

  select format, match_type into v_format, v_match
    from public.tournaments where id = p_tournament_id;
  if v_format is null then raise exception 'Tournament not found'; end if;
  if v_match <> 'doubles' then raise exception 'Pairs are only for doubles tournaments'; end if;
  if v_format in ('mlp', 'mlp_random', 'rotating_partners') then
    raise exception 'This format does not use fixed partner pairs';
  end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = p_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into this tournament before creating a pair';
  end if;

  select id into v_existing from public.doubles_pairs
   where tournament_id = p_tournament_id
     and v_uid in (captain_id, partner_1_id, partner_2_id)
   limit 1;
  if v_existing is not null then
    raise exception 'You''re already on a pair in this tournament';
  end if;

  insert into public.doubles_pairs (tournament_id, name, captain_id, partner_1_id)
  values (p_tournament_id, trim(p_name), v_uid, v_uid)
  returning id into v_pair_id;

  return v_pair_id;
end;
$$;

grant execute on function public.create_doubles_pair(uuid, text) to authenticated;


-- 5. pair_invite ----------------------------------------------------------
create or replace function public.pair_invite(
  p_pair_id uuid,
  p_user_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_captain         uuid;
  v_status          text;
  v_tournament_id   uuid;
  v_pair_name       text;
  v_tournament_name text;
  v_captain_name    text;
  v_req_id          uuid;
  v_god             boolean := public.is_godmode_user();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select dp.captain_id, dp.status, dp.tournament_id, dp.name, t.name, p.full_name
    into v_captain, v_status, v_tournament_id, v_pair_name, v_tournament_name, v_captain_name
    from public.doubles_pairs dp
    join public.tournaments t on t.id = dp.tournament_id
    left join public.profiles p on p.id = v_uid
   where dp.id = p_pair_id;

  if v_captain is null then raise exception 'Pair not found'; end if;
  if v_uid <> v_captain and not v_god then raise exception 'Only the captain can invite'; end if;
  if v_status <> 'forming' then raise exception 'Pair is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_tournament_id and user_id = p_user_id and status = 'approved'
  ) then
    raise exception 'Invitee must be approved into the tournament first';
  end if;

  insert into public.doubles_pair_join_requests (pair_id, user_id, direction, message, status)
  values (p_pair_id, p_user_id, 'invite', p_message, 'pending')
  on conflict (pair_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  perform public._notify_user(
    p_user_id,
    'Doubles partner invite',
    format('%s invited you to pair up as %s in %s. Open the tournament to respond.',
           coalesce(v_captain_name, 'A player'), v_pair_name, v_tournament_name),
    v_tournament_id,
    'tournament'
  );

  -- Godmode auto-accepts on behalf of the invitee.
  if v_god then
    perform public.pair_respond_to_join(v_req_id, true);
  end if;

  return v_req_id;
end;
$$;

grant execute on function public.pair_invite(uuid, uuid, text) to authenticated;


-- 6. pair_request_join ---------------------------------------------------
create or replace function public.pair_request_join(
  p_pair_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_pair            record;
  v_tournament_name text;
  v_player_name     text;
  v_req_id          uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select dp.id, dp.status, dp.tournament_id, dp.name, dp.captain_id, t.name as tname, p.full_name as player_name
    into v_pair
    from public.doubles_pairs dp
    join public.tournaments t on t.id = dp.tournament_id
    left join public.profiles p on p.id = v_uid
   where dp.id = p_pair_id;

  if v_pair.id is null then raise exception 'Pair not found'; end if;
  if v_pair.status <> 'forming' then raise exception 'Pair is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_pair.tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into the tournament before requesting to join a pair';
  end if;

  if exists (
    select 1 from public.doubles_pairs
     where tournament_id = v_pair.tournament_id
       and v_uid in (captain_id, partner_1_id, partner_2_id)
  ) then
    raise exception 'You''re already on a pair in this tournament';
  end if;

  insert into public.doubles_pair_join_requests (pair_id, user_id, direction, message, status)
  values (p_pair_id, v_uid, 'request', p_message, 'pending')
  on conflict (pair_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  if v_pair.captain_id is not null then
    perform public._notify_user(
      v_pair.captain_id,
      'New pair join request',
      format('%s wants to pair with %s. Open the tournament to accept or decline.',
             coalesce(v_pair.player_name, 'Someone'), v_pair.name),
      v_pair.tournament_id,
      'tournament'
    );
  end if;

  return v_req_id;
end;
$$;

grant execute on function public.pair_request_join(uuid, text) to authenticated;


-- 7. pair_respond_to_join -------------------------------------------------
create or replace function public.pair_respond_to_join(
  p_request_id uuid,
  p_accept     boolean
) returns void language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_req             record;
  v_pair            record;
  v_target_slot     text;
  v_responder_name  text;
  v_tournament_name text;
  v_god             boolean := public.is_godmode_user();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.doubles_pair_join_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request already %', v_req.status; end if;

  select * into v_pair from public.doubles_pairs where id = v_req.pair_id;
  if v_pair.id is null then raise exception 'Pair not found'; end if;
  if v_pair.status <> 'forming' then raise exception 'Pair is locked'; end if;

  if not v_god then
    if v_req.direction = 'invite' then
      if v_uid <> v_req.user_id then raise exception 'Only the invitee can respond'; end if;
    else
      if v_uid <> v_pair.captain_id then raise exception 'Only the captain can respond'; end if;
    end if;
  end if;

  if not p_accept then
    update public.doubles_pair_join_requests
       set status = 'declined', responded_at = now()
     where id = p_request_id;
    return;
  end if;

  -- Accept path
  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_pair.tournament_id and user_id = v_req.user_id and status = 'approved'
  ) then
    raise exception 'User is no longer approved into the tournament';
  end if;
  if exists (
    select 1 from public.doubles_pairs
     where tournament_id = v_pair.tournament_id
       and id <> v_pair.id
       and v_req.user_id in (captain_id, partner_1_id, partner_2_id)
  ) then
    raise exception 'User is already on another pair';
  end if;

  -- Find an open slot (partner_1, then partner_2)
  if    v_pair.partner_1_id is null then v_target_slot := 'partner_1';
  elsif v_pair.partner_2_id is null then v_target_slot := 'partner_2';
  else  raise exception 'Pair is already full';
  end if;

  execute format('update public.doubles_pairs set %I_id = $1 where id = $2', v_target_slot)
    using v_req.user_id, v_pair.id;

  update public.doubles_pair_join_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id;

  select p.full_name into v_responder_name from public.profiles p where p.id = v_req.user_id;
  select t.name      into v_tournament_name from public.tournaments t where t.id = v_pair.tournament_id;

  if v_req.direction = 'invite' then
    if v_pair.captain_id is not null and v_pair.captain_id <> v_uid then
      perform public._notify_user(
        v_pair.captain_id,
        'Partner invite accepted',
        format('%s paired with you as %s in %s.',
               coalesce(v_responder_name, 'A player'), v_pair.name, v_tournament_name),
        v_pair.tournament_id,
        'tournament'
      );
    end if;
  else
    perform public._notify_user(
      v_req.user_id,
      'Pair request accepted',
      format('Your request to join %s in %s was accepted.',
             v_pair.name, v_tournament_name),
      v_pair.tournament_id,
      'tournament'
    );
  end if;
end;
$$;

grant execute on function public.pair_respond_to_join(uuid, boolean) to authenticated;


-- 8. pair_set_slot — captain or admin moves a player between slots --------
create or replace function public.pair_set_slot(
  p_pair_id  uuid,
  p_slot     text,   -- 'partner_1' | 'partner_2'
  p_user_id  uuid    -- null clears the slot
) returns void language plpgsql security definer as $$
declare
  v_uid  uuid := auth.uid();
  v_pair record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_slot not in ('partner_1', 'partner_2') then raise exception 'Invalid slot %', p_slot; end if;

  select * into v_pair from public.doubles_pairs where id = p_pair_id;
  if v_pair.id is null then raise exception 'Pair not found'; end if;
  if v_uid <> v_pair.captain_id and not public._is_tournament_admin(v_pair.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can change slots';
  end if;
  if v_pair.status <> 'forming' then raise exception 'Pair is locked'; end if;

  execute format('update public.doubles_pairs set %I_id = $1 where id = $2', p_slot)
    using p_user_id, p_pair_id;
end;
$$;

grant execute on function public.pair_set_slot(uuid, text, uuid) to authenticated;


-- 9. pair_lock_pair — captain locks when both slots filled ----------------
create or replace function public.pair_lock_pair(p_pair_id uuid)
returns void language plpgsql security definer as $$
declare
  v_uid  uuid := auth.uid();
  v_pair record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_pair from public.doubles_pairs where id = p_pair_id;
  if v_pair.id is null then raise exception 'Pair not found'; end if;
  if v_uid <> v_pair.captain_id and not public._is_tournament_admin(v_pair.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can lock';
  end if;
  if v_pair.partner_1_id is null or v_pair.partner_2_id is null then
    raise exception 'Both slots must be filled to lock the pair';
  end if;

  update public.doubles_pairs set status = 'locked' where id = p_pair_id;
end;
$$;

grant execute on function public.pair_lock_pair(uuid) to authenticated;


-- 10. pair_leave_pair — same semantics as mlp_leave_team -----------------
create or replace function public.pair_leave_pair(p_pair_id uuid)
returns void language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_pair    record;
  v_admin   boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_pair from public.doubles_pairs where id = p_pair_id;
  if v_pair.id is null then raise exception 'Pair not found'; end if;
  if v_pair.status <> 'forming' then raise exception 'Pair is locked'; end if;

  v_admin := public._is_tournament_admin(v_pair.tournament_id, v_uid);

  if v_uid <> v_pair.captain_id
     and v_uid <> v_pair.partner_1_id and v_uid <> v_pair.partner_2_id
     and not v_admin then
    raise exception 'Only members of this pair can leave it';
  end if;

  -- Captain leaving: delete the pair (cascades to join_requests).
  if v_uid = v_pair.captain_id then
    delete from public.doubles_pairs where id = p_pair_id;
    return;
  end if;

  -- Non-captain: null out the leaver's slot.
  if v_uid = v_pair.partner_1_id then
    update public.doubles_pairs set partner_1_id = null where id = p_pair_id;
  elsif v_uid = v_pair.partner_2_id then
    update public.doubles_pairs set partner_2_id = null where id = p_pair_id;
  end if;
end;
$$;

grant execute on function public.pair_leave_pair(uuid) to authenticated;


-- 11. generate_random_pairs — admin one-shot for unpaired approved players --
create or replace function public.generate_random_pairs(
  p_tournament_id uuid,
  p_mode          text default 'random'   -- 'random' or 'snake' (by PLUPR)
) returns integer language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_match     text;
  v_format    text;
  v_unpaired  uuid[];
  v_created   integer := 0;
  v_i         integer;
  v_a         uuid;
  v_b         uuid;
  v_pair_id   uuid;
  v_name      text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select match_type, format into v_match, v_format
    from public.tournaments where id = p_tournament_id;
  if v_match <> 'doubles' or v_format in ('mlp', 'mlp_random', 'rotating_partners') then
    raise exception 'generate_random_pairs only applies to non-MLP doubles tournaments';
  end if;

  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can auto-generate pairs';
  end if;

  -- Approved players not already on a pair
  with already_paired as (
    select unnest(array[captain_id, partner_1_id, partner_2_id]) as uid
      from public.doubles_pairs where tournament_id = p_tournament_id
  ),
  candidates as (
    select tr.user_id, coalesce(p.rating, 3.250) as rating
      from public.tournament_registrations tr
      left join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
       and tr.user_id not in (select uid from already_paired where uid is not null)
  )
  select array_agg(user_id order by
    case when p_mode = 'snake' then -rating else random() end
  )
    into v_unpaired
    from candidates;

  if v_unpaired is null or array_length(v_unpaired, 1) is null then
    return 0;
  end if;

  -- Snake-pairs: top vs bottom (1 ↔ N, 2 ↔ N-1, ...) for balance.
  -- Random:      consecutive pairs from the shuffled list.
  for v_i in 1..(array_length(v_unpaired, 1) / 2) loop
    if p_mode = 'snake' then
      v_a := v_unpaired[v_i];
      v_b := v_unpaired[array_length(v_unpaired, 1) - v_i + 1];
    else
      v_a := v_unpaired[2 * v_i - 1];
      v_b := v_unpaired[2 * v_i];
    end if;

    v_name := format('Random Pair %s', v_created + 1);
    insert into public.doubles_pairs (
      tournament_id, name, captain_id, partner_1_id, partner_2_id, is_random_generated, status
    ) values (
      p_tournament_id, v_name, v_a, v_a, v_b, true, 'locked'
    ) returning id into v_pair_id;
    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

grant execute on function public.generate_random_pairs(uuid, text) to authenticated;

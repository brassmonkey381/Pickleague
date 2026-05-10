-- ============================================================
-- Pickle pots — admin-funded prize pools for leagues, seasons,
-- tournaments. Tournaments additionally support an entry ante
-- charged on registration approval.
--
-- Concepts:
--   * Each scope (league / season / tournament) has a `prize_pool`
--     and a `payout_structure` (percentages summing to 100, e.g.
--     [60,25,15] means 1st gets 60% of the pool, 2nd 25%, 3rd 15%).
--   * Admins/co-admins contribute their own pickles to the pool
--     and the house adds a 25% bonus on top — i.e. a 100🥒
--     contribution puts 125🥒 into the pool.
--   * Tournaments may set a non-zero `pickle_ante`; on registration
--     approval the player's ante is deducted and added to the pool.
--   * Admins can grant ad-hoc rewards from the pool to any user
--     (manual reward), or auto-distribute across the structure
--     after a season / tournament finishes.
--   * Two ledgers (pickle_pot_contributions, pickle_pot_payouts)
--     keep an audit trail of every movement.
--
-- Run AFTER migration_add_pickles_shop.sql.
-- ============================================================

-- 1. Pool + structure columns ---------------------------------------------
alter table public.tournaments
  add column if not exists prize_pool       integer not null default 0 check (prize_pool >= 0),
  add column if not exists pickle_ante      integer not null default 0 check (pickle_ante >= 0),
  add column if not exists payout_structure integer[] not null default '{60,25,15}';

alter table public.league_seasons
  add column if not exists prize_pool       integer not null default 0 check (prize_pool >= 0),
  add column if not exists payout_structure integer[] not null default '{60,25,15}';

alter table public.leagues
  add column if not exists prize_pool       integer not null default 0 check (prize_pool >= 0),
  add column if not exists payout_structure integer[] not null default '{60,25,15}';

-- 2. Audit ledgers --------------------------------------------------------
create table if not exists public.pickle_pot_contributions (
  id            uuid default gen_random_uuid() primary key,
  scope_type    text not null check (scope_type in ('league','season','tournament')),
  scope_id      uuid not null,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  amount_paid   integer not null check (amount_paid > 0),    -- pickles deducted from contributor
  bonus_amount  integer not null check (bonus_amount >= 0),  -- house bonus
  pool_added    integer not null check (pool_added > 0),     -- amount_paid + bonus_amount
  created_at    timestamptz default now()
);
alter table public.pickle_pot_contributions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='pickle_pot_contributions' and policyname='Contributions viewable by everyone') then
    create policy "Contributions viewable by everyone" on public.pickle_pot_contributions for select using (true);
  end if;
end $$;

create table if not exists public.pickle_pot_payouts (
  id            uuid default gen_random_uuid() primary key,
  scope_type    text not null check (scope_type in ('league','season','tournament')),
  scope_id      uuid not null,
  user_id       uuid references public.profiles(id) on delete cascade not null, -- recipient
  amount        integer not null check (amount > 0),
  reason        text not null default '',
  granted_by    uuid references public.profiles(id) on delete set null,         -- null = automatic
  is_automatic  boolean not null default false,
  created_at    timestamptz default now()
);
alter table public.pickle_pot_payouts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='pickle_pot_payouts' and policyname='Payouts viewable by everyone') then
    create policy "Payouts viewable by everyone" on public.pickle_pot_payouts for select using (true);
  end if;
end $$;

-- 3. Helper: confirm caller is an admin/co-admin of a scope ---------------
create or replace function public.is_scope_admin(p_scope_type text, p_scope_id uuid)
returns boolean language plpgsql stable security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_league_id uuid;
begin
  if v_uid is null then return false; end if;

  if p_scope_type = 'league' then
    v_league_id := p_scope_id;
  elsif p_scope_type = 'season' then
    select league_id into v_league_id from public.league_seasons where id = p_scope_id;
  elsif p_scope_type = 'tournament' then
    -- Tournaments may belong to a league, or be standalone (created_by counts).
    return exists (
      select 1 from public.tournaments t
      where t.id = p_scope_id
        and (
          t.created_by = v_uid
          or (t.league_id is not null and exists (
            select 1 from public.league_members
            where league_id = t.league_id and user_id = v_uid and role in ('admin','co-admin')
          ))
        )
    );
  else
    return false;
  end if;

  if v_league_id is null then return false; end if;
  return exists (
    select 1 from public.league_members
    where league_id = v_league_id and user_id = v_uid and role in ('admin','co-admin')
  );
end;
$$;

-- 4. Helper: read/write the pool column for any scope ---------------------
create or replace function public._update_pool(p_scope_type text, p_scope_id uuid, p_delta integer)
returns integer language plpgsql security definer as $$
declare v_new integer;
begin
  if p_scope_type = 'league' then
    update public.leagues        set prize_pool = prize_pool + p_delta where id = p_scope_id returning prize_pool into v_new;
  elsif p_scope_type = 'season' then
    update public.league_seasons set prize_pool = prize_pool + p_delta where id = p_scope_id returning prize_pool into v_new;
  elsif p_scope_type = 'tournament' then
    update public.tournaments    set prize_pool = prize_pool + p_delta where id = p_scope_id returning prize_pool into v_new;
  else
    raise exception 'Invalid scope_type %', p_scope_type;
  end if;
  return v_new;
end;
$$;

create or replace function public._read_pool(p_scope_type text, p_scope_id uuid)
returns integer language plpgsql stable security definer as $$
declare v integer;
begin
  if p_scope_type = 'league' then
    select prize_pool into v from public.leagues        where id = p_scope_id;
  elsif p_scope_type = 'season' then
    select prize_pool into v from public.league_seasons where id = p_scope_id;
  elsif p_scope_type = 'tournament' then
    select prize_pool into v from public.tournaments    where id = p_scope_id;
  end if;
  return coalesce(v, 0);
end;
$$;

-- 5. contribute_pickles_to_pool — admin contributes from own balance,
--    house adds 25% bonus on top.
create or replace function public.contribute_pickles_to_pool(
  p_scope_type text,
  p_scope_id   uuid,
  p_amount     integer
) returns table (success boolean, new_pool integer, contributor_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_balance integer;
  v_bonus   integer;
  v_added   integer;
  v_new_pool integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_amount is null or p_amount <= 0 then
    return query select false, null::integer, null::integer, 'Amount must be positive'::text; return;
  end if;
  if not public.is_scope_admin(p_scope_type, p_scope_id) then
    return query select false, null::integer, null::integer, 'Only admins/co-admins may contribute'::text; return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < p_amount then
    return query select false, null::integer, v_balance, 'Not enough pickles'::text; return;
  end if;

  v_bonus := floor(p_amount * 0.25);
  v_added := p_amount + v_bonus;

  update public.profiles set pickles = pickles - p_amount where id = v_uid returning pickles into v_balance;
  v_new_pool := public._update_pool(p_scope_type, p_scope_id, v_added);

  insert into public.pickle_pot_contributions
    (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added)
  values (p_scope_type, p_scope_id, v_uid, p_amount, v_bonus, v_added);

  return query select true, v_new_pool, v_balance, format('Added %s 🥒 (+%s house bonus)', p_amount, v_bonus);
end;
$$;

-- 6. award_pickles_from_pool — admin grants reward to a recipient ---------
create or replace function public.award_pickles_from_pool(
  p_scope_type text,
  p_scope_id   uuid,
  p_recipient  uuid,
  p_amount     integer,
  p_reason     text default ''
) returns table (success boolean, new_pool integer, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_pool      integer;
  v_new_pool  integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_amount is null or p_amount <= 0 then
    return query select false, null::integer, 'Amount must be positive'::text; return;
  end if;
  if not public.is_scope_admin(p_scope_type, p_scope_id) then
    return query select false, null::integer, 'Only admins/co-admins may award'::text; return;
  end if;

  v_pool := public._read_pool(p_scope_type, p_scope_id);
  if v_pool < p_amount then
    return query select false, v_pool, 'Pool only has ' || v_pool || ' 🥒'; return;
  end if;

  v_new_pool := public._update_pool(p_scope_type, p_scope_id, -p_amount);
  update public.profiles set pickles = pickles + p_amount where id = p_recipient;

  insert into public.pickle_pot_payouts
    (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
  values (p_scope_type, p_scope_id, p_recipient, p_amount, coalesce(p_reason, ''), v_uid, false);

  return query select true, v_new_pool, 'Awarded'::text;
end;
$$;

-- 7. set_tournament_pickle_config — admin configures ante + structure ----
create or replace function public.set_tournament_pickle_config(
  p_tournament_id uuid,
  p_ante          integer,
  p_structure     integer[]
) returns void language plpgsql security definer as $$
declare v_sum integer;
begin
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins/co-admins may configure tournaments';
  end if;
  if p_ante < 0 then raise exception 'Ante must be >= 0'; end if;
  if array_length(p_structure, 1) is null or array_length(p_structure, 1) < 1 then
    raise exception 'Payout structure must have at least one entry';
  end if;
  select sum(x) into v_sum from unnest(p_structure) x;
  if v_sum <> 100 then raise exception 'Payout structure must sum to 100 (got %)', v_sum; end if;

  -- Refuse changes after registration closes (tournament has gone active).
  if exists (select 1 from public.tournaments where id = p_tournament_id and status <> 'registration') then
    raise exception 'Cannot change ante / structure after registration closes';
  end if;

  update public.tournaments
     set pickle_ante = p_ante,
         payout_structure = p_structure
   where id = p_tournament_id;
end;
$$;

-- 8. set_season_pickle_config --------------------------------------------
create or replace function public.set_season_pickle_config(
  p_season_id uuid,
  p_structure integer[]
) returns void language plpgsql security definer as $$
declare v_sum integer;
begin
  if not public.is_scope_admin('season', p_season_id) then
    raise exception 'Only admins/co-admins may configure seasons';
  end if;
  if array_length(p_structure, 1) is null or array_length(p_structure, 1) < 1 then
    raise exception 'Payout structure must have at least one entry';
  end if;
  select sum(x) into v_sum from unnest(p_structure) x;
  if v_sum <> 100 then raise exception 'Payout structure must sum to 100'; end if;

  update public.league_seasons set payout_structure = p_structure where id = p_season_id;
end;
$$;

-- 9. Auto-charge ante when a registration is approved --------------------
create or replace function public._charge_tournament_ante()
returns trigger language plpgsql security definer as $$
declare
  v_ante     integer;
  v_balance  integer;
  v_bonus    integer := 0;  -- no house bonus on antes
begin
  -- Only act on the transition pending → approved (or direct insert as approved)
  if new.status <> 'approved' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'approved' then return new; end if;

  select pickle_ante into v_ante from public.tournaments where id = new.tournament_id;
  if v_ante is null or v_ante <= 0 then return new; end if;

  select pickles into v_balance from public.profiles where id = new.user_id;
  if v_balance < v_ante then
    raise exception 'User % has only % 🥒, ante is %', new.user_id, v_balance, v_ante;
  end if;

  update public.profiles set pickles = pickles - v_ante where id = new.user_id;
  perform public._update_pool('tournament', new.tournament_id, v_ante);

  -- Log as a self-contribution with no bonus so the audit trail is complete
  insert into public.pickle_pot_contributions
    (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added)
  values ('tournament', new.tournament_id, new.user_id, v_ante, v_bonus, v_ante);

  return new;
end;
$$;

drop trigger if exists trg_charge_tournament_ante on public.tournament_registrations;
create trigger trg_charge_tournament_ante
  after insert or update of status on public.tournament_registrations
  for each row execute procedure public._charge_tournament_ante();

-- 10. distribute_tournament_pool — admin or auto on completion -----------
create or replace function public.distribute_tournament_pool(
  p_tournament_id uuid,
  p_winner_uids   uuid[]                -- ordered: 1st, 2nd, 3rd, ...
) returns table (success boolean, distributed integer, message text)
language plpgsql security definer as $$
declare
  v_pool      integer;
  v_structure integer[];
  v_total_distributed integer := 0;
  v_share     integer;
  v_recipient uuid;
  i           integer;
begin
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may distribute';
  end if;

  select prize_pool, payout_structure
    into v_pool, v_structure
    from public.tournaments where id = p_tournament_id;

  if v_pool is null or v_pool = 0 then
    return query select false, 0, 'Pool is empty'::text; return;
  end if;

  for i in 1 .. least(array_length(v_structure, 1), array_length(p_winner_uids, 1)) loop
    v_recipient := p_winner_uids[i];
    if v_recipient is null then continue; end if;
    v_share := floor(v_pool * v_structure[i] / 100.0);
    if v_share <= 0 then continue; end if;

    update public.profiles set pickles = pickles + v_share where id = v_recipient;
    insert into public.pickle_pot_payouts
      (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
    values ('tournament', p_tournament_id, v_recipient, v_share,
            'Tournament finish #' || i, auth.uid(), true);
    v_total_distributed := v_total_distributed + v_share;
  end loop;

  update public.tournaments
     set prize_pool = prize_pool - v_total_distributed
   where id = p_tournament_id;

  return query select true, v_total_distributed, format('Distributed %s 🥒', v_total_distributed);
end;
$$;

-- 11. distribute_season_pool — pulls top finishers from
--     season_final_standings, hands out per the structure.
create or replace function public.distribute_season_pool(p_season_id uuid)
returns table (success boolean, distributed integer, message text)
language plpgsql security definer as $$
declare
  v_pool      integer;
  v_structure integer[];
  v_total     integer := 0;
  v_share     integer;
  v_rec       record;
  i           integer := 0;
begin
  if not public.is_scope_admin('season', p_season_id) then
    raise exception 'Only admins may distribute';
  end if;

  select prize_pool, payout_structure into v_pool, v_structure
    from public.league_seasons where id = p_season_id;

  if v_pool is null or v_pool = 0 then
    return query select false, 0, 'Pool is empty'::text; return;
  end if;
  if not exists (select 1 from public.season_final_standings where season_id = p_season_id) then
    return query select false, v_pool, 'Complete the season first'::text; return;
  end if;

  for v_rec in (
    select user_id, final_rank from public.season_final_standings
     where season_id = p_season_id
     order by final_rank asc
     limit array_length(v_structure, 1)
  ) loop
    i := i + 1;
    v_share := floor(v_pool * v_structure[i] / 100.0);
    if v_share <= 0 then continue; end if;

    update public.profiles set pickles = pickles + v_share where id = v_rec.user_id;
    insert into public.pickle_pot_payouts
      (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
    values ('season', p_season_id, v_rec.user_id, v_share,
            'Season finish #' || v_rec.final_rank, auth.uid(), true);
    v_total := v_total + v_share;
  end loop;

  update public.league_seasons
     set prize_pool = prize_pool - v_total
   where id = p_season_id;

  return query select true, v_total, format('Distributed %s 🥒', v_total);
end;
$$;

-- 12. Grants ------------------------------------------------------------
grant execute on function public.is_scope_admin(text, uuid)                        to authenticated;
grant execute on function public.contribute_pickles_to_pool(text, uuid, integer)   to authenticated;
grant execute on function public.award_pickles_from_pool(text, uuid, uuid, integer, text) to authenticated;
grant execute on function public.set_tournament_pickle_config(uuid, integer, integer[])   to authenticated;
grant execute on function public.set_season_pickle_config(uuid, integer[])         to authenticated;
grant execute on function public.distribute_tournament_pool(uuid, uuid[])          to authenticated;
grant execute on function public.distribute_season_pool(uuid)                      to authenticated;

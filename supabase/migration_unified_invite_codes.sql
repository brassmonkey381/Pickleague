-- ============================================================
-- Unified invite codes for leagues + tournaments.
--
-- Replaces league_invites (left around for safety; backfilled
-- into the new table). All future create/revoke/redeem traffic
-- goes through this table + three RPCs.
--
-- New capability: pickle subsidy. A code creator can optionally
-- earmark a pickle amount that subsidizes the tournament entry
-- ante for each redeemer. At redemption time, the code creator
-- is debited the subsidy and the recipient pays only
-- (ante - subsidy). The pool still receives the full ante.
-- Subsidies require max_uses to be set so creators know their
-- max exposure.
--
-- Schema additions:
--   * invite_codes table
--   * tournament_registrations.redeemed_invite_code_id column
--   * _charge_tournament_ante reworked to honor subsidies
--
-- Run AFTER migration_add_roles_invites.sql + the pickle pots
-- migration.
-- ============================================================


-- 1. Unified invite_codes table -----------------------------------------
create table if not exists public.invite_codes (
  id              uuid default gen_random_uuid() primary key,
  scope_type      text not null check (scope_type in ('league', 'tournament')),
  scope_id        uuid not null,
  created_by      uuid references public.profiles(id) on delete set null,
  token           text unique not null default upper(encode(gen_random_bytes(6), 'hex')),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  max_uses        integer,
  used_count      integer not null default 0,
  is_active       boolean not null default true,
  pickle_subsidy  integer not null default 0 check (pickle_subsidy >= 0),
  created_at      timestamptz default now()
);

alter table public.invite_codes enable row level security;

do $$ begin
  -- Any authenticated user can look up a code by token (needed for redeem).
  if not exists (select 1 from pg_policies where tablename='invite_codes' and policyname='Invite codes lookup') then
    create policy "Invite codes lookup" on public.invite_codes for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='invite_codes' and policyname='Scope admins manage codes') then
    create policy "Scope admins manage codes" on public.invite_codes for all using (
      public.is_scope_admin(scope_type, scope_id)
    );
  end if;
end $$;

create index if not exists idx_invite_codes_scope on public.invite_codes (scope_type, scope_id, is_active);
create index if not exists idx_invite_codes_token on public.invite_codes (token);


-- 2. Tournament registration: track which code (if any) was redeemed ---
alter table public.tournament_registrations
  add column if not exists redeemed_invite_code_id uuid references public.invite_codes(id) on delete set null;


-- 3. Backfill: copy existing league_invites into invite_codes ---------
insert into public.invite_codes
  (scope_type, scope_id, created_by, token, expires_at, max_uses, used_count, is_active, pickle_subsidy, created_at)
select 'league', li.league_id, li.created_by, li.token, li.expires_at, li.max_uses, li.used_count, li.is_active, 0, li.created_at
  from public.league_invites li
 where not exists (select 1 from public.invite_codes ic where ic.token = li.token);


-- 4. Reworked ante trigger: subsidies apply when redeemed via a code --
create or replace function public._charge_tournament_ante()
returns trigger language plpgsql security definer as $$
declare
  v_ante         integer;
  v_balance      integer;
  v_subsidy      integer := 0;
  v_creator      uuid;
  v_creator_bal  integer;
  v_user_pays    integer;
begin
  if new.status <> 'approved' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'approved' then return new; end if;

  select pickle_ante into v_ante from public.tournaments where id = new.tournament_id;
  if v_ante is null or v_ante <= 0 then return new; end if;

  -- If redemption came via an invite code with a subsidy, honor it.
  if new.redeemed_invite_code_id is not null then
    select coalesce(pickle_subsidy, 0), created_by into v_subsidy, v_creator
      from public.invite_codes where id = new.redeemed_invite_code_id;
    if v_subsidy is null then v_subsidy := 0; end if;
    if v_subsidy > v_ante then v_subsidy := v_ante; end if;  -- cap at full ante
  end if;

  v_user_pays := v_ante - v_subsidy;

  -- Charge the registrant the (possibly discounted) ante
  select pickles into v_balance from public.profiles where id = new.user_id;
  if coalesce(v_balance, 0) < v_user_pays then
    raise exception 'User % has only % 🥒, ante is % (after %🥒 subsidy)',
      new.user_id, coalesce(v_balance, 0), v_user_pays, v_subsidy;
  end if;
  if v_user_pays > 0 then
    update public.profiles set pickles = pickles - v_user_pays where id = new.user_id;
  end if;

  -- Charge the code creator for the subsidy (if any)
  if v_subsidy > 0 and v_creator is not null then
    select pickles into v_creator_bal from public.profiles where id = v_creator;
    if coalesce(v_creator_bal, 0) < v_subsidy then
      raise exception 'Code creator can''t cover the % 🥒 subsidy', v_subsidy;
    end if;
    update public.profiles set pickles = pickles - v_subsidy where id = v_creator;
  end if;

  -- Pool always gets the full ante
  perform public._update_pool('tournament', new.tournament_id, v_ante);

  -- Ledger entries — split between the registrant and the subsidizer
  if v_user_pays > 0 then
    insert into public.pickle_pot_contributions
      (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added)
    values ('tournament', new.tournament_id, new.user_id, v_user_pays, 0, v_user_pays);
  end if;
  if v_subsidy > 0 and v_creator is not null then
    insert into public.pickle_pot_contributions
      (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added)
    values ('tournament', new.tournament_id, v_creator, v_subsidy, 0, v_subsidy);
  end if;

  return new;
end;
$$;


-- 5. create_invite_code RPC --------------------------------------------
create or replace function public.create_invite_code(
  p_scope_type     text,
  p_scope_id       uuid,
  p_max_uses       integer default null,
  p_expires_days   integer default 7,
  p_pickle_subsidy integer default 0
) returns public.invite_codes
language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_row public.invite_codes%rowtype;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_scope_type not in ('league', 'tournament') then
    raise exception 'Invalid scope_type %', p_scope_type;
  end if;
  if not public.is_scope_admin(p_scope_type, p_scope_id) then
    raise exception 'Only admins can create invite codes';
  end if;
  if coalesce(p_pickle_subsidy, 0) < 0 then
    raise exception 'Subsidy must be non-negative';
  end if;
  if coalesce(p_pickle_subsidy, 0) > 0 and p_scope_type <> 'tournament' then
    raise exception 'Pickle subsidies only apply to tournament codes';
  end if;
  if coalesce(p_pickle_subsidy, 0) > 0 and p_max_uses is null then
    raise exception 'Subsidized codes must set a max_uses limit';
  end if;

  insert into public.invite_codes
    (scope_type, scope_id, created_by, max_uses, expires_at, pickle_subsidy)
  values
    (p_scope_type, p_scope_id, v_uid, p_max_uses,
     now() + (greatest(p_expires_days, 1) || ' days')::interval,
     coalesce(p_pickle_subsidy, 0))
  returning * into v_row;
  return v_row;
end;
$$;


-- 6. revoke_invite_code RPC --------------------------------------------
create or replace function public.revoke_invite_code(p_code_id uuid)
returns void language plpgsql security definer as $$
declare
  v_uid  uuid := auth.uid();
  v_code public.invite_codes%rowtype;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_code from public.invite_codes where id = p_code_id;
  if v_code.id is null then raise exception 'Code not found'; end if;
  if not public.is_scope_admin(v_code.scope_type, v_code.scope_id) then
    raise exception 'Only admins can revoke codes';
  end if;
  update public.invite_codes set is_active = false where id = p_code_id;
end;
$$;


-- 7. redeem_invite_code RPC --------------------------------------------
create or replace function public.redeem_invite_code(p_token text)
returns table (
  success      boolean,
  scope_type   text,
  scope_id     uuid,
  scope_name   text,
  subsidy      integer,
  message      text
) language plpgsql security definer as $$
declare
  v_uid         uuid := auth.uid();
  v_code        public.invite_codes%rowtype;
  v_scope_name  text;
  v_ante        integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_code from public.invite_codes
   where upper(token) = upper(regexp_replace(p_token, '-', '', 'g'));
  if v_code.id is null then
    return query select false, ''::text, null::uuid, ''::text, 0, 'Invalid invite code.'::text;
    return;
  end if;
  if not v_code.is_active then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has been revoked.'::text;
    return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has expired.'::text;
    return;
  end if;
  if v_code.max_uses is not null and v_code.used_count >= v_code.max_uses then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has reached its max uses.'::text;
    return;
  end if;

  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
    if v_scope_name is null then
      return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'League no longer exists.'::text;
      return;
    end if;
    if exists (select 1 from public.league_members where league_id = v_code.scope_id and user_id = v_uid) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already a member of %s.', v_scope_name)::text;
      return;
    end if;
    insert into public.league_members (league_id, user_id, role)
      values (v_code.scope_id, v_uid, 'member')
      on conflict do nothing;
    update public.invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                       format('Joined %s!', v_scope_name)::text;
    return;
  end if;

  if v_code.scope_type = 'tournament' then
    select name, pickle_ante into v_scope_name, v_ante
      from public.tournaments where id = v_code.scope_id;
    if v_scope_name is null then
      return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'Tournament no longer exists.'::text;
      return;
    end if;
    if exists (
      select 1 from public.tournament_registrations
       where tournament_id = v_code.scope_id and user_id = v_uid
    ) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already registered for %s.', v_scope_name)::text;
      return;
    end if;

    -- Insert as approved → fires reworked _charge_tournament_ante which
    -- reads redeemed_invite_code_id and applies the subsidy split.
    insert into public.tournament_registrations
      (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
    values
      (v_code.scope_id, v_uid, 'approved', v_code.created_by, v_code.id);

    update public.invite_codes set used_count = used_count + 1 where id = v_code.id;

    return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, v_code.pickle_subsidy,
                       case when v_code.pickle_subsidy > 0 and coalesce(v_ante, 0) > 0
                         then format('Joined %s — saved %s 🥒 thanks to the code!', v_scope_name, v_code.pickle_subsidy)
                         else format('Joined %s!', v_scope_name)
                       end::text;
    return;
  end if;

  return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'Unknown scope type.'::text;
end;
$$;


-- 8. Grants -------------------------------------------------------------
grant execute on function public.create_invite_code(text, uuid, integer, integer, integer) to authenticated;
grant execute on function public.revoke_invite_code(uuid)                                   to authenticated;
grant execute on function public.redeem_invite_code(text)                                   to authenticated;

notify pgrst, 'reload schema';

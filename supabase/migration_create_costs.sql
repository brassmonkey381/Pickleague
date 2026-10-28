-- ============================================================
-- Starting a league or a tournament costs pickles, and each account runs at
-- most one active league and one active tournament (follows
-- migration_fair_rewards.sql).
--
-- The user, 2026-10-28: "require pickles to start a league, and max 1 active
-- admin / league creation per account (same with tournaments). In the future,
-- maybe we increase the cap for paid accounts." / "5000 pickles to start a
-- league, 2500 to start a tournament".
--
-- ── What changes ──────────────────────────────────────────────────────────
--   1. trg_pl_league_create_cost (BEFORE INSERT on leagues):
--      * at most _pl_create_limit(uid, 'league') active leagues you admin
--        (you created it, or league_members.role = 'admin'; leagues.is_active).
--        It is 1 for everyone; a paid tier can raise it there later.
--      * 5,000 pickles, taken from the creator as the league is made.
--      The app already checked the one-league limit (countActiveAdminLeagues);
--      now the server does too, so the API can't skip it.
--   2. trg_pl_tournament_create_cost (BEFORE INSERT on tournaments):
--      * at most _pl_create_limit(uid, 'tournament') active tournaments you
--        created (status registration or active), as the app counted.
--      * 2,500 pickles.
--      * Refunded when the tournament is cancelled before it starts (status
--        registration -> cancelled): the app's own half-built rollback, or a
--        change of plan. A tournament that ran keeps the fee.
--   3. Only client creates pay (the request's role is authenticated / anon).
--      Godmode, service_role scripts and server code are exempt. Leagues and
--      tournaments that exist today are untouched (nobody is charged
--      retroactively; someone running two leagues keeps both).
--   4. create_fees records each fee (and its refund).
--
-- Refusal codes (HINT 'pl:<code>', mobile/src/lib/refusals.ts):
--   create.limit   DETAIL {"kind": "league"|"tournament", "limit": 1}
--   create.cost    DETAIL {"kind": ..., "cost": 5000|2500, "balance": n}
--
-- New internal functions (execute revoked from public, anon, authenticated):
--   _pl_create_limit(uuid,text), _pl_create_cost(text), _pl_charge_create(),
--   _pl_refund_tournament_create()
-- pickle_ledger_sources gains the charge and the refund.
--
-- Idempotent; no top-level transaction. Persona test:
--   supabase/tests/create_costs_personas.sql
-- Applied by state/fair-rewards-apply.ps1 after migration_fair_rewards.sql.
-- ============================================================

create table if not exists public.create_fees (
  kind        text not null check (kind in ('league', 'tournament')),
  scope_id    uuid not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      integer not null,
  charged_at  timestamptz not null default now(),
  refunded_at timestamptz,
  primary key (kind, scope_id)
);
do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.create_fees'::regclass) then
    alter table public.create_fees enable row level security;
  end if;
end $$;
revoke all on table public.create_fees from public, anon, authenticated;
grant all on table public.create_fees to service_role;

-- How many active ones an account may run. 1 for everyone today; a paid tier
-- raises it here.
create or replace function public._pl_create_limit(p_uid uuid, p_kind text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select 1 $$;
revoke execute on function public._pl_create_limit(uuid, text) from public, anon, authenticated;

create or replace function public._pl_create_cost(p_kind text)
returns integer
language sql
immutable
set search_path = ''
as $$ select case p_kind when 'league' then 5000 when 'tournament' then 2500 end $$;
revoke execute on function public._pl_create_cost(text) from public, anon, authenticated;

-- BEFORE INSERT on leagues and tournaments.
create or replace function public._pl_charge_create()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind    text := case tg_table_name when 'leagues' then 'league' else 'tournament' end;
  v_uid     uuid := auth.uid();
  v_role    text := coalesce(auth.role(), '');
  v_active  integer;
  v_limit   integer;
  v_cost    integer := public._pl_create_cost(v_kind);
  v_balance integer;
begin
  -- Server code, scripts and godmode create for free.
  if v_role not in ('authenticated', 'anon') or v_uid is null
     or coalesce(public.is_godmode_user(v_uid), false) then
    return new;
  end if;

  v_limit := public._pl_create_limit(v_uid, v_kind);
  if v_kind = 'league' then
    select count(*) into v_active
      from public.leagues l
     where l.is_active
       and (l.created_by = v_uid
            or exists (select 1 from public.league_members m
                        where m.league_id = l.id and m.user_id = v_uid and m.role = 'admin'));
  else
    select count(*) into v_active
      from public.tournaments t
     where t.created_by = v_uid and t.status in ('registration', 'active');
  end if;
  if v_active >= v_limit then
    raise exception 'You already run an active %.', v_kind
      using hint = 'pl:create.limit',
            detail = jsonb_build_object('kind', v_kind, 'limit', v_limit)::text;
  end if;

  select coalesce(p.pickles, 0) into v_balance from public.profiles p where p.id = v_uid for update;
  if coalesce(v_balance, 0) < v_cost then
    raise exception 'Starting a % costs % pickles.', v_kind, v_cost
      using hint = 'pl:create.cost',
            detail = jsonb_build_object('kind', v_kind, 'cost', v_cost, 'balance', coalesce(v_balance, 0))::text;
  end if;

  if new.id is null then
    new.id := gen_random_uuid();
  end if;
  perform set_config('pl.pickle_reason', left('Started a ' || v_kind || ': ' || coalesce(new.name, 'untitled'), 200), true);
  perform set_config('pl.pickle_meta', jsonb_build_object(v_kind || '_id', new.id)::text, true);
  update public.profiles set pickles = pickles - v_cost where id = v_uid;
  perform set_config('pl.pickle_reason', '', true);
  perform set_config('pl.pickle_meta', '', true);
  insert into public.create_fees (kind, scope_id, user_id, amount) values (v_kind, new.id, v_uid, v_cost)
  on conflict do nothing;
  return new;
end $$;
revoke execute on function public._pl_charge_create() from public, anon, authenticated;

create or replace trigger trg_pl_league_create_cost
  before insert on public.leagues
  for each row execute function public._pl_charge_create();
create or replace trigger trg_pl_tournament_create_cost
  before insert on public.tournaments
  for each row execute function public._pl_charge_create();

-- A tournament cancelled before it starts gets its fee back.
create or replace function public._pl_refund_tournament_create()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee public.create_fees%rowtype;
begin
  if new.status <> 'cancelled' or old.status <> 'registration' then
    return new;
  end if;
  update public.create_fees f set refunded_at = now()
   where f.kind = 'tournament' and f.scope_id = new.id and f.refunded_at is null
  returning * into v_fee;
  if v_fee.scope_id is null then
    return new;
  end if;
  perform set_config('pl.pickle_reason', left('Fee back: ' || coalesce(new.name, 'tournament') || ' was cancelled', 200), true);
  perform set_config('pl.pickle_meta', jsonb_build_object('tournament_id', new.id)::text, true);
  update public.profiles set pickles = coalesce(pickles, 0) + v_fee.amount where id = v_fee.user_id;
  perform set_config('pl.pickle_reason', '', true);
  perform set_config('pl.pickle_meta', '', true);
  return new;
end $$;
revoke execute on function public._pl_refund_tournament_create() from public, anon, authenticated;

create or replace trigger trg_pl_tournament_create_refund
  after update of status on public.tournaments
  for each row execute function public._pl_refund_tournament_create();

insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('_pl_charge_create',            -1, 'Started a league or tournament', 'spend',  'league',     false, '5,000 a league, 2,500 a tournament'),
  ('_pl_refund_tournament_create',  1, 'Tournament cancelled: fee back',  'refund', 'tournament', false, 'cancelled before it started')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;

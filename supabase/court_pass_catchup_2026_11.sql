-- ============================================================
-- Court Pass catch-up: pickleballs for every earn between the November pass's
-- start (Nov 1 2026, Pacific midnight, 07:00Z) and the moment
-- migration_court_pass_xp.sql's trigger went live. Brian, 2026-11-03: Court
-- Pass launches now, back-dated to Nov 1. Port of Doggle's
-- db/ops/park_pass_catchup_2026_11.sql. Not a migration_ file, so the drift
-- tool ignores it.
--
-- Run it in ONE transaction with migration_court_pass_xp.sql and the cycles
-- files (migration_court_pass_cycles_2026_11.sql,
-- migration_court_pass_cycles_2026_12_2027_01.sql), after them:
-- court-pass-apply.ps1 does. CREATE OR REPLACE TRIGGER holds a lock that
-- blocks pickle_ledger inserts until commit, so every row is counted by
-- exactly one of the trigger and this.
-- The replay locks each player's profiles row (FOR UPDATE), and a live
-- transaction can hold that row (an earn, SELECT ... FOR UPDATE in a purchase,
-- a match insert's FK check) while it waits on this transaction, so the
-- transaction must start with
--   set local lock_timeout = '10s';
--   lock table public.profiles in exclusive mode;
-- (profiles, then pickle_ledger: a live earn's order; the apply script does
-- this). EXCLUSIVE, not SHARE ROW EXCLUSIVE: it also conflicts with ROW SHARE
-- (FOR UPDATE, FK checks), so the LOCK waits out every transaction holding a
-- profile row lock and none can start until commit; plain SELECTs still run.
-- It holds every profile write and row lock (matches, logins, purchases,
-- edits) until the transaction commits; lock_timeout bounds the wait for it.
--
-- Replays every pickle_ledger row with created_at >= the 2026-11 start and
-- delta > 0, in (created_at, id) order, through the trigger's own function
-- (_pl_track_xp_from_ledger), so everything works as if live: half the
-- pickles of the 4 play sources, no daily cap, logins (claim_daily_login_streak)
-- +5 once per Pacific day, guests and test accounts 0. Tiers reached get their
-- grant rows (paid on the next open of Home or the Court Pass, as always).
-- Skips itself if any XP event exists (a re-run, or the trigger has been live
-- for a while). The apply script prints the totals after commit.
-- ============================================================
do $$
declare
  v_start timestamptz;
  r       public.pickle_ledger;
  v_n     integer := 0;
  v_who   integer;
  v_xp    bigint;
  v_tiers integer;
begin
  if exists (select 1 from public.reward_track_xp_events) then
    raise notice 'court pass catch-up: XP already recorded, skipped';
    return;
  end if;
  select c.starts_at into v_start from public.reward_track_cycles c where c.id = '2026-11';
  if v_start is null then
    raise exception 'court pass catch-up: cycle 2026-11 is not seeded; apply migration_court_pass_cycles_2026_11.sql in the same transaction first';
  end if;
  for r in
    select * from public.pickle_ledger l
     where l.created_at >= v_start and l.delta > 0
     order by l.created_at, l.id
  loop
    perform public._pl_track_xp_from_ledger(r);
    v_n := v_n + 1;
  end loop;
  select count(*) filter (where x.xp > 0), coalesce(sum(x.xp), 0) into v_who, v_xp
    from public.reward_track_xp x;
  select count(*) into v_tiers from public.reward_track_grants;
  raise notice 'court pass catch-up: % ledger rows replayed: % people, % pickleballs, % tiers reached (paid on their next open)',
    v_n, v_who, v_xp, v_tiers;
end;
$$;

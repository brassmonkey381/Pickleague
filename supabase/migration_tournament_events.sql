-- migration_tournament_events.sql: PKL-054. A log of what happens in a tournament,
-- so any tournament can be replayed in order (simulations/replay-tournament.ts).
--
-- Brian, 2026-11-19: "make it a tool we can use for every tournament". The
-- replay is rebuilt from the tournament's own rows. Most moments already have a
-- timestamp (registered_at, rounds.created_at, matches.called_at /
-- completed_at, notifications.created_at), but these were lost:
--   - who entered a score, and every score correction (only the last one stays)
--   - court calls and court changes (called_at is overwritten)
--   - cancelled / reopened matches, and bracket slots filling in
--   - the tournament's status changes (draft -> registration -> active -> done)
--   - settings edits (courts, pools, playoff, prize, ante, start time ...)
--   - registration approvals, role and seed changes
--   - the admin's tie order (PKL-052)
-- From now on each of those writes one tournament_events row.
--
-- Rules:
--   at    = now(), the transaction time. Notifications a write causes share the
--           same created_at, so the replay hangs each alert under its cause.
--   actor = auth.uid(): the signed-in person who made the write (null = the
--           server: service role, cron, a trigger with no user).
--   Logging never blocks play: a failed insert is swallowed (warning only).
--   Only INSERT and UPDATE are logged, never DELETE, so deleting a tournament
--   (which cascades) can't trip over its own log. Rows go with the tournament.
-- Safe to re-run.

create table if not exists public.tournament_events (
  id            bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  at            timestamptz not null default now(),
  actor         uuid,
  kind          text not null,
  match_id      uuid,
  user_id       uuid,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists tournament_events_t_at on public.tournament_events (tournament_id, at, id);

alter table public.tournament_events enable row level security;
drop policy if exists tournament_events_read on public.tournament_events;
-- Readable wherever the tournament is (the subquery runs under the reader's RLS).
create policy tournament_events_read on public.tournament_events
  for select to authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_events.tournament_id));
-- No write policies: only the triggers below write. Supabase's default
-- privileges grant every new table to anon; take that back.
revoke all on public.tournament_events from public, anon, authenticated;
grant select on public.tournament_events to authenticated;

-- Internal: write one row, never fail the caller.
create or replace function public._pl_tev(p_tournament_id uuid, p_kind text, p_match_id uuid, p_user_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tournament_events (tournament_id, actor, kind, match_id, user_id, data)
  values (p_tournament_id, auth.uid(), p_kind, p_match_id, p_user_id, coalesce(p_data, '{}'::jsonb));
exception when others then
  raise warning 'tournament_events: % (%)', sqlerrm, p_kind;
end;
$$;
revoke execute on function public._pl_tev(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Internal: {col: [old, new]} for the listed columns that changed.
create or replace function public._pl_tev_diff(p_old jsonb, p_new jsonb, p_cols text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c, jsonb_build_array(p_old -> c, p_new -> c)), '{}'::jsonb)
    from unnest(p_cols) c
   where (p_old -> c) is distinct from (p_new -> c)
$$;
revoke execute on function public._pl_tev_diff(jsonb, jsonb, text[]) from public, anon, authenticated;

-- ── tournament_matches ──────────────────────────────────────────────────────
create or replace function public._pl_tev_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  v_score jsonb;
  v_slots jsonb;
  v_court jsonb;
begin
  v_score := public._pl_tev_diff(o, n, array['team1_score', 'team2_score', 'winner_team', 'game_scores', 'status']);
  v_slots := public._pl_tev_diff(o, n, array['team1_player1', 'team1_player2', 'team2_player1', 'team2_player2']);
  v_court := public._pl_tev_diff(o, n, array['court', 'called_at', 'play_round', 'scheduled_at']);

  if v_score <> '{}'::jsonb then
    perform public._pl_tev(new.tournament_id,
      case
        when old.status = 'completed' and new.status = 'completed' then 'score_edited'
        when new.status = 'completed' then 'match_scored'
        when new.status = 'cancelled' then 'match_cancelled'
        when old.status in ('completed', 'cancelled') then 'match_reopened'
        else 'match_status'
      end,
      new.id, null,
      v_score || jsonb_build_object('score', jsonb_build_array(new.team1_score, new.team2_score)));
  end if;
  if v_slots <> '{}'::jsonb then
    perform public._pl_tev(new.tournament_id, 'slots_filled', new.id, null, v_slots);
  end if;
  if v_court <> '{}'::jsonb then
    perform public._pl_tev(new.tournament_id,
      case when (o -> 'called_at') is distinct from (n -> 'called_at') and new.called_at is not null
           then 'match_called' else 'court_changed' end,
      new.id, null, v_court);
  end if;
  return null;
end;
$$;
revoke execute on function public._pl_tev_match() from public, anon, authenticated;
drop trigger if exists trg_tev_match on public.tournament_matches;
create trigger trg_tev_match after update on public.tournament_matches
  for each row execute function public._pl_tev_match();

-- ── tournament_rounds: a pool, a round, a playoff stage appears ─────────────
create or replace function public._pl_tev_round()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_tev(new.tournament_id, 'round_added', null, null,
    jsonb_build_object('round_id', new.id, 'label', new.label, 'round_type', new.round_type, 'round_number', new.round_number));
  return null;
end;
$$;
revoke execute on function public._pl_tev_round() from public, anon, authenticated;
drop trigger if exists trg_tev_round on public.tournament_rounds;
create trigger trg_tev_round after insert on public.tournament_rounds
  for each row execute function public._pl_tev_round();

-- ── tournaments: created, status, settings ──────────────────────────────────
create or replace function public._pl_tev_tournament()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set jsonb;
begin
  if tg_op = 'INSERT' then
    perform public._pl_tev(new.id, 'tournament_created', null, null,
      jsonb_build_object('status', new.status, 'format', new.format, 'match_type', new.match_type));
    return null;
  end if;
  if old.status is distinct from new.status then
    perform public._pl_tev(new.id, 'tournament_status', null, null,
      jsonb_build_object('status', jsonb_build_array(old.status, new.status)));
  end if;
  v_set := public._pl_tev_diff(to_jsonb(old), to_jsonb(new), array[
    'name', 'description', 'format', 'match_type', 'seeding', 'pool_count', 'partner_rotation',
    'registration_mode', 'max_players', 'min_players', 'start_time', 'location_name',
    'bracket_release_time', 'prize_pool', 'pickle_ante', 'payout_structure', 'expected_length_hours',
    'mlp_play_format', 'mlp_pool_count', 'mlp_playoff_teams', 'playoff_format', 'team_creation',
    'playoff_third_place', 'registration_closes_at', 'courts']);
  if v_set <> '{}'::jsonb then
    perform public._pl_tev(new.id, 'settings_changed', null, null, v_set);
  end if;
  return null;
end;
$$;
revoke execute on function public._pl_tev_tournament() from public, anon, authenticated;
drop trigger if exists trg_tev_tournament on public.tournaments;
create trigger trg_tev_tournament after insert or update on public.tournaments
  for each row execute function public._pl_tev_tournament();

-- ── tournament_registrations: joins, approvals, roles, seeds ────────────────
create or replace function public._pl_tev_registration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chg jsonb;
begin
  if tg_op = 'INSERT' then
    perform public._pl_tev(new.tournament_id, 'registered', null, new.user_id,
      jsonb_build_object('status', new.status, 'role', new.role, 'seed', new.seed));
    return null;
  end if;
  v_chg := public._pl_tev_diff(to_jsonb(old), to_jsonb(new), array['status', 'role', 'seed']);
  if v_chg <> '{}'::jsonb then
    perform public._pl_tev(new.tournament_id, 'registration_changed', null, new.user_id, v_chg);
  end if;
  return null;
end;
$$;
revoke execute on function public._pl_tev_registration() from public, anon, authenticated;
drop trigger if exists trg_tev_registration on public.tournament_registrations;
create trigger trg_tev_registration after insert or update on public.tournament_registrations
  for each row execute function public._pl_tev_registration();

-- ── tournament_tie_orders (PKL-052): one row per entrant placed ─────────────
create or replace function public._pl_tev_tie()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_tev(new.tournament_id, 'tie_rank_set', null, null,
    jsonb_build_object('entrant_key', new.entrant_key, 'tie_rank', new.tie_rank));
  return null;
end;
$$;
revoke execute on function public._pl_tev_tie() from public, anon, authenticated;
do $$
begin
  if to_regclass('public.tournament_tie_orders') is null then
    raise exception 'PKL-054 needs PKL-052 first (migration_tournament_tiebreak_admin.sql)';
  end if;
  drop trigger if exists trg_tev_tie on public.tournament_tie_orders;
  create trigger trg_tev_tie after insert or update on public.tournament_tie_orders
    for each row execute function public._pl_tev_tie();
end $$;

-- ============================================================
-- My Place stays (2026-11-05): Doggle's home visit stays
-- (doggle/db/migrations/0520_home_visit_stays.sql, docs/home-visit-stays.md
-- "Porting to Pickleague"). In Pickleague the player's avatar is the one that
-- goes to stay (Brian, 2026-11-05).
--
-- Brian's decisions (2026-11-05):
--   * A stay is 4 hours at a friend's My Place, one at a time. While away my
--     avatar is missing from my own place, which says where it is.
--   * When it ends, my next Home open shows it once: +15 pickles INSIDE the
--     500/day play cap (_pl_play_cap_left), a souvenir line, and a 1 in 4
--     chance of My Place decor I don't own (non-seasonal, sold for pickles,
--     common or rare; rare a third as often). Pickleague's paddles and balls
--     are My Place decor (paddle racks, ball jar, ball hopper...), so the
--     pool is home_items.
--   * While a Court Pass cycle runs, a full stay also earns 5 pickleballs
--     (_pl_track_add_xp, source 'place_stay', keyed on the stay id, so a
--     replay adds nothing; 0 with no cycle, for guests and test accounts).
--     Not through reward_track_xp_sources: that would tie it to the pickles
--     the daily cap left. reward_track_xp_events' source CHECK gains
--     'place_stay'.
--   * "Bring me home early" pays nothing. So does a stay cut short by an
--     unfriend, a block, the host making their place Only me, or either
--     account being deleted.
--
-- ── Table ──────────────────────────────────────────────────────────────────
--   place_stays (id, visitor_id, host_id, created_at, ends_at, returned_at,
--     ended_early, seen_at, souvenir, item_id, pickles, pickleballs). One open stay per
--     visitor (returned_at is null). Rows are kept as history. RLS on, no
--     policies: read and written only through the RPCs below.
--
-- ── Client RPCs (SECURITY DEFINER, search_path '', authenticated only, in
--    the migration_rls_hardening_2026q3.sql allowlist) ─────────────────────
--   visit_place(p_host uuid) -> jsonb {ends_at, host_id, host_label}
--     Starts a 4-hour stay. A finished stay of mine is settled first; asking
--     again for the host I'm already at answers that stay. Refused like
--     get_home (home.unavailable / home.guest / home.private /
--     home.friends_only, player.gone), plus stay.self (my own place) and
--     stay.elsewhere (I'm staying somewhere else; DETAIL {host_label}).
--   leave_place() -> jsonb {ended: bool, early: bool}
--     Bring me home: early = no reward. A stay already over is settled with
--     its reward (shown at the next claim). Nothing open: ended false.
--   claim_place_stay_returns() -> jsonb [{stay_id, host_id, host_label,
--     souvenir, pickles, pickleballs, returned_at, item_id, item_name,
--     item_rarity}]
--     Settles every finished stay of mine and returns, once each, the ones
--     not shown yet (oldest first). Home calls it on focus.
--   get_place_stays(p_owner uuid default null) -> jsonb {away, guests}
--     away: the owner's own stay in progress {host_id, host_label, ends_at}
--     or null; guests: [{visitor_id, name, ends_at, avatar_url, avatar_emoji,
--     avatar_bg_color, avatar_id}] staying at the owner's
--     place now. Mine, or a friend's whose place I may visit (as get_home);
--     anyone else gets {away: null, guests: []}, never an error, so a
--     profile preview can always ask.
--
-- ── Pickles ────────────────────────────────────────────────────────────────
--   _pl_settle_place_stay pays least(15, _pl_play_cap_left) and records what
--   landed; its name joins the play sources in _pl_play_cap_left and
--   _pl_profiles_play_cap (bodies from migration_fair_rewards.sql, the
--   latest), and pickle_ledger_sources labels it "My Place stay".
--
-- New refusal codes (mobile/src/lib/refusals.ts): stay.self, stay.elsewhere.
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_place_stays.sql
-- Tested by supabase/tests/place_stays_personas.sql (build-place-stays-test.mjs).
-- ============================================================


-- ════ 1. The table ═══════════════════════════════════════════════════════
create table if not exists public.place_stays (
  id          uuid primary key default gen_random_uuid(),
  visitor_id  uuid not null references public.profiles (id) on delete cascade,
  host_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  returned_at timestamptz,
  ended_early boolean not null default false,
  seen_at     timestamptz,
  souvenir    text,
  item_id     text references public.home_items (id) on delete set null,
  pickles     integer not null default 0,
  constraint place_stays_not_self check (visitor_id <> host_id),
  constraint place_stays_pickles_chk check (pickles >= 0)
);
alter table public.place_stays add column if not exists pickleballs integer not null default 0;
comment on table public.place_stays is
  'migration_place_stays.sql: a player''s avatar staying 4 hours at a friend''s My Place. Kept as history; RPCs only.';
create unique index if not exists place_stays_one_open_idx on public.place_stays (visitor_id) where returned_at is null;
create index if not exists place_stays_host_open_idx on public.place_stays (host_id) where returned_at is null;
create index if not exists place_stays_unseen_idx on public.place_stays (visitor_id) where seen_at is null;

do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.place_stays'::regclass) then
    alter table public.place_stays enable row level security;
  end if;
end $$;
revoke all on table public.place_stays from public, anon, authenticated;
grant all on table public.place_stays to service_role;

-- Court Pass earns from a stay (migration_court_pass_tables.sql allowed only
-- 'ledger' and 'login'). NOT VALID then VALIDATE: no long lock on a re-run.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'reward_track_xp_events_source_chk'
                    and pg_get_constraintdef(oid) like '%place_stay%') then
    alter table public.reward_track_xp_events drop constraint if exists reward_track_xp_events_source_chk;
    alter table public.reward_track_xp_events add constraint reward_track_xp_events_source_chk
      check (source in ('ledger', 'login', 'place_stay')) not valid;
    alter table public.reward_track_xp_events validate constraint reward_track_xp_events_source_chk;
  end if;
end $$;


-- ════ 2. Helpers ═════════════════════════════════════════════════════════

-- How a host's place reads in copy: "Sam's place", else "your friend's place".
create or replace function public._pl_place_host_label(p_host uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(split_part(btrim(p.full_name), ' ', 1), '') || '''s place'
       from public.profiles p where p.id = p_host and p.deleted_at is null),
    'your friend''s place');
$$;
revoke all on function public._pl_place_host_label(uuid) from public, anon, authenticated;

-- Why I can't stay at (or see the stays of) p_host's place: a refusal code
-- as get_home raises it, or null when I can. Not for my own place.
create or replace function public._pl_place_visit_refusal(p_me uuid, p_host uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vis text;
begin
  if not exists (select 1 from public.profiles p where p.id = p_host and p.deleted_at is null) then
    return 'player.gone';
  end if;
  if public._pl_blocked_pair(p_me, p_host) then return 'home.unavailable'; end if;
  if public._pl_presence_viewer_is_guest(p_me) then return 'home.guest'; end if;
  select s.visibility into v_vis from public.home_settings s where s.owner_id = p_host;
  if coalesce(v_vis, 'friends') = 'only_me' then return 'home.private'; end if;
  if not public.are_friends(p_me, p_host) then return 'home.friends_only'; end if;
  return null;
end $$;
revoke all on function public._pl_place_visit_refusal(uuid, uuid) from public, anon, authenticated;

-- Settle one stay that has run its 4 hours: pickles (inside the daily play
-- cap), a souvenir line, maybe a decor item. Does nothing to a stay still
-- running or already returned. Its name is a play source (section 4).
create or replace function public._pl_settle_place_stay(p_stay uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.place_stays;
  v_host  text;
  v_pay   integer;
  v_balls integer := 0;
  v_item  text;
  v_lines text[] := array[
    'You came back from %1$s with a ball that has seen things.',
    'You picked up a new grip trick at %1$s.',
    'You and the couch at %1$s are close now.',
    'You came home from %1$s humming the kitchen line song.',
    'You found a spare overgrip at %1$s. Finders keepers.',
    'You lost a dinking rally to a houseplant at %1$s. A rematch is planned.',
    'You brought back a scorecard from %1$s. The score is a secret.',
    'You napped by the paddle rack at %1$s.',
    'You studied every poster at %1$s and have notes.',
    'You came back from %1$s ready for a third shot drop.'
  ];
begin
  select * into v_row from public.place_stays s where s.id = p_stay for update;
  if v_row.id is null or v_row.returned_at is not null or v_row.ends_at > now() then return; end if;

  v_host := public._pl_place_host_label(v_row.host_id);

  v_pay := greatest(least(15, public._pl_play_cap_left(v_row.visitor_id)), 0);
  if v_pay > 0 then
    perform set_config('pl.pickle_reason', 'My Place stay at ' || v_host, true);
    update public.profiles set pickles = coalesce(pickles, 0) + v_pay
     where id = v_row.visitor_id and deleted_at is null;
    if not found then v_pay := 0; end if;
    perform set_config('pl.pickle_reason', '', true);
  end if;

  -- Court Pass: 5 pickleballs while a cycle runs (0 otherwise). Never blocks the return.
  begin
    v_balls := coalesce(public._pl_track_add_xp(v_row.visitor_id, now(), 'place_stay', v_row.id::text, 5, null), 0);
  exception when others then
    raise warning 'place stay %: no pickleballs (%: %)', p_stay, sqlstate, sqlerrm;
    v_balls := 0;
  end;

  -- 1 in 4: decor I don't own yet (rare ones a third as often).
  if random() < 0.25 then
    select i.id into v_item
      from public.home_items i
     where i.season is null
       and i.cost > 0
       and not i.is_starter
       and i.rarity in ('common', 'rare')
       and (i.available_from is null or i.available_from <= now())
       and (i.available_until is null or i.available_until > now())
       and not exists (select 1 from public.home_owned_items o where o.owner_id = v_row.visitor_id and o.item_id = i.id)
     order by random() * case when i.rarity = 'rare' then 3 else 1 end
     limit 1;
    if v_item is not null then
      insert into public.home_owned_items (owner_id, item_id, cost_paid, source)
      values (v_row.visitor_id, v_item, 0, 'grant')
      on conflict (owner_id, item_id) do nothing;
    end if;
  end if;

  update public.place_stays
     set returned_at = v_row.ends_at,
         pickles     = v_pay,
         pickleballs = v_balls,
         souvenir    = format(v_lines[1 + floor(random() * array_length(v_lines, 1))::int], v_host),
         item_id     = v_item
   where id = p_stay;
end $$;
revoke all on function public._pl_settle_place_stay(uuid) from public, anon, authenticated;

-- End stays early (no reward), for the cases a stay can't go on.
create or replace function public._pl_end_place_stays(p_where text, p_a uuid, p_b uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.place_stays s
     set returned_at = now(), ended_early = true, seen_at = now()
   where s.returned_at is null
     and case p_where
           -- Everything p_a is part of (an account deleted).
           when 'account' then s.visitor_id = p_a or s.host_id = p_a
           -- Between p_a and p_b either way (an unfriend, a block).
           when 'pair'    then (s.visitor_id = p_a and s.host_id = p_b) or (s.visitor_id = p_b and s.host_id = p_a)
           -- Everyone staying at p_a's place (it went Only me).
           when 'host'    then s.host_id = p_a
           else false
         end;
end $$;
revoke all on function public._pl_end_place_stays(text, uuid, uuid) from public, anon, authenticated;


-- ════ 3. Client RPCs ═════════════════════════════════════════════════════
create or replace function public.visit_place(p_host uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_why  text;
  v_name text;
  v_open public.place_stays;
  v_ends timestamptz;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_host is null or p_host = v_me then
    raise exception using message = 'That''s your own place. Visit a friend''s place to stay there.', hint = 'pl:stay.self';
  end if;
  v_why := public._pl_place_visit_refusal(v_me, p_host);
  if v_why is not null then
    select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'This player') into v_name
      from public.profiles p where p.id = p_host;
    raise exception using
      message = case v_why
        when 'player.gone'       then 'That account isn''t in Pickleague any more, so there''s no My Place to visit. Go back and pick someone else.'
        when 'home.unavailable'  then 'This My Place isn''t available. Go back and visit someone else''s.'
        when 'home.guest'        then 'Visiting other players'' places needs a full Pickleague account. Finish signing up, then come back.'
        when 'home.private'      then v_name || ' keeps My Place to themselves right now, so it can''t be visited. Visit a friend''s place instead.'
        else v_name || ' shares My Place with friends only. Send them a friend request; once they accept, you can visit.'
      end,
      detail = case when v_why in ('home.private', 'home.friends_only') then jsonb_build_object('name', v_name)::text end,
      hint   = 'pl:' || v_why;
  end if;

  -- One stay at a time per player (serialized by the open-stay row lock).
  perform pg_advisory_xact_lock(hashtext('place_stay:' || v_me::text));
  select * into v_open from public.place_stays s where s.visitor_id = v_me and s.returned_at is null;
  if v_open.id is not null and v_open.ends_at <= now() then
    perform public._pl_settle_place_stay(v_open.id);
    v_open := null;
  end if;
  if v_open.id is not null then
    if v_open.host_id = p_host then
      return jsonb_build_object('ends_at', v_open.ends_at, 'host_id', p_host, 'host_label', public._pl_place_host_label(p_host));
    end if;
    raise exception using
      message = 'You''re staying at ' || public._pl_place_host_label(v_open.host_id) || ' right now. Come home first, then visit here.',
      detail  = jsonb_build_object('host_label', public._pl_place_host_label(v_open.host_id))::text,
      hint    = 'pl:stay.elsewhere';
  end if;

  insert into public.place_stays (visitor_id, host_id, ends_at)
  values (v_me, p_host, now() + interval '4 hours')
  returning ends_at into v_ends;
  return jsonb_build_object('ends_at', v_ends, 'host_id', p_host, 'host_label', public._pl_place_host_label(p_host));
end $$;
revoke all on function public.visit_place(uuid) from public, anon;
grant execute on function public.visit_place(uuid) to authenticated;

create or replace function public.leave_place()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_open public.place_stays;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  perform pg_advisory_xact_lock(hashtext('place_stay:' || v_me::text));
  select * into v_open from public.place_stays s where s.visitor_id = v_me and s.returned_at is null;
  if v_open.id is null then
    return jsonb_build_object('ended', false, 'early', false);
  end if;
  if v_open.ends_at <= now() then
    perform public._pl_settle_place_stay(v_open.id);
    return jsonb_build_object('ended', true, 'early', false);
  end if;
  update public.place_stays
     set returned_at = now(), ended_early = true, seen_at = now()
   where id = v_open.id;
  return jsonb_build_object('ended', true, 'early', true);
end $$;
revoke all on function public.leave_place() from public, anon;
grant execute on function public.leave_place() to authenticated;

create or replace function public.claim_place_stay_returns()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_id  uuid;
  v_out jsonb;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  perform pg_advisory_xact_lock(hashtext('place_stay:' || v_me::text));
  for v_id in
    select s.id from public.place_stays s
     where s.visitor_id = v_me and s.returned_at is null and s.ends_at <= now()
  loop
    perform public._pl_settle_place_stay(v_id);
  end loop;

  with shown as (
    update public.place_stays s set seen_at = now()
     where s.visitor_id = v_me and s.returned_at is not null and not s.ended_early and s.seen_at is null
    returning s.id, s.host_id, s.souvenir, s.pickles, s.pickleballs, s.returned_at, s.item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'stay_id',     x.id,
           'host_id',     x.host_id,
           'host_label',  public._pl_place_host_label(x.host_id),
           'souvenir',    x.souvenir,
           'pickles',     x.pickles,
           'pickleballs', x.pickleballs,
           'returned_at', x.returned_at,
           'item_id',     i.id,
           'item_name',   i.name,
           'item_rarity', i.rarity) order by x.returned_at), '[]'::jsonb)
    into v_out
    from shown x
    left join public.home_items i on i.id = x.item_id;
  return v_out;
end $$;
revoke all on function public.claim_place_stay_returns() from public, anon;
grant execute on function public.claim_place_stay_returns() to authenticated;

create or replace function public.get_place_stays(p_owner uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid := coalesce(p_owner, auth.uid());
  v_away  jsonb;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if v_owner <> v_me and public._pl_place_visit_refusal(v_me, v_owner) is not null then
    return jsonb_build_object('away', null, 'guests', '[]'::jsonb);
  end if;

  select jsonb_build_object('host_id', s.host_id, 'host_label', public._pl_place_host_label(s.host_id), 'ends_at', s.ends_at)
    into v_away
    from public.place_stays s
   where s.visitor_id = v_owner and s.returned_at is null and s.ends_at > now();

  return jsonb_build_object(
    'away', v_away,
    'guests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'visitor_id', s.visitor_id,
               'name',       coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'A friend'),
               'ends_at',    s.ends_at,
               -- How the room draws the guest (as the profile's own avatar).
               'avatar_url',      p.avatar_url,
               'avatar_emoji',    p.avatar_emoji,
               'avatar_bg_color', p.avatar_bg_color,
               'avatar_id',       p.avatar_id) order by s.ends_at)
        from public.place_stays s
        join public.profiles p on p.id = s.visitor_id and p.deleted_at is null
       where s.host_id = v_owner and s.returned_at is null and s.ends_at > now()
         -- A guest blocked by me (or blocking me) isn't listed to me.
         and (s.visitor_id = v_me or not public._pl_blocked_pair(v_me, s.visitor_id))), '[]'::jsonb));
end $$;
revoke all on function public.get_place_stays(uuid) from public, anon;
grant execute on function public.get_place_stays(uuid) to authenticated;


-- ════ 4. The daily play cap counts stays ═════════════════════════════════
-- From migration_fair_rewards.sql (the latest). Changed: '_pl_settle_place_stay'
-- joins both play-source lists.
create or replace function public._pl_play_cap_left(p_uid uuid)
returns integer
language plpgsql
volatile    -- sees the rows earlier grants of the same transaction wrote
security definer
set search_path = ''
as $$
declare
  v_tz    text := public._pickleague_tz_for(p_uid);
  v_start timestamptz := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_paid  integer;
begin
  select coalesce(sum(l.delta), 0)::integer into v_paid
    from public.pickle_ledger l
   where l.profile_id = p_uid
     and l.created_at >= v_start
     and l.delta > 0
     and l.source = any (array[
       '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
       '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
       '_grant_new_opponent_bonus', '_grant_checkin_match_bonus', '_pl_settle_place_stay']);
  return greatest(500 - v_paid, 0);
end $$;
revoke execute on function public._pl_play_cap_left(uuid) from public, anon, authenticated;

create or replace function public._pl_profiles_play_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src  text;
  v_left integer;
begin
  if coalesce(new.pickles, 0) <= coalesce(old.pickles, 0) then
    return new;
  end if;
  begin
    v_src := public._pl_play_source();
    if v_src = any (array[
         '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
         '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
         '_grant_new_opponent_bonus', '_grant_checkin_match_bonus', '_pl_settle_place_stay']) then
      v_left := public._pl_play_cap_left(new.id);
      if new.pickles - coalesce(old.pickles, 0) > v_left then
        new.pickles := coalesce(old.pickles, 0) + v_left;
      end if;
    end if;
  exception when others then
    raise warning 'play cap: left a % pickles raise on profile % unchecked (%: %)',
      new.pickles - coalesce(old.pickles, 0), new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._pl_profiles_play_cap() from public, anon, authenticated;

insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('_pl_settle_place_stay', 1, 'My Place stay', 'earn', 'my_place', false, 'pay for a finished stay at a friend''s place, inside the daily cap')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;


-- ════ 5. Stays that can't go on end early ════════════════════════════════
create or replace function public._pl_place_stays_on_friendship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'accepted' and (tg_op = 'DELETE' or new.status is distinct from 'accepted') then
    perform public._pl_end_place_stays('pair', old.requester_id, old.addressee_id);
  end if;
  return null;
end $$;
revoke all on function public._pl_place_stays_on_friendship() from public, anon, authenticated;

create or replace trigger trg_friendships_place_stays
  after update of status or delete on public.friendships
  for each row execute function public._pl_place_stays_on_friendship();

create or replace function public._pl_place_stays_on_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_end_place_stays('pair', new.blocker_id, new.blocked_id);
  return null;
end $$;
revoke all on function public._pl_place_stays_on_block() from public, anon, authenticated;

create or replace trigger trg_user_blocks_place_stays
  after insert on public.user_blocks
  for each row execute function public._pl_place_stays_on_block();

create or replace function public._pl_place_stays_on_private()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.visibility = 'only_me' and (tg_op = 'INSERT' or old.visibility is distinct from 'only_me') then
    perform public._pl_end_place_stays('host', new.owner_id);
  end if;
  return null;
end $$;
revoke all on function public._pl_place_stays_on_private() from public, anon, authenticated;

create or replace trigger trg_home_settings_place_stays
  after insert or update of visibility on public.home_settings
  for each row execute function public._pl_place_stays_on_private();

create or replace function public._pl_place_stays_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_end_place_stays('account', new.id);
  return null;
end $$;
revoke all on function public._pl_place_stays_on_delete() from public, anon, authenticated;

create or replace trigger trg_profiles_place_stays_purge
  after update on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public._pl_place_stays_on_delete();

notify pgrst, 'reload schema';

-- ============================================================
-- Presence Phase 1, file 4 of 5: mutual friends. Apply order: see
-- migration_presence_p1_schema.sql (the friendships, close_friends and
-- friend_request_log tables are created there, because the privacy helpers
-- read them).
--
-- Lifecycle of one pair (one friendships row, either direction):
--   none ──send──────────────────▶ pending   ("🤝 Sam wants to be friends")
--   pending ──their send────────▶ accepted  (crossing requests auto-accept)
--   pending ──accept────────────▶ accepted  ("🤝 Sam accepted your friend request")
--   pending ──decline───────────▶ declined  (a re-request within 30 days is
--                                           stored pending but notifies nobody)
--   pending ──cancel────────────▶ (deleted)
--   accepted ──remove_friend────▶ (deleted, silent; stars cleared both ways)
--   any ──block either way──────▶ (deleted with stars and notices; hide-from
--                                           rows stay, so a hide survives an unblock)
-- When a request leaves pending its "wants to be friends" notice is deleted
-- (the league join requests convention), so its push and bell row go too.
--
-- Real people only: requests refuse yourself, guest passes, unclaimed DUPR
-- placeholders (claim_my_dupr_profile deletes those, request and all),
-- deleted accounts and blocked pairs. A sender may send 20 a day (their local
-- day) and pushes the same person at most once a day (cancel then re-send is
-- quiet).
--
-- Notices: type 'info', category 'notifyFriendRequests', entity_type
-- 'friend', push_data.kind 'friend_request' (entity = requester, deep link
-- friends/-, Accept / Decline buttons from send-push while still pending) or
-- 'friend_accepted' (entity = accepter, deep link player/<id>, no buttons).
-- ============================================================


-- ── 1. Internal helpers ────────────────────────────────────────────────────
create or replace function public._pl_display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select nullif(trim(p.full_name), '') from public.profiles p
                    where p.id = p_user and p.deleted_at is null), 'A player');
$$;
revoke all on function public._pl_display_name(uuid) from public, anon, authenticated;

-- Someone a friend request may reach: a real, signed-up, live account.
create or replace function public._pl_friendable(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_user and not p.is_guest and not p.is_unclaimed and p.deleted_at is null
  );
$$;
revoke all on function public._pl_friendable(uuid) from public, anon, authenticated;

-- Serializes everything that touches one pair (crossing requests).
create or replace function public._pl_lock_pair(a uuid, b uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtext('friend:' || least(a, b)::text || ':' || greatest(a, b)::text));
$$;
revoke all on function public._pl_lock_pair(uuid, uuid) from public, anon, authenticated;

create or replace function public._pl_notify_friend(p_to uuid, p_from uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := public._pl_display_name(p_from);
begin
  if p_kind = 'friend_request' then
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (p_to, '🤝 ' || v_name || ' wants to be friends', 'Accept to see each other at the courts.',
            'info', p_from, 'friend', 'notifyFriendRequests',
            jsonb_build_object('kind', 'friend_request', 'deep_link', 'friends/-', 'requester_id', p_from));
  elsif p_kind = 'friend_accepted' then
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (p_to, '🤝 ' || v_name || ' accepted your friend request', 'You''ll see each other at the courts now.',
            'info', p_from, 'friend', 'notifyFriendRequests',
            jsonb_build_object('kind', 'friend_accepted', 'deep_link', 'player/' || p_from::text));
  end if;
exception when others then
  -- A notice problem must never undo the friendship change.
  raise warning '_pl_notify_friend failed: %', sqlerrm;
end $$;
revoke all on function public._pl_notify_friend(uuid, uuid, text) from public, anon, authenticated;

-- The addressee's "wants to be friends" notices from this requester (their
-- push_outbox rows cascade).
create or replace function public._pl_clear_friend_request_notices(p_requester uuid, p_addressee uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.notifications n
   where n.user_id = p_addressee
     and n.entity_type = 'friend'
     and n.entity_id = p_requester
     and n.push_data ->> 'kind' = 'friend_request';
$$;
revoke all on function public._pl_clear_friend_request_notices(uuid, uuid) from public, anon, authenticated;


-- ── 2. Requests ────────────────────────────────────────────────────────────
-- Returns 'pending' (sent), 'accepted' (they had asked me: now friends) or
-- 'already' (friends, or my request is still pending).
create or replace function public.send_friend_request(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_tz    text;
  v_quiet boolean;
  r       public.friendships;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_user is null then raise exception 'Player not found'; end if;
  if p_user = v_me then raise exception 'You can''t add yourself as a friend'; end if;
  if public._pl_presence_viewer_is_guest(v_me) then
    raise exception 'Create an account to add friends';
  end if;
  if not public._pl_friendable(p_user) or public.blocked_between(v_me, p_user) then
    raise exception 'This player isn''t available';
  end if;
  perform public._pl_lock_pair(v_me, p_user);

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);

  if r.status = 'accepted' then return 'already'; end if;
  if r.status = 'pending' then
    if r.requester_id = v_me then return 'already'; end if;
    -- They asked me first: this is a yes.
    update public.friendships set status = 'accepted', responded_at = now() where id = r.id;
    perform public._pl_clear_friend_request_notices(p_user, v_me);
    perform public._pl_notify_friend(p_user, v_me, 'friend_accepted');
    return 'accepted';
  end if;

  v_tz := public._pickleague_tz_for(v_me);
  if (select count(*) from public.friend_request_log l
       where l.sender_id = v_me
         and l.sent_at >= (date_trunc('day', now() at time zone v_tz) at time zone v_tz)) >= 20 then
    raise exception 'You''ve sent 20 friend requests today. Try again tomorrow.';
  end if;

  v_quiet := coalesce(r.status = 'declined' and r.requester_id = v_me
                      and r.responded_at > now() - interval '30 days', false)
          or exists (select 1 from public.friend_request_log l
                      where l.sender_id = v_me and l.addressee_id = p_user and l.notified
                        and l.sent_at > now() - interval '24 hours');

  if r.id is null then
    insert into public.friendships (requester_id, addressee_id) values (v_me, p_user);
  else
    update public.friendships
       set requester_id = v_me, addressee_id = p_user, status = 'pending',
           created_at = now(), responded_at = null
     where id = r.id;
  end if;
  insert into public.friend_request_log (sender_id, addressee_id, notified) values (v_me, p_user, not v_quiet);
  if not v_quiet then
    perform public._pl_notify_friend(p_user, v_me, 'friend_request');
  end if;
  return 'pending';
end $$;
revoke all on function public.send_friend_request(uuid) from public, anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- Answer p_user's request to me. Idempotent (lock-screen buttons replay):
-- 'accepted' | 'declined' when that is already the answer, 'gone' when there
-- is no request to answer (cancelled, blocked, deleted).
create or replace function public.respond_friend_request(p_user uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  r    public.friendships;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_user is null or p_user = v_me then return 'gone'; end if;
  perform public._pl_lock_pair(v_me, p_user);

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);
  if r.id is null or public.blocked_between(v_me, p_user) then return 'gone'; end if;
  if r.status = 'accepted' then return 'accepted'; end if;
  if r.requester_id <> p_user then return 'gone'; end if;   -- my own request to them
  if r.status = 'declined' then return 'declined'; end if;

  if coalesce(p_accept, false) then
    update public.friendships set status = 'accepted', responded_at = now() where id = r.id;
    perform public._pl_clear_friend_request_notices(p_user, v_me);
    perform public._pl_notify_friend(p_user, v_me, 'friend_accepted');
    return 'accepted';
  end if;
  update public.friendships set status = 'declined', responded_at = now() where id = r.id;
  perform public._pl_clear_friend_request_notices(p_user, v_me);
  return 'declined';
end $$;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;

-- Withdraw my pending request. Returns whether there was one.
create or replace function public.cancel_friend_request(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  perform public._pl_lock_pair(v_me, p_user);
  delete from public.friendships
   where requester_id = v_me and addressee_id = p_user and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public._pl_clear_friend_request_notices(v_me, p_user); end if;
  return v_n > 0;
end $$;
revoke all on function public.cancel_friend_request(uuid) from public, anon;
grant execute on function public.cancel_friend_request(uuid) to authenticated;

-- Silent. Clears the close-friend star both ways. Returns whether we were friends.
create or replace function public.remove_friend(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  perform public._pl_lock_pair(v_me, p_user);
  delete from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user)
     and f.status = 'accepted';
  get diagnostics v_n = row_count;
  delete from public.close_friends
   where (user_id = v_me and friend_id = p_user) or (user_id = p_user and friend_id = v_me);
  return v_n > 0;
end $$;
revoke all on function public.remove_friend(uuid) from public, anon;
grant execute on function public.remove_friend(uuid) to authenticated;

-- The ⭐ on an accepted friend. Returns whether they are starred now.
create or replace function public.set_close_friend(p_user uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not coalesce(p_on, true) then
    delete from public.close_friends where user_id = v_me and friend_id = p_user;
    return false;
  end if;
  if p_user is null or p_user = v_me or not public.are_friends(v_me, p_user) then
    raise exception 'Only friends can be close friends';
  end if;
  insert into public.close_friends (user_id, friend_id) values (v_me, p_user) on conflict do nothing;
  return true;
end $$;
revoke all on function public.set_close_friend(uuid, boolean) from public, anon;
grant execute on function public.set_close_friend(uuid, boolean) to authenticated;


-- ── 3. Reads ───────────────────────────────────────────────────────────────
-- {status, is_close_friend}. status: 'self' | 'friends' | 'pending_outgoing'
-- | 'pending_incoming' | 'none' | 'unavailable' (blocked either way, a guest,
-- an unclaimed placeholder or a deleted account, or I am a guest).
create or replace function public.friendship_status_with(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  r    public.friendships;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_user = v_me then return jsonb_build_object('status', 'self', 'is_close_friend', false); end if;
  if p_user is null or public._pl_presence_viewer_is_guest(v_me) or not public._pl_friendable(p_user)
     or public.blocked_between(v_me, p_user) then
    return jsonb_build_object('status', 'unavailable', 'is_close_friend', false);
  end if;

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);
  return jsonb_build_object(
    'status', case
                when r.status = 'accepted' then 'friends'
                when r.status = 'pending' and r.requester_id = v_me then 'pending_outgoing'
                when r.status = 'pending' then 'pending_incoming'
                else 'none'
              end,
    'is_close_friend', coalesce(r.status = 'accepted', false) and exists (
      select 1 from public.close_friends cf where cf.user_id = v_me and cf.friend_id = p_user));
end $$;
revoke all on function public.friendship_status_with(uuid) from public, anon;
grant execute on function public.friendship_status_with(uuid) to authenticated;

create or replace function public.list_my_friends()
returns table (user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text,
               doubles_rating numeric, is_close_friend boolean, since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color, p.doubles_rating,
         exists (select 1 from public.close_friends cf where cf.user_id = auth.uid() and cf.friend_id = p.id),
         coalesce(f.responded_at, f.created_at)
    from public.friendships f
    join public.profiles p
      on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
     and p.deleted_at is null
   where f.status = 'accepted'
     and auth.uid() in (f.requester_id, f.addressee_id)
     and not public.blocked_between(auth.uid(), p.id)
   order by lower(p.full_name);
$$;
revoke all on function public.list_my_friends() from public, anon;
grant execute on function public.list_my_friends() to authenticated;

create or replace function public.list_friend_requests()
returns table (user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text,
               doubles_rating numeric, direction text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color, p.doubles_rating,
         case when f.addressee_id = auth.uid() then 'incoming' else 'outgoing' end,
         f.created_at
    from public.friendships f
    join public.profiles p
      on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
     and p.deleted_at is null and not p.is_guest and not p.is_unclaimed
   where f.status = 'pending'
     and auth.uid() in (f.requester_id, f.addressee_id)
     and not public.blocked_between(auth.uid(), p.id)
   order by (f.addressee_id = auth.uid()) desc, f.created_at desc;
$$;
revoke all on function public.list_friend_requests() from public, anon;
grant execute on function public.list_friend_requests() to authenticated;

-- People I have really played with: completed matches together in the last
-- 180 days (any of the four player columns), drill sessions in the last 180
-- days, closed leagues we are both in (both admitted while it was closed, as
-- share_closed_league counts them). Ranked in that order (score packs the
-- three counts). Leaves out friends, pending requests, a decline in the last
-- 30 days, blocked pairs, guests, unclaimed placeholders and deleted accounts.
create or replace function public.suggest_friends(p_limit int default 10)
returns table (user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text,
               doubles_rating numeric, reason text, score int)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select auth.uid() as id
     where auth.uid() is not null and not public._pl_presence_viewer_is_guest(auth.uid())
  ),
  co_match as (
    select u.uid, count(distinct m.id) as n
      from me
      join public.matches m
        on me.id in (m.player1_id, m.partner1_id, m.player2_id, m.partner2_id)
       and m.status = 'completed'
       and m.played_at > now() - interval '180 days'
      cross join lateral unnest(array[m.player1_id, m.partner1_id, m.player2_id, m.partner2_id]) as u(uid)
     where u.uid is not null and u.uid <> me.id
     group by u.uid
  ),
  co_drill as (
    select case when d.player1_id = me.id then d.player2_id else d.player1_id end as uid, count(*) as n
      from me
      join public.drill_sessions d
        on me.id in (d.player1_id, d.player2_id)
       and d.session_date between current_date - 180 and current_date
     group by 1
  ),
  co_league as (
    select mb.user_id as uid, count(distinct l.id) as n, min(l.name) as league_name
      from me
      join public.league_members ma on ma.user_id = me.id and ma.admitted_closed
                                   and (ma.expires_at is null or ma.expires_at > now())
      join public.leagues l on l.id = ma.league_id and not l.is_open
      join public.league_members mb on mb.league_id = ma.league_id and mb.user_id <> me.id
                                   and mb.admitted_closed
                                   and (mb.expires_at is null or mb.expires_at > now())
     group by mb.user_id
  ),
  cand as (
    select x.uid, sum(x.m) as m, sum(x.d) as d, sum(x.l) as l, max(x.league_name) as league_name
      from (
        select uid, n as m, 0 as d, 0 as l, null::text as league_name from co_match
        union all select uid, 0, n, 0, null from co_drill
        union all select uid, 0, 0, n, league_name from co_league
      ) x
     group by x.uid
  )
  select p.id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color, p.doubles_rating,
         case when c.m > 0 then c.m || case when c.m = 1 then ' match together' else ' matches together' end
              when c.d > 0 then 'Drilled ' || c.d || 'x'
              else 'Both in ' || c.league_name end,
         (least(c.m, 99) * 10000 + least(c.d, 99) * 100 + least(c.l, 99))::int
    from cand c
    cross join me
    join public.profiles p on p.id = c.uid
   where not p.is_guest and not p.is_unclaimed and p.deleted_at is null
     and not public.blocked_between(me.id, p.id)
     and not exists (
       select 1 from public.friendships f
        where least(f.requester_id, f.addressee_id) = least(me.id, p.id)
          and greatest(f.requester_id, f.addressee_id) = greatest(me.id, p.id)
          and (f.status in ('pending', 'accepted') or f.responded_at > now() - interval '30 days'))
   order by 8 desc, lower(p.full_name)
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;
revoke all on function public.suggest_friends(int) from public, anon;
grant execute on function public.suggest_friends(int) to authenticated;


-- ── 4. Blocking tears it all down ──────────────────────────────────────────
-- Hide-from rows are kept: a block already hides names both ways
-- (_pl_can_see_presence treats the pair as strangers first), they must survive
-- an unblock, and deleting the blocked person's own row would both undo their
-- setting and tell them they were blocked.
create or replace function public._user_blocks_presence_teardown()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a uuid := new.blocker_id;
  b uuid := new.blocked_id;
begin
  delete from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(a, b)
     and greatest(f.requester_id, f.addressee_id) = greatest(a, b);
  delete from public.close_friends
   where (user_id = a and friend_id = b) or (user_id = b and friend_id = a);
  delete from public.notifications n
   where n.entity_type = 'friend'
     and ((n.user_id = a and n.entity_id = b) or (n.user_id = b and n.entity_id = a))
     and n.push_data ->> 'kind' in ('friend_request', 'friend_accepted');
  return null;
end $$;
revoke all on function public._user_blocks_presence_teardown() from public, anon, authenticated;

drop trigger if exists trg_user_blocks_presence_teardown on public.user_blocks;
create trigger trg_user_blocks_presence_teardown
  after insert on public.user_blocks
  for each row execute function public._user_blocks_presence_teardown();

notify pgrst, 'reload schema';

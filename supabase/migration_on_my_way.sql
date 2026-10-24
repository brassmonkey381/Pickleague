-- ============================================================
-- "On my way": tell friends you're heading to a court, about N minutes out.
-- Ported from Doggle (db/migrations/0425_on_my_way.sql, 0437, 0441, 0442) to
-- Pickleague's courts, with an ETA (the user, 2026-10-24: "an on my way
-- option, with a default 15 minutes away notification that you send to your
-- friends. It shouldn't be spam and the minutes should be easily set").
--
-- send_on_my_way(p_venue, p_eta_minutes default 15, p_recipients default null)
--   returns jsonb {sent, count, reason?, eta_minutes, venue_id, venue_name,
--                  sent_at?, retry_at?}
--
--   * p_venue: any court id; the facility's canonical id is used (a duplicate
--     row or an alias tells friends about the facility). Unknown, or
--     rejected by an admin (get_court calls that gone too, so the push's
--     link would open "That court isn't in Pickleague any more"): refused
--     with pl:court.gone.
--   * p_eta_minutes: 1..180, null = 15. Anything else: refused with
--     pl:omw.bad_eta (the app only offers 5-60).
--   * p_recipients: the friends picked in the app (at most 50, else
--     pl:omw.too_many). null = all my friends (at most 50: the ones I
--     starred first, then the rest by id), which is what the app's sheet
--     pre-ticks. Ids that aren't an accepted friend, are blocked either way,
--     deleted, a guest pass or unclaimed are ignored.
--     This is not a close-friend push: the star still only orders lists
--     (Phase 2 of docs/play-sessions-presence.md decides the close-friend
--     direction), so who is told never depends on a star.
--
--   Not spam (the user's decisions, 2026-10-24):
--   * One send per sender per court per 30 minutes. A second send inside the
--     window (a new ETA included) pushes nothing and answers
--     reason 'recent' with sent_at (the last send) and retry_at.
--   * One push per sender per friend per 30 minutes, whatever the court: a
--     friend already told in the window is skipped (and not counted). When
--     every friend picked was told already: reason 'recent_friends', with
--     retry_at (the earliest a skipped friend can be told again).
--   * Nobody to tell (no friend picked is still a friend, or no friends at
--     all): reason 'nobody', and the 30-minute window is not spent.
--   * The recipient's own switches decide the push: a phone registered, push
--     on (opt-in), and "Friends on the way" (notifyFriendsOnTheWay) not off
--     (_pl_push_reaches; send-push checks the same at send time). A friend it
--     can't reach is still counted as told, so the reply never reveals
--     anyone's settings.
--   * Blocked pairs never: neither way.
--   * The test-account switch (_pl_hide_test_accounts_for) is a discovery
--     rule; friends are never hidden, so it doesn't apply here.
--
-- The push goes straight into push_outbox (no notifications row: a
-- lock-screen notice, not an inbox item, like the court arrival pushes):
--   title  "<Name> is on the way to <Court>"
--   body   "About 15 min away. Tap to see the court."  ("about 1 hr" for 60)
--   kind 'info', category 'notifyFriendsOnTheWay', deep link 'home/-', push_data
--   {kind: 'on_my_way', venue_id, venue_name, sender_id, eta_minutes}, outbox
--   expires at the ETA (min 10 minutes): a push still pending after the
--   sender should have arrived says nothing.
--   The tap: builds with this feature read kind 'on_my_way' + venue_id (both
--   ride on the push already, send-push PASS_KEYS) and open the court's page
--   (lib/pushLinks linkOf -> 'court/<venue>'). 'home/-' is the link an older
--   bundle routes (Home, where the court cards are; the court arrival pushes
--   use it too), so a friend who hasn't got the OTA yet never lands on an
--   inbox that doesn't mention the push (KIND_LINKS' rule: keep a link the
--   older builds know).
--
-- Throttle rows (pl_throttle, scope = the sender's id): kind 'on_my_way' key
-- <canonical venue>, kind 'on_my_way_to' key <friend id>. _purge_account
-- and prune_presence_history already clear them (scope = the account / older
-- than 2 days), so neither is replaced here. No live function is replaced.
--
-- Needs (live already): pl_throttle + _pl_throttle_ok + _pl_push_reaches
-- (migration_court_arrival_queue.sql), push_outbox.push_data
-- (migration_push_data.sql), friendships / close_friends / _pl_friendable /
-- _pl_blocked_pair / _pl_display_name (migration_presence_p1_*.sql).
--
-- send_on_my_way is on the allowlist in migration_rls_hardening_2026q3.sql
-- and grants itself below. Re-runnable.
--
-- Apply (any order with the OTA: an older bundle opens Home):
--   supabase db query --linked -f supabase/migration_on_my_way.sql
-- Then redeploy send-push (notifyFriendsOnTheWay in KNOWN_PREF_KEYS):
--   supabase functions deploy send-push --no-verify-jwt
-- Test first: node supabase/tests/build-on-my-way-test.mjs
-- ============================================================


-- ── 1. Internal helpers ────────────────────────────────────────────────────

-- "15 min", "1 hr", "1 hr 30 min", "2 hr".
create or replace function public._pl_eta_label(p_minutes int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_minutes < 60 then p_minutes || ' min'
    when p_minutes % 60 = 0 then (p_minutes / 60) || ' hr'
    else (p_minutes / 60) || ' hr ' || (p_minutes % 60) || ' min'
  end;
$$;
revoke all on function public._pl_eta_label(int) from public, anon, authenticated;

-- The last time this sender used one throttle key, or null (a read: nothing
-- is recorded). The caller holds the sender's on-my-way lock.
create or replace function public._pl_omw_last(p_sender uuid, p_kind text, p_key text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select t.last_at from public.pl_throttle t
   where t.scope = p_sender::text and t.kind = p_kind and t.key = p_key;
$$;
revoke all on function public._pl_omw_last(uuid, text, text) from public, anon, authenticated;


-- ── 2. send_on_my_way ─────────────────────────────────────────────────────
-- Drop any other signature first, so PostgREST never has two to choose from.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'send_on_my_way'
       and p.oid is distinct from to_regprocedure('public.send_on_my_way(text,integer,uuid[])')::oid
  loop
    execute format('drop function %s', f);
  end loop;
end $$;

create or replace function public.send_on_my_way(
  p_venue       text,
  p_eta_minutes int default 15,
  p_recipients  uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_eta      int := coalesce(p_eta_minutes, 15);
  v_window   constant interval := interval '30 minutes';
  v_venue    text;
  v_court    text;
  v_status   text;
  v_last    timestamptz;
  v_title    text;
  v_body     text;
  v_expires  timestamptz;
  v_total    int := 0;
  v_told     int := 0;
  v_retry    timestamptz;
  v_ids      uuid[];
  v_fresh    uuid[];
  v_to       uuid;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if v_eta < 1 or v_eta > 180 then
    raise exception using
      message = 'Pick how far away you are: 1 minute to 3 hours.',
      hint = 'pl:omw.bad_eta',
      detail = jsonb_build_object('eta_minutes', p_eta_minutes)::text;
  end if;
  if p_recipients is not null and coalesce(cardinality(p_recipients), 0) > 50 then
    raise exception using message = 'You can tell up to 50 friends at once. Pick fewer friends, then send.', hint = 'pl:omw.too_many';
  end if;

  v_venue := public._pl_canonical_venue(p_venue);
  select nullif(trim(v.name), ''), v.confirmation_status into v_court, v_status
    from public.venues v where v.id = v_venue;
  if v_venue is null or not found or v_status = 'rejected' then
    raise exception using
      message = 'That court isn''t in Pickleague any more, so your friends can''t be told you''re on the way. Find your court again.',
      hint = 'pl:court.gone';
  end if;
  v_court := coalesce(v_court, 'the courts');

  -- One sender at a time: two quick taps (or two phones) can't both pass the
  -- window checks below.
  perform pg_advisory_xact_lock(hashtext('omw:' || v_me::text));

  -- Who would be told: accepted friends, real live accounts, not blocked
  -- either way. Picked ids, or (none picked) all my friends, starred first,
  -- at most 50. v_fresh: the
  -- ones not told by me (about any court) in the last 30 minutes.
  select coalesce(array_agg(x.id order by x.id), '{}'),
         coalesce(array_agg(x.id order by x.id) filter (
           where public._pl_omw_last(v_me, 'on_my_way_to', x.id::text) is null
              or public._pl_omw_last(v_me, 'on_my_way_to', x.id::text) <= now() - v_window), '{}')
    into v_ids, v_fresh
    from (
      select distinct y.id
        from (
          select unnest(p_recipients) as id where p_recipients is not null
          union all
          (select a.id from (
            select case when f.requester_id = v_me then f.addressee_id else f.requester_id end as id
              from public.friendships f
             where p_recipients is null
               and f.status = 'accepted'
               and (f.requester_id = v_me or f.addressee_id = v_me)
          ) a
           where public._pl_friendable(a.id)
             and not public._pl_blocked_pair(v_me, a.id)
           order by exists (select 1 from public.close_friends cf
                             where cf.user_id = v_me and cf.friend_id = a.id) desc, a.id
           limit 50)
        ) y
       where y.id is not null
         and y.id <> v_me
         and exists (
           select 1 from public.friendships f
            where f.status = 'accepted'
              and ((f.requester_id = v_me and f.addressee_id = y.id)
                   or (f.addressee_id = v_me and f.requester_id = y.id)))
         and public._pl_friendable(y.id)
         and not public._pl_blocked_pair(v_me, y.id)
    ) x;
  v_total := cardinality(v_ids);

  -- Nobody to tell: say so without spending the 30-minute window.
  if v_total = 0 then
    return jsonb_build_object('sent', false, 'count', 0, 'reason', 'nobody',
      'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court);
  end if;

  -- One send per court per 30 minutes, a new ETA included.
  v_last := public._pl_omw_last(v_me, 'on_my_way', v_venue);
  if v_last is not null and v_last > now() - v_window then
    return jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent',
      'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court,
      'sent_at', v_last, 'retry_at', v_last + v_window);
  end if;

  -- Every friend picked was told (about any court) in the last 30 minutes.
  if cardinality(v_fresh) = 0 then
    select min(public._pl_omw_last(v_me, 'on_my_way_to', i::text)) + v_window into v_retry from unnest(v_ids) i;
    return jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent_friends',
      'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court, 'retry_at', v_retry);
  end if;

  perform public._pl_throttle_ok(v_me::text, 'on_my_way', v_venue, v_window);

  v_title := public._pl_display_name(v_me) || ' is on the way to ' || v_court;
  v_body := 'About ' || public._pl_eta_label(v_eta) || ' away. Tap to see the court.';
  v_expires := now() + make_interval(mins => greatest(v_eta, 10));

  foreach v_to in array v_fresh loop
    perform public._pl_throttle_ok(v_me::text, 'on_my_way_to', v_to::text, v_window);
    v_told := v_told + 1;
    -- Their switches: no phone, push off or "Friends on the way" off sends
    -- nothing (counted all the same).
    if not public._pl_push_reaches(v_to, 'notifyFriendsOnTheWay') then
      continue;
    end if;
    begin
      insert into public.push_outbox
        (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
      values (
        v_to, 'info', 'notifyFriendsOnTheWay', v_title, v_body, 'home/-', v_expires,
        jsonb_build_object('kind', 'on_my_way', 'venue_id', v_venue, 'venue_name', v_court,
                           'sender_id', v_me, 'eta_minutes', v_eta));
    exception when others then
      -- One friend's push must never undo the others.
      raise warning 'on my way push for % not queued: %', v_to, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('sent', true, 'count', v_told, 'skipped_recent', v_total - v_told,
    'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court, 'sent_at', now());
end $$;

revoke all on function public.send_on_my_way(text, int, uuid[]) from public, anon;
grant execute on function public.send_on_my_way(text, int, uuid[]) to authenticated;

notify pgrst, 'reload schema';

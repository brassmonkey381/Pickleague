# Presence Phase 1: API contract

The SQL work and the three client work streams build against this contract in parallel. If the SQL has to
deviate, update this file in the same commit so the integration step can reconcile. Plan and rules:
[play-sessions-presence.md](./play-sessions-presence.md).

All RPCs below are `security definer`, `set search_path = ''` (or `public` where an existing function already uses it),
`revoke all ... from public, anon`, `grant execute ... to authenticated`, and are appended to the allowlist in
`supabase/migration_rls_hardening_2026q3.sql`. Errors are raised with human-readable messages (the client shows
them via `friendlySbMessage`).

Feature flag: `FRIENDS_AT_COURTS_ENABLED` in `mobile/src/lib/features.ts` (false until the persona tests pass
on the live DB). Gate every new screen registration, linking path, push route and Home section on it. The
location-confirmed check-in and session changes are NOT gated (they replace existing behaviour), and neither are
the player's own controls that ship with them: the one-time consent sheet, Settings › Privacy "Who sees me at the
courts" / "Hidden from", Pause sharing and "Hide my presence" on the ⋯ menu.

## SQL files and apply order

Apply in ONE transaction, in this order (none of the files contains begin/commit):

0. `supabase/migration_league_members_lock_identity.sql`: clients may update only `league_members.role`, and a
   trigger refuses any change of `league_id` / `user_id` (an admin could move a membership onto anyone, which
   presence reads as consent). Stands alone: it can also go live ahead of the rest. Since file 8 clients may also
   name `league_id` / `user_id` (old bundles' merge-upsert Join), never change them; re-running this file drops that
   grant (its table-level revoke), so re-run file 8 after it.
1. `supabase/migration_presence_p1_schema.sql`: columns (incl. `league_members.admitted_closed`), all new tables
   (friendships, close_friends and the internal `friend_request_log` / `presence_closed_ids` live here, because
   the privacy helpers and file 2 read them), owner-only RLS, the venue dedupe pass, the league / court-location
   backfill + sync triggers, privacy helpers (incl. the guarded `blocked_between`)
2. `supabase/migration_presence_p1_checkins.sql`: checkin_venue, checkout_venue, extend_checkin,
   start_play_session, end_play_session, expire_play_sessions, resolve_court, resolve_venue
3. `supabase/migration_presence_p1_reads.sql`: venue_players_here, court_presence, venue_crowd, friends_at_courts,
   presence settings, court favorites
4. `supabase/migration_presence_p1_friends.sql`: friend RPCs, notices, block teardown trigger, suggest_friends
5. `supabase/migration_presence_p1_hygiene.sql`: `_purge_account` (delete_my_account + moderator_eject_user),
   `pickleague-presence-retention` cron

`migration_rls_hardening_2026q3.sql` already allowlists every RPC below (plus the 29 client RPCs that were
missing and the policy helpers), so re-running it afterwards takes nothing offline. Re-running the older
`migration_venue_checkins.sql` / `migration_play_sessions.sql` afterwards is safe too: once
`venue_checkins.location_confirmed` exists they skip the read policies and RPCs presence replaced. Persona tests
(320 assertions, all passing against the live DB in a rolled-back transaction on 2026-10-16; the build also
re-runs the hardening file and the two superseded files before the assertions):
`node supabase/tests/build-presence-test.mjs <out.sql>`, then `supabase db query --linked -f <out.sql> -o csv`
from the linked checkout. Then redeploy send-push with `--no-verify-jwt`.

6. **Phase 1.5** `supabase/migration_validity_rules.sql` (applied after files 0-5, which are live): stay proof,
   `matches.play_session_id`, session validity, `my_session_validity`. See [Phase 1.5](#phase-15-validity-rules)
   below. Re-runnable on its own, no begin/commit, no send-push change. Since this file,
   `migration_presence_p1_checkins.sql` skips its own 3-argument `checkout_venue` and 2-argument
   `end_play_session` once `venue_checkins.stay_confirmed` exists, so re-running file 2 keeps the Phase 1.5
   versions (and only those). The persona build applies files 0-6, re-runs file 2 and file 6, then the hardening
   file and the two superseded files: 440 assertions (325 Phase 1 + 115 Phase 1.5 in
   `supabase/tests/validity_personas.sql`), all passing against the live DB in a rolled-back transaction on
   2026-10-16 (the same Phase 1.5 assertions against the previous version of the file: 27 fail).

7. **Refusal messages** `supabase/migration_refusal_messages.sql` (after file 6, and after any re-run of files 2 or
   6, which put the older texts back): every refusal's text and code, new returned reasons, the why keys on
   `my_session_validity`, the pending-match and expiry notices. Re-runnable, no begin/commit, signatures and
   attributes unchanged. See [Refusal messages and codes](#refusal-messages-and-codes-rule-11). The persona build
   applies it last and re-runs it after files 2 and 6: 506 assertions (440 + 66 in
   `supabase/tests/refusal_personas.sql`), all passing against the live DB in a rolled-back transaction on
   2026-10-16.

8. **Offline check-in time and old-build joins** `supabase/migration_checkin_tap_time.sql` (after file 7, and
   again after any re-run of files 0, 2, 6 or 7: files 2, 6 and 7 put the older `checkin_venue`,
   `start_play_session` and `extend_checkin` back, file 0 drops the column grant). A check-in's fix is judged at
   the tap, up to 12 hours back; `league_members (league_id, user_id)` UPDATE granted. Re-runnable, no
   begin/commit, signatures and attributes unchanged, one internal helper (`_pl_tap_fix`), no new client RPC. See
   [Offline check-in time](#offline-check-in-time-the-tap-rule-2026-10-16). The persona build applies it last and
   re-runs it last: 621 assertions (516 + 103 in `supabase/tests/tap_time_personas.sql`, plus the older
   backdated-tap assertions moved to the honest replay shape), all passing against the live DB in a rolled-back
   transaction on 2026-10-16. Release: this SQL first, then the OTA.

## Where the SQL differs from or sharpens this contract (2026-10-16)

Signatures are exactly as below. Behaviour details the clients should know (error texts quoted here are the
Phase 1 ones; since file 7 every refusal has a code and a reworded text, listed in
[Refusal messages and codes](#refusal-messages-and-codes-rule-11)):

- **checkout_venue `p_source`** keeps its 1.0.4 meaning, a FILTER: `'manual' | 'geofence' | 'session'` close only
  check-ins that source opened. Its default stays `null` (not `'manual'`): no filter. Any other value, e.g.
  `'signout'`, also means no filter, so `checkout_venue(null, 'signout', now)` closes everything.
- **Unknown-id fallback** (checkout_venue, extend_checkin) applies only when `p_id` names no check-in of the caller
  (1.0.4 keeps its own id when the server hands back the row it already had). A `p_id` that names a closed row is a
  replay: checkout returns 0, extend raises `Check-in is no longer open`.
- **Fix age on one clock:** checkin_venue, start_play_session and extend_checkin take a trailing
  `p_fix_age_ms` (the fix's age at send time, measured on the device). With it, fresh = age between -5 s and 2 min
  whatever the device clock says, and `fix_at` is stored on the server clock (`now() - age`). Without it (1.0.4,
  older builds) `p_fix_at` is compared with the server clock as before. **Since file 8** the fix is judged at the
  tap when `p_at` is sent too (taken within 2 minutes of the tap, the tap under 12 hours old); the window above
  applies only to calls with no tap (extend). See [Offline check-in time](#offline-check-in-time-the-tap-rule-2026-10-16).
- **Precise fixes only:** a fix confirms only when `p_accuracy_m` is reported and at most 150 m (an approximate
  location is km-wide). checkin_venue raises `Your location isn't precise enough to confirm you're at the court.
  Make sure Precise Location is on for Pickleague, then try again.`; start_play_session starts untracked.
- **Extra check-in errors:** a stale fix raises `Your location is out of date. Try again at the court.` (with an
  age) or `Your location is out of date. Check that your phone's date and time are set automatically, then try
  again at the court.` (without one, where a wrong clock is the likely cause); a fix with only one of lat/lng (or
  out of range) raises `Your location didn't come through. Try again.` The distance in the "about % m away" message
  is to the nearest of the facility's rows (canonical + duplicates), and a fix confirms when it is inside any of
  them.
- **Quiet repeat check-in:** a call without a fix at a court where the caller already has a confirmed row returns
  that row unchanged (no extension without a fix). A confirmed call there extends it and stores its fix as the
  latest. A confirmed call at a court where the caller has only a private (unconfirmed) row closes it and opens a
  new confirmed row.
- **extend_checkin stays confirmed:** for a confirmed check-in, a fix (when sent) must confirm the court
  (`You need to be at the court to stay checked in (about % m away).`) and becomes its latest fix. Without a fix
  it extends at most 4 hours past the last confirming fix, then raises `To stay checked in, open Pickleague at
  the court so it can confirm you're still there.` A replay of an end time already reached returns the row. A
  private (unconfirmed) row extends as before.
- **start_play_session adopt path** needs no fix (the adopted row was already confirmed), but without a confirming
  fix it covers the session only to 4 hours past the check-in's last fix. Without an adoptable row, a fix that
  does not confirm the court is NOT an error: the session starts untracked.
- **Closed before stored:** an `end_play_session` / `checkout_venue` whose `p_id` names no row is remembered
  (`presence_closed_ids`, pruned after 2 days). When that Start or check-in lands later (queued, or a request that
  timed out and still arrived), start_play_session stores the session already ended, with no check-in, and
  checkin_venue returns an in-memory closed row without storing anything; neither touches what was opened since,
  and neither is an error.
- **resolve_court** clamps `p_radius_m` to 10..2000 m; `p_sport = null` means any sport; `inside` = in a boundary or
  within a row's `geofence_radius_m` (no accuracy slack); raises `Not authenticated` without a session.
- **resolve_venue** (1.0.4 only) now answers the canonical venue of the nearest row (same signature and jsonb
  shape; `distance_meters` still to the nearest row), so 1.0.4's arrival fences and check-ins key on the id the
  server stores.
- **venue_crowd** omits unknown ids, answers each requested id as given (two duplicates both answer), and raises
  `At most 50 courts at a time` past 50. here_now counts blocked players too (as anonymous strangers). The band is
  built only from rated players this viewer sees anonymously (never the viewer, never anyone named), and only with
  3+ of them. "Rated" = has played a match (`total_matches_played > 0`), as the standings treat it.
  band_low / band_high are `numeric(4,2)`.
- **Anonymous rows** (venue_players_here, court_presence): `checkin_id` is a fresh random uuid on every call (a
  React key, nothing more: never the real id, unlinkable between calls), `checked_in_at` / `expires_at` are rounded
  out to the hour, `via_session` is false and `session_kind` null, and they follow the named rows in no meaningful
  order. A viewer who saw someone's named row can't find them again after a pause or a hide-from.
- **Blocked pairs** see each other as anonymous strangers (counted, never named), not as nothing: a missing row
  would single the blocker out against a second account's or a guest's view.
- **Closed leagues count only for memberships made while closed** (`league_members.admitted_closed`, set by the
  server on insert; clients may update only `role`). Closing an open league later admits only its creator; who
  joined while it was open stays anonymous (share_closed_league, the friends_at_courts candidates and
  suggest_friends all apply it). Existing memberships of closed leagues were admitted once, when the column was
  added.
- **blocked_between** answers a signed-in caller only about pairs that include them (false otherwise); service
  code with no session gets the full answer. Internal code that judges two other people uses `_pl_blocked_pair`.
- **friends_at_courts courts** lists every favorite (at most 5, oldest first), then fills up to 3 with league home
  courts and frequent courts.
- **set_presence_settings:** `p_paused_until` is capped at 7 days ahead; a time already past clears the pause.
  get_my_presence_settings returns `paused_until = null` once a pause has run out.
- **respond_friend_request** returns `'accepted'` (or `'declined'`) when that is already the answer, so lock-screen
  replays are idempotent; `'gone'` when there is no request (cancelled, blocked, deleted, or it was my own).
- **send_friend_request** errors: `You can't add yourself as a friend`, `Create an account to add friends` (guest
  caller), `This player isn't available` (guest, unclaimed, deleted or blocked target),
  `You've sent 20 friend requests today. Try again tomorrow.` A re-send to the same person within 24 h of a notified
  request (e.g. after a cancel) is stored pending without a second push.
- **friendship_status_with** reads `'none'` for a declined pair (either side), so the requester may re-request
  (quietly within 30 days).
- **Leagues / court locations:** a trigger keeps `leagues.home_venue_id` and `court_locations.venue_id` canonical, and
  re-resolves them when a 1.0.4 app changes only the name / coordinates. The backfill also resolves by name within
  1 km when nothing is in range: Crocker-Amazon (dinks) -> Crocker Amazon Pickleball Courts (752 m). Both Bladium
  leagues -> The Hub Sports Club - Alameda.
- **send-push** attaches the catalog's `friend_request` category (Accept / Decline) while the request is still
  pending. (The SQL stream first read it loosely, before the catalog had the entry; since integration it is the
  typed `CATEGORY.friend_request`.)

## Tables

```
venue_checkins  + location_confirmed boolean not null default false
                + fix_lat double precision, fix_lng double precision, fix_accuracy_m real,
                  fix_at timestamptz, fix_distance_m real
                  (venue_id stores the CANONICAL venue id, see venues.canonical_id)
venues          + canonical_id text null references venues(id) on delete set null
                  (null = this row is canonical; set by a non-destructive dedupe pass)
leagues         + home_venue_id text null references venues(id) on delete set null
court_locations + venue_id text null references venues(id) on delete set null
presence_settings(user_id uuid pk -> profiles on delete cascade,
                  checkins_level text not null default 'leaguemates'  -- everyone|leaguemates|friends|hidden
                  plans_level    text not null default 'friends'      -- leaguemates|friends|hidden
                  paused_until timestamptz, consent_seen_at timestamptz,
                  auto_checkin boolean not null default false,          -- read in Phase 2
                  updated_at timestamptz not null default now())         -- owner-only select, no write policies
presence_hidden_from(user_id uuid, hidden_user_id uuid, created_at, pk(user_id, hidden_user_id))  -- owner-only
friendships(id uuid pk, requester_id uuid, addressee_id uuid,
            status text check in ('pending','accepted','declined'),
            created_at timestamptz, responded_at timestamptz,
            unique (least(requester_id,addressee_id), greatest(requester_id,addressee_id)),
            check (requester_id <> addressee_id))      -- select for the two parties only
close_friends(user_id uuid, friend_id uuid, created_at, pk(user_id, friend_id))  -- owner-only; requires accepted friendship
court_favorites(user_id uuid, venue_id text, created_at, pk(user_id, venue_id))   -- owner-only; max 5 per user
league_members  + admitted_closed boolean not null default false   -- made while the league was closed (server-set)
presence_closed_ids(user_id uuid, id uuid, closed_at, created_at, pk(user_id, id))  -- internal; ids closed before stored
```

Phase 1.5 adds `venue_checkins.stay_confirmed` + check-out fix columns, `matches.play_session_id` and
`play_sessions.valid` / `valid_reason` / `validated_at` / `rewards_pending_confirmation`: see
[Phase 1.5](#phase-15-validity-rules).

RLS: `venue_checkins_read` and `play_sessions_read` become `using (user_id = auth.uid())`. Clients may update only
`league_members.role` (column grant), and no one may change a membership's `league_id` / `user_id` (trigger). Since
file 8 (decided 2026-10-16) `league_id` / `user_id` are granted too, so pre-2026-10-14 bundles' merge-upsert Join
(`ON CONFLICT (id) DO UPDATE SET league_id, user_id, role`) passes the privilege check; the trigger still refuses
any change (P0001 `pl:membership.locked`), and the UPDATE policy reaches only rows of a league the caller is admin of.

## Location confirmation (no manual check-ins)

A fix confirms a venue when it is fresh, precise, and at the court:
- fresh (since file 8, `_pl_tap_fix`): taken within 2 minutes of the tap, `abs(p_at - p_fix_at) <= 2 min` (both on
  the phone's clock), and the tap under 12 hours old (`tap_at = now() - p_fix_age_ms + (p_at - p_fix_at)` on the
  server clock). A call with no tap (extend): `p_fix_age_ms` (the age measured on the device at send time) between
  -5 s and 2 minutes. Without an age, `p_fix_at >= now() - interval '2 minutes'` and not more than 1 minute in the
  future (server clock), and within 2 minutes of `p_at` when one is sent;
- precise: `p_accuracy_m` reported and at most 150 m (a null accuracy is refused);
- at the court: inside `venues.boundary_geom`, or within `coalesce(geofence_radius_m, 100) + least(p_accuracy_m, 75)`
  metres of `(lat, lng)` (`public.haversine_meters`). Duplicates resolve to the canonical row first.

## RPCs

### Check-ins and sessions (signatures replaced in ONE transaction; 1.0.4 named-argument calls still resolve)

```
checkin_venue(p_id uuid, p_venue text, p_minutes int default 120, p_source text default 'manual',
              p_at timestamptz default null,
              p_lat double precision default null, p_lng double precision default null,
              p_accuracy_m double precision default null, p_fix_at timestamptz default null,
              p_fix_age_ms double precision default null)
  returns public.venue_checkins
```
- Idempotent on `p_id`. Advisory lock `hashtext('checkin:' || uid)`.
- `p_lat is null` (un-updated 1.0.4 client): insert a PRIVATE row with `location_confirmed = false`. It is shown
  to nobody, counted nowhere, earns nothing. Behaviour otherwise as today.
- Fix given but not confirming: `raise exception 'You need to be at the court to check in (about % m away).'`.
- Confirmed: if the caller already has an open, unexpired, confirmed row at the same canonical venue, return it and
  extend `expires_at` to `greatest(existing, new)` (no close-and-reopen). Otherwise close the caller's other open rows
  and insert. Stores the fix and its distance.

```
checkout_venue(p_id uuid default null, p_source text default null, p_at timestamptz default null) returns integer
```
- Replaces the 2-arg version. `checked_out_at = greatest(checked_in_at + 1s, least(coalesce(p_at, now()), now(), expires_at))`.
- `p_id` that names no check-in of the caller falls back to the caller's open rows (any venue); `p_id is null` closes all
  of the caller's open rows. `p_source` is a filter (see the differences list above).
- **Phase 1.5** adds trailing `p_lat, p_lng, p_accuracy_m, p_fix_age_ms` (all `default null`): the check-out fix,
  see [Phase 1.5](#phase-15-validity-rules). Every call shape above still resolves.

```
start_play_session(p_id uuid, p_kind text, p_source uuid default null, p_venue text default null,
                   p_at timestamptz default null,
                   p_lat double precision default null, p_lng double precision default null,
                   p_accuracy_m double precision default null, p_fix_at timestamptz default null,
                   p_fix_age_ms double precision default null)
  returns public.play_sessions
```
- Unchanged behaviour plus: when `p_venue` is set and the fix confirms it, open a `source='session'` check-in with
  `id = p_id`, `expires_at = greatest(v_at, now()) + 180 min` (skip if that is already past). If the caller already
  has an open confirmed check-in at that venue, adopt it (extend its `expires_at` to cover 180 min) instead.
  **Since file 8:** the check-in is judged at the tap and anchored there (`checked_in_at` = the tap on the server
  clock, `expires_at = tap + 180 min`, ending where a later check-in of mine starts), stored already over when that
  is past; with a fix confirmed at the tap it adopts only a check-in begun at or before the tap. The session row
  keeps the app's time (`v_at`, clamped to 12 h).
- Closing a previous session also closes that session's `source='session'` check-in.

`end_play_session(p_id, p_at)` — also closes the check-in `id = p_id and source = 'session'`;
an id never stored is remembered as ended (see "Closed before stored"). **Phase 1.5** adds trailing
`p_lat, p_lng, p_accuracy_m, p_fix_age_ms` (all `default null`): End is the check-out of the session's own check-in,
see [Phase 1.5](#phase-15-validity-rules). `{p_id, p_at}` and positional calls still resolve.

```
extend_checkin(p_id uuid, p_until timestamptz,
               p_lat double precision default null, p_lng double precision default null,
               p_accuracy_m double precision default null, p_fix_at timestamptz default null,
               p_fix_age_ms double precision default null)
  returns public.venue_checkins
```
- Replaces the 2-arg version (1.0.4's `{p_id, p_until}` call still resolves). Falls back to the caller's open row
  when `p_id` names no check-in of the caller (a closed one still raises). A confirmed check-in needs a confirming
  fix, or stops 4 hours past its last one (see the differences list above).

```
resolve_court(p_lat double precision, p_lng double precision, p_radius_m double precision default 150,
              p_sport text default 'pickleball') returns jsonb
  -- {id, name, lat, lng, distance_m, inside boolean} of the canonical venue, or null
```

### Privacy settings

```
get_my_presence_settings() returns jsonb
  -- {checkins_level, plans_level, paused_until, consent_seen_at, auto_checkin} with defaults when no row
set_presence_settings(p_checkins_level text default null, p_plans_level text default null,
                      p_paused_until timestamptz default null, p_clear_pause boolean default false,
                      p_consent_seen boolean default false) returns jsonb  -- the full row as above
hide_presence_from(p_user uuid, p_hidden boolean) returns boolean
list_presence_hidden() returns table(user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text)
```

Internal (revoked from clients): `are_friends(a,b)`, `share_closed_league(a,b)`,
`_pl_can_see_presence(viewer uuid, owner uuid, p_kind text) returns text` → `'named' | 'anonymous' | 'none'`:
self → named; deleted owner → none; blocked either way → anonymous (counted, never named, whatever the level);
viewer is guest/expired guest/deleted → anonymous for counts only; owner paused or hiding from viewer → anonymous;
owner level `hidden` → anonymous; `everyone` → named; `leaguemates` → named if friends or share a closed league
(both admitted while it was closed); `friends` → named if friends; else anonymous.
Only `location_confirmed` rows are ever visible to anyone but the owner.

### Presence reads

```
venue_players_here(p_venue text) returns table(...)   -- identical signature/columns as today (1.0.4 clients)
  -- now SECURITY DEFINER; anonymous rows: a random checkin_id per call, hour-rounded times,
  -- user_id/full_name/avatar_*/rating/doubles_rating null; 'none' rows omitted
court_presence(p_venue text) returns table(checkin_id uuid, user_id uuid, full_name text, avatar_url text,
  avatar_emoji text, avatar_bg_color text, doubles_rating numeric, checked_in_at timestamptz,
  expires_at timestamptz, anonymous boolean, is_friend boolean, is_close_friend boolean, via_session boolean,
  session_kind text)
venue_crowd(p_venue_ids text[]) returns table(venue_id text, here_now int, band_low numeric, band_high numeric,
  friends_here int)
  -- at most 50 ids; here_now counts confirmed open rows (hidden, paused and blocked players count);
  -- band = 25th–75th pct of doubles_rating rounded to 0.25, from rated players anonymous to the viewer only,
  -- and only with >= 3 of them
friends_at_courts(p_hours int default 12) returns jsonb
  -- {now: [{venue_id, venue_name, lat, lng, since, until, people: [{user_id, full_name, avatar_url,
  --          avatar_emoji, avatar_bg_color, is_close_friend, via_session, session_kind, checked_in_at, expires_at}],
  --         others_here int}],
  --  courts: [{venue_id, venue_name, reason: 'favorite'|'home'|'frequent', here_now, band_low, band_high, friends_here}]}
  -- now: named people only (friends + closed-league mates per their settings), grouped by canonical venue, cap 100
  -- courts: every favorite (max 5), then league home venues, then the viewer's most-visited (last 60 days),
  --         filled to 3
```

### Friends

```
send_friend_request(p_user uuid) returns text        -- 'pending' | 'accepted' (crossing request auto-accepts) | 'already'
respond_friend_request(p_user uuid, p_accept boolean) returns text   -- 'accepted' | 'declined' | 'gone'
cancel_friend_request(p_user uuid) returns boolean
remove_friend(p_user uuid) returns boolean            -- silent; clears close_friends both ways
set_close_friend(p_user uuid, p_on boolean) returns boolean   -- requires accepted friendship
friendship_status_with(p_user uuid) returns jsonb     -- {status: 'self'|'friends'|'pending_outgoing'|'pending_incoming'|'none'|'unavailable', is_close_friend}
list_my_friends() returns table(user_id uuid, full_name text, avatar_url text, avatar_emoji text,
  avatar_bg_color text, doubles_rating numeric, is_close_friend boolean, since timestamptz)
list_friend_requests() returns table(user_id uuid, full_name text, avatar_url text, avatar_emoji text,
  avatar_bg_color text, doubles_rating numeric, direction text /* 'incoming'|'outgoing' */, created_at timestamptz)
suggest_friends(p_limit int default 10) returns table(user_id uuid, full_name text, avatar_url text,
  avatar_emoji text, avatar_bg_color text, doubles_rating numeric, reason text, score int)
  -- reason e.g. '4 matches together', 'Drilled 2x', 'Both in Lunch League'
```
- `send_friend_request` refuses self, guests, `is_unclaimed`, deleted, and blocked pairs (`'unavailable'` status);
  max 20 per sender per local day; a re-request within 30 days of a decline is stored pending but notifies nobody.
- Blocking (AFTER INSERT on `user_blocks`) deletes the friendship and close_friends rows both ways, and the friend
  notices. presence_hidden_from rows are kept, so a hide survives an unblock and the blocked person cannot tell they
  were blocked.

### Court favorites

```
set_court_favorite(p_venue text, p_on boolean) returns boolean   -- canonicalises; raises past 5
list_my_court_favorites() returns table(venue_id text, venue_name text, lat double precision, lng double precision)
```

## Notifications produced in Phase 1

| kind (`push_data.kind`) | type | category (pref key) | entity_type / entity_id | deep link | buttons |
|---|---|---|---|---|---|
| `friend_request` | `info` | `notifyFriendRequests` | `friend` / requester id | `friends/-` | Accept (authenticationRequired), Decline |
| `friend_accepted` | `info` | `notifyFriendRequests` | `friend` / accepter id | `player/<id>` | none |

Copy: "🤝 <name> wants to be friends" / "Accept to see each other at the courts."; "🤝 <name> accepted your friend
request" / "You'll see each other at the courts now." (names via the viewer-safe display name).
`supabase/functions/send-push/index.ts`: add `notifyFriendRequests` to `KNOWN_PREF_KEYS`; `resolveButtons` for
`friend` returns buttons only while the request is still pending. Needs a redeploy with `--no-verify-jwt` (the user runs it).

## Hygiene

- `delete_my_account` (and the godmode delete) deletes venue_checkins, play_sessions, presence_settings,
  presence_hidden_from (both columns), friendships, close_friends (both), court_favorites and presence_closed_ids
  for the user.
- Daily pg_cron job `pickleague-presence-retention` deletes venue_checkins older than 180 days, friend request log
  rows older than 30 days and presence_closed_ids older than 2 days.
- Client: before `signOutSafely`, best-effort `checkout_venue(null, null, now)` and `end_play_session` for the open
  session, each bounded to 3 s, never blocking sign-out (`mobile/src/lib/signOutPresence.ts`, called from
  SettingsScreen doSignOut, the GuestJoinScreen rollback and AppNavigator's expired-guest sign-out). `p_source` is
  `null`, not `'signout'`: it is a source filter, and `null` closes every open row whatever opened it (the SQL also
  reads `'signout'` as no filter, so either works).

## Client notes

How the three client streams call this contract. The SQL sections above are authoritative for signatures; these
notes say which arguments the app sends and what it assumes about the answers.

### Check-ins and sessions (checkin stream, `feat/presence-p1-checkin`)

- `checkout_venue` always gets `p_source` explicitly: `null` for a plain check-out and for sign-out (no filter),
  `'geofence'` when leaving a fenced court (it must not close a manual check-in). The no-match fallback applies the
  same filter, as the SQL does.
- Every `checkin_venue` call sends the fix arguments (no manual check-ins) and the tap (`p_at`), with
  `p_fix_age_ms` computed at each send (`fixArgs(fix, Date.now())`), so the server can place the tap and the fix on
  its own clock and a wrong device clock doesn't matter. A check-in queued offline carries the fix taken at tap
  time and counts when it syncs, up to 12 hours after the tap (since file 8); when the server refuses it on replay,
  the client drops it and tells the player the next time the court card shows. A queued check-in from an older
  build that has no fix is dropped without being sent.
- `takeCheckinFix` treats a reading with accuracy over 150 m (or none) as no fix and `noFixReason()` names it
  (Precise Location / approximate browser location, or "try again in the open" for a 150-500 m fix), so the card
  never offers "Add this court" at a blurred spot and the start sheet never preselects a court from one. The
  server's own refusals ("isn't precise enough", "out of date", "need to be at the court") all offer the untracked
  session on the court card and become the lock-screen notice text.
- `extend_checkin` gets a fix whenever location is already allowed (the card's +1 h reuses a recent fix; the
  island and the lock-screen Extend take one, with no prompt). A refusal on the lock screen becomes "Open Pickleague
  at the court to stay checked in."
- `start_play_session` sends the fix only with a court (`p_venue`); a session with no court sends nulls. At my
  current check-in's court the start sheet sends no fix when it has none (the server adopts that check-in). With
  any other court it compares the fix's `resolve_court` answer with the chosen court first and, when they differ,
  says "You're not at <court>" and offers the court I'm at, no court, or "Start anyway". After a court Start
  lands (live or replayed), the app re-reads my check-in; when the session did not check me in, the island stops
  naming the court and says so once.
- A successful End keeps its pending-End entry until it ages out (3 days), so a resume read already in flight when
  End was tapped can't bring the island back.
- `resolve_court` is always called with `p_sport` from `mobile/src/sports/registry.ts` (`getSport().courtSport`).
  The court card, the start sheet, the league court chip and the geofence list all key on its canonical id. The
  arrival-alert fences are starred courts first (`list_my_court_favorites`, with the flag on; a failed read drops
  only them), then league home courts, then the most-visited courts; starring or unstarring re-syncs them.
- League home-court pickers write `leagues.home_venue_id` (the picked catalog venue, else null) alongside `home_court*`.
- The start sheet reads the presence settings (for its "who sees you" line) and `list_my_court_favorites`, through
  the presence stream's wrappers (`data/presenceSettings`, `data/courtFavorites`), and treats either failing as
  "defaults / none".

### Privacy, crowd and Friends at the courts (presence stream, `feat/presence-p1-presence`)

- Rosters (PlayersHereList, the league court chip) read `court_presence`; `venue_players_here` is kept only for
  1.0.4. An anonymous row shows "Player"; the client would show a half-point band if the row carried
  `doubles_rating`, but the SQL sends null for anonymous rows, so it never does. Its `checkin_id` is a React key
  only (random per call). `usePlayersHere` polls only while its screen is focused.
- `venue_crowd` is called in chunks of at most 50 ids; an id the SQL omits reads as an empty court.
- Consent (`lib/presenceConsent.ts`, recorded with `set_presence_settings(p_consent_seen => true)`):
  `ensurePresenceConsent()` is awaited outside any bounded busy state and never while another Modal is up (iOS
  shows one at a time). The court card asks it before the location prompt and the bounded check-in; the start
  sheet's host asks it before the sheet opens ("Not now" opens the sheet with only the private no-court timer, no
  location read); the lock-screen arrival Check in uses `hasPresenceConsent()` and, when it is false, asks the
  player to open the app. The sheet, Settings › Privacy (who sees me, hidden from), Pause sharing and hide-from are
  not behind `FRIENDS_AT_COURTS_ENABLED`: they ship with the check-ins they control. "Who sees my planned games"
  is not shown until Phase 3 (court_plans); `plans_level` is still stored and returned.
- Pause (`p_paused_until` up to 7 days) and hide-from are written only through their RPCs; the returned settings
  row replaces the cached one.

### Friends (friends stream, `feat/presence-p1-friends`)

- send-push: `friendButtons` attaches category `friend_request` when `push_data.kind = 'friend_request'` and
  `friendships` has `requester_id = entity_id`, `addressee_id = recipient`, `status = 'pending'`.
- `friend_accepted` gets **no catalog category**: it has no buttons, and the kit's `catalogProblems` rejects a
  category without actions. Its tap uses the `player/<id>` deep link (a `friend/<id>` row without a link is
  mapped there by `push_data.kind`).
- Lock-screen buttons `friend_accept` / `friend_decline` call `respond_friend_request(entity_id, accept)` and, on
  `'gone'`, `friendship_status_with(entity_id)` to tell a replay ("Already friends") from a cancelled request.
- Home's Up next counts incoming `list_friend_requests` rows on the bell (one row, "Sam wants to be friends" /
  "3 friend requests"), so that RPC runs on every Home load while the flag is on.
- Copy: the SQL titles are "🤝 <name> wants to be friends" / "🤝 <name> accepted your friend request"; the
  lock-screen notice reads the name back out of the title (`lib/pushSubject.ts` strips the emoji). The SQL's
  fallback name "A player" reads as no name, so the notice keeps its plain title.

### Integration check (2026-10-16)

Every `supabase.rpc` call in `mobile/src` was checked against the five SQL files: names, argument names and the
fields read back all match. The one deliberate difference is sign-out's `checkout_venue(null, null, now)` (see
Hygiene).

## Phase 1.5: validity rules

Decided by the user 2026-10-16 ([plan](./play-sessions-presence.md#phase-15-validity-rules-decided-by-the-user-2026-10-16-sql--ota)).
Presence is about being there, rewards are about having played: nothing here changes who is shown at a court.
SQL: `supabase/migration_validity_rules.sql` (apply after the live Phase 1 files; re-runnable; one new client RPC,
allowlisted in `migration_rls_hardening_2026q3.sql`). Release: apply the SQL first, then the OTA. The app also
copes with the SQL not being there yet (see Client).

### Schema

```
venue_checkins + stay_confirmed boolean not null default false
               + arrival_fix_at timestamptz   -- when the arrival fix was taken (server clock); confirmed rows only
               + checkout_fix_at timestamptz, checkout_fix_accuracy_m real, checkout_fix_distance_m real,
                 checkout_fix_lat double precision, checkout_fix_lng double precision
                 (lat/lng stored only when the check-out fix confirmed the court)
matches        + play_session_id uuid null references play_sessions(id) on delete set null
                 (partial index matches_play_session_id_idx)
play_sessions  + valid boolean not null default false
               + valid_reason text  -- linked_match | match_in_window | drill_in_window (valid)
                                    -- open | too_short | no_match_or_drill (not valid)
               + validated_at timestamptz          -- when it became valid; null while not valid
               + rewards_pending_confirmation boolean not null default false
               + at_court boolean not null default false
               (index play_sessions_user_started_idx on (user_id, started_at desc))
drill_sessions   clients may UPDATE only notes, reminder_dismissed_by (column grants; was every column)
```

`matches` stays readable by everyone (`using (true)`), so `play_session_id` is public: an opaque id, and
`play_sessions` rows stay owner-only. The insert policy "League members can record matches" gains
`play_session_id is null or` it names a session of `auth.uid()`.

No rule trusts a time the client picks: "recorded" is the server's `matches.created_at`, a drill review is dated by
the server, a stay counts from the arrival fix (dated by its age on the server clock), and a player's sessions never
overlap.

### Stay proof (`venue_checkins.stay_confirmed`)

True only when the check-in was `location_confirmed` at arrival AND a later fix confirmed the same court at least
5 minutes after the arrival fix: `greatest(checked_in_at, arrival_fix_at)`. `arrival_fix_at` is set on insert from
the stored fix (`fix_at`, which Phase 1 stores as `now() - age`), never from `p_at`: a check-in or session Start
backdated by `p_at` keeps its `checked_in_at`, but its 5 minutes run from the fix that proved it. Rows confirmed
before the file get `greatest(checked_in_at, created_at - 2 min)` (their fix was at most 2 minutes old when stored).
The later fix is either:
- the **check-out fix**: `checkout_venue`'s and `end_play_session`'s new arguments (End is the check-out of the
  session's own check-in; an adopted check-in stays open and gets nothing). Position and precision from the
  Phase 1 `_pl_check_fix` (150 m accuracy, fence + slack); time from `p_fix_age_ms` (`fix_at = now() - age`), which
  must fall between the arrival fix + 5 min and `expires_at`. A queued check-out's or End's fix is the one taken at
  the tap, dated by its age, so it still counts. No age: the fix is ignored. A fix that doesn't confirm keeps only
  its distance and accuracy. Recorded only on check-ins that same call closed (a replay records nothing).
- **any later confirming fix a Phase 1 function stores on the row** (`extend_checkin` with a fix, a repeat
  `checkin_venue` at the same court, a `start_play_session` that adopts the check-in): a BEFORE UPDATE OF `fix_at`
  trigger sets `stay_confirmed` when the stored fix moves to 5+ minutes after the arrival fix. Those functions
  already refuse or skip a fix that doesn't confirm the court.

A check-out or End without a fix, with half a fix, with an undatable fix, or a replay closes exactly as in Phase 1;
the fix is recorded in a helper that never raises. Residual slack: an arrival fix the app says is 2 minutes old
(the oldest the freshness rule takes) needs 3 real minutes before the check-out fix. Future presence rewards (kept
plans, Phase 3) pay only on a confirmed stay.

```
checkout_venue(p_id uuid default null, p_source text default null, p_at timestamptz default null,
               p_lat double precision default null, p_lng double precision default null,
               p_accuracy_m double precision default null, p_fix_age_ms double precision default null)
  returns integer
end_play_session(p_id uuid, p_at timestamptz default null,
                 p_lat double precision default null, p_lng double precision default null,
                 p_accuracy_m double precision default null, p_fix_age_ms double precision default null)
  returns integer
```
Live signatures checked first (`pg_get_function_identity_arguments`: `p_id uuid, p_source text, p_at timestamptz`
and `p_id uuid, p_at timestamptz`); dropped and recreated in the same file. For `checkout_venue`, 1.0.4's
`{p_id, p_source}`, the current `{p_id, p_source, p_at}`, positional and sign-out shapes all resolve; for
`end_play_session`, `{p_id, p_at}` and sign-out's positional `(id, at)` (persona-tested). Both stay allowlisted by
name in the hardening file.

### Matches written by clients

A BEFORE INSERT guard on `matches` (`a_matches_client_insert_guard`; its name sorts before `on_match_completed`,
because BEFORE triggers fire in name order and `update_plupr_ratings` applies PLUPR at once on a `completed`
insert). Clients have no UPDATE policy on `matches`, so this covers every client write. For every signed-in insert:
- `created_at = now()`, whatever was sent: this is "recorded" for the 2 h window.
- Godmode: nothing else (its `completed` insert stands).
- `status = 'scheduled'` (ScheduleMatchScreen): no deadline, no confirmations.
- Anything else: `status = 'pending'`, `confirm_deadline = now() + 1 h`, `team1_confirmed_by` = the caller when on
  team 1, else `team2_confirmed_by` = the caller when on team 2, never both (self vs self can't complete alone).
Server-side inserts (no `auth.uid()`: seeds, backfills) are untouched.

`expire_pending_matches()` also deletes a pending match with no deadline an hour after it was stored
(`coalesce(confirm_deadline, created_at + 1 h) < now()`), so no pending match lives forever.

### Valid session (`play_sessions.valid`)

`ended_at - started_at >= 5 min` AND one of:
- **linked_match**: a match with `play_session_id = session` that the owner played in;
- **match_in_window**: a match the owner played in (any of the four player columns), recorded (`created_at`, the
  server's clock; `played_at` is never read) between `started_at` and `ended_at + 2 h`;
- **drill_in_window**: a drill session of the owner's, held during the session (its `starts_at` overlaps the
  session give or take 30 minutes: `starts_at < ended_at + 30 min` and `starts_at + length_minutes > started_at
  - 30 min`), that they completed in the window. A drill has no status: completed = the owner's
  `drill_session_reviews` row (`submit_drill_review`), dated by its `created_at`. A review of an older drill never
  counts, and clients can no longer move a drill's time (column grants above).

**One session per match or drill, per player.** A match counts for the owner's session it is linked to; else the
one it was recorded during; else the latest one that ended before it (within its window). A drill counts for the
session started from it (`kind = 'drill'`, `source_id`), else the one that started closest to the drill's start.
A session that ended under 5 minutes never takes one (it falls to the next). Helpers: `_pl_match_session`,
`_pl_drill_session`.

**Sessions never overlap.** A BEFORE INSERT trigger on `play_sessions` moves a Start dated before the end of one of
the player's earlier sessions (a backdated `p_at`, or a late Start that arrives after newer ones) to when the latest
of them ended (for one still open, when it started); a late Start stored ended ends no earlier. Honest Starts
arrive in order and are never moved. Without it, sessions could be stacked after the fact around one match.

Matches count when `pending` or `completed` (recorded is enough), never `scheduled`.
`rewards_pending_confirmation = valid and` no completed match and no drill qualifies: pickles for a session wait
for the other team's confirmation (which a client can no longer assert). A pending match that expires (the 1-hour
cron deletes it) un-validates the session. Open sessions are never valid (`reason = 'open'`).

**at_court**: a location-confirmed check-in of the owner at the session's court (its own `source = 'session'`
check-in, or one it adopted) overlapped the session, counted from its arrival fix. `valid` says the player played
(an untracked session can be valid); rewards and streak credit pay only on **valid AND at_court** (decisions 5
and 6: only location-confirmed presence earns anything).

**Linking** (BEFORE INSERT OR UPDATE OF `play_session_id` on `matches`, never raises): the link is kept only when
the session exists, belongs to the caller (`auth.uid()`; server code without a session skips this), the owner is
one of the match's players, and the session is open or ended under 2 h ago. Otherwise the match is stored unlinked,
never refused: a Start still in the offline queue must not fail the match (it still counts through the window
once its session lands).

**Recompute** (`_pl_refresh_session_validity(session)`, writes only on change): AFTER INSERT / DELETE / UPDATE OF
status, play_session_id, created_at or a player on `matches` (the linked session before and after, and every ended
session of its players whose window holds the match); AFTER INSERT / DELETE on `drill_session_reviews`; AFTER
INSERT / UPDATE OF started_at, ended_at on `play_sessions` (Start, End, a newer Start, the 6-hour expiry, a late
Start stored ended), which also re-judges the owner's other sessions whose windows overlap (a match or drill can
move between them). Each trigger catches its own failure (`raise warning`), so the match, review, Start or End
always lands; the owner's next `my_session_validity` heals a session left behind. The file backfills every ended
session once.

Decided 2026-10-16 (the plan's decisions of that day): the 5-minute floor is measured on the session's own start and
end, which the app sends (a Start may be backdated up to 12 h for offline use), so a fully offline session keeps
counting; each such session still needs its own match or drill. Rewards and streak credit pay only on valid AND
at_court.

### RPC

```
my_session_validity(p_session uuid) returns jsonb
  -- {valid boolean, reason text, needs 'minutes' | 'match_or_drill' | null,
  --  window_ends_at timestamptz | null (ended_at + 2 h), rewards_pending_confirmation boolean,
  --  at_court boolean}
  -- plus, since migration_refusal_messages.sql (null keys left out; see "Refusal messages" below):
  --  started_at, ended_at, match_pending, confirm_by, confirm_needed, drill_counted, why, match_at,
  --  counted_for_started_at, drill_starts_at
```
Owner only: `null` for a session that isn't mine or isn't stored yet (same answer). Raises `Not authenticated`.
Recomputes and stores. `needs`: `minutes` when too short (or open under 5 min), `match_or_drill` when nothing
qualifies (the window may already be over: compare `window_ends_at` with now), else null. For an open session,
`needs = null` (past 5 minutes) means a match or drill already counts for it.

Internal (revoked from clients): `_pl_session_validity`, `_pl_refresh_session_validity`, `_pl_sessions_around`,
`_pl_match_session`, `_pl_drill_session`, `_pl_record_checkout_fix`, and the trigger functions
`_pl_checkin_arrival_fix`, `_pl_checkin_stay_from_fix`, `_pl_matches_client_insert_guard`,
`_pl_matches_link_session`, `_pl_matches_refresh_validity`, `_pl_drill_reviews_refresh_validity`,
`_pl_play_sessions_no_overlap`, `_pl_play_sessions_refresh_validity`.

### Client (Phase 1.5)

- **Check-out** (`lib/courtCheckin.checkOut`): takes a fresh fix only when location is already allowed (no prompt)
  and one comes back within 3 s (`fixWithin`, `CHECKOUT_FIX_WAIT_MS`); otherwise it checks out without one. The
  queued payload carries the fix taken at the tap; `checkoutFixArgs` sends `p_lat, p_lng, p_accuracy_m,
  p_fix_age_ms` with the age measured at each send, and nothing at all without a fix (the Phase 1 call shape). A
  geofence exit sends no fix. On PGRST202 (SQL not applied yet) it checks out again without the fix. The court
  card's check-out bound is 10 s + 3 s, and so is the lock-screen Check out's deadline (`ActionHandler.timeoutMs`;
  the lock-screen Extend gets 15 s for its 5 s fix wait).
- **End** (`lib/playSession.endPlay`) clears the island at once. At a court it is the check-out of the session's
  check-in: in the background, alongside the pending-End entry, it takes a fix the same way (3 s, no prompt) and
  sends it with the End (`data/playSessions.endPlaySession(id, at, fix)`, the same four arguments; on PGRST202 it
  ends again without them). The queued End carries the fix taken at the tap; one queued by an older build has none.
- **End sheet** (`playEnded` -> `components/play/PlayEndSheet`, `lib/sessionValidity`; the copy quoted here is the
  first build's, reworded with the why since rule 11: see [Refusal messages › Client](#client-rule-11)): under 5 minutes, a toast
  "Session ended. Sessions under 5 minutes don't count."; something this device knows counts ("Session ended. It
  counts: you recorded a match." / "...a match or drill."), a toast. Otherwise it asks `my_session_validity`
  (bounded at 2 s, `END_CHECK_MS`; `endDecisionWithServer`): counted already (valid, or open with `needs = null`
  because the End hasn't landed), a success toast ("...a match you played in is recorded.", "...you reviewed a
  drill.", plus "If the other team doesn't confirm within the hour, it stops counting." while pending); too short
  by the server, the too-short toast; `needs = 'match_or_drill'`, the sheet "Record a match or drill?" (Record
  match, Review drill for any drill session, Not now); no answer (offline, slow, Start not there yet), the same
  sheet hedged: "If you haven't recorded what you played yet, record it within 2 hours and this session counts."
  Not now (or closing it): "Saved. This session counts once you record a match or drill within 2 hours (by 7:40
  PM)." or, hedged, "Saved. If nothing's recorded yet, this session counts once you record a match or drill by
  7:40 PM." Review drill opens DrillRequests ("Review your drills", which lists today's drill).
- **What the device knows** (`lib/playSession`): `noteMatchRecorded` after MatchEntry records a match I played in
  for the session (linked, or while it runs, from any entry point), and `noteDrillReviewed` after a drill review
  when `my_session_validity` then says the drill is what makes the running session count (`drill_counted`). Kept
  on the session's meta (`PlayMeta.recorded`, persisted per user), so a restart between recording and End
  remembers it. A confirmed match or a drill ends in a toast without asking; a pending match still asks the server
  at End (it may have expired since).
- **MatchEntry** takes `playSessionId` (from Record match, the island's Enter score, and Home's Now panel Enter score
  and quick Record, while a session runs) and inserts it as `play_session_id` only when the recorder is one of the
  players (otherwise a toast: "This match doesn't count for your play session: you're not one of the players.").
  A linked insert reads `play_session_id` back; when the server dropped it, End asks the server instead of
  claiming the match. A PGRST204 for that column (SQL not applied yet) inserts again without it (nothing was
  written, so no duplicate). After a linked insert it reads `my_session_validity` (best-effort, 5 s) and toasts
  `validityNote` ("This play session counts now.", with the confirm-within-the-hour line while pending).
- The island's Enter score and the sheet's Record match go through `lib/navigationRef.openMatchEntryForSession`:
  when MatchEntry is already open (from an event, league or tournament) it only merges `playSessionId` into that
  form (a same-name navigate would replace its params in React Navigation 7).
- Not gated by `FRIENDS_AT_COURTS_ENABLED`: it is the player's own session flow.

## Refusal messages and codes (rule 11)

The user's standing rule (2026-10-16): every refusal, and every outcome where something does not count, says why
in plain words and, when possible, what to do. Plan: [rule 11](./play-sessions-presence.md#rules-every-change-in-this-plan-follows).
SQL: `supabase/migration_refusal_messages.sql` (file 7 above). App: `mobile/src/lib/refusals.ts` (the one mapping),
`lib/refusalNotices.ts` + `components/RefusalNoticeHost.tsx` (refusals the player wasn't looking at).

### How a refusal travels

- **Server:** `raise exception using message = '<why, then what to do>', hint = 'pl:<code>'[, detail = '<json>']`.
  SQLSTATE stays `P0001` (never 42501, which the kit shows as "You don't have access to that."). PostgREST returns
  `{code: 'P0001', message, hint, details}`.
- **App:** `refusalCode(e)` reads the hint (or, from a server without file 7, the older message);
  `refusalCopy(code, ctx, detail)` words it with the court's and the person's name and times in the device's zone;
  `explainRefusal(e, fallback, ctx)` is that, else the kit's `friendlySbMessage` with the app's no-connection line
  ("No connection. Check your signal and try again."). The lock screen's `mapError` uses the same mapping
  (`refusalNotice`), titled per code.
- **1.0.4 and older bundles** show the message raw, so each one is complete on its own and keeps the words their
  regexes read: `need to be at the court`, `precise enough`, `location is out of date`, `open Pickleague at the
  court` (courtCheckinRules: the "Start without a court" offer and the lock-screen notices), `no longer pending`
  (the match_confirm replay check), `expired` (the lock screen's "Nothing to answer" for a lapsed match). No text
  adds `expired` / `not found` where they did not apply, and none uses a network word (`timed out`, `load failed`,
  `failed to fetch`, `network`), `jwt`, `permission denied` or an em dash (persona T27 checks all of them).

### Codes

| Code | Raised by | Server text (what 1.0.4 shows) | App copy (lib/refusals, device zone) |
|---|---|---|---|
| `auth.signed_out` | every in-scope RPC with no user | You're signed out. Sign in to Pickleague and try again. | same |
| `request.bad` | checkin_venue (no id, bad source, an id that is someone else's), start_play_session (no id) | Couldn't check you in because the app sent an incomplete request. Update Pickleague, then try again. / Couldn't save your play session because the app sent an incomplete request. Update Pickleague, then start again. | That didn't go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again. |
| `court.gone` | checkin_venue, set_court_favorite | That court isn't in Pickleague any more, so you can't check in there. Find your court again. / ...so it can't be starred. | Lakeside isn't in Pickleague any more, so you can't check in there. Find your court again. |
| `court.favorites_full` | set_court_favorite | You can star up to 5 courts. Unstar one to add this one. | same |
| `fix.stale` | checkin_venue, extend_checkin | Your location is out of date: it was taken more than 2 minutes before you tapped. Try again at the court. (file 8; file 7: "...it's more than 2 minutes old...") | same |
| `fix.after_tap` | checkin_venue (file 8) | Your location was taken more than 2 minutes after you tapped Check in, so it can't show you were at the court then. Check in again when you're at the court. | Your location was taken more than 2 minutes after you tapped, so it can't show you were at the court then. Check in again when you're at the court. |
| `checkin.too_old` | checkin_venue (file 8) | This check-in was saved with no signal at Thu Oct 16, 5:40 AM and reached Pickleague more than 12 hours later, too late to count. Check in again when you're at the court. (DETAIL `{"tapped_at", "limit_hours": 12}`; the tap in the player's zone) | It reached Pickleague more than 12 hours after you tapped, too late to count. Check in again when you're at the court. (the queued notice names the tap first) |
| `fix.stale_clock` | (no age sent) | Your location is out of date. Check that your phone's date and time are set automatically, then try again at the court. | same |
| `fix.imprecise` | | Your location isn't precise enough to confirm you're at the court. Make sure Precise Location is on for Pickleague, then try again. | ...Turn on Precise Location for Pickleague, then try again. |
| `fix.not_at_court` | | You need to be at the court to check in. You're about 328 m away, so try again when you're there. (`stay checked in` for extend; DETAIL `{"distance_m": 328}`) | You're about 328 m from Lakeside. You need to be at the court to check in, so try again when you get there. / Extend: ...so your check-in can't be extended. Check in again when you're back at the court. |
| `fix.malformed` | checkin_venue, extend_checkin, start_play_session | Your location didn't come through, so Pickleague couldn't confirm you're at the court. Try again. | same |
| `checkin.none` | extend_checkin | You're not checked in anywhere, so there's nothing to extend. Check in when you're at a court. | same |
| `checkin.closed` | extend_checkin | Your check-in at Lakeside already ended (Thu Oct 16, 5:40 PM). Check in again when you're at the court. (DETAIL `ended_at`) | Your check-in at Lakeside already ended at 5:40 PM. Check in again when you're at the court. |
| `checkin.needs_fix` | extend_checkin | Pickleague last confirmed you at Lakeside (Thu Oct 16, 1:40 PM), and a check-in lasts at most 4 hours past that. To stay checked in, open Pickleague at the court so it can confirm you're still there. (DETAIL `last_fix_at`) | In app: ...Turn on location for Pickleague, then try again at the court. Lock screen: ...Open Pickleague at the court to stay checked in. |
| `session.not_yours` | start_play_session | That play session belongs to another account, so it wasn't saved. Start a new session. | same |
| `match.removed` | confirm_match | This match was removed: it expired because it wasn't confirmed within an hour, or someone deleted it. Ask whoever recorded it to enter it again. | This match was removed: it wasn't confirmed by both teams within an hour, or it was deleted. Ask whoever recorded it to enter it again. (true whoever recorded it: the recorder's own team is confirmed at insert) |
| `match.already_confirmed` | confirm_match | This match is no longer pending: it's already confirmed. Nothing more to do. | This match is already confirmed, so there's nothing more to do. |
| `match.scheduled` | confirm_match | This match is no longer pending: it's scheduled and has no score yet. Record the score after you play it. | This match is scheduled and has no score yet. Record the score after you play it. |
| `match.confirm_expired` | confirm_match (deadline passed, cron not run yet) | Too late to confirm: the hour to confirm this match expired (Thu Oct 16, 5:40 PM). Ask whoever recorded it to enter it again. (DETAIL `deadline`) | Too late to confirm: the hour to confirm this match ended at 5:40 PM. Ask whoever recorded it to enter it again. |
| `match.not_player` | confirm_match | Only players on this match can confirm it. | Only players in this match can confirm it. |
| `player.gone` | send_friend_request (no id), hide_presence_from | We couldn't find that player. Open their profile and try again. / ...so there's nothing to hide from. | same |
| `presence.pick_someone` | hide_presence_from (self) | You can't hide from yourself. Pick another player. | same |
| `friend.self` | send_friend_request | You can't add yourself as a friend. | same |
| `friend.guest_caller` | send_friend_request | Guest passes can't add friends. Create an account to add friends. | same |
| `friend.unclaimed` | send_friend_request | Una Unclaimed hasn't joined Pickleague yet, so you can't add them as a friend. | same, first name |
| `friend.guest` | send_friend_request | Gus Guest is on a guest pass, so you can't add them as a friend until they create an account. | same, first name |
| `friend.unavailable` | send_friend_request (deleted, unknown, blocked either way) | This player isn't available | This player isn't available, so you can't add them as a friend. (one vague line: a block is never singled out) |
| `friend.daily_cap` | send_friend_request | You've sent 20 friend requests today. Try again tomorrow. | same |
| `friend.not_friends` | set_close_friend | You and Lena League aren't friends, so they can't be a close friend. | You and Lena aren't friends any more, so they can't be a close friend. |
| `membership.locked` | the `league_members` identity trigger (file 8; was 42501) | A league membership can't be moved to another league or player. Leave the league, then join the one you want. | same (no app path reaches it) |

App-only codes (same table in lib/refusals): `match.not_pending` (an older server's "Match is no longer pending"),
`match.not_member` (a 42501 on a match insert: "You're not a member of Tuesday Doubles, so you can't record
matches there. Pick a league you're in." No "any more": the same RLS refusal hits someone who never joined),
`match.score_invalid` (a 23514 on the score check),
`consent.declined` / `consent.unknown_offline` (the one-time "who sees you" sheet).

`submit_drill_review` answers `success = false` with a message (its return table can't carry a code). The texts:
"This drill was cancelled or removed, so it can't be reviewed.", "Only the two players in this drill can review
it.", "This drill starts Sat Oct 17, 3:33 PM. You can review it after it starts.", "You already reviewed this
drill. Each drill gets one review.", "Rate at least one thing to send your review." (the app maps the older ones to
these, `drillReviewRefusal`).

### New returned reasons (1.0.4 reads them as before)

- `confirm_match` → `'already_your_team'`: my team had already confirmed (a stale Confirm, or my partner's push);
  still waiting on the other team. `'one_team_confirmed'` now means I confirmed for my team just now. 1.0.4's
  lock screen treats any answer but `'already'` as a confirm, as before.
- `send_friend_request` → `'already_friends'` (was `'already'`, which still means my request is pending). 1.0.4's
  parseSendResult reads it as `'already'`.
- `respond_friend_request(p_accept => true)` on a request I declined → `'already_declined'` (was `'declined'`).
  1.0.4 reads it as `'gone'` ("That request is no longer waiting on you."). A Decline replay still reads
  `'declined'`.

### Why keys on my_session_validity (null keys left out)

`started_at`, `ended_at` (stored; the End toast compares them with the device's own times: a later stored start
means the no-overlap rule moved it, "Pickleague counted only 3 min of it because it overlapped your previous
session"; an earlier stored end means another device or a newer Start ended it, "It had already ended at 5:43 PM,
on another device or when you started a new one, after 3 min"; otherwise, or from an older server, the plain
"Pickleague counted under 5 minutes of it"), `match_pending` (it counts only through a match still waiting to be
confirmed, open sessions too), `confirm_by` (the earliest such deadline), `confirm_needed` (who still has to
confirm that match: `'theirs'`, the other team; `'mine'`, the player's own team, when an opponent recorded it;
`'both'`, when a league member who didn't play recorded it), `drill_counted` (a drill counts for it: a drill review
never takes credit for a session a match made count), and `why = 'match_counted_elsewhere'` (only when nothing
counts; + `match_at`, `counted_for_started_at`: a match in its window counts for another of my sessions) or `why =
'drill_not_during_session'` (+ `drill_starts_at`: a drill reviewed in its window wasn't held during it; also when a
match counts). Computed by the internal `_pl_session_explain` (read only, never stored; `_pl_session_validity`
keeps its OUT list).

### Notices

- **Pending match** (`_notify_pending_match`, same recipients): the recorder is the signed-in caller (a league member
  who didn't play now shows by name). The recorder's partner gets "🥒 Rita Recorder recorded your match" / "In RF
  Test League: you won 11-5. Your team is confirmed. The other team has until Thu Oct 16, 5:40 PM to confirm, or the
  match is removed."; the other team "🥒 Match needs your team to confirm" / "Rita Recorder entered a match in RF
  Test League: you lost 5-11. Confirm by Thu Oct 16, 5:40 PM if that's right, or it's removed."; when the recorder
  played on neither team, "...Both teams need to confirm by ... if that's right, or it's removed." Times in each
  recipient's zone.
- **Expiry** (`expire_pending_matches`, same rows, same count; the cron every minute): before each delete it notes
  which of the players' sessions count; after it, each player gets `🥒 Match removed` / "Your match vs Ben Opponent
  (recorded Thu Oct 16, 5:15 PM) was removed because the other team didn't confirm it within an hour. Record it again
  and ask them to confirm." (or "because your team didn't confirm...", or "because neither team confirmed..."),
  plus "Your play session from 4:50 PM no longer counts. Record a match or drill by 7:20 PM to make it count." for
  an ended session that stopped counting, or, for a session still running that counted only through it (open
  sessions are never stored valid, so they are judged by what they need now), "Your play session from 4:50 PM no
  longer counts. Record a match or drill before you end it, or within 2 hours after, to make it count." A running
  session that still counts through something else (a drill) is not named. `type 'match'`, `entity_type 'match'`,
  `entity_id` null (the row is gone: the
  app greys out a notice whose target is missing), category `notifyMatchResults` (a result, not a request; an
  existing pref key, so no send-push change), `push_data {kind: 'match_expired', deep_link: 'match/-'}` (Match
  History). Built by the internal `_pl_notify_match_expired`; a failed notice never keeps a match.

### Client (rule 11)

- **Queued writes** (`venue:checkin`, `venue:checkout`, `play:start`, `play:end`): no signal or signed out
  (`isRetryLater`: network, PGRST301 / `auth.signed_out`) keeps the entry queued (rethrown as a TimeoutError, which
  the kit's queue keeps); a real refusal is said (`noteRefusalNotice`) and dropped. The notice is a card over the
  top of the screen that stays until the player taps OK (`RefusalNoticeHost`, mounted after the splash; one at a
  time, oldest first, marked seen only on OK: these run 30 to 50 words, too long for a 4 s toast; not a Modal, so
  it never fights the end or start sheet), or, when the app is in the background AND notification permission is
  granted, a local notification (without permission the OS drops it silently, so it waits for the card). A refused check-out brings the still-open check-in
  back on the card ("you may still show there until 7:40 PM. Tap Check out to try again."). A refused Start stops
  the island ("Your play session from 5:40 PM wasn't saved, so it won't count."). A refused End clears the
  pending-End entry so the island comes back ("Tap End again."). A queued Start older than a day is dropped and said
  (the queue's own age-out would be silent, so its `maxAgeMs` is a week and the handler decides). A queued
  check-in from an older build with no fix: "It was saved by an older version of Pickleague without your location."
  Since file 8, a queued check-in refused for its age says "It reached Pickleague more than 12 hours after you
  tapped, too late to count." (the old "more than 2 minutes after you tapped" only for an older server's refusal of
  a fix that was fresh at its tap, `refusedForQueueWait`), and one stored already over gets its own notice (see
  [Offline check-in time › Client](#client-tap-rule)).
- **Lost sessions** (`getActivePlay` → `playLost`): a session the island showed that the server ended without this
  device (the 6-hour expiry, another device or a newer Start there) or never had is explained on resume
  (`lostPlayNote`). After the expiry the end sheet runs only while its 2 hours to record are still open
  (`lostPlayOffersRecord`); later the toast alone says it ended (no "record by" a time that has passed). A session
  still open on the server past 6 hours (before the hourly expiry runs) is treated as auto-ended at start + 6 h,
  the end the expiry will store, so the island never vanishes unexplained. A Start still in the offline queue keeps
  the island however long it waits (`isPlayStartQueued`).
- **Extend** answers with less than an hour (`extendedNote`; the lock-screen title reads "Extended, not a full
  hour"): at the 4-hour ceiling (a check-in never runs more than 4 hours ahead, fix or no fix): "A check-in can run
  at most 4 hours ahead, so you're checked in until 9:00 PM. Extend it again later to stay longer."; with no
  confirming fix sent: "Checked in until 6:55 PM, not a full hour: Pickleague couldn't confirm you're still at
  Lakeside. Open Pickleague at the court to stay later." A refused lock-screen Extend is titled "Not extended"
  (never "Not checked in": the check-in still runs). A `checkin.closed` / `checkin.none` refusal refreshes the card
  in the background, so the refusal itself is never late.
- **Start at my check-in's court** (no fix sent, the server adopts it): if it isn't adopted, the island says the
  check-in had ended ("Not checked in at Lakeside: your check-in there had ended, so only you see this session.
  Check in from Home to be seen there.") or was a private one, never "couldn't get your location". A private
  check-in never skips the fix.
- **Court card**: Not now on the consent sheet says the check-in needs that choice; a check-in that ran out or was
  closed elsewhere says so once, to its own account only (the line is kept with its user id and cleared at
  sign-out); a private (no-fix, older build) check-in says only the player sees it. Pause sharing, the "who sees
  me" rows, Hidden from and the consent sheet's save use `explainRefusal` (the app's no-connection line, coded
  refusals).
- **Lock screen**: `court_checkin` gets 15 s, tells "no connection" apart from "not chosen yet" for the consent
  check, and a refusal that lands after its deadline still reaches the player; its success line follows the
  player's own settings ("Your friends can see you are here.", "Sharing is paused, so others see "a player" here.").
- **MatchEntry**: the score rule is checked before sending; the result line says who still has to confirm and by
  when, from the stored status and deadline ("Match recorded. Both teams need to confirm by 5:40 PM, or the match is
  removed." for a recorder who didn't play); a dropped session link says why (recorded over 2 hours after the
  session ended; the session hasn't synced; it never reached Pickleague).
- **End** (decision 3): "Session ended. It counts once the other team confirms (within the hour)." while the match
  is pending and the other team has to confirm; "Session ended. It counts once your team confirms the match, by
  6:40 PM. Confirm it in Match History." when an opponent recorded it; "...once both teams confirm the match, by
  6:40 PM." when a non-player did (`confirm_needed`); "It counts: you recorded a match." only for a match stored
  confirmed. A match this device recorded still asks the server at End (it may have expired unconfirmed while the
  session ran; decision 3's line only when the server can't answer); if it is gone, the sheet says "The match you
  recorded during it was removed: it wasn't confirmed by both teams within an hour, or it was deleted. Record
  another match or drill by 7:40 PM to make this one count." Too short: "Session ended after 3 min. Sessions under
  5 minutes don't count." (plus "Your match is still recorded."). The sheet: "Session ended after 42 min. It doesn't
  count yet: no match or drill is recorded for it. Record one by 7:40 PM.", or the server's why. Once the 2-hour
  window is over: "Session ended. It didn't count: no match or drill was recorded within 2 hours of its end." (or,
  with no server answer, "...The 2 hours to record a match or drill for it are over, so it counts only if one was
  recorded in time."). Not now: "Saved. It counts if you record a match or drill by 7:40 PM."
- **Drill review**: a review of a drill held during the running session: "Your play session counts now: you
  reviewed a drill held during it." only when `drill_counted`; a session a match made count, with an old drill
  reviewed: "This drill doesn't count for your play session: it was scheduled for Thu 5:00 PM, not during the
  session. Your session counts through your match instead." A lost answer (timeout, dropped connection) never says
  the review wasn't sent ("Lost the connection, so we can't tell whether your review was saved. Try again: if it
  was, Pickleague will say so."); a retry that answers "already reviewed" reads as saved ("Your review was saved").
- **Sign-out** that couldn't close presence: what stays open and until when, then the action for each ("Sign in
  again and tap Check out to end it sooner." / "...tap End on your play session..." / both).
- **Friends**: "Request sent. Sam can accept it in Pickleague." (never promises a notification: a quiet re-request
  would make it untrue); "You and Sam are already friends."; a Cancel that cancelled nothing says why ("Sam already
  accepted, so you're friends now.", else "That request isn't waiting any more, so there's nothing to cancel.":
  true for a decline, which is never revealed, a cancel elsewhere, a block, and a failed status read).

## Offline check-in time (the tap rule, 2026-10-16)

Decided by the user 2026-10-16 ([plan, decisions of 2026-10-16](./play-sessions-presence.md#phase-15-validity-rules-decided-by-the-user-2026-10-16-sql--ota)):
a check-in's fix is judged against the check-in (tap) time, not the time it reached the server, and must have been
taken within 2 minutes of the tap. SQL: `supabase/migration_checkin_tap_time.sql` (file 8). Release: SQL first, then
the OTA.

### Representation (no signature or payload change)

Every check-in and Start the app sends, live or queued, already carries three numbers from the phone's own clock:
`p_at` (the tap, stamped after the fix is taken), `p_fix_at` (when the fix was taken) and `p_fix_age_ms` (the fix's
age when the request is sent, recomputed at every send; it keeps that meaning everywhere, the check-out / End stay
proof included). The internal `_pl_tap_fix(p_at, p_fix_at, p_fix_age_ms)` works out, on the server clock:

```
age_at_tap = p_at - p_fix_at                 -- signed, phone clock (offset cancels)
fix_at     = now() - p_fix_age_ms            -- as before
tap_at     = least(now(), fix_at + age_at_tap)
verdict    = 'stale'     when age_at_tap > +120 s      (fix.stale)
             'after_tap' when age_at_tap < -120 s      (fix.after_tap)
             'too_old'   when tap_at < now() - 12 h    (checkin.too_old)
             'ok'
```

- No tap (`p_at` or `p_fix_at` null: `extend_checkin`, which is never queued): the tap is the send, and the old
  window on the age at send applies (-5 s to +2 min).
- No age (no shipped build sends a fix without one): the server-clock check on `p_fix_at` (`fix.stale_clock`) plus
  `abs(p_at - p_fix_at) <= 2 min`, so a backdated tap with a fix from now is refused in every call shape.
- Position and precision stay with `_pl_check_fix` (called with no age, so it judges only those).
- Live calls: the app reuses a fix under 60 s old or takes a fresh one, then stamps the tap, so `age_at_tap` is about
  0 to 70 s whatever the phone's clock says. `checked_in_at = tap_at` (about now): a phone 10 minutes off is never
  refused and never backdated by its offset.
- Not Doggle's form (the age measured at the tap, live calls with no tap): it would date the arrival fix by a
  phone-clock tap and shorten the Phase 1.5 stay proof; the runtime-1.0.4 OTA sends `p_at` plus the age at send on
  every live call, which this rule judges exactly; and `start_play_session` must keep `p_at` on live Starts.

### What is stored (backdating limit: 12 hours from the tap)

Matching how check-ins expire (`expires_at = tap + minutes`; the 10-minute `expire_venue_checkins` job sets
`checked_out_at = expires_at`):

| When it syncs | `checkin_venue` | The app |
|---|---|---|
| still running | open from `tap_at` to `tap_at + minutes` | adopts it (the card keeps showing it) |
| after it would have ended | **stored, already over**: `checked_in_at = tap_at`, `expires_at = tap_at + minutes` (or the start of a later check-in of mine), `checked_out_at` null, so the expiry job closes it and a queued check-out behind it records the real leave time and the stay fix. Every presence read wants `expires_at > now()`, so nobody sees it and no crowd counts it; `at_court` and the stay proof do | detects it with `expires_at <= created_at` (the server's two times) and says so once, on a notice card (`lapsedCheckinNotice`) |
| over 12 hours after the tap | refused, `checkin.too_old` (the tap in the player's zone) | drops it and says why |

- A replay never closes or overrides a check-in of mine made after its tap (the app tries a live call before an older
  queued one): it ends where that one starts; the quiet same-court path joins only a check-in begun at or before the
  tap; the one-open-check-in rule closes only check-ins begun at or before it (a private row whenever it began); a
  replay's older fix never replaces a newer one (`fix_at = greatest(...)`).
- `start_play_session`: the session row is unchanged (the app's time, clamped to 12 h, decision 2 of Phase 1.5); its
  check-in is judged at the tap and anchored there (`tap_at` to `tap_at + 180 min`, what a live Start already got),
  stored already over when that is past, and ended by End as before. `too_old`, `after_tap` and `stale` give no
  check-in and are never an error. With a fix confirmed at the tap it adopts only a check-in begun at or before the
  tap, and takes its fix only when newer. The no-fix adopt path is unchanged.
- `extend_checkin`: unchanged, except that a confirmed check-in stored already over can't be extended back to life
  in the minutes before the expiry job closes it (`checkin.closed`, ended at its `expires_at`). A private row keeps
  its old behaviour.
- No fix (1.0.2-1.0.4 embedded bundles): unchanged (6 h clamp, private row, untracked Start).

### 1.0.4 on this server

- Embedded bundles send no fix: every path they use is unchanged (persona T35).
- The runtime-1.0.4 OTA: live calls are accepted as before (`checked_in_at` becomes the true server time); its queued
  check-ins under 12 h now count (one still running is adopted; one already over shows nothing, since its card
  cleared at the expiry); over 12 h it gets `checkin.too_old`, a code it doesn't know, so it shows its own "more
  than 2 minutes after you tapped" notice, still true. `fix.stale` keeps "location is out of date" and "2 minutes".
  No new text uses a network word, "expired", "not found" or errcode 42501.

### Client (tap rule)

- `QUEUED_CHECKIN_NOTE` (court card and lock-screen "Checked in" notice): "Saved with no signal. It counts if your
  phone is back online within 12 hours."
- A replay stored already over (`courtCheckinRules.syncedAfterItEnded`): drops the card's entry and posts "Check-in
  saved late" / "Your check-in at Lakeside (2:10 PM) reached Pickleague at 5:05 PM, after it had ended at 4:10 PM,
  so nobody saw you there. Pickleague still saved it as your visit. Check in again if you're still at the court."
- A queued check-in that runs out on the device before it is sent: the card says once "Your check-in at Lakeside
  ended at 4:10 PM before your phone had a signal to send it. It's sent when you're back online, if that's within
  12 hours of when you tapped. Check in again if you're still at the court." (was silent).
- A refused replay words the server's code (`checkin.too_old`, `fix.after_tap`, `fix.not_at_court`...); the old
  2-minute reason only for an older server's `fix.stale` on a fix that was fresh at its tap (`refusedForQueueWait`).
- A Start at a court that didn't check me in (`lib/playStartRules.untrackedReason`, reading the session's own
  check-in by id, `data/venueCheckins.getMyCheckin`): `synced_late` ("Your check-in at Lakeside for this session ran
  until 5:10 PM, but the session reached Pickleague after that, so nobody saw you there. Pickleague still counts you
  as at the court for it. Check in from Home if you're still there."), `too_old`, `unconfirmed_late` (replaces
  `stale`: true under old and new servers), `not_at_court` and the rest as before. A replayed Start says it on a
  notice card (the player wasn't watching); a live one on the island.
- `offersUntrackedSession` also offers the untracked session after `fix.after_tap` and `checkin.too_old`.

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
location-confirmed check-in and session changes are NOT gated (they replace existing behaviour).

## SQL files and apply order

Apply in ONE transaction, in this order (none of the files contains begin/commit):

1. `supabase/migration_presence_p1_schema.sql`: columns, all new tables (friendships, close_friends and the
   internal `friend_request_log` live here, because the privacy helpers read them), owner-only RLS, the venue
   dedupe pass, the league / court-location backfill + sync triggers, privacy helpers
2. `supabase/migration_presence_p1_checkins.sql`: checkin_venue, checkout_venue, extend_checkin,
   start_play_session, end_play_session, expire_play_sessions, resolve_court
3. `supabase/migration_presence_p1_reads.sql`: venue_players_here, court_presence, venue_crowd, friends_at_courts,
   presence settings, court favorites
4. `supabase/migration_presence_p1_friends.sql`: friend RPCs, notices, block teardown trigger, suggest_friends
5. `supabase/migration_presence_p1_hygiene.sql`: `_purge_account` (delete_my_account + moderator_eject_user),
   `pickleague-presence-retention` cron

`migration_rls_hardening_2026q3.sql` already allowlists every RPC below (plus the 29 client RPCs that were
missing and the policy helpers), so re-running it afterwards takes nothing offline. Persona tests (250
assertions, all passing against the live DB in a rolled-back transaction on 2026-10-16):
`node supabase/tests/build-presence-test.mjs <out.sql>`, then `supabase db query --linked -f <out.sql> -o csv`
from the linked checkout. Then redeploy send-push with `--no-verify-jwt`.

## Where the SQL differs from or sharpens this contract (2026-10-16)

Signatures are exactly as below. Behaviour details the clients should know:

- **checkout_venue `p_source`** keeps its 1.0.4 meaning, a FILTER: `'manual' | 'geofence' | 'session'` close only
  check-ins that source opened. Its default stays `null` (not `'manual'`): no filter. Any other value, e.g.
  `'signout'`, also means no filter, so `checkout_venue(null, 'signout', now)` closes everything.
- **Unknown-id fallback** (checkout_venue, extend_checkin) applies only when `p_id` names no check-in of the caller
  (1.0.4 keeps its own id when the server hands back the row it already had). A `p_id` that names a closed row is a
  replay: checkout returns 0, extend raises `Check-in is no longer open`.
- **Extra check-in errors:** a stale fix (older than 2 minutes or more than 1 minute ahead) raises
  `Your location is out of date. Try again at the court.`; a fix with only one of lat/lng (or out of range) raises
  `Your location didn't come through. Try again.` The distance in the "about % m away" message is to the nearest
  of the facility's rows (canonical + duplicates), and a fix confirms when it is inside any of them.
- **Quiet repeat check-in:** a call without a fix at a court where the caller already has a confirmed row returns
  that row unchanged (no extension without a fix). A confirmed call at a court where the caller has only a private
  (unconfirmed) row closes it and opens a new confirmed row.
- **start_play_session adopt path** needs no fix (the adopted row was already confirmed). Without an adoptable row,
  a fix that does not confirm the court is NOT an error: the session starts untracked.
- **resolve_court** clamps `p_radius_m` to 10..2000 m; `p_sport = null` means any sport; `inside` = in a boundary or
  within a row's `geofence_radius_m` (no accuracy slack); raises `Not authenticated` without a session.
- **venue_crowd** omits unknown ids, answers each requested id as given (two duplicates both answer), and raises
  `At most 50 courts at a time` past 50. "Rated" for the band = has played a match (`total_matches_played > 0`),
  as the standings treat it. band_low / band_high are `numeric(4,2)`.
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
```

RLS: `venue_checkins_read` and `play_sessions_read` become `using (user_id = auth.uid())`.

## Location confirmation (no manual check-ins)

A fix confirms a venue when it is at most 2 minutes old (`p_fix_at >= now() - interval '2 minutes'`, and not in the
future by more than 1 minute) and either inside `venues.boundary_geom` or within
`coalesce(geofence_radius_m, 100) + least(coalesce(p_accuracy_m, 75), 75)` metres of `(lat, lng)`
(`public.haversine_meters`). Duplicates resolve to the canonical row first.

## RPCs

### Check-ins and sessions (signatures replaced in ONE transaction; 1.0.4 named-argument calls still resolve)

```
checkin_venue(p_id uuid, p_venue text, p_minutes int default 120, p_source text default 'manual',
              p_at timestamptz default null,
              p_lat double precision default null, p_lng double precision default null,
              p_accuracy_m double precision default null, p_fix_at timestamptz default null)
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

```
start_play_session(p_id uuid, p_kind text, p_source uuid default null, p_venue text default null,
                   p_at timestamptz default null,
                   p_lat double precision default null, p_lng double precision default null,
                   p_accuracy_m double precision default null, p_fix_at timestamptz default null)
  returns public.play_sessions
```
- Unchanged behaviour plus: when `p_venue` is set and the fix confirms it, open a `source='session'` check-in with
  `id = p_id`, `expires_at = greatest(v_at, now()) + 180 min` (skip if that is already past). If the caller already
  has an open confirmed check-in at that venue, adopt it (extend its `expires_at` to cover 180 min) instead.
- Closing a previous session also closes that session's `source='session'` check-in.

`end_play_session(p_id, p_at)` — unchanged signature; also closes the check-in `id = p_id and source = 'session'`.
`extend_checkin(p_id, p_until)` — unchanged signature; falls back to the caller's open row when `p_id` names no
check-in of the caller (a closed one still raises).

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
self → named; viewer is guest/expired guest/deleted → anonymous for counts only; blocked either way → none;
owner paused or hiding from viewer → anonymous; owner level `hidden` → anonymous; `everyone` → named;
`leaguemates` → named if friends or share a closed league; `friends` → named if friends; else anonymous.
Only `location_confirmed` rows are ever visible to anyone but the owner.

### Presence reads

```
venue_players_here(p_venue text) returns table(...)   -- identical signature/columns as today (1.0.4 clients)
  -- now SECURITY DEFINER; anonymous rows: checkin_id = md5(c.id::text || auth.uid()::text)::uuid,
  -- user_id/full_name/avatar_*/rating/doubles_rating null; 'none' rows omitted
court_presence(p_venue text) returns table(checkin_id uuid, user_id uuid, full_name text, avatar_url text,
  avatar_emoji text, avatar_bg_color text, doubles_rating numeric, checked_in_at timestamptz,
  expires_at timestamptz, anonymous boolean, is_friend boolean, is_close_friend boolean, via_session boolean,
  session_kind text)
venue_crowd(p_venue_ids text[]) returns table(venue_id text, here_now int, band_low numeric, band_high numeric,
  friends_here int)
  -- at most 50 ids; here_now counts confirmed open rows (hidden players count, blocked excluded);
  -- band = 25th–75th pct of doubles_rating rounded to 0.25, only with >= 3 rated players present
friends_at_courts(p_hours int default 12) returns jsonb
  -- {now: [{venue_id, venue_name, lat, lng, since, until, people: [{user_id, full_name, avatar_url,
  --          avatar_emoji, avatar_bg_color, is_close_friend, via_session, session_kind, checked_in_at, expires_at}],
  --         others_here int}],
  --  courts: [{venue_id, venue_name, reason: 'favorite'|'home'|'frequent', here_now, band_low, band_high, friends_here}]}
  -- now: named people only (friends + closed-league mates per their settings), grouped by canonical venue, cap 100
  -- courts: up to 3 — favorites first, then league home venues, then the viewer's most-visited (last 60 days)
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
- Blocking (AFTER INSERT on `user_blocks`) deletes the friendship, close_friends and presence_hidden_from rows both ways.

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
  presence_hidden_from (both columns), friendships, close_friends (both), court_favorites for the user.
- Daily pg_cron job `pickleague-presence-retention` deletes venue_checkins older than 180 days.
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
- Every `checkin_venue` call sends the four fix arguments (no manual check-ins). A check-in queued offline carries
  the fix taken at tap time; when the server refuses it on replay, the client drops it and tells the player the next
  time the court card shows. A queued check-in from an older build that has no fix is dropped without being sent.
- `start_play_session` sends the fix only with a court (`p_venue`); a session with no court sends four nulls.
- `resolve_court` is always called with `p_sport` from `mobile/src/sports/registry.ts` (`getSport().courtSport`).
  The court card, the start sheet, the league court chip and the geofence list all key on its canonical id.
- League home-court pickers write `leagues.home_venue_id` (the picked catalog venue, else null) alongside `home_court*`.
- The start sheet reads the presence settings (for its "who sees you" line) and `list_my_court_favorites`, through
  the presence stream's wrappers (`data/presenceSettings`, `data/courtFavorites`), and treats either failing as
  "defaults / none".

### Privacy, crowd and Friends at the courts (presence stream, `feat/presence-p1-presence`)

- Rosters (PlayersHereList, the league court chip) read `court_presence`; `venue_players_here` is kept only for
  1.0.4. An anonymous row shows "Player"; the client would show a half-point band if the row carried
  `doubles_rating`, but the SQL sends null for anonymous rows, so it never does.
- `venue_crowd` is called in chunks of at most 50 ids; an id the SQL omits reads as an empty court.
- Consent (`lib/presenceConsent.ts`, recorded with `set_presence_settings(p_consent_seen => true)`):
  `ensurePresenceConsent()` is awaited outside any bounded busy state and never while another Modal is up (iOS
  shows one at a time). The court card asks it before the location prompt and the bounded check-in; the start
  sheet's host asks it before the sheet opens ("Not now" opens nothing); the lock-screen arrival Check in uses
  `hasPresenceConsent()` and, when it is false, asks the player to open the app.
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

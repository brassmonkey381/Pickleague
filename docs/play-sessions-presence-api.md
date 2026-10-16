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
checkout_venue(p_id uuid, p_source text default 'manual', p_at timestamptz default null) returns integer
```
- Replaces the 2-arg version. `checked_out_at = greatest(checked_in_at + 1s, least(coalesce(p_at, now()), now(), expires_at))`.
- `p_id` that matches no open row falls back to the caller's open row (any venue); `p_id is null` closes all of the caller's open rows.

```
start_play_session(p_id uuid, p_kind text, p_source uuid, p_venue text, p_at timestamptz,
                   p_lat double precision default null, p_lng double precision default null,
                   p_accuracy_m double precision default null, p_fix_at timestamptz default null)
  returns public.play_sessions
```
- Unchanged behaviour plus: when `p_venue` is set and the fix confirms it, open a `source='session'` check-in with
  `id = p_id`, `expires_at = greatest(v_at, now()) + 180 min` (skip if that is already past). If the caller already
  has an open confirmed check-in at that venue, adopt it (extend its `expires_at` to cover 180 min) instead.
- Closing a previous session also closes that session's `source='session'` check-in.

`end_play_session(p_id, p_at)` — unchanged signature; also closes the check-in `id = p_id and source = 'session'`.
`extend_checkin(p_id, p_until)` — unchanged signature; falls back to the caller's open row when `p_id` is not open.

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

Client side (friends stream, `feat/presence-p1-friends`), for the SQL to match:
- send-push (done in that branch): `friendButtons` attaches category `friend_request` when `push_data.kind =
  'friend_request'` and `friendships` has `requester_id = entity_id`, `addressee_id = recipient`, `status = 'pending'`.
- `friend_accepted` gets **no catalog category**: it has no buttons, and the kit's `catalogProblems` rejects a
  category without actions. Its tap uses the `player/<id>` deep link (a `friend/<id>` row without a link is
  mapped there by `push_data.kind`).
- Lock-screen buttons `friend_accept` / `friend_decline` call `respond_friend_request(entity_id, accept)` and, on
  `'gone'`, `friendship_status_with(entity_id)` to tell a replay ("Already friends") from a cancelled request.
- Home's Up next counts incoming `list_friend_requests` rows on the bell (one row, "Sam wants to be friends" /
  "3 friend requests"), so that RPC runs on every Home load while the flag is on.
- Copy the SQL should match: notice titles start with the requester's display name and end with "wants to be
  friends" / "accepted your friend request" (the lock-screen notice reads the name back out of the title).

## Hygiene

- `delete_my_account` (and the godmode delete) deletes venue_checkins, play_sessions, presence_settings,
  presence_hidden_from (both columns), friendships, close_friends (both), court_favorites for the user.
- Daily pg_cron job `pickleague-presence-retention` deletes venue_checkins older than 180 days.
- Client: before `signOutSafely`, best-effort `checkout_venue(null, 'signout', now)` and `end_play_session` for the open
  session, each bounded to 3 s, never blocking sign-out (SettingsScreen doSignOut, GuestJoinScreen).

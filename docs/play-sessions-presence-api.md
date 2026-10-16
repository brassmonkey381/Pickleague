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
   presence reads as consent). Stands alone: it can also go live ahead of the rest.
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

## Where the SQL differs from or sharpens this contract (2026-10-16)

Signatures are exactly as below. Behaviour details the clients should know:

- **checkout_venue `p_source`** keeps its 1.0.4 meaning, a FILTER: `'manual' | 'geofence' | 'session'` close only
  check-ins that source opened. Its default stays `null` (not `'manual'`): no filter. Any other value, e.g.
  `'signout'`, also means no filter, so `checkout_venue(null, 'signout', now)` closes everything.
- **Unknown-id fallback** (checkout_venue, extend_checkin) applies only when `p_id` names no check-in of the caller
  (1.0.4 keeps its own id when the server hands back the row it already had). A `p_id` that names a closed row is a
  replay: checkout returns 0, extend raises `Check-in is no longer open`.
- **Fix age on one clock:** checkin_venue, start_play_session and extend_checkin take a trailing
  `p_fix_age_ms` (the fix's age at send time, measured on the device). With it, fresh = age between -5 s and 2 min
  whatever the device clock says, and `fix_at` is stored on the server clock (`now() - age`). Without it (1.0.4,
  older builds) `p_fix_at` is compared with the server clock as before.
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
`league_members.role` (column grant), and no one may change a membership's `league_id` / `user_id` (trigger).

## Location confirmation (no manual check-ins)

A fix confirms a venue when it is fresh, precise, and at the court:
- fresh: `p_fix_age_ms` (the age measured on the device at send time) between -5 s and 2 minutes; without an age,
  `p_fix_at >= now() - interval '2 minutes'` and not more than 1 minute in the future (server clock);
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
- Every `checkin_venue` call sends the fix arguments (no manual check-ins), with `p_fix_age_ms` computed at each
  send (`fixArgs(fix, Date.now())`), so a queued replay counts its time in the queue and a wrong device clock
  doesn't matter. A check-in queued offline carries the fix taken at tap time; when the server refuses it on replay,
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

Not decided yet (the user's call, see the plan's "Still open"): the 5-minute floor is measured on the session's own
start and end, which the app sends (a Start may be backdated up to 12 h for offline use). Each such session still
needs its own match or drill, so the damage is bounded.

### RPC

```
my_session_validity(p_session uuid) returns jsonb
  -- {valid boolean, reason text, needs 'minutes' | 'match_or_drill' | null,
  --  window_ends_at timestamptz | null (ended_at + 2 h), rewards_pending_confirmation boolean,
  --  at_court boolean}
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
- **End sheet** (`playEnded` -> `components/play/PlayEndSheet`, `lib/sessionValidity`): under 5 minutes, a toast
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
  when `my_session_validity` then says the running session needs nothing more. Kept on the session's meta
  (`PlayMeta.recorded`, persisted per user), so a restart between recording and End remembers it.
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

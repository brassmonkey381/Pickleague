// Build-time feature flags.
//
// A flag here is for work that is MERGED but not SHIPPABLE - the code stays
// on master so it does not rot on a branch, while every user-visible entry
// point stays dark until the flag flips.

/**
 * Pickle wagering (bet earned pickles on match outcomes, exact scores, and
 * tournament finishes).
 *
 * OFF since 2026-08-16, for App Store review. The UI merged ahead of its
 * backend: every wager RPC the client calls is absent from the production
 * database - `calculate_wager_odds`, `place_wager`, `cancel_wager`,
 * `get_league_wager_totals`, `get_tournament_wager_totals`, `list_my_wagers`,
 * `get_player_wagers` all return PGRST202 (verified 2026-08-16). Only the
 * `wagers` table exists. So the flows fail at the point of use, and the
 * member lists fired failing lookups on mount.
 *
 * Two reasons this must stay OFF until the backend lands AND the store
 * position is decided:
 *   1. Guideline 2.1 - a reviewer who opens any wager flow hits a missing
 *      function. That reads as an unfinished app.
 *   2. Guideline 5.3 + age rating - wagering is a gambling-adjacent
 *      feature. The App Store listing declares a 4+ rating with no
 *      gambling, and Apple's rating questionnaire asks about simulated
 *      gambling explicitly. Turning this on means revisiting that
 *      declaration, virtual currency or not.
 *
 * To re-enable: ship the RPCs, flip this to true, re-answer the age-rating
 * questionnaire, and re-check the store copy (marketing-studio
 * apps/pickleague/app.yaml lists wagering under doNotMarket).
 */
export const WAGERS_ENABLED = false;

/**
 * Friends at the courts (docs/play-sessions-presence.md, Phase 1): the Friends
 * screen, friend requests, FriendButton / FriendsLink, Home "Friends at the
 * courts", the crowd line, the Notifications "Friends" chip, the "Friend
 * requests" push switch and friend push routes.
 *
 * ON since 2026-10-20, by OTA. Its precondition held: the presence Phase 1
 * SQL is live (applied 2026-10-16) and the rolled-back persona suite
 * (supabase/tests/presence_p1_personas.sql, with the court arrival personas)
 * passed 817/817 against the live DB on 2026-10-20. Every RPC behind it
 * (friend writes and reads, friends_at_courts, court_presence, venue_crowd)
 * is granted to authenticated and in the migration_rls_hardening_2026q3
 * allowlist. To turn it off again, flip this back: the screen unregisters and
 * every surface renders nothing, with no fetches.
 *
 * NOT behind this flag (they ship together, so a player is never shown at a
 * court without the means to control it): location-confirmed check-ins and
 * session check-ins, the one-time consent sheet, Settings > Privacy "Who sees
 * me at the courts" / "Hidden from", Pause sharing, and "Hide my presence" on
 * a player's ⋯ menu. The court star has its own flag (below).
 */
export const FRIENDS_AT_COURTS_ENABLED = true;

/**
 * The court star (☆ / ★, up to 3 courts), on its own flag since court arrival
 * (state/court-arrival-decisions.md, D4): starred courts are where Pickleague
 * checks you in when you arrive, so the star shows now on Home's court card
 * and in Settings > Check-in automation, whatever the friends flag above says.
 * Home's "Friends at the courts" list shows its star only when that section
 * shows.
 */
export const COURT_STARS_ENABLED = true;

/**
 * Court discovery, Phase 1 (state/court-discovery-plan.md): the Courts list
 * (nearby courts, nearest first, with a name filter) and each court's page
 * (facts, leagues, who's here, Directions, Share, Check in). Gates the
 * Courts / CourtDetail screens, their routes and links (pickleague.club/courts,
 * /courts/<encoded id>) and every entry point together: Home's Courts tile,
 * "Browse courts ›" on the court card, the home-court chip on a league, and
 * the Friends at the courts rows.
 *
 * OFF until supabase/migration_court_discovery_p1.sql is live and
 * supabase/tests/court_discovery_personas.sql passes against it; then flipped
 * by OTA after 1.0.4 is approved (the plan's ship note). Off, the screens are
 * unregistered, nothing links to them and nothing fetches.
 */
export const COURT_DISCOVERY_ENABLED = false;

/**
 * Routine check-ins (state/routine-checkins-plan.md, Doggle's routines): My
 * routine (Profile and Settings > Check-in automation), the routine editor,
 * Planned check-ins on profiles, the "Make it a routine?" card on Home, a
 * check-in's planned length and Closed group / Open play windows, "Switch to
 * open play now", "N here · M open to play" and the roster's play modes, and
 * routine courts fenced first and checked in during their window.
 *
 * OFF until supabase/migration_court_routines.sql is live (with the hardening
 * re-run that grants its RPCs) and send-push is redeployed with the new
 * kinds; then flipped by OTA. Off, nothing renders, nothing fetches, and the
 * geofence list and the arrival rules are exactly as before. (The
 * routine_reminder / arrival_extend_until buttons register either way: only
 * a server with routines sends a push that names them.)
 */
export const ROUTINES_ENABLED = false;

/**
 * Referrals, Doggle parity (state/referrals-plan.md): invite links
 * (www.pickleague.club/invite/CODE and ?ref=CODE), the InviteLanding screen,
 * the ReferralHost that stashes a code and claims it after sign-in (with
 * deferred click-to-install matching), the optional "Referral code" field on
 * Create Account, the code riding along on a guest's upgrade, and the
 * Invite & Earn section on Profile. 2500 pickles to each side once the new
 * account confirms its email; badges and bonuses at 1 / 5 / 10 friends.
 *
 * OFF until the user has tested it. Its backend is
 * supabase/migration_referrals.sql (plus the record-invite-click and
 * claim-deferred-invite edge functions and the INVITE_CLICK_SALT secret);
 * the persona suite is supabase/tests/referral_personas.sql. While off, no
 * screen registers, no link path resolves, no storage is read and no RPC is
 * called: the app behaves exactly as before.
 */
export const REFERRALS_ENABLED = false;

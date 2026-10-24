// The crowd line ("6 playing now · mostly 3.5–4.0 · 2 friends"; with routines
// "6 here · 4 open to play · mostly 3.5–4.0 · 2 friends") and the roster
// rows of who is at a court (docs/play-sessions-presence.md, Phase 1 step 8).
//
// PURE: no React, no Supabase. The numbers come from venue_crowd /
// friends_at_courts and the rows from court_presence; the server has already
// applied privacy (anonymous rows carry no ids, hidden, paused and blocked
// players count as "a player"). It also only sends a skill band when 3+ rated
// players are there whom this viewer sees only anonymously (never the viewer,
// never anyone shown by name), so no single person can be picked out of it;
// this file never makes a band out of the crowd itself.

/** venue_crowd's numbers for one court (and friends_at_courts' YOUR COURTS). */
export type CrowdNumbers = {
  here_now: number;
  band_low: number | null;
  band_high: number | null;
  friends_here: number;
};

/** "3.5", "4.0", "3.25": a PLUPR level as players say it (one decimal unless
 *  the quarter needs two). */
export function formatLevel(x: number): string {
  const two = (Math.round(x * 100) / 100).toFixed(2);
  return two.endsWith('0') ? two.slice(0, -1) : two;
}

/** "3.5–4.0", or "3.5" when both ends match; null without both ends. */
export function bandLabel(low: number | null | undefined, high: number | null | undefined): string | null {
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const a = formatLevel(Math.min(low, high));
  const b = formatLevel(Math.max(low, high));
  return a === b ? a : `${a}–${b}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "6 playing now · mostly 3.5–4.0 · 2 friends". With nobody there it is
 * `emptyText` (null by default, so a surface that already says "No one else
 * here yet" doesn't say it twice). null for no numbers at all (not loaded, or
 * the read failed): a crowd line never claims "nobody" it doesn't know.
 * `showFriends: false` leaves the friends part out ("6 playing now · mostly
 * 3.5–4.0"): the anonymous turnout without the friends feature (court
 * discovery, decision 4).
 */
export function crowdLineText(
  c: CrowdNumbers | null | undefined,
  emptyText: string | null = null,
  opts: { showFriends?: boolean; openNow?: number | null } = {},
): string | null {
  if (!c) return null;
  const n = Math.max(0, Math.floor(c.here_now ?? 0));
  if (n === 0) return emptyText;
  // Routines (venue_open_to_play): "6 here · 4 open to play"; none open, no part.
  // Without the number (routines off, not loaded) the line is as before.
  const open = opts.openNow == null ? null : Math.min(n, Math.max(0, Math.floor(opts.openNow)));
  const parts = open == null ? [`${n} playing now`] : [`${n} here`];
  if (open != null && open > 0) parts.push(`${open} open to play`);
  const band = bandLabel(c.band_low, c.band_high);
  if (band) parts.push(`mostly ${band}`);
  const f = opts.showFriends === false ? 0 : Math.max(0, Math.floor(c.friends_here ?? 0));
  if (f > 0) parts.push(plural(f, 'friend'));
  return parts.join(' · ');
}

// ── Roster rows (court_presence) ──────────────────────────────────────────────

/** The fields of a court_presence row this file reads. */
export type PresenceRowLike = {
  anonymous: boolean;
  full_name: string | null;
  doubles_rating: number | null;
  is_friend: boolean;
  is_close_friend: boolean;
  checked_in_at: string;
};

/** A half-point band around one rating: 3.62 -> 3.5–4.0. */
export function ratingBand(r: number | null | undefined): { low: number; high: number } | null {
  if (r == null || !Number.isFinite(r) || r <= 0) return null;
  const low = Math.floor(r * 2) / 2;
  return { low, high: low + 0.5 };
}

/** An anonymous row's label: "Player · 3.5–4.0" (a band, never the exact
 *  rating), or "Player" when no rating came with it. */
export function anonymousPlayerLabel(rating: number | null | undefined): string {
  const b = ratingBand(rating);
  return b ? `Player · ${bandLabel(b.low, b.high)}` : 'Player';
}

/** A named row's label. A close friend is no longer marked in the text: the
 *  row draws a star glyph beside it (presenceIsCloseFriend). */
export function presenceRowLabel(row: PresenceRowLike): string {
  if (row.anonymous) return anonymousPlayerLabel(row.doubles_rating);
  const name = row.full_name?.trim() || 'Player';
  return name;
}

/** Draw the close-friend star beside this row's label (named rows only). */
export function presenceIsCloseFriend(row: PresenceRowLike): boolean {
  return !row.anonymous && !!row.is_close_friend;
}

/** Close friends, then friends, then other named players (each by arrival),
 *  then the anonymous rows. Stable for equal keys. */
export function sortPresenceRows<T extends PresenceRowLike>(rows: readonly T[]): T[] {
  const rank = (r: T) => (r.anonymous ? 3 : r.is_close_friend ? 0 : r.is_friend ? 1 : 2);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const d = rank(a.r) - rank(b.r);
      if (d !== 0) return d;
      const ta = Date.parse(a.r.checked_in_at);
      const tb = Date.parse(b.r.checked_in_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

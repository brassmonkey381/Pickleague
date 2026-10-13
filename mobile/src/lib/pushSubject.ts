// What a push is about, read back out of its title, so a lock-screen action's
// notice can say "You're in: Tuesday Doubles" instead of a bare "You're in".
//
// The titles come from the DB generators (supabase/migration_*.sql); every
// shape matched here is one they write. An unknown shape gives null and the
// notice keeps its generic copy, rather than echoing a whole title back.
//
// PURE and import-free: notificationActions.ts pulls Supabase and the
// foundation, which vitest can't load, so the tests import this file alone.

/** Longest notice title we build (the lock screen cuts off around here). */
export const NOTICE_TITLE_MAX = 40;

// "🗳️ New vote: Tuesday Doubles" and friends: a label, a colon, the name.
const LABELLED =
  /^(?:New vote|Vote closing soon|Voting closes soon|Event scheduled|Event reminder|Event cancelled|New tournament|Tournament starting soon|Registration closing soon|Tournament invite|Invite|Join request):\s*(.+)$/i;
// "📣 Tuesday Doubles is today", "Bracket Set — Summer Smash".
const TRAILING = /^(.+?)\s+is (?:today|tomorrow)$/i;
const BRACKET = /^Bracket Set\s*[—–-]\s*(.+)$/i;
// Drill pushes name the other player: "🥒 Sam wants to drill", "💬 Sam replied".
const PERSON = /^(.+?)\s+(?:wants to drill|replied|accepted!|declined|is on the way|can['’]t make it)$/i;
// What the generators write when they have no name, and "Invite accepted" /
// "Invite declined" (tournament pushes that PERSON would otherwise read as a name).
const NO_NAME = new Set(['someone', 'your partner', 'your drill partner', 'invite']);

// Leading emoji and symbols: astral emoji (surrogate pairs), dingbats like
// ✅ ❌ ⏳, variation selectors and joiners. Spelled as ranges, not \p{...},
// so it needs no Unicode-property support from the JS engine (Hermes).
const LEAD = /^[\s\uD800-\uDFFF℀-⯿‍︀-️]+/;

/** The event / tournament / league / player a push title names, or null. */
export function pushSubject(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const t = title.replace(/\s+/g, ' ').replace(LEAD, '').trim();
  if (!t) return null;
  const m = LABELLED.exec(t) ?? BRACKET.exec(t) ?? TRAILING.exec(t) ?? PERSON.exec(t);
  const s = m?.[1]?.trim();
  if (!s || NO_NAME.has(s.toLowerCase())) return null;
  return s;
}

/** Cut to `max` characters (code points, so an emoji is never split), ending in an ellipsis. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  if (max <= 1) return '…';
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** "You're in" + "Tuesday Doubles" -> "You're in: Tuesday Doubles", kept within NOTICE_TITLE_MAX. */
export function titleWith(prefix: string, subject: string | null | undefined, max = NOTICE_TITLE_MAX): string {
  const s = subject?.trim();
  if (!s) return prefix;
  const room = max - Array.from(prefix).length - 2;
  // Too little room for a useful name: the plain prefix reads better than "You're in: T…".
  return room < 4 ? prefix : `${prefix}: ${truncate(s, room)}`;
}

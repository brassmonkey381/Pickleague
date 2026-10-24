// Notification copy for display (2026-10-24, glyph review). The server writes
// its notification titles and bodies with emoji ("🔥 Day 5 streak: +200🥒!"),
// and the same text is the OS push, so the stored text keeps them. On screen
// the row already draws a glyph tile, so the body drops each line's leading
// emoji and spells the pickles out: "Day 5 streak: +200 pickles!".
//
// PURE: the foundation's text helpers come from their own subpath, which loads
// no glyph components.
import { textForDisplay, type EmojiUnit } from '@just-messin-around/expo-foundation/icons/text';

/** The pickles currency as the server writes it after a number ("150 🥒").
 *  A lookup key for server text, not UI: screens draw the `pickle` glyph. */
export const PICKLE_UNIT: EmojiUnit = { emoji: '🥒', one: 'pickle', other: 'pickles' };

/** A notification body as the Notifications row shows it (display only). */
export function noticeBodyForDisplay(body: string | null | undefined): string {
  return textForDisplay(body, { units: [PICKLE_UNIT] });
}

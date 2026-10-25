// Where Home's check-in card (components/CourtCheckinCard) sits, and whether
// it shows: in NOW while it has something to say (checked in, or "At <court>?"),
// else in the old court row, hidden there with the bottom bar (its centre Check
// in does that job).
//
// The card must stay ONE element under ONE key with ONE wrapper type in every
// mode. React keeps a keyed element mounted only while its type stays the
// same, and the card reports 'idle' as it mounts (its cached check-in is read
// after the first render). Until 2026-10-24 the idle row wrapped it in a
// hidden <View key="court"> and NOW pushed it bare under the same key, so each
// report swapped the element type and remounted it: idle -> wrapped ->
// remount -> checked_in -> unwrapped -> remount -> idle ..., about 30 times a
// second whenever this device held a check-in. Every mount read my open
// check-in, who's here and the check-in's plan (court_presence,
// court_play_modes, venue_checkins), so Home sent ~130 requests a second, and
// ~50 a second from any screen pushed over Home (the plan line's read runs
// unfocused too). Home now always renders the slot's wrapper and only moves it
// or hides it.
//
// PURE: vitest covers it (lib/__tests__/homeCourtSlot.test.ts).

/** CourtCheckinCard's mode (components/CourtCheckinCard CourtCardMode). */
export type HomeCourtMode = 'idle' | 'checked_in' | 'prompt';

export type HomeCourtSlot = {
  /** The React key of the wrapper, the same in every mode. */
  key: 'court';
  /** The wrapper's type, the same in every mode (a View). */
  wrapper: 'view';
  /** NOW (under its header) or the court row's old place, lower down. */
  place: 'now' | 'row';
  /** display: none (the card stays mounted, so its modes still surface). */
  hidden: boolean;
};

export function homeCourtSlot(mode: HomeCourtMode, o: { playNav: boolean }): HomeCourtSlot {
  const now = mode !== 'idle';
  return { key: 'court', wrapper: 'view', place: now ? 'now' : 'row', hidden: !now && o.playNav };
}

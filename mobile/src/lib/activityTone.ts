// Shared color tones for "activity" status across league surfaces.
//
//   purple = open / joinable / not-yet-locked-in and upcoming for a future date
//            (open votes, upcoming seasons, tournaments open for registration)
//   blue   = locked in & scheduled for a future date, registration/voting closed
//            (tournaments closed for registration, finalized events)
//
// Fixed hex (theme-agnostic) so the same meaning reads the same in light/dark,
// matching the existing fixed-hex season chips on the leagues list.

export type ActivityTone = 'purple' | 'blue';

export const TONE_COLORS: Record<ActivityTone, { bg: string; border: string; label: string; value: string }> = {
  purple: { bg: '#efe6fb', border: '#9b6dd6', label: '#7b3fb5', value: '#5a2d86' },
  blue:   { bg: '#e3effb', border: '#5a9bd6', label: '#2f6db5', value: '#1f4d86' },
};

// Is a tournament "open for registration" (purple) vs "scheduled / closed" (blue)?
// registration → purple; anything else still upcoming (active, future start) → blue.
export function tournamentTone(status: string): ActivityTone {
  return status === 'registration' ? 'purple' : 'blue';
}

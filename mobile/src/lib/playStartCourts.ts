// The "Where are you playing?" sheet's court list and its "who sees you" line
// (components/play/PlayStartSheet). Pure, so vitest pins the order.

/** Who sees my check-ins, as far as the line needs it (get_my_presence_settings). */
export type CheckinVisibility = { level: string | null; pausedUntil: string | null };

export type CourtReason = 'checked_in' | 'here' | 'home' | 'favorite' | 'recent';
export type CourtCandidate = { id: string; name: string; reason: CourtReason };

/** Preselection order: my check-in, the court I'm standing in, then my usual courts. */
const ORDER: CourtReason[] = ['checked_in', 'here', 'home', 'favorite', 'recent'];

const NOTE: Record<CourtReason, string> = {
  checked_in: 'Checked in',
  here: "You're here",
  home: 'League home court',
  favorite: 'Favorite',
  recent: 'Recent',
};

export function courtNote(reason: CourtReason): string {
  return NOTE[reason];
}

/**
 * One list in preselection order, at most `max` courts. A court that shows up
 * twice keeps its first (strongest) reason. The first entry is the one to
 * preselect.
 */
export function mergeCourtCandidates(
  groups: Partial<Record<CourtReason, { id: string; name: string }[]>>,
  max = 5,
): CourtCandidate[] {
  const out: CourtCandidate[] = [];
  for (const reason of ORDER) {
    for (const c of groups[reason] ?? []) {
      if (out.length >= max) return out;
      if (!c?.id || out.some((o) => o.id === c.id)) continue;
      out.push({ id: c.id, name: c.name, reason });
    }
  }
  return out;
}

/**
 * The line under the court list. `untilLabel` formats the pause end in the
 * device's zone ("today 7:40 PM").
 */
export function visibilityLine(
  v: CheckinVisibility | null,
  hasCourt: boolean,
  nowMs: number,
  untilLabel: (iso: string) => string,
): string {
  if (!hasCourt) return 'No court: only you see this session.';
  const paused = v?.pausedUntil ? Date.parse(v.pausedUntil) : NaN;
  if (Number.isFinite(paused) && paused > nowMs) {
    return `Sharing paused until ${untilLabel(new Date(paused).toISOString())}: others see "Player".`;
  }
  switch (v?.level) {
    case 'everyone':
      return 'Visible to everyone at the courts';
    case 'friends':
      return 'Visible to friends';
    case 'hidden':
      return 'Hidden: others see "Player"';
    default:
      // 'leaguemates', the default, and what an unreadable setting falls back to.
      return 'Visible to friends and league-mates';
  }
}

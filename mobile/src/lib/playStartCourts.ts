// The "Where are you playing?" sheet's court list and its "who sees you" line
// (components/play/PlayStartSheet). Pure, so vitest pins the order.

/** Who sees my check-ins, as far as the line needs it (get_my_presence_settings). */
export type CheckinVisibility = { level: string | null; pausedUntil: string | null };

/** 'picked': "▶ Play here" named this court (a court page, a feed row). */
export type CourtReason = 'checked_in' | 'picked' | 'here' | 'home' | 'favorite' | 'recent';
export type CourtCandidate = { id: string; name: string; reason: CourtReason };

/** Preselection order: my check-in, the court I asked for, the court I'm standing in, then my usual courts. */
const ORDER: CourtReason[] = ['checked_in', 'picked', 'here', 'home', 'favorite', 'recent'];

const NOTE: Record<CourtReason, string> = {
  checked_in: 'Checked in',
  picked: 'Picked',
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
 * Start sends a fresh fix with the court (that is what checks me in there),
 * except at my current check-in's court: start_play_session adopts that
 * already-confirmed check-in without one (indoors, permission revoked, web).
 * `currentVenueId` is read at Start, so a check-in that ended since the sheet
 * opened needs the fix again.
 */
export function startNeedsFix(court: CourtCandidate, currentVenueId: string | null | undefined): boolean {
  return !(court.reason === 'checked_in' && !!currentVenueId && currentVenueId === court.id);
}

/**
 * Does the selected court look like where I am? true: it is my check-in's
 * court, or the court my fix is inside. false: a fix was taken and it is
 * somewhere else. null: not known (no fix, or near the court but not inside
 * its mapped fence). The server is the judge at Start; this only keeps the
 * line from promising presence it won't give.
 */
export function atSelectedCourt(
  court: CourtCandidate | null,
  here: { id: string; inside: boolean } | null,
  fixTaken: boolean,
): boolean | null {
  if (!court) return null;
  if (court.reason === 'checked_in') return true;
  if (here && here.id === court.id) return here.inside ? true : null;
  return fixTaken ? false : null;
}

/**
 * The line under the court list. `untilLabel` formats the pause end in the
 * device's zone ("today 7:40 PM"). `atCourt` (atSelectedCourt): only a court
 * I seem to be at is promised as "Visible to ...".
 */
export function visibilityLine(
  v: CheckinVisibility | null,
  hasCourt: boolean,
  nowMs: number,
  untilLabel: (iso: string) => string,
  atCourt: boolean | null = true,
): string {
  if (!hasCourt) return 'No court: only you see this session.';
  if (atCourt === false) return "You don't seem to be at this court: this session won't show you there.";
  const paused = v?.pausedUntil ? Date.parse(v.pausedUntil) : NaN;
  if (Number.isFinite(paused) && paused > nowMs) {
    return `Sharing paused until ${untilLabel(new Date(paused).toISOString())}: others see "a player".`;
  }
  let who: string;
  switch (v?.level) {
    case 'everyone':
      who = 'Visible to anyone signed in to Pickleague';
      break;
    case 'friends':
      who = 'Visible to friends';
      break;
    case 'hidden':
      return 'Hidden: others see "a player"';
    default:
      // 'leaguemates', the default, and what an unreadable setting falls back to.
      who = 'Visible to friends and league-mates';
  }
  return atCourt === null ? `If you're at the court when you start: ${who.charAt(0).toLowerCase()}${who.slice(1)}` : who;
}

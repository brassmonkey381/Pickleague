// Court arrival rules (Doggle parity, state/court-arrival-doggle-parity.md
// sections B1-B5): what the phone does when it arrives at or leaves a court,
// what each notice says, and which courts it watches. The engine
// (lib/courtArrival), the geofence sync (lib/courtGeofence), the foreground
// monitor (lib/courtPromptMonitor) and the notice buttons (lib/courtCheckin)
// all decide through here, so the order of the checks is written once.
//
// PURE (no React Native, no kit imports), so vitest covers it
// (lib/__tests__/courtArrivalRules.test.ts).
//
// Copy the server also sends must stay identical to it, byte for byte:
// "Check in nearby?" (supabase/migration_court_checkin_prompt.sql) and
// "Checked in" / "Still at" (supabase/migration_court_arrival_queue.sql). The
// phone posts the same words when the server can't push to it.

// ── Timing (Doggle's, S3) ─────────────────────────────────────────────────────
/** A re-report within this of an arrival stays quiet; also the arrivals store's keep. */
export const ARRIVAL_QUIET_MS = 2 * 60 * 60_000;
/** A prompt this recent (app in the background) covers an arrival there. */
export const PROMPT_COVERS_ARRIVAL_MS = 15 * 60_000;
/** An Exit this soon after an arrival still has something to cancel or take back. */
export const CANCEL_WINDOW_MS = 30 * 60_000;
/** "Leaving X?" once per court in this window: a phone at the edge reports exit / enter / exit. */
export const DEPARTURE_COOLDOWN_MS = 30 * 60_000;
/** queue_court_arrival's budget inside a geofence wake. */
export const QUEUE_ARRIVAL_TIMEOUT_MS = 8_000;
/** The court's name for "At X?" when the region info has none. */
export const NAME_LOOKUP_TIMEOUT_MS = 1_500;
/** Check in / Check in now: the quiet fix, then the whole button (the OS gives about 30 s). */
export const CHECKIN_ACTION_FIX_MS = 8_000;
export const CHECKIN_ACTION_TIMEOUT_MS = 22_000;
/** confirm_court_arrival, then court_arrival_pending, inside that budget. */
export const CONFIRM_ARRIVAL_TIMEOUT_MS = 4_000;
export const ARRIVAL_PENDING_TIMEOUT_MS = 3_000;
/** Not here: the button's deadline, and how long a queued one may wait for signal. */
export const NOT_HERE_TIMEOUT_MS = 15_000;
export const ARRIVAL_CANCEL_MAX_AGE_MS = 2 * 60 * 60_000;
/** "At X?" is past its use after this: on app open, and on any geofence wake. */
export const STALE_ON_OPEN_MS = 2 * 60_000;
export const STALE_ON_WAKE_MS = 15 * 60_000;
/** Foreground monitor: a tick a minute, one prompt per court per 2 hours. */
export const MONITOR_TICK_MS = 60_000;
export const MONITOR_COOLDOWN_MS = 2 * 60 * 60_000;
/** QR wallet notice: once per court per 3 hours (as before). */
export const WALLET_RENOTIFY_MS = 3 * 60 * 60_000;
/** The server's arrival check-in: due a minute after arriving, 2 hours long
 *  (supabase/migration_court_arrival_two_hours.sql, _pl_arrival_length),
 *  "Still at" 5 minutes before the end; its job runs every 20 seconds. */
export const ARRIVAL_DUE_MS = 60_000;
export const ARRIVAL_JOB_PERIOD_MS = 20_000;
export const ARRIVAL_CHECKIN_MS = 2 * 60 * 60_000;
/** How long an arrival check-in lasted before that file (Doggle's 30 minutes):
 *  one made then, or by a server not yet updated, is still recognised. */
export const LEGACY_ARRIVAL_CHECKIN_MS = 30 * 60_000;
export const STILL_AT_LEAD_MS = 5 * 60_000;
/** How long after the phone's own "Checked in" (D3) the server has surely
 *  decided: without sub-minute pg_cron its job runs only once a minute. */
export const ARRIVAL_SETTLE_MS = 60_000;
/** The player's notification types, read before the phone stands in for a
 *  push it can't get (a geofence wake may have weak signal). */
export const PREFS_LOOKUP_TIMEOUT_MS = 1_500;

// ── Circles (S6) ──────────────────────────────────────────────────────────────
export const COURT_RADIUS_CHOICES = [0, 100, 250, 1000] as const;
export const DEFAULT_COURT_RADIUS_M = 100;
export const WALLET_RADIUS_M = 100;
export const MIN_REGION_RADIUS_M = 50;
export const MAX_REGION_RADIUS_M = 800;
/** iOS watches at most 20 regions per app. */
export const MAX_COURT_REGIONS = 20;

// ── Kinds and ids ─────────────────────────────────────────────────────────────
/** data.kind of the phone's "At X?" (the only notice shown while the app is open). */
export const ARRIVAL_NOTICE_KIND = 'arrival-notice';
/** data.kind of "Check in nearby?", the server's push and the phone's copy alike. */
export const COURT_PROMPT_KIND = 'court_prompt';
/** data.kind of "Leaving X?". */
export const DEPARTURE_NOTICE_KIND = 'checkin-departure';
/** push_data.kind of the server's arrival pushes (the phone's D3 copies use the first two). */
export const ARRIVAL_CHECKIN_KIND = 'arrival_checkin';
export const ARRIVAL_EXTEND_KIND = 'arrival_extend';
/** "Staying until 12 PM?": an arrival check-in at a routine court whose
 *  planned end is later than the arrival length (migration_court_routines.sql). */
export const ARRIVAL_EXTEND_UNTIL_KIND = 'arrival_extend_until';
export const ARRIVAL_FAILED_KIND = 'arrival_failed';
export const ARRIVAL_EXPIRED_KIND = 'arrival_expired';

/** A QR wallet spot picked by GPS has no court row: its region id is "qr:<pass id>". */
export function isWalletOnlyRegionId(id: string): boolean {
  return id.startsWith('qr:');
}

// ── Settings ──────────────────────────────────────────────────────────────────
/** get_court_arrival_settings (supabase/migration_court_arrival_settings.sql). */
export type CourtArrivalSettings = {
  /** "Notice me at starred courts": 0 (Off) / 100 / 250 / 1000. */
  court_radius_m: number;
  /** "Prompt me near other courts": the same choices, default Off. */
  other_court_radius_m: number;
  /** "Check me in when I arrive". */
  auto_checkin: boolean;
  auto_checkin_set_at: string | null;
  /** "Remind me to check out when I leave". */
  departure_reminder: boolean;
  /** I've chosen who sees me at the courts (the queue checks in only after that). */
  consent_seen: boolean;
};

export const DEFAULT_COURT_ARRIVAL_SETTINGS: CourtArrivalSettings = {
  court_radius_m: DEFAULT_COURT_RADIUS_M,
  other_court_radius_m: 0,
  auto_checkin: true,
  auto_checkin_set_at: null,
  departure_reminder: true,
  consent_seen: false,
};

const isRadiusChoice = (v: unknown): v is number =>
  typeof v === 'number' && (COURT_RADIUS_CHOICES as readonly number[]).includes(v);

/** Fill anything the server left out (or an older copy lacks) with the defaults. */
export function normalizeCourtArrivalSettings(raw: unknown): CourtArrivalSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_COURT_ARRIVAL_SETTINGS;
  return {
    court_radius_m: isRadiusChoice(r.court_radius_m) ? r.court_radius_m : d.court_radius_m,
    other_court_radius_m: isRadiusChoice(r.other_court_radius_m) ? r.other_court_radius_m : d.other_court_radius_m,
    auto_checkin: typeof r.auto_checkin === 'boolean' ? r.auto_checkin : d.auto_checkin,
    auto_checkin_set_at: typeof r.auto_checkin_set_at === 'string' ? r.auto_checkin_set_at : null,
    departure_reminder: typeof r.departure_reminder === 'boolean' ? r.departure_reminder : d.departure_reminder,
    consent_seen: r.consent_seen === true,
  };
}

// ── What a geofence wake knows about its region ───────────────────────────────
/** Saved at each sync (lib/courtGeofence), read by wakes without the network. */
export type CourtRegionInfo = {
  name: string;
  /** A starred court (arrival check-ins and prompts). False: a QR wallet court only. */
  starred: boolean;
  /** The per-court "Check me in when I arrive" switch (starred courts). */
  autoCheckin: boolean;
  /** The QR wallet pass to open at this court, when one is saved and shown. */
  passId?: string;
  /** In my routine (an active routine at this starred court): fenced first,
   *  and an arrival during a stop's window checks in (decideArrival). */
  routine?: boolean;
};

// ── Arrival (Enter), rows 13-25 ───────────────────────────────────────────────
/** Why an arrival didn't check in by itself, said in "Check in nearby?". */
export type NearbyPromptReason = 'recently_left' | 'not_starred' | 'no_consent';

export type ArrivalFacts = {
  /** The region was last seen outside (an Enter after an Exit), not a re-report. */
  arrival: boolean;
  /** The region's saved info; null for a region this build didn't fence. */
  info: CourtRegionInfo | null;
  /** null: unreadable (no cache, no signal), which means the defaults (100 m, auto on). */
  settings: CourtArrivalSettings | null;
  /** An arrival here under 2 hours ago (read for a re-report only). */
  arrivedRecently: boolean;
  /** This phone prompted here in the last 15 minutes while in the background. */
  promptedRecently: boolean;
  /** A play session is running (it gates arrival check-ins, as Doggle's walk does). */
  playSessionActive: boolean;
  /** Who-sees-me consent as this phone knows it; 'no' asks first with the reason. */
  consent: 'yes' | 'no' | 'unknown';
  /** This court's QR wallet notice went out under 3 hours ago. */
  walletThrottled: boolean;
  /**
   * A routine stop is due here now (30 minutes before to 30 minutes after its
   * time) and "Check me in at my routine courts" is on (lib/courtRoutineRules
   * routineArrivalDue). Doggle's routine rule: such an arrival checks in even
   * when "Check me in when I arrive" or "Notice me at starred courts" is
   * off, as the server's _pl_court_arrival_off does. A court switched off
   * for automatic check-in still asks (the server answers off_here).
   */
  routineDue?: boolean;
};

export type ArrivalAction =
  | { action: 'quiet'; why: string }
  /** The QR wallet notice ("You're at X / Tap to show your check-in QR code").
   *  `standIn`: it replaces a "Check in nearby?", so it stays as quiet as that
   *  prompt while the app is open (it may come from a re-report). */
  | { action: 'wallet'; standIn?: true }
  | { action: 'prompt'; reason?: NearbyPromptReason }
  | { action: 'queue' };

export type ArrivalDecision = ArrivalAction & {
  /** Record the arrival (every region, wallet-only included), before any check. */
  mark: boolean;
};

/** A prompt at a court with a QR code: the QR notice (its Check in button
 *  included) replaces "Check in nearby?", and the server prompt is skipped. */
function promptOrWallet(f: ArrivalFacts, reason?: NearbyPromptReason): ArrivalAction {
  if (f.info?.passId) {
    return f.walletThrottled ? { action: 'quiet', why: 'wallet_throttled' } : { action: 'wallet', standIn: true };
  }
  return reason ? { action: 'prompt', reason } : { action: 'prompt' };
}

/**
 * Doggle's handleFavoriteProximity order (favoriteProximity.ts:562-599),
 * minus the home rule (S1, S2), with its routine rule (:334-359) as the
 * `routineDue` fact. The mark comes first and does not depend on anything
 * after it.
 */
export function decideArrival(f: ArrivalFacts): ArrivalDecision {
  return { mark: f.arrival, ...arrivalAction(f) };
}

function arrivalAction(f: ArrivalFacts): ArrivalAction {
  const info = f.info;
  // Not fenced by this build (a league-home or most-used court the old task
  // still holds until the first sync): silent.
  if (!info) return { action: 'quiet', why: 'not_member' };
  // A QR wallet court only: today's notice, on arrivals only, 3 h apart.
  if (!info.starred) {
    if (!f.arrival || !info.passId) return { action: 'quiet', why: 'wallet_re_report' };
    return f.walletThrottled ? { action: 'quiet', why: 'wallet_throttled' } : { action: 'wallet' };
  }
  // A routine stop due here: its arrival checks in whatever the two switches
  // below say (only a real arrival; a re-report goes on as any other).
  const routineArrival = f.routineDue === true && f.arrival;
  // "Notice me at starred courts" Off. A QR court keeps its notice.
  if (f.settings && f.settings.court_radius_m <= 0 && !routineArrival) {
    if (f.arrival && info.passId && !f.walletThrottled) return { action: 'wallet' };
    return { action: 'quiet', why: 'radius_off' };
  }
  // "Check me in when I arrive" off: every Enter asks first.
  if (f.settings?.auto_checkin === false && !routineArrival) return promptOrWallet(f);
  if (!f.arrival) {
    // A re-report after an arrival: that arrival already queued or prompted.
    return f.arrivedRecently ? { action: 'quiet', why: 're_report' } : promptOrWallet(f);
  }
  // Just prompted here from the background: that prompt is this arrival's.
  if (f.promptedRecently) return { action: 'quiet', why: 'prompt_covers' };
  // A play session already has me at a court: ask instead.
  if (f.playSessionActive) return promptOrWallet(f);
  // Who sees me isn't chosen yet: the server would refuse; ask, and say why.
  // Not at a court switched off for me: the server checks that first and asks
  // with no reason (off_here), since consent isn't why it didn't check me in.
  if (f.consent === 'no' && info.autoCheckin !== false) return promptOrWallet(f, 'no_consent');
  return { action: 'queue' };
}

/** queue_court_arrival's answer (supabase/migration_court_arrival_queue.sql). */
export type QueueCourtArrivalAnswer = {
  queued: boolean;
  reason?: string;
  open?: boolean;
  pushable?: boolean;
  due_at?: string;
  checkin_id?: string;
};

export type QueueAnswerAction =
  /** Post "At X?" (and, not pushable, the phone's own "Checked in" / "Still at"). */
  | { action: 'notice' }
  | { action: 'quiet'; why: string }
  | { action: 'prompt'; reason?: NearbyPromptReason };

/** Rows 22-25. null: unreachable (offline, a timeout, a server without the function). */
export function decideQueueAnswer(a: QueueCourtArrivalAnswer | null): QueueAnswerAction {
  if (!a) return { action: 'prompt' };
  if (a.queued) return { action: 'notice' };
  switch (a.reason) {
    // Checked in there already (open, not taken back): quiet. 'left': the
    // Exit already reached Pickleague. 'court_gone': asking would point at nothing.
    case 'already_checked_in':
    case 'left':
    case 'court_gone':
      return { action: 'quiet', why: a.reason };
    // The player expected a check-in: the prompt also says why it didn't happen.
    case 'recently_left':
    case 'not_starred':
    case 'no_consent':
      return { action: 'prompt', reason: a.reason };
    // off / off_here (their own setting), or an answer this build doesn't know.
    default:
      return { action: 'prompt' };
  }
}

/** The same QR rule for a prompt that came from the queue's answer. */
export function promptRoute(
  info: CourtRegionInfo | null,
  walletThrottled: boolean,
): 'nearby' | 'wallet' | 'quiet' {
  if (!info?.passId) return 'nearby';
  return walletThrottled ? 'quiet' : 'wallet';
}

// ── Prompt delivery (row 28) ──────────────────────────────────────────────────
/**
 * The server's push is the prompt; the phone's own copy only when the server
 * couldn't be reached, or it enqueued for a phone it can't push to. A server
 * "not enqueued" held it back on purpose (open check-in there, 30-minute
 * cooldown): nothing shows, and the phone's prompt mark is cleared.
 * (The foundation's promptWithFallback applies this; this names the outcome.)
 */
export function decidePromptDelivery(r: {
  unreachable: boolean;
  enqueued?: boolean | null;
  pushable?: boolean | null;
}): 'server' | 'local' | 'held' {
  if (r.unreachable) return 'local';
  if (!r.enqueued) return 'held';
  return r.pushable ? 'server' : 'local';
}

export const NEARBY_PROMPT_TITLE = 'Check in nearby?';

/** The prompt's words: the court, why it didn't check in automatically, then the action. */
export function nearbyPromptBody(name: string | null | undefined, reason?: NearbyPromptReason | null): string {
  const near = name ? `You're near ${name}.` : "You're near a court.";
  const why =
    reason === 'recently_left'
      ? " You left under 10 minutes ago, so we didn't check you in automatically."
      : reason === 'not_starred'
        ? " It isn't one of your starred courts anymore, so we didn't check you in automatically."
        : reason === 'no_consent'
          ? " Choose who sees you at the courts first, so we didn't check you in automatically."
          : '';
  return `${near}${why} Tap to check in.`;
}

// ── Notices ───────────────────────────────────────────────────────────────────
/** "At X?" (row 26), or its QR wallet variant (row 29). */
export function arrivalNoticeCopy(
  name: string | null | undefined,
  passId?: string | null,
): { title: string; body: string; deepLink: string } {
  return {
    title: name ? `At ${name}? 🏓` : 'At your starred court? 🏓',
    body: passId
      ? 'Tap to show your check-in QR code. Checking you in here in a minute.'
      : 'Checking you in here in a minute.',
    deepLink: passId ? `wallet/${passId}` : 'home/-',
  };
}

/** The QR wallet notice (as before 1.0.4 build 14). */
export function walletNoticeCopy(name: string | null | undefined): { title: string; body: string } {
  return { title: `You're at ${name || 'the courts'}`, body: 'Tap to show your check-in QR code.' };
}

/** The server's "Checked in" push, which the phone posts itself when it can't be pushed to (D3). */
export function arrivalCheckedInCopy(name: string | null | undefined): { title: string; body: string } {
  return {
    title: `✅ Checked in at ${name || 'your starred court'}`,
    body: "You're checked in. Check out when you leave, or tap Stay 1 more hour if you're staying.",
  };
}

/** The server's "Still at" push, likewise (D3). */
export function arrivalStillAtCopy(name: string | null | undefined): { title: string; body: string } {
  return {
    title: `Still at ${name || 'the courts'}?`,
    body: "Your check-in ends in 5 minutes. Tap Stay 1 more hour if you're staying.",
  };
}

/**
 * When the phone's own "Checked in" and "Still at" go off for a queued
 * arrival (D3): just after the server's job would have checked the player in,
 * and 5 minutes before that 2-hour check-in ends. The server's arrival is
 * due_at minus a minute. During a routine stop (`plannedEndIso`) the server
 * ends it at the planned end when that comes first, but never under 30
 * minutes after the arrival (migration_court_routines.sql, part B).
 */
export function arrivalLocalSchedule(
  dueAtIso: string,
  plannedEndIso?: string | null,
): {
  checkedInAtMs: number;
  stillAtAtMs: number;
  expiresAtIso: string;
} | null {
  const due = Date.parse(dueAtIso);
  if (!Number.isFinite(due)) return null;
  const arrived = due - ARRIVAL_DUE_MS;
  const planned = plannedEndIso ? Date.parse(plannedEndIso) : NaN;
  const expires = Number.isFinite(planned)
    ? Math.min(arrived + ARRIVAL_CHECKIN_MS, Math.max(planned, arrived + LEGACY_ARRIVAL_CHECKIN_MS))
    : arrived + ARRIVAL_CHECKIN_MS;
  return {
    checkedInAtMs: due + ARRIVAL_JOB_PERIOD_MS,
    stillAtAtMs: expires - STILL_AT_LEAD_MS,
    expiresAtIso: new Date(expires).toISOString(),
  };
}

/**
 * An arrival check-in whose end is still the one the server's job gave it:
 * nobody extended it and no play session adopted it (both only ever move the
 * end later, by an hour or more). The server's _pl_arrival_untouched, same
 * rule: the current length or the old 30 minutes.
 */
export function arrivalCheckinUntouched(checkedInAtIso: string, expiresAtIso: string): boolean {
  const len = Date.parse(expiresAtIso) - Date.parse(checkedInAtIso);
  return len === ARRIVAL_CHECKIN_MS || len === LEGACY_ARRIVAL_CHECKIN_MS;
}

/** One court's phone-made pair (D3): the check-in id, when "Checked in" goes off, and when "Still at" does. */
export type ArrivalLocalEntry = { id: string; at: number; until: number };

/**
 * The courts whose arrival is still waiting out its minute (its "Checked in"
 * hasn't gone off): a switch turned off now makes the server skip it, so its
 * notices would announce a check-in that never happens. One past that may
 * already be a real check-in, which a switch doesn't end; reconcileArrivalEntries
 * settles those against the server. `venueId` limits it to one court.
 */
export function waitingArrivalVenues(
  entries: Record<string, ArrivalLocalEntry>,
  nowMs: number,
  venueId?: string,
): string[] {
  return Object.entries(entries)
    .filter(([venue, e]) => (venueId == null || venue === venueId) && e.at > nowMs)
    .map(([venue]) => venue);
}

/**
 * The phone's own notices against my open check-in as the server has it now.
 * Before an entry's "Checked in" plus a minute, the server may not have
 * decided yet: left alone. After that, an entry that isn't my open check-in
 * either never happened (the server skipped the arrival: a check-in elsewhere,
 * a play session, a switch turned off) or is over: `cancel` (its "Still at"
 * and its buttons would point at a check-in that isn't open, and Check out
 * with an id the server never stored closes every open check-in I have). My
 * open one stays until its "Still at" has gone off, then is `forget`.
 */
export function reconcileArrivalEntries(
  entries: Record<string, ArrivalLocalEntry>,
  open: { id: string | null } | null,
  nowMs: number,
): { cancel: string[]; forget: string[] } {
  const cancel: string[] = [];
  const forget: string[] = [];
  for (const [venue, e] of Object.entries(entries)) {
    if (e.at + ARRIVAL_SETTLE_MS > nowMs) continue;
    if (open?.id !== e.id) cancel.push(venue);
    else if (e.until <= nowMs) forget.push(venue);
  }
  return { cancel, forget };
}

/** Entries that reconcileArrivalEntries can settle now (else no server read is needed). */
export function arrivalEntriesToSettle(entries: Record<string, ArrivalLocalEntry>, nowMs: number): boolean {
  return Object.values(entries).some((e) => e.at + ARRIVAL_SETTLE_MS <= nowMs);
}

/** Left within 5 minutes and the check-in was taken back (row 38). */
export function checkinRemovedCopy(name: string | null | undefined): { title: string; body: string } {
  return {
    title: 'Check-in removed',
    body: `You left ${name || 'the courts'} within 5 minutes of arriving, so it didn't count as a visit.`,
  };
}

/** "Leaving X?" (row 39). */
export function leavingNoticeCopy(name: string | null | undefined): { title: string; body: string } {
  return {
    title: name ? `Leaving ${name}?` : 'Leaving the courts?',
    body: "You're still checked in. Check out, or tap Stay 1 more hour if you're staying.",
  };
}

// ── Departure (Exit), rows 38-39 ──────────────────────────────────────────────
/** cancel_court_arrival's answer. */
export type CancelCourtArrivalResult = { dropped: boolean; closed: boolean; removed: boolean };

/** The Exit sends a cancel when the arrival is recent enough to have one, and
 *  the region is a court (a GPS-picked QR spot has no court row). */
export function exitCancels(regionId: string, arrivedWithinCancelWindow: boolean): boolean {
  return arrivedWithinCancelWindow && !isWalletOnlyRegionId(regionId);
}

export type DepartureDecision =
  /** The arrival check-in was taken back: take its pushes down (and say so if one was seen). */
  | { action: 'took_back' }
  | { action: 'quiet'; why: string }
  /** Read my open check-in and maybe post "Leaving X?" (decideLeaving). */
  | { action: 'check_open' };

export function decideDeparture(f: {
  /** The Exit's cancel: null when none was sent (or it failed outright). */
  cancel: { queued: boolean; result?: CancelCourtArrivalResult | null } | null;
  playSessionActive: boolean;
  settings: CourtArrivalSettings | null;
}): DepartureDecision {
  // Removed or closed: nothing left to remind about. Only 'dropped' (no
  // check-in yet) and a queued cancel go on: "Check in now" may have made one.
  if (f.cancel?.result?.removed || f.cancel?.result?.closed) return { action: 'took_back' };
  // A play session ends with its End, not with a reminder.
  if (f.playSessionActive) return { action: 'quiet', why: 'play_session' };
  // "Remind me to check out when I leave" off. Unreadable settings: on.
  if (f.settings && !f.settings.departure_reminder) return { action: 'quiet', why: 'reminder_off' };
  return { action: 'check_open' };
}

/** My open check-in as the server has it (data/venueCheckins getMyOpenCheckin). */
export type OpenCheckinFact = {
  id: string | null;
  venue_id: string;
  expires_at: string;
  source: string;
  via_arrival?: boolean;
  venue_name?: string | null;
};

export type LeavingDecision =
  | { action: 'quiet'; why: string }
  | {
      action: 'leaving';
      title: string;
      body: string;
      data: {
        checkin_id: string;
        expires_at: string;
        venue_id: string;
        venue_name: string | null;
        via_arrival: boolean;
        deepLink: string;
        kind: typeof DEPARTURE_NOTICE_KIND;
      };
    };

/**
 * "Leaving X?" only for an open check-in of mine at this court that isn't a
 * play session's, with its id: Check out with no id closes EVERY open
 * check-in I have, so a notice without one is never posted. Once per court
 * per 30 minutes.
 */
export function decideLeaving(f: {
  regionId: string;
  open: OpenCheckinFact | null;
  lastPromptAtMs?: number;
  nowMs: number;
  /** The region's saved name, when the check-in row has none. */
  regionName?: string | null;
}): LeavingDecision {
  const o = f.open;
  if (!o) return { action: 'quiet', why: 'not_checked_in' };
  if (o.venue_id !== f.regionId) return { action: 'quiet', why: 'checked_in_elsewhere' };
  if (o.source === 'session') return { action: 'quiet', why: 'session_checkin' };
  if (!o.id) return { action: 'quiet', why: 'no_checkin_id' };
  if (f.lastPromptAtMs != null && f.nowMs - f.lastPromptAtMs < DEPARTURE_COOLDOWN_MS) {
    return { action: 'quiet', why: 'cooldown' };
  }
  const name = o.venue_name || f.regionName || null;
  const copy = leavingNoticeCopy(name);
  return {
    action: 'leaving',
    ...copy,
    data: {
      checkin_id: o.id,
      expires_at: o.expires_at,
      venue_id: o.venue_id,
      venue_name: name,
      via_arrival: o.via_arrival === true,
      deepLink: 'home/-',
      kind: DEPARTURE_NOTICE_KIND,
    },
  };
}

// ── The notice buttons (rows 30-31) ───────────────────────────────────────────
export type CheckInOutcomeKind = 'done' | 'queued' | 'already' | 'arriving' | 'refused';

/** Location refusals (lib/refusals codes 'fix.*'): the fix didn't confirm the court. */
export function isLocationRefusalCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.startsWith('fix.');
}

/**
 * What a Check in / Check in now press came to (Doggle performCheckIn,
 * PushNotificationContext.tsx:536-586). `pending` is court_arrival_pending's
 * answer, asked only on "At X?" when nothing else confirmed it: null or
 * undefined (a timeout, an error) counts as still coming, as in Doggle.
 */
export function checkInOutcome(p: {
  /** Pressed on "At X?", whose arrival may still check the player in. */
  onArrivalNotice: boolean;
  /** A usable fix was taken. */
  hasFix: boolean;
  /** No fix, on "At X?": confirm_court_arrival found an arrival check-in to confirm. */
  confirmed?: boolean | null;
  pending?: boolean | null;
  /** The check-in write's result, when it didn't throw. `viaArrival`: the row
   *  it handed back is the arrival check-in (so this press confirmed it). */
  checkin?: { queued: boolean; viaArrival?: boolean } | null;
  /** lib/refusals' code when the write threw, else null. */
  refusalCode?: string | null;
}): CheckInOutcomeKind {
  const stillComing = p.onArrivalNotice && p.pending !== false;
  if (!p.hasFix) {
    if (p.onArrivalNotice && p.confirmed === true) return 'already';
    return stillComing ? 'arriving' : 'refused';
  }
  if (p.checkin) {
    if (p.checkin.viaArrival) return 'already';
    return p.checkin.queued ? 'queued' : 'done';
  }
  // A location refusal while the arrival is still coming: it checks them in
  // anyway (Doggle parity; the plan's "Rejected" 1).
  if (isLocationRefusalCode(p.refusalCode) && stillComing) return 'arriving';
  return 'refused';
}

/** Words for the outcomes Pickleague didn't have before ("already", "arriving"). */
export function checkInOutcomeCopy(
  kind: 'already' | 'arriving',
  name: string | null | undefined,
): { title: string; body: string } {
  if (kind === 'already') {
    return { title: "You're already checked in", body: name ? `You're checked in at ${name}.` : "You're checked in." };
  }
  return {
    title: 'Checking you in',
    body: "We couldn't confirm your location just now, but you'll be checked in here in a minute if you stay.",
  };
}

export const CHECK_IN_TIMED_OUT = { title: 'Your check-in may not have saved', body: 'Open Pickleague to check.' };

/** The notice a Not here press ends in (Doggle performNotHere). `link` is where a tap goes. */
export type NotHereCopy = { title: string; body: string; link: string };

/** Where the per-court switch lives (the Not here notices point there). */
export const CHECKINS_SETTINGS_LINK = 'settings/checkins';

/**
 * Not here's outcome (row 31): queued for signal, checked out (later than 5
 * minutes), taken back, nothing to act on, or not checked in this time.
 * Timeouts and failures: NOT_HERE_TIMED_OUT, NOT_HERE_FAILED.
 */
export function notHereOutcome(
  r: { queued: boolean; result?: CancelCourtArrivalResult | null },
  name: string | null | undefined,
): NotHereCopy {
  const at = name ? ` at ${name}` : '';
  if (r.queued) {
    return {
      title: 'Saved 📶',
      body: "No signal. We'll stop the check-in here once you're back online (within 2 hours). If it already counted, we'll check you out instead.",
      link: CHECKINS_SETTINGS_LINK,
    };
  }
  if (r.result?.closed) return { title: 'Checked out', body: `You're checked out${at}.`, link: 'home/-' };
  if (r.result?.removed) {
    return {
      title: 'Check-in removed',
      body: `We took back your check-in${at}. It won't count as a visit.`,
      link: CHECKINS_SETTINGS_LINK,
    };
  }
  if (r.result && !r.result.dropped) {
    return { title: 'Not checked in', body: `You weren't checked in${at}.`, link: CHECKINS_SETTINGS_LINK };
  }
  return {
    title: 'Not checked in',
    body: `We won't check you in${at} this time. To stop it there, turn that court off in Settings, under Check-in automation.`,
    link: CHECKINS_SETTINGS_LINK,
  };
}

export const NOT_HERE_TIMED_OUT = { title: 'That may not have saved', body: 'Open Pickleague to check your visit.' };
export const NOT_HERE_FAILED = { title: "Couldn't cancel that check-in", body: 'Open Pickleague to check your visit.' };

// ── Foreground display (row 33) ───────────────────────────────────────────────
/** Shown as nothing while the app is open (no banner, no list entry). */
const HIDDEN_WHILE_ACTIVE = new Set<string>([
  COURT_PROMPT_KIND,
  ARRIVAL_CHECKIN_KIND,
  ARRIVAL_EXTEND_KIND,
  ARRIVAL_EXTEND_UNTIL_KIND,
  ARRIVAL_FAILED_KIND,
  ARRIVAL_EXPIRED_KIND,
  DEPARTURE_NOTICE_KIND,
]);

/**
 * Whether a notification shows while Pickleague is open. "At X?" does (it's
 * the only way to say Not here before the check-in lands); the court prompts,
 * the arrival pushes and "Leaving X?" stay quiet, as in Doggle (the player is
 * looking at the app, and an app-open resync makes the OS re-report every
 * region), the foreground monitor's prompts included. Every other Pickleague
 * notice keeps showing.
 */
export function showWhileAppActive(data: Record<string, unknown> | null | undefined): boolean {
  const kind = data?.kind;
  if (kind === ARRIVAL_NOTICE_KIND) return true;
  return !(typeof kind === 'string' && HIDDEN_WHILE_ACTIVE.has(kind));
}

// ── Which courts the phone watches (rows 5, 7, 8) ─────────────────────────────
/** A geofence circle (the foundation's GeofenceRegion). */
export type CourtRegion = { id: string; lat: number; lng: number; radiusM: number };

/** Routine courts come first, as Doggle fences routine stops before favorites. */
export const ROUTINE_TIER = 'routine';
export const WALLET_TIER = 'wallet';
export const STARRED_TIER = 'starred';

/** A routine court, as a region source (lib/courtRoutineRules CourtRoutine, flattened). */
export type RoutineRegionSource = {
  venueId: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /** The outline's circle; null without one. */
  radiusM: number | null;
  autoCheckin: boolean;
  /** An active routine at a court still starred (a dormant one isn't fenced). */
  live: boolean;
};

/** Doggle's routine circle with no outline (favoriteGeofenceTask.ts:41). */
export const ROUTINE_FALLBACK_RADIUS_M = 150;

/**
 * The routine tier: one circle per court with a live routine (several
 * routines at one court share it), the outline's circle else 150 m. Fenced
 * whatever "Notice me at starred courts" says: a routine stop checks in even
 * with that Off (decideArrival).
 */
export function routineTierRegions(rows: readonly RoutineRegionSource[]): CourtRegion[] {
  const out: CourtRegion[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.live || r.lat == null || r.lng == null || seen.has(r.venueId)) continue;
    seen.add(r.venueId);
    out.push({
      id: r.venueId,
      lat: r.lat,
      lng: r.lng,
      radiusM: r.radiusM != null && r.radiusM > 0 ? r.radiusM : ROUTINE_FALLBACK_RADIUS_M,
    });
  }
  return out;
}

/** A QR wallet pass, as a region source (lib/qrWallet walletRegionId gives the id). */
export type WalletRegionSource = { regionId: string; passId: string; name: string; lat: number; lng: number };

/** list_starred_court_geofences (supabase/migration_court_arrival_settings.sql). */
export type StarredCourtGeofence = {
  venue_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /** The equal-area circle of a mapped outline; null without one. */
  radius_m: number | null;
  auto_checkin: boolean;
};

/** The wallet tier: one circle per pass, 100 m (a court picked from the catalog keeps its id). */
export function walletTierRegions(passes: readonly WalletRegionSource[]): CourtRegion[] {
  return passes.map((p) => ({ id: p.regionId, lat: p.lat, lng: p.lng, radiusM: WALLET_RADIUS_M }));
}

/** The starred tier: an outline's circle, else "Notice me at starred courts". Off watches none. */
export function starredTierRegions(rows: readonly StarredCourtGeofence[], courtRadiusM: number): CourtRegion[] {
  if (!(courtRadiusM > 0)) return [];
  const out: CourtRegion[] = [];
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    out.push({ id: r.venue_id, lat: r.lat, lng: r.lng, radiusM: r.radius_m != null && r.radius_m > 0 ? r.radius_m : courtRadiusM });
  }
  return out;
}

/**
 * buildRegions' merge: a court that is both a QR wallet court and starred
 * keeps the wallet's place in the list (it is never the one dropped past 20)
 * but takes the starred circle (before, the wallet's 100 m won).
 */
export function mergeCourtRegion(
  kept: CourtRegion,
  incoming: CourtRegion,
  tiers: { kept: readonly string[]; incoming: string },
): CourtRegion {
  if (tiers.incoming === STARRED_TIER && !tiers.kept.includes(STARRED_TIER)) {
    return { ...kept, radiusM: incoming.radiusM };
  }
  return kept;
}

const clampRadius = (m: number) => Math.min(MAX_REGION_RADIUS_M, Math.max(MIN_REGION_RADIUS_M, m));

/**
 * The fenced list and what each wake needs to know about it, from
 * buildRegions' result (routine tier first, then wallet, then starred): at
 * most 20, each circle clamped to 50-800 m. The first saved pass names a
 * wallet court's code; a starred court is named as the server names it. A
 * routine court is a starred court (routines live only there), so it is
 * `starred` whether or not the starred tier fenced it too.
 */
export function buildCourtRegionList(
  built: { regions: readonly CourtRegion[]; tiersById: Record<string, readonly string[]> },
  src: {
    wallet: readonly WalletRegionSource[];
    starred: readonly StarredCourtGeofence[];
    routine?: readonly RoutineRegionSource[];
  },
): { regions: CourtRegion[]; info: (CourtRegionInfo & { id: string })[] } {
  const regions = built.regions
    .slice(0, MAX_COURT_REGIONS)
    .map((r) => ({ ...r, radiusM: clampRadius(r.radiusM) }));
  const info = regions.map((r) => {
    const tiers = built.tiersById[r.id] ?? [];
    const star = tiers.includes(STARRED_TIER) ? src.starred.find((s) => s.venue_id === r.id) : undefined;
    const pass = tiers.includes(WALLET_TIER) ? src.wallet.find((p) => p.regionId === r.id) : undefined;
    const routine = tiers.includes(ROUTINE_TIER) ? src.routine?.find((x) => x.venueId === r.id && x.live) : undefined;
    return {
      id: r.id,
      name: star?.name || routine?.name || pass?.name || '',
      starred: !!star || !!routine,
      autoCheckin: star ? star.auto_checkin !== false : routine ? routine.autoCheckin !== false : false,
      ...(pass ? { passId: pass.passId } : {}),
      ...(routine ? { routine: true } : {}),
    };
  });
  return { regions, info };
}

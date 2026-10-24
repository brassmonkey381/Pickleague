// The check-in flow, shared by Home's court card (components/CourtCheckinCard)
// and a court's page (screens/CourtDetailScreen), lifted out of the card so
// both say and do the same thing (state/court-discovery-plan.md, Phase 1 step 5).
//
// What it covers:
//   - `run`: every button's wrapper. The one-time "who sees you at the courts"
//     consent sheet and the location permission sheet wait on the player, so
//     they sit outside the bound; the fix and the write don't (10 s; 16 s when
//     it first waits for a fix). Busy resets in `finally`, so a dead
//     connection never leaves a spinner running. A refusal says why, then what
//     to do (lib/refusals, rule 11), and a fix that was missing or outside the
//     fence offers "Start without a court".
//   - `checkIn`: a fresh device fix (or the one "Find my court" just took, while
//     recent), the server confirms it is inside the court's fence. No fix, or
//     an imprecise one: the reason (noFixReason). Saved offline: the queued
//     check-in note. Went through: the rating prompt's good moment and, once
//     per device, the offer to star the court so arriving next time checks you
//     in (then the "Always" location ask).
//   - `starAndAsk`: that offer accepted.
// The caller keeps what is its own (the card's current check-in, the court it
// found) through `onCheckedIn` / `onCurrent`, and draws the outcome lines with
// components/court/CourtCheckInNotes.
import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { peekQuery } from '@just-messin-around/expo-foundation/cache';
import {
  askForLocation,
  checkInAt,
  noFixReason,
  refreshCurrentCheckin,
  takeCheckinFix,
  type CurrentCheckin,
} from './courtCheckin';
import { explainRefusal } from './refusalNotices';
import { QUEUED_CHECKIN_NOTE, refusalCode, refusalCopy, type RefusalContext } from './refusals';
import { FIX_REUSE_MS, isFixFresh, offersUntrackedSession, type DeviceFix } from './courtCheckinRules';
import { noteGoodMoment } from './ratingPrompt';
import { ensurePresenceConsent } from './presenceConsent';
import { COURT_STARS_ENABLED } from './features';
import { arrivalSyncMessage, askForArrivalLocation, courtStarsChanged } from './courtArrivalAsk';
import { COURT_FAVORITES_KEY, MAX_COURT_FAVORITES, toggleCourtFavorite, type CourtFavorite } from '../data/courtFavorites';
import { COURT_ARRIVAL_SETTINGS_KEY } from '../data/courtArrival';
import type { CourtArrivalSettings } from './courtArrivalRules';

export const CHECKIN_BOUND_MS_DEFAULT = 10_000;
/** Check in may first wait up to 6 s for a fix, then the write. */
export const CHECKIN_BOUND_MS = 16_000;
/** How long Check in waits for a fresh fix. */
const FIX_WAIT_MS = 6_000;
// Set the moment the star offer is shown, so it never asks twice. A new key:
// build 13's offer (pickleague_court_alerts_offered_v1) was for prompts only.
const STAR_OFFERED_KEY = 'pickleague_court_star_offered_v1';

/**
 * True once per device, after a check-in at `venueId`: native, the star
 * shown, that court not starred yet with room for it, and arrival check-ins
 * not switched off (as far as this session knows). Marks it offered. Anything
 * unknown (the star list not loaded) skips without marking, so it can come later.
 */
async function claimStarOffer(venueId: string): Promise<boolean> {
  if (Platform.OS === 'web' || !COURT_STARS_ENABLED) return false;
  const stars = peekQuery<CourtFavorite[]>(COURT_FAVORITES_KEY);
  if (!stars || stars.some((f) => f.venue_id === venueId) || stars.length >= MAX_COURT_FAVORITES) return false;
  const s = peekQuery<CourtArrivalSettings>(COURT_ARRIVAL_SETTINGS_KEY);
  if (s && (s.court_radius_m <= 0 || !s.auto_checkin)) return false;
  try {
    if (await AsyncStorage.getItem(STAR_OFFERED_KEY)) return false;
    await AsyncStorage.setItem(STAR_OFFERED_KEY, '1');
    return true;
  } catch {
    return false; // can't remember we asked, so don't ask
  }
}

export type CheckInBusy = 'find' | 'checkin' | 'extend' | 'out';

export type CheckInRunOptions = {
  boundMs?: number;
  /** Ask for location permission first (the OS sheet; not timed). */
  askLocation?: boolean;
  /** Ask the one-time presence consent first; Not now says why and stops. */
  consent?: boolean;
  refusal?: RefusalContext;
};

export type StarOffer = { venueId: string; venueName: string; busy: boolean };

export type CourtCheckInOptions = {
  /** A check-in went through (or was saved to send later). */
  onCheckedIn?: (next: CurrentCheckin) => void;
  /** The server says the check-in already ended: here is what it has now. */
  onCurrent?: (current: CurrentCheckin | null) => void;
};

export type CourtCheckInFlow = {
  busy: CheckInBusy | null;
  message: string | null;
  setMessage: (m: string | null) => void;
  /** No fix, or a fix outside the fence: offer an untracked session instead. */
  offerUntracked: boolean;
  setOfferUntracked: (on: boolean) => void;
  /** The one-time "Star this court" offer, for the court just checked in at. */
  starOffer: StarOffer | null;
  dismissStarOffer: () => void;
  /** The star offer's result line (a live region). */
  alertsResult: string | null;
  /** The last fix this flow took; Check in reuses it while it is recent. */
  lastFix: MutableRefObject<DeviceFix | null>;
  run: (kind: CheckInBusy, fn: () => Promise<void>, failMsg: string, opts?: CheckInRunOptions) => Promise<void>;
  /** No fix: say why, and offer the untracked session. */
  noFix: () => Promise<void>;
  checkIn: (court: { id: string; name: string }) => Promise<void>;
  starAndAsk: (offer: { venueId: string; venueName: string }) => Promise<void>;
};

export function useCourtCheckIn(options: CourtCheckInOptions = {}): CourtCheckInFlow {
  const [busy, setBusy] = useState<CheckInBusy | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [offerUntracked, setOfferUntracked] = useState(false);
  const [starOffer, setStarOffer] = useState<StarOffer | null>(null);
  const [alertsResult, setAlertsResult] = useState<string | null>(null);
  const lastFix = useRef<DeviceFix | null>(null);
  // Latest callbacks, so the returned functions never act on a stale closure.
  const opts = useRef(options);
  opts.current = options;

  const run = useCallback<CourtCheckInFlow['run']>(async (kind, fn, failMsg, o = {}) => {
    setBusy(kind);
    setMessage(null);
    setOfferUntracked(false);
    setAlertsResult(null);
    try {
      // The one-time "who sees you at the courts" sheet and the permission
      // sheet wait on the player, so they sit outside the bound; the fix and
      // the write don't. Not now on the consent sheet: no check-in, and the
      // caller says why (rule 11: nothing refused silently).
      if (o.consent && !(await ensurePresenceConsent())) {
        setMessage(refusalCopy('consent.declined'));
        return;
      }
      if (o.askLocation) await askForLocation();
      await withTimeout(fn(), o.boundMs ?? CHECKIN_BOUND_MS_DEFAULT);
    } catch (e) {
      // Why, then what to do (lib/refusals): how far from the court, too
      // vague, too old, the court is gone, the check-in already ended,
      // signed out.
      setMessage(explainRefusal(e, failMsg, o.refusal));
      if (kind === 'checkin' && offersUntrackedSession(e)) setOfferUntracked(true);
      // A check-in the server already ended: stop showing it.
      const code = refusalCode(e);
      if (code === 'checkin.closed' || code === 'checkin.none') {
        void refreshCurrentCheckin()
          .then((c) => opts.current.onCurrent?.(c))
          .catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const noFix = useCallback(async () => {
    setMessage(await noFixReason());
    setOfferUntracked(true);
  }, []);

  const checkIn = useCallback<CourtCheckInFlow['checkIn']>(
    (v) =>
      run(
        'checkin',
        async () => {
          const fix = isFixFresh(lastFix.current, Date.now(), FIX_REUSE_MS)
            ? lastFix.current
            : await takeCheckinFix(FIX_WAIT_MS);
          if (!fix) return noFix();
          lastFix.current = fix;
          const next = await checkInAt({ id: v.id, name: v.name }, fix);
          opts.current.onCheckedIn?.(next);
          if (next.queued) setMessage(QUEUED_CHECKIN_NOTE);
          else {
            noteGoodMoment(); // a check-in that went through (rating prompt)
            void claimStarOffer(next.venueId).then(
              (show) => show && setStarOffer({ venueId: next.venueId, venueName: next.venueName, busy: false }),
            );
          }
        },
        "Couldn't check you in. Try again.",
        {
          boundMs: CHECKIN_BOUND_MS,
          askLocation: true,
          consent: true,
          refusal: { venueName: v.name, action: 'check_in' },
        },
      ),
    [run, noFix],
  );

  // The offer accepted: star the court, then the same ask as Settings' Allow
  // (the OS sheets, only if "Always" is missing). Not bounded: the player may
  // sit on the permission sheet.
  const starAndAsk = useCallback<CourtCheckInFlow['starAndAsk']>(async (offer) => {
    // The result line is a live region on Android; iOS has none, so say it.
    const tell = (text: string) => {
      setAlertsResult(text);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    };
    setStarOffer({ ...offer, busy: true });
    try {
      try {
        await toggleCourtFavorite(offer.venueId, true, offer.venueName);
      } catch (e) {
        // The star cap, a court that's gone: why, then what to do.
        tell(
          explainRefusal(e, "Couldn't star this court. Try again with the star above.", {
            action: 'favorite',
            venueName: offer.venueName,
          }),
        );
        return;
      }
      courtStarsChanged();
      const r = await askForArrivalLocation();
      const m = arrivalSyncMessage(r, { noticeOff: r.reason === 'stopped' });
      tell(
        m.ok
          ? `Starred. Next time you arrive at ${offer.venueName} and stay a minute, we'll check you in. Leave within 5 minutes and it doesn't count. Change it in Settings > Check-in automation.`
          : `Starred. ${m.message}`,
      );
    } finally {
      setStarOffer(null);
    }
  }, []);

  const dismissStarOffer = useCallback(() => setStarOffer(null), []);

  return {
    busy,
    message,
    setMessage,
    offerUntracked,
    setOfferUntracked,
    starOffer,
    dismissStarOffer,
    alertsResult,
    lastFix,
    run,
    noFix,
    checkIn,
    starAndAsk,
  };
}

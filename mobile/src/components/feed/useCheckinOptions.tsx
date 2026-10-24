// The one "Check in ▾" for a court (Doggle's park card), shared by Home's
// feed court cards and the court's page: the options sheet, tomorrow's Plan
// sheet, the On my way sheet, and my own check-in (Stay 1 more hour, Check
// out). Which items show is lib/checkinOptions (tested); what Check in now
// and Make this a routine do is the caller's (the feed hands the check-in to
// CheckinHost, the page runs its own flow so its notes show there).
//
//   <court name>
//   You're checked in at Star Park. Checking in here moves you.   (only then)
//   (pin)       Check in now
//   (walk)      On my way                (friends to tell)
//   (calendar)  Make this a routine      (a starred court)
//   Close
//
// A follow-up (the On my way sheet, a check-in that may ask for location)
// opens from the sheet's onDismissed: iOS won't present a second modal while
// the sheet is still fading out.
import React from 'react';
import { ActionSheetModal, type ActionSheetAction } from '@just-messin-around/expo-foundation/ui';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { TimeoutError, withTimeout } from '@just-messin-around/expo-foundation/platform';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { STILL_WORKING } from '../../lib/refusals';
import { FRIENDS_AT_COURTS_ENABLED, ROUTINES_ENABLED } from '../../lib/features';
import { useMyFriends } from '../../lib/useFriends';
import { playSession } from '../../lib/playSession';
import { checkOutHere } from '../../lib/checkinPlay';
import {
  checkinChanged,
  extendCheckinByHour,
  peekCurrentCheckin,
  takeFixIfAllowed,
  type CurrentCheckin,
} from '../../lib/courtCheckin';
import { checkinOptionIds, movesCheckinNote, planOptionIds, type CheckinOptionId } from '../../lib/checkinOptions';
import type { FeedMyCheckin } from '../../lib/pickleagueFeed';
import OnMyWaySheet, { type OnMyWayTarget } from '../OnMyWaySheet';

/** The court a sheet is for. */
export type CheckinCourt = {
  venueId: string;
  venueName: string;
  /** Starred by me: a routine can stop there. */
  starred: boolean;
  /** Friends the caller shows there now ("Here now"): On my way lists them first. */
  atCourt?: ReadonlyMap<string, string>;
};

export type CheckinOptionsConfig = {
  /** Check in now at this court. */
  checkIn: (court: CheckinCourt) => void;
  /** Make this a routine: My routine's add sheet with this court. */
  openRoutines: (court: CheckinCourt) => void;
  /** Where the On my way sheet was opened from (analytics). */
  from: 'feed' | 'court';
  /** A tap on one of the sheet's items (analytics). */
  onTap?: (id: CheckinOptionId | 'extend' | 'check_out') => void;
};

// Stay 1 more hour waits on a fix (5 s) and the write; Check out on its fix
// wait (3 s) and the write. Past this the busy state clears and says so.
const ACTION_BOUND_MS = 16_000;

export function useCheckinOptions(config: CheckinOptionsConfig) {
  const toast = useToast();
  const friendsQ = useMyFriends(FRIENDS_AT_COURTS_ENABLED);
  const canOnMyWay = FRIENDS_AT_COURTS_ENABLED && (friendsQ.data?.length ?? 0) > 0;

  // My check-in now (this device's copy; lib/courtCheckin keeps it current).
  const [current, setCurrent] = React.useState<CurrentCheckin | null>(null);
  React.useEffect(() => {
    let on = true;
    void peekCurrentCheckin().then((c) => on && setCurrent(c));
    return () => {
      on = false;
    };
  }, []);
  useSignal(checkinChanged, setCurrent);
  const playing = playSession.useLiveSession().status !== 'idle';
  const mine = React.useMemo<FeedMyCheckin | null>(
    () =>
      current
        ? {
            id: current.id,
            venueId: current.venueId,
            venueName: current.venueName,
            checkedInAt: current.checkedInAt ?? null,
            expiresAt: current.expiresAt,
            queued: !!current.queued,
            playing,
          }
        : null,
    [current, playing],
  );

  const [sheet, setSheet] = React.useState<{ court: CheckinCourt; kind: 'checkin' | 'plan' } | null>(null);
  const [omwTarget, setOmwTarget] = React.useState<OnMyWayTarget | null>(null);
  const [busy, setBusy] = React.useState<'extend' | 'out' | null>(null);
  // What to open once the sheet has faded out (ActionSheetModal onDismissed).
  const after = React.useRef<(() => void) | null>(null);
  const configRef = React.useRef(config);
  configRef.current = config;

  const onMyWay = React.useCallback((court: CheckinCourt, from: OnMyWayTarget['from'] = configRef.current.from) => {
    setOmwTarget({ venueId: court.venueId, venueName: court.venueName, atCourt: court.atCourt, from });
  }, []);

  const canRoutine = (court: CheckinCourt) => ROUTINES_ENABLED && court.starred;

  function sheetActions(court: CheckinCourt, kind: 'checkin' | 'plan'): ActionSheetAction[] {
    const cfg = configRef.current;
    const ids = kind === 'plan' ? planOptionIds({ canRoutine: canRoutine(court) }) : checkinOptionIds({ canOnMyWay, canRoutine: canRoutine(court) });
    return ids.map((id): ActionSheetAction => {
      const tap = () => cfg.onTap?.(id);
      switch (id) {
        case 'checkInNow':
          return {
            label: 'Check in now',
            iconName: 'pin',
            onPress: () => {
              tap();
              after.current = () => cfg.checkIn(court);
            },
          };
        case 'onMyWay':
          return {
            label: 'On my way',
            iconName: 'walk',
            onPress: () => {
              tap();
              after.current = () => onMyWay(court, cfg.from === 'feed' ? 'feed_sheet' : 'court');
            },
          };
        case 'makeRoutine':
          return {
            label: 'Make this a routine',
            iconName: 'calendar-event',
            onPress: () => {
              tap();
              cfg.openRoutines(court);
            },
          };
      }
    });
  }

  /** Stay 1 more hour on my check-in (a fix when location is allowed, no prompt). */
  const extend = async (checkin?: CurrentCheckin | null) => {
    const cur = checkin ?? current;
    if (!cur || busy) return;
    configRef.current.onTap?.('extend');
    setBusy('extend');
    try {
      const { note } = await withTimeout(
        (async () => extendCheckinByHour(cur, await takeFixIfAllowed(5_000)))(),
        ACTION_BOUND_MS,
      );
      if (note.full) toast.success(note.message);
      else toast.info(note.message);
    } catch (e) {
      if (e instanceof TimeoutError) toast.info(STILL_WORKING);
      else toast.error(explainRefusal(e, "Couldn't extend your check-in. Try again.", { venueName: cur.venueName, action: 'extend' }));
    } finally {
      setBusy(null);
    }
  };

  /** Check out (and end the play session; its end sheet asks what to record). */
  const checkOut = async (checkin?: CurrentCheckin | null) => {
    const cur = checkin ?? current;
    if (!cur || busy) return;
    configRef.current.onTap?.('check_out');
    setBusy('out');
    try {
      const { ended, checkedOut, venueName, error } = await withTimeout(checkOutHere(cur), ACTION_BOUND_MS);
      if (error) toast.error(explainRefusal(error, "Couldn't check you out. Try again.", { venueName }));
      else if (!ended) toast.success(checkedOut && venueName ? `Checked out of ${venueName}.` : 'Session ended.');
    } catch (e) {
      if (e instanceof TimeoutError) toast.info(STILL_WORKING);
      else toast.error(explainRefusal(e, "Couldn't check you out. Try again.", { venueName: cur.venueName }));
    } finally {
      setBusy(null);
    }
  };

  const elements = (
    <>
      <ActionSheetModal
        visible={sheet != null}
        title={sheet?.court.venueName}
        subtitle={
          sheet?.kind === 'plan' ? 'Tomorrow' : sheet ? movesCheckinNote(current, sheet.court.venueId) : undefined
        }
        actions={sheet ? sheetActions(sheet.court, sheet.kind) : []}
        cancelLabel="Close"
        onClose={() => setSheet(null)}
        onDismissed={() => {
          const next = after.current;
          after.current = null;
          next?.();
        }}
      />
      <OnMyWaySheet target={omwTarget} onClose={() => setOmwTarget(null)} />
    </>
  );

  return {
    /** My check-in now, or null. */
    current,
    /** The same, as the feed's own line takes it. */
    mine,
    canOnMyWay,
    /** Stay 1 more hour / Check out is running. */
    busy,
    /** "Check in ▾": the options sheet for this court. */
    openCheckin: (court: CheckinCourt) => {
      after.current = null;
      setSheet({ court, kind: 'checkin' });
    },
    /** Tomorrow's "Plan ▾". Nothing to plan: no sheet. */
    openPlan: (court: CheckinCourt) => {
      if (planOptionIds({ canRoutine: canRoutine(court) }).length === 0) return;
      after.current = null;
      setSheet({ court, kind: 'plan' });
    },
    canPlan: (court: Pick<CheckinCourt, 'starred'>) => planOptionIds({ canRoutine: ROUTINES_ENABLED && court.starred }).length > 0,
    /** The On my way sheet, straight away (a header button, a line's sheet's follow-up). */
    onMyWay,
    extend,
    checkOut,
    /** The sheets: render once, anywhere in the caller's tree. */
    elements,
  };
}

// The one "Check in ▾" for a court (Doggle's park card), shared by Home's
// feed court cards and the court's page: the options sheet, the plan
// pickers, the On my way sheet, and my own check-in (Stay 1 more hour, Check
// out). Which items show is lib/checkinOptions (tested); what Check in now
// and Make this a routine do is the caller's (the feed hands the check-in to
// CheckinHost, the page runs its own flow so its notes show there).
//
//   <court name>
//   You're checked in at Star Park. Checking in here moves you.   (only then)
//   (pin)        Check in now
//   (megaphone)  Check in and tell friends   (friends to tell)
//   (walk)       On my way                   (friends to tell)
//   (calendar)   Plan a check-in for later   (feed: a slot left today; page: any day)
//   (calendar)   Make this a routine         (a starred court)
//   Close
//
// Check in and tell friends checks in (the caller's Check in now), then opens
// the On my way sheet in its "I'm here" form once that check-in has landed
// at that court (lib/courtCheckin checkedInHere), as Doggle does after
// checkInHere. A check-in saved with no signal tells nobody yet (the server
// only sends while I'm checked in there) and says so; a refused one opens
// nothing, and it stops waiting as soon as the check-in is over either way
// (the page's flow settles; the feed's CheckinHost goes idle), or another
// Check in ▾ / Check in now is tapped.
//
// Plan a check-in for later: on the feed, today's quarter hours to 11:45 PM
// (SingleSelectModal, "Check in at Lakeside at"); on the court's page, a
// sheet that names the court ("Plan a check-in at Lakeside"), a day and a
// time (the foundation's DateTimeField) and [Plan check-in], as Doggle's place
// page has PLAN A VISIT / WHEN / [Schedule visit]. The same sheet changes a
// plan's time there (any day). Tomorrow's Plan ▾ opens tomorrow's slots
// straight away (6 AM to 11:45 PM). Each calls data/courtPlans; `planning`
// names the court whose plan is being written, so only its control shows
// "…". The court page's sheet says a refusal or a failure inside itself and
// stays open to pick again: a toast sits under an open sheet's backdrop on
// web and behind its Modal on native (the pickers close first, so theirs toast).
// With plan sharing, a new plan is Shared by default (friends who can see my
// plans see it); the court page's sheet has a Shared / Only you chip for it.
//
// A follow-up (the On my way sheet, a picker, a check-in that may ask for
// location, My routine's add sheet) opens from the sheet's onDismissed: iOS
// won't present a second modal while the sheet is still fading out.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ActionSheetModal,
  BottomSheet,
  DateTimeField,
  SingleSelectModal,
  StatusBanner,
  type ActionSheetAction,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { TimeoutError, withTimeout } from '@just-messin-around/expo-foundation/platform';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { STILL_WORKING, refusalCode } from '../../lib/refusals';
import { CHECKIN_PLANS_ENABLED, FRIENDS_AT_COURTS_ENABLED, PLAN_SHARING_ENABLED, ROUTINES_ENABLED } from '../../lib/features';
import { PlanShareChip } from '@just-messin-around/expo-foundation/plans';
import { planSheetShareHint } from '../../lib/planSharing';
import { useMyFriends } from '../../lib/useFriends';
import { playSession } from '../../lib/playSession';
import { checkOutHere } from '../../lib/checkinPlay';
import { checkinHostBusy } from '../../lib/checkinHost';
import { checkedInHere, extendCheckinByHour, takeFixIfAllowed, type CurrentCheckin } from '../../lib/courtCheckin';
import { useCurrentCheckin } from '../../lib/useCurrentCheckin';
import { checkinOptionIds, movesCheckinNote, planOptionIds, type CheckinOptionId } from '../../lib/checkinOptions';
import {
  canPlanLaterToday,
  cancelledMessage,
  defaultPlanAt,
  movedMessage,
  planPickerTitle,
  planTimeProblem,
  plannedMessage,
  slotPickerEmptyText,
  todayPlanSlots,
  tomorrowPlanSlots,
  type CourtPlan,
} from '../../lib/courtPlans';
import { cancelCourtPlan, loadMyCourtPlans, moveCourtPlan, planCourtCheckin } from '../../data/courtPlans';
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
  /** Check in now at this court. A promise settles once that check-in is
   *  done or refused (the page's own flow); false: nothing started here
   *  (the court's page opened instead). "Check in and tell friends" stops
   *  waiting for it then. */
  checkIn: (court: CheckinCourt) => void | boolean | Promise<unknown>;
  /** Make this a routine: My routine's add sheet with this court. */
  openRoutines: (court: CheckinCourt) => void;
  /** Where the On my way sheet was opened from (analytics). */
  from: 'feed' | 'court';
  /** Plan a check-in for later: today's slots (the feed, Doggle's park sheet)
   *  or a day and a time (the court's page, Doggle's place page). */
  planPicker?: 'today' | 'datetime';
  /** A tap on one of the sheet's items (analytics). */
  onTap?: (id: CheckinOptionId | 'extend' | 'check_out' | 'plan_pick') => void;
};

// Stay 1 more hour waits on a fix (5 s) and the write; Check out on its fix
// wait (3 s) and the write. Past this the busy state clears and says so.
const ACTION_BOUND_MS = 16_000;
// "Check in and tell friends" waits at most this long for its check-in to
// land (a fix, maybe the consent sheet, the write).
const TELL_AFTER_CHECKIN_MS = 2 * 60_000;

type SlotPick = { court: CheckinCourt; day: 'today' | 'tomorrow' };
/** The court page's plan sheet: a new plan, or (planId) a plan's new time.
 *  `share`: a new plan's Shared / Only you (plan sharing; default Shared). */
type PlanSheet = { court: CheckinCourt; value: Date; planId: string | null; was: string | null; share: boolean };
type Busy = 'extend' | 'out' | 'plan';
/** Where a plan write's outcome is said: the toast, or the plan sheet's own line. */
type Say = { success: (m: string) => void; info: (m: string) => void; error: (m: string) => void };

export function useCheckinOptions(config: CheckinOptionsConfig) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const friendsQ = useMyFriends(FRIENDS_AT_COURTS_ENABLED);
  const canOnMyWay = FRIENDS_AT_COURTS_ENABLED && (friendsQ.data?.length ?? 0) > 0;

  // My check-in now (this device's copy; lib/courtCheckin keeps it current;
  // a change heard first wins over the cached read, lib/useCurrentCheckin).
  const [current] = useCurrentCheckin();
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
  // What runs now. The ref is the guard (a callback can hold an old render's
  // state); the state shows it. `planning`: the court a plan write is for.
  const [busy, setBusyState] = React.useState<Busy | null>(null);
  const busyRef = React.useRef<Busy | null>(null);
  const [planning, setPlanning] = React.useState<string | null>(null);
  const setBusy = (b: Busy | null) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const [slotPick, setSlotPick] = React.useState<SlotPick | null>(null);
  const [planSheet, setPlanSheet] = React.useState<PlanSheet | null>(null);
  // Why the plan sheet's last Plan check-in / Change time didn't go through,
  // said in the sheet (a toast would be under its backdrop). Cleared as the
  // sheet opens and as the time changes.
  const [planError, setPlanError] = React.useState<string | null>(null);
  const openPlanSheet = (s: PlanSheet) => {
    setPlanError(null);
    setPlanSheet(s);
  };
  // The plan sheet keeps its court while it slides away (planSheet is null then).
  const planShown = React.useRef(planSheet);
  if (planSheet) planShown.current = planSheet;
  const planView = planSheet ?? planShown.current;
  // What to open once the sheet has faded out (ActionSheetModal onDismissed).
  const after = React.useRef<(() => void) | null>(null);
  const configRef = React.useRef(config);
  configRef.current = config;

  const onMyWay = React.useCallback((court: CheckinCourt, from: OnMyWayTarget['from'] = configRef.current.from) => {
    setOmwTarget({ venueId: court.venueId, venueName: court.venueName, atCourt: court.atCourt, from });
  }, []);

  // "Check in and tell friends": the court asked for, until its check-in
  // lands there or is over.
  const tellAfter = React.useRef<{ court: CheckinCourt; until: number } | null>(null);
  useSignal(checkedInHere, (cur) => {
    const want = tellAfter.current;
    if (!want || Date.now() > want.until) return;
    // Only the check-in this asked for: at that court (the facility the
    // server answered with, or the name the request carried).
    if (cur.venueId !== want.court.venueId && cur.venueName !== want.court.venueName) return;
    tellAfter.current = null;
    if (cur.queued) {
      toast.info(`Checked in with no signal. Tell your friends you're at ${cur.venueName} once it goes through.`);
      return;
    }
    // The court the check-in landed at (the facility the server answered with).
    setOmwTarget({
      venueId: cur.venueId,
      venueName: cur.venueName || want.court.venueName,
      atCourt: want.court.atCourt,
      from: configRef.current.from === 'feed' ? 'feed_sheet' : 'court',
      here: true,
    });
  });
  // The feed's check-in runs in CheckinHost: once the host is idle again,
  // that check-in landed (and was taken above) or never will (refused,
  // consent declined, a request it dropped while busy).
  useSignal(checkinHostBusy, (b) => {
    if (b == null && configRef.current.from === 'feed') tellAfter.current = null;
  });

  const canRoutine = (court: CheckinCourt) => ROUTINES_ENABLED && court.starred;
  const canPlanLater = () =>
    CHECKIN_PLANS_ENABLED && (configRef.current.planPicker === 'datetime' || canPlanLaterToday(Date.now()));

  /** Open the right picker for "Plan a check-in for later". */
  const openPlanLater = (court: CheckinCourt) => {
    if (configRef.current.planPicker === 'datetime') {
      openPlanSheet({ court, value: defaultPlanAt(Date.now()), planId: null, was: null, share: true });
    } else {
      setSlotPick({ court, day: 'today' });
    }
  };

  function sheetActions(court: CheckinCourt, kind: 'checkin' | 'plan'): ActionSheetAction[] {
    const cfg = configRef.current;
    const ids =
      kind === 'plan'
        ? planOptionIds({ canRoutine: canRoutine(court) })
        : checkinOptionIds({
            canOnMyWay,
            canRoutine: canRoutine(court),
            canTellFriends: CHECKIN_PLANS_ENABLED && canOnMyWay,
            canPlanLater: canPlanLater(),
          });
    return ids.map((id): ActionSheetAction => {
      const tap = () => cfg.onTap?.(id);
      switch (id) {
        case 'checkInNow':
          return {
            label: 'Check in now',
            iconName: 'pin',
            onPress: () => {
              tap();
              after.current = () => {
                tellAfter.current = null;
                cfg.checkIn(court);
              };
            },
          };
        case 'tellFriends':
          return {
            label: 'Check in and tell friends',
            iconName: 'megaphone',
            onPress: () => {
              tap();
              after.current = () => {
                const armed = { court, until: Date.now() + TELL_AFTER_CHECKIN_MS };
                tellAfter.current = armed;
                const started = cfg.checkIn(court);
                const stop = () => {
                  if (tellAfter.current === armed) tellAfter.current = null;
                };
                if (started === false) stop();
                else if (started && typeof (started as Promise<unknown>).then === 'function') {
                  (started as Promise<unknown>).then(stop, stop);
                }
              };
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
        case 'planLater':
          return {
            label: 'Plan a check-in for later',
            iconName: 'calendar-event',
            onPress: () => {
              tap();
              after.current = () => openPlanLater(court);
            },
          };
        case 'makeRoutine':
          return {
            label: 'Make this a routine',
            iconName: 'calendar-event',
            onPress: () => {
              tap();
              // My routine opens its add sheet (a modal) as it mounts: after this one has gone.
              after.current = () => cfg.openRoutines(court);
            },
          };
      }
    });
  }

  /** A plan write (plan, move, cancel) for one court, then a line that says
   *  what happened (or why not): a toast, or `say`'s (the plan sheet's own,
   *  while it stays open). True when it went through. */
  const writePlan = async (
    court: CheckinCourt,
    write: () => Promise<unknown>,
    done: string,
    fail: string,
    say: Say = toast,
  ): Promise<boolean> => {
    if (busyRef.current) {
      say.info(STILL_WORKING);
      return false;
    }
    setBusy('plan');
    setPlanning(court.venueId);
    try {
      await write();
      say.success(done);
      return true;
    } catch (e) {
      say.error(explainRefusal(e, fail, { venueName: court.venueName, action: 'plan_checkin' }));
      // Moved or cancelled elsewhere, or over: the list is out of date.
      if (refusalCode(e) === 'visit.gone') void loadMyCourtPlans(true).catch(() => undefined);
      return false;
    } finally {
      setBusy(null);
      setPlanning(null);
    }
  };

  /** plan_court_checkin at `at`. `share`: Shared (the default) or Only you,
   *  with plan sharing on (the pickers make Shared plans; the court page's
   *  sheet has the chip). */
  const plan = async (court: CheckinCourt, at: Date, say: Say = toast, share = true): Promise<boolean> => {
    const problem = planTimeProblem(at, Date.now());
    if (problem) {
      say.info(problem);
      return false;
    }
    configRef.current.onTap?.('plan_pick');
    return writePlan(
      court,
      () => planCourtCheckin(court.venueId, at, { share }),
      plannedMessage(court.venueName, at.toISOString(), Date.now()) + (PLAN_SHARING_ENABLED && share ? ' Your friends can see it.' : ''),
      "Couldn't plan your check-in. Try again.",
      say,
    );
  };

  /** move_court_plan to `at` (the court page's Change time; the feed moves its own). */
  const movePlan = async (court: CheckinCourt, planId: string, at: Date, say: Say = toast): Promise<boolean> => {
    const problem = planTimeProblem(at, Date.now());
    if (problem) {
      say.info(problem);
      return false;
    }
    return writePlan(
      court,
      () => moveCourtPlan(planId, at),
      movedMessage(court.venueName, at.toISOString(), Date.now()),
      "Couldn't change the time. Try again.",
      say,
    );
  };

  /** cancel_court_plan ("Cancel this visit" on the court page). */
  const cancelPlan = (court: CheckinCourt, p: Pick<CourtPlan, 'planId' | 'plannedAt'>): Promise<boolean> =>
    writePlan(
      court,
      () => cancelCourtPlan(p.planId),
      cancelledMessage(court.venueName, p.plannedAt, Date.now()),
      "Couldn't cancel that check-in. Try again.",
    );

  /** The plan sheet's button: plan, or move to the time picked. A refusal or
   *  a failure shows IN the sheet, which stays open to pick again: a toast
   *  would sit under its backdrop (web), or behind its Modal (native).
   *  Success closes it and toasts. */
  const submitPlanSheet = async () => {
    const s = planSheet;
    if (!s) return;
    if (s.planId && s.was && Date.parse(s.was) === s.value.getTime()) {
      setPlanSheet(null);
      return;
    }
    setPlanError(null);
    const inSheet: Say = { success: toast.success, info: setPlanError, error: setPlanError };
    const ok = s.planId ? await movePlan(s.court, s.planId, s.value, inSheet) : await plan(s.court, s.value, inSheet, s.share);
    if (ok) setPlanSheet((cur) => (cur === s ? null : cur));
  };

  /** Stay 1 more hour on my check-in (a fix when location is allowed, no prompt). */
  const extend = async (checkin?: CurrentCheckin | null) => {
    const cur = checkin ?? current;
    if (!cur || busyRef.current) return;
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
    if (!cur || busyRef.current) return;
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

  const slots = slotPick ? (slotPick.day === 'tomorrow' ? tomorrowPlanSlots(Date.now()) : todayPlanSlots(Date.now())) : [];
  const planBusy = busy === 'plan';

  const elements = (
    <>
      <ActionSheetModal
        visible={sheet != null}
        title={sheet?.court.venueName}
        subtitle={
          sheet?.kind === 'plan' ? 'Tomorrow' : sheet ? movesCheckinNote(current, sheet.court.venueId, Date.now()) : undefined
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
      <SingleSelectModal
        visible={slotPick != null}
        title={slotPick ? planPickerTitle(slotPick.court.venueName, slotPick.day) : 'Check in at'}
        items={slots}
        selectedId={null}
        onPick={(id) => {
          const pick = slotPick;
          setSlotPick(null);
          if (pick && id) void plan(pick.court, new Date(id));
        }}
        onClose={() => setSlotPick(null)}
        searchPlaceholder="e.g. 5:30"
        emptyText={slotPickerEmptyText(slotPick?.day ?? 'today', slots.length)}
      />
      <BottomSheet
        visible={planSheet != null}
        onClose={() => {
          if (!planBusy) setPlanSheet(null);
        }}
        title={
          planView
            ? planView.planId
              ? `New time at ${planView.court.venueName}`
              : `Plan a check-in at ${planView.court.venueName}`
            : 'Plan a check-in'
        }
        titleIconName="calendar-event"
      >
        <View style={S.planBody}>
          {planView ? (
            <DateTimeField
              label="When"
              value={planView.value}
              minimumDate={new Date()}
              onChange={(d) => {
                setPlanError(null);
                setPlanSheet((cur) => (cur ? { ...cur, value: d } : cur));
              }}
            />
          ) : null}
          {PLAN_SHARING_ENABLED && planView && !planView.planId ? (
            <View style={S.shareRow}>
              <Text style={[t.body, S.shareLabel]}>Who sees it</Text>
              <PlanShareChip
                shared={planView.share}
                size="md"
                disabled={busy != null}
                onPress={() => setPlanSheet((cur) => (cur ? { ...cur, share: !cur.share } : cur))}
              />
            </View>
          ) : null}
          <Text style={[t.hint, { color: c.textSub }]}>
            {PLAN_SHARING_ENABLED
              ? `A check-in there within 30 minutes of this time keeps it.${
                  planView && !planView.planId ? ` ${planSheetShareHint(planView.share)}` : ''
                }`
              : 'A check-in there within 30 minutes of this time keeps it. Only you see your planned check-ins.'}
          </Text>
          {/* Why it didn't go through: here, not a toast (one would sit under this sheet). */}
          <StatusBanner status={planError ? { kind: 'error', text: planError } : null} style={S.planError} />
          <Button
            title={planView?.planId ? 'Change time' : 'Plan check-in'}
            iconName="calendar-event"
            variant="primary"
            onPress={() => void submitPlanSheet()}
            loading={planBusy}
            disabled={busy != null}
          />
        </View>
      </BottomSheet>
      <OnMyWaySheet target={omwTarget} onClose={() => setOmwTarget(null)} />
    </>
  );

  return {
    /** My check-in now, or null. */
    current,
    /** The same, as the feed's own line takes it. */
    mine,
    canOnMyWay,
    /** Stay 1 more hour / Check out / a plan write is running. */
    busy,
    /** The court a plan write (plan, move, cancel) is running for, or null. */
    planning,
    /** "Check in ▾": the options sheet for this court. */
    openCheckin: (court: CheckinCourt) => {
      after.current = null;
      tellAfter.current = null;
      setSheet({ court, kind: 'checkin' });
    },
    /** Tomorrow's "Plan ▾": tomorrow's time picker (Doggle); with plans off,
     *  the Make this a routine sheet (nothing to plan: no sheet). */
    openPlan: (court: CheckinCourt) => {
      tellAfter.current = null;
      if (CHECKIN_PLANS_ENABLED) {
        setSlotPick({ court, day: 'tomorrow' });
        return;
      }
      if (planOptionIds({ canRoutine: canRoutine(court) }).length === 0) return;
      after.current = null;
      setSheet({ court, kind: 'plan' });
    },
    canPlan: (court: Pick<CheckinCourt, 'starred'>) =>
      CHECKIN_PLANS_ENABLED || planOptionIds({ canRoutine: ROUTINES_ENABLED && court.starred }).length > 0,
    /** "Plan a check-in for later" straight away (the court page's link while checked in there). */
    openPlanLater,
    /** A plan's Change time on the court page: the plan sheet at its time, any day. */
    openMovePlan: (court: CheckinCourt, p: Pick<CourtPlan, 'planId' | 'plannedAt'>) =>
      openPlanSheet({ court, value: new Date(p.plannedAt), planId: p.planId, was: p.plannedAt, share: true }),
    /** A plan's Cancel this visit on the court page. */
    cancelPlan,
    /** The On my way sheet, straight away (a header button, a line's sheet's follow-up). */
    onMyWay,
    extend,
    checkOut,
    /** The sheets: render once, anywhere in the caller's tree. */
    elements,
  };
}

const S = StyleSheet.create({
  planBody: { gap: SPACE.md, paddingBottom: SPACE.sm },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.md },
  shareLabel: { flexShrink: 1 },
  // The body's gap spaces it.
  planError: { marginVertical: 0 },
});

// The Pickleague Feed: Home's one card for what's going on (the user,
// 2026-10-22: "collapsing the sections UP NEXT, YOUR LEAGUES, FRIENDS AT THE
// COURT, YOUR COURTS into a single Pickleague Feed, much like Doggle's home
// feed", then "court cards should kind of be like the top layer of the feed.
// They are the equivalent of places in Doggle"). Doggle's DoggleFeedSection:
//
//   Pickleague Feed
//   📅 My routine: Tue, Thu 6 PM at Lakeside ›
//   NEEDS YOU · 3 ...... votes, RSVPs, scores to confirm, invites, requests
//   [Today  Thu, Oct 22                    5 ^]
//     ★ Lakeside                     [On my way ▾]  [Check in ▾]
//        6 here · 2 open
//        (Ann)  Ann · PLUPR 3.82 · Open to play until 7 PM   [Here now ▾]
//        (📅)   Ladder night · Dinks · you're in            6 PM
//        (📅)   You · your routine · 6–8 PM               [At 6 PM ▾]
//     ★ Star Park                                    [Check in ▾]
//        Nothing planned
//     ELSEWHERE
//        (🏆)   Fall Classic · The HUB · registered         Sat 9 AM
//   [Tomorrow  Fri, Oct 23                    1 v]
//   [Later this week                          2 v]
//   My tournaments ›  My routine ›
//
// What qualifies is lib/pickleagueFeed.ts (tested): my leagues, tournaments I
// signed up for, starred and routine courts, and my accepted friends. The
// league side comes from the HomeData Home already loaded (no second load).
// The court side reads friends_at_courts (polled each minute while Home is
// focused), my stars, my routines, my friends list (their PLUPR and who counts
// as a friend), and court_play_modes for at most 6 courts with people there.
//
// A court card's one "Check in ▾" (Doggle's park card, 2026-10-24) and my own
// check-in line come from ./useCheckinOptions; which items each line's sheet
// lists is lib/checkinOptions (tested).
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CommonActions, useIsFocused, useNavigation } from '@react-navigation/native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { usePollWhileActive, useSignal, useTicker } from '@just-messin-around/expo-foundation/hooks';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { ActionSheetModal, Panel, SectionHeader, SingleSelectModal, TextLink, TITLE_ICON_COLUMN, type ActionSheetAction } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { DayBands, FeedActionPill, dayBandDate, type DayBand } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { trackHomeTap } from '../../lib/analytics';
import { openDiscover } from '../../lib/discoverNav';
import {
  checkinAtRequested,
  checkinHereRequested,
  checkinHostBusy,
  checkinHostOwnsNotes,
  type CheckinHostBusy,
} from '../../lib/checkinHost';
import { checkinChanged } from '../../lib/courtCheckin';
import { SHARE_ACTION_LABEL, lineActionIds, sheetLineFacts, type LineActionId } from '../../lib/checkinOptions';
import { dayLabel, shortTime, type AgendaRow, type AgendaTarget } from '../../lib/agenda';
import { inboxAgendaItems } from '../../lib/inboxRequests';
import {
  CHECKIN_PLANS_ENABLED,
  COURT_DISCOVERY_ENABLED,
  COURT_STARS_ENABLED,
  FRIENDS_AT_COURTS_ENABLED,
  PLAN_SHARING_ENABLED,
  ROUTINES_ENABLED,
} from '../../lib/features';
import { shareToggledMessage } from '../../lib/planSharing';
import {
  FRIEND_PLANS_KEY,
  FRIEND_PLANS_PERSIST_MS,
  FRIEND_PLANS_TTL_MS,
  fetchFriendCourtPlans,
  setCourtPlanShared,
} from '../../data/planSharing';
import { explainRefusal } from '../../lib/refusalNotices';
import { refusalCode } from '../../lib/refusals';
import { cancelledMessage, movedMessage, moveSlots, planWhen } from '../../lib/courtPlans';
import {
  MY_COURT_PLANS_KEY,
  MY_COURT_PLANS_PERSIST_MS,
  MY_COURT_PLANS_TTL_MS,
  cancelCourtPlan,
  fetchMyCourtPlans,
  moveCourtPlan,
} from '../../data/courtPlans';
import {
  BAND_ROWS_PREVIEW,
  NEEDS_YOU_PREVIEW,
  buildPickleagueFeed,
  placeLabel,
  previewRows,
  routineHeaderLine,
  type DayBandKey,
  type FeedCourtCard as CourtCard,
  type FeedSheetLine,
} from '../../lib/pickleagueFeed';
import type { PlayModeRow } from '../../lib/courtRoutineRules';
import type { HomeData } from '../home/homeData';
import LeaguePickerModal, { type PickableLeague } from '../LeaguePickerModal';
import { FRIENDS_COURTS_KEY, getFriendsAtCourts, type FriendsAtCourts } from '../../data/courtPresence';
import { useCourtFavorites } from '../../data/courtFavorites';
import { useMyFriends } from '../../lib/useFriends';
import {
  MY_COURT_ROUTINES_KEY,
  MY_COURT_ROUTINES_PERSIST_MS,
  MY_COURT_ROUTINES_TTL_MS,
  COURT_ROUTINE_SETTINGS_KEY,
  autoShareOf,
  fetchMyCourtRoutines,
  getCourtPlayModes,
  getCourtRoutineSettings,
  moveRoutineOccurrence,
  skipRoutineOccurrence,
  unskipRoutineOccurrence,
  type CourtPlayModes,
} from '../../data/courtRoutines';
import RoutineSuggestionCard from '../routines/RoutineSuggestionCard';
import FeedAgendaLine from './FeedAgendaLine';
import FeedCourtCard, { type FeedCourtCardActions } from './FeedCourtCard';
import { useCheckinOptions, type CheckinCourt } from './useCheckinOptions';
import type { OnMyWayTarget } from '../OnMyWaySheet';
import { onMyWaySent, sentOnMyWayRecently } from '../../data/onMyWay';

const POLL_MS = 60_000;
const CLOCK_MS = 60_000;
const SLOT_MS = 15 * 60_000;

/** home.tap targets for the Check in sheet's items and my own line's. */
const CHECKIN_TAP: Record<string, string> = {
  checkInNow: 'checkin_now',
  tellFriends: 'checkin_tell_friends',
  onMyWay: 'checkin_on_my_way',
  planLater: 'checkin_plan_later',
  makeRoutine: 'checkin_routine',
  plan_pick: 'plan_pick',
  extend: 'extend',
  check_out: 'check_out',
};

// Which bands the viewer folded or opened: module scope, so Home remounting
// doesn't spring a folded Today open again. A cold start goes back to the
// defaults. Kept apart for daytime and late evening (Doggle's rule): an
// afternoon tap doesn't stop Tomorrow opening at 10 PM.
let rememberedBands: { late: boolean; open: Partial<Record<string, boolean>> } = { late: false, open: {} };

/** From 10 PM local the day is about over: Tomorrow opens and Today folds. */
const LATE_HOUR = 22;
const isLateEvening = (ms: number) => new Date(ms).getHours() >= LATE_HOUR;

type Nav = { navigate: (...args: never[]) => void; dispatch: (action: ReturnType<typeof CommonActions.navigate>) => void };

export type PickleagueFeedProps = {
  home: HomeData;
  now: number;
  /** Agenda keys Home shows on their own card (a live league event). */
  hideKeys: ReadonlySet<string>;
  /** Leagues I run (their join requests are mine to answer). */
  privilegedLeagues: PickableLeague[];
  /** Opens an agenda line's screen (HomeScreen's go). */
  navigate: (target: AgendaTarget) => void;
  /** Inline drill Confirm. Rejects on failure (the caller shows the error). */
  onConfirmDrill: (sessionId: string) => Promise<void>;
  onDismissDrill: (sessionId: string) => void;
  /** "Propose a play day" (leagues I run): CreateEvent for that league. */
  onProposePlayDay: (leagueId: string) => void;
  /** The league picker opened / closed (Home holds its pop-up queue meanwhile). */
  onPickerOpenChange?: (open: boolean) => void;
  /** "All requests in Notifications ›" under Needs you. */
  onSeeAllRequests: () => void;
  /** Home's pull-to-refresh calls this: the court side's reads (friends at the
   *  courts, my stars, my routines, my friends list) reload with it. */
  refreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
};

const tap = (target: string, position?: number) => trackHomeTap({ section: 'feed', target, position });

/** Times a routine stop can move to: every 15 minutes for the rest of its day, plus its own. */
function timeSlots(atIso: string, nowMs: number): { id: string; name: string }[] {
  const at = new Date(atIso);
  const end = new Date(at);
  end.setHours(23, 45, 0, 0);
  const dayStart = new Date(at);
  dayStart.setHours(0, 0, 0, 0);
  const from = Math.max(dayStart.getTime(), Math.ceil((nowMs + 60_000) / SLOT_MS) * SLOT_MS);
  const out: { id: string; name: string }[] = [];
  for (let ms = from; ms <= end.getTime(); ms += SLOT_MS) out.push({ id: new Date(ms).toISOString(), name: shortTime(new Date(ms)) });
  if (!out.some((s) => Date.parse(s.id) === at.getTime())) {
    out.push({ id: at.toISOString(), name: shortTime(at) });
    out.sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}

export default function PickleagueFeedSection(props: PickleagueFeedProps) {
  const { home, hideKeys, privilegedLeagues } = props;
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const navigation = useNavigation() as unknown as Nav;
  const go = (name: string, params?: object) => navigation.dispatch(CommonActions.navigate({ name, params }));
  const focused = useIsFocused();
  const tick = useTicker(focused ? CLOCK_MS : 0);
  const now = Math.max(tick, props.now);
  const late = isLateEvening(now);

  // ── Court-side reads (Home's payload has the league side) ──
  const friendsQ = useCachedQuery<FriendsAtCourts>(FRIENDS_COURTS_KEY, () => getFriendsAtCourts(), {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
    enabled: FRIENDS_AT_COURTS_ENABLED,
  });
  usePollWhileActive(friendsQ.refresh, POLL_MS, FRIENDS_AT_COURTS_ENABLED && focused ? 'feed-friends' : null);
  const myFriendsQ = useMyFriends(FRIENDS_AT_COURTS_ENABLED);
  const favoritesQ = useCourtFavorites(COURT_STARS_ENABLED);
  const routinesQ = useCachedQuery(MY_COURT_ROUTINES_KEY, fetchMyCourtRoutines, {
    ttlMs: MY_COURT_ROUTINES_TTL_MS,
    persistMs: MY_COURT_ROUTINES_PERSIST_MS,
    enabled: ROUTINES_ENABLED,
  });
  const routines = React.useMemo(() => (ROUTINES_ENABLED ? routinesQ.data ?? [] : []), [routinesQ.data]);
  // My one-off planned check-ins (data/courtPlans; a plan, move or cancel
  // writes the new list into this cache).
  const plansQ = useCachedQuery(MY_COURT_PLANS_KEY, fetchMyCourtPlans, {
    ttlMs: MY_COURT_PLANS_TTL_MS,
    persistMs: MY_COURT_PLANS_PERSIST_MS,
    enabled: CHECKIN_PLANS_ENABLED,
  });
  const plans = React.useMemo(() => (CHECKIN_PLANS_ENABLED ? plansQ.data ?? [] : []), [plansQ.data]);
  // Plan sharing: my friends' shared plans (7 days, every court), and my
  // "Share my routine stops automatically" (a stop's chip predicts it).
  const sharing = PLAN_SHARING_ENABLED && CHECKIN_PLANS_ENABLED && ROUTINES_ENABLED;
  const friendPlansQ = useCachedQuery(FRIEND_PLANS_KEY, () => fetchFriendCourtPlans(), {
    ttlMs: FRIEND_PLANS_TTL_MS,
    persistMs: FRIEND_PLANS_PERSIST_MS,
    enabled: sharing && FRIENDS_AT_COURTS_ENABLED,
  });
  const friendPlans = React.useMemo(
    () => (sharing && FRIENDS_AT_COURTS_ENABLED ? friendPlansQ.data ?? [] : []),
    [sharing, friendPlansQ.data],
  );
  const routineSettingsQ = useCachedQuery(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, {
    ttlMs: 60 * 60_000,
    enabled: sharing,
  });
  const autoShare = sharing ? autoShareOf(routineSettingsQ.data) : null;
  // A check-in within 30 minutes of a routine stop or a planned check-in
  // keeps it on the server (_pl_routine_plan_at): reload both when a new
  // check-in lands, so a kept one leaves the card instead of sitting next to
  // my own "Here now" line (Doggle reloads its feed after every check-in).
  const seenCheckin = React.useRef<string | null>(null);
  useSignal(checkinChanged, (cur) => {
    const id = cur && !cur.queued ? cur.id : null;
    if (id && id !== seenCheckin.current) {
      if (ROUTINES_ENABLED) void routinesQ.refresh();
      if (CHECKIN_PLANS_ENABLED) void plansQ.refresh();
    }
    seenCheckin.current = id;
  });
  const friendsFailed = FRIENDS_AT_COURTS_ENABLED && friendsQ.error != null && friendsQ.data === undefined;

  // Home's pull-to-refresh reloads the court side too.
  const refreshers = [
    FRIENDS_AT_COURTS_ENABLED ? friendsQ.refresh : null,
    FRIENDS_AT_COURTS_ENABLED ? myFriendsQ.refresh : null,
    COURT_STARS_ENABLED ? favoritesQ.refresh : null,
    ROUTINES_ENABLED ? routinesQ.refresh : null,
    CHECKIN_PLANS_ENABLED ? plansQ.refresh : null,
    sharing && FRIENDS_AT_COURTS_ENABLED ? friendPlansQ.refresh : null,
  ];
  const refreshersRef = React.useRef(refreshers);
  refreshersRef.current = refreshers;
  const { refreshRef } = props;
  React.useEffect(() => {
    if (!refreshRef) return undefined;
    refreshRef.current = async () => {
      await Promise.allSettled(refreshersRef.current.map((fn) => (fn ? fn() : undefined)));
    };
    return () => {
      refreshRef.current = null;
    };
  }, [refreshRef]);

  const friendIds = React.useMemo(
    () => (myFriendsQ.data ? new Set(myFriendsQ.data.map((f) => f.user_id)) : null),
    [myFriendsQ.data],
  );
  const plupr = React.useMemo(
    () => new Map((myFriendsQ.data ?? []).map((f) => [f.user_id, f.doubles_rating] as const)),
    [myFriendsQ.data],
  );
  const starred = React.useMemo(() => {
    // My stars, and the stars friends_at_courts knows (whichever loaded).
    const m = new Map<string, { venueId: string; venueName: string; lat: number | null; lng: number | null }>();
    for (const f of favoritesQ.data ?? []) m.set(f.venue_id, { venueId: f.venue_id, venueName: f.venue_name, lat: f.lat, lng: f.lng });
    for (const ct of friendsQ.data?.courts ?? []) {
      if (ct.reason === 'favorite' && !m.get(ct.venue_id)?.venueName) {
        m.set(ct.venue_id, { venueId: ct.venue_id, venueName: ct.venue_name, lat: null, lng: null });
      }
    }
    return [...m.values()];
  }, [favoritesQ.data, friendsQ.data]);

  const requests = React.useMemo(
    () => inboxAgendaItems(home.inbox, home.profile?.id ?? null, privilegedLeagues, now),
    [home.inbox, home.profile?.id, privilegedLeagues, now],
  );

  // The court card's "Check in ▾", Plan ▾, On my way, and my own check-in
  // (its line, Stay 1 more hour, Check out).
  const checkin = useCheckinOptions({
    from: 'feed',
    planPicker: 'today',
    // CheckinHost runs it (false: no host, the court's page opened instead).
    checkIn: (court) => checkInHere(court, null),
    openRoutines: (court) => openRoutines({ venueId: court.venueId, venueName: court.venueName }),
    onTap: (id) => tap(CHECKIN_TAP[id] ?? id),
  });

  const feed = React.useMemo(
    () =>
      buildPickleagueFeed({
        now,
        events: home.events,
        tournaments: home.myTournaments,
        drills: home.drills ?? home.drillsToday,
        matches: home.matches ?? [],
        requests,
        hideKeys,
        starred: COURT_STARS_ENABLED ? starred : [],
        routines,
        friendsAtCourts: FRIENDS_AT_COURTS_ENABLED ? friendsQ.data ?? null : null,
        friendIds,
        mine: checkin.mine,
        plans,
        friendPlans,
        autoShareRoutines: autoShare,
      }),
    [now, home.events, home.myTournaments, home.drills, home.drillsToday, home.matches, requests, hideKeys, starred, routines, friendsQ.data, friendIds, checkin.mine, plans, friendPlans, autoShare],
  );

  // Who is open to play / in a closed group: court_play_modes for today's
  // courts with someone here (at most 6, one call each, cached together).
  const modeVenues = React.useMemo(() => {
    const today = feed.days.find((d) => d.key === 'today');
    return (today?.courts ?? [])
      .filter((ct) => ct.lines.some((l) => l.kind === 'here') || (ct.crowd?.here_now ?? 0) > 0)
      .map((ct) => ct.venueId)
      .sort();
  }, [feed]);
  const modesQ = useCachedQuery<Record<string, CourtPlayModes>>(
    `feed:playModes:${modeVenues.join(',')}`,
    async () => {
      const out: Record<string, CourtPlayModes> = {};
      const got = await Promise.allSettled(modeVenues.map((v) => getCourtPlayModes(v)));
      got.forEach((r, i) => {
        if (r.status === 'fulfilled') out[modeVenues[i]] = r.value;
      });
      return out;
    },
    { ttlMs: 60_000, persistMs: 60 * 60_000, enabled: ROUTINES_ENABLED && modeVenues.length > 0 },
  );
  const modesByVenue = React.useMemo(() => {
    const m = new Map<string, Map<string, PlayModeRow>>();
    for (const [venue, modes] of Object.entries(modesQ.data ?? {})) {
      m.set(venue, new Map(modes.players.filter((p) => p.userId).map((p) => [p.userId as string, p])));
    }
    return m;
  }, [modesQ.data]);

  // ── Actions ──
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [lineSheet, setLineSheet] = React.useState<{ line: FeedSheetLine; card: CourtCard; day: DayBandKey } | null>(null);
  // Change time: a routine stop's (move_court_routine_occurrence, the same
  // day) or a one-off plan's (move_court_plan).
  const [timePick, setTimePick] = React.useState<
    { kind: 'stop' | 'plan'; planId: string; at: string; venueName: string; key: string } | null
  >(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = React.useState<ReadonlySet<string>>(() => new Set());
  // CheckinHost's work (a Check in now from here, the bar's centre button,
  // the island's Stay or Check out): the card whose check-in it runs shows
  // "…" on its Check in, and the other controls dim meanwhile (Doggle's
  // pillState). Which court: the last check-in asked of the host, until it
  // is done.
  const [hostBusy, setHostBusy] = React.useState<CheckinHostBusy>(null);
  const [checkingInAt, setCheckingInAt] = React.useState<string | null>(null);
  useSignal(checkinAtRequested, (v) => setCheckingInAt(v.id));
  useSignal(checkinHereRequested, () => setCheckingInAt(null));
  useSignal(checkinHostBusy, (b) => {
    setHostBusy(b);
    if (b == null) setCheckingInAt(null);
  });
  // omwTick re-labels "On my way" as "On the way" after a send.
  const [, setOmwTick] = React.useState(0);
  useSignal(onMyWaySent, () => setOmwTick((n) => n + 1));
  // What a line's sheet opens once it has faded out (ActionSheetModal
  // onDismissed): iOS won't present the next modal before then.
  const afterLineSheet = React.useRef<(() => void) | null>(null);

  const openCourt = (venueId: string) => {
    if (COURT_DISCOVERY_ENABLED) go('CourtDetail', { venueId });
  };
  const openRoutines = (newVenue?: { venueId: string; venueName: string }) => {
    if (ROUTINES_ENABLED) go('Routines', newVenue ? { newVenue } : undefined);
  };
  const openPerson = (userId: string, name: string) => go('PlayerProfile', { userId, userName: name });
  // Check in at this court (CheckinHost; every check-in starts the play
  // session). With no host mounted (the bottom bar off), the court page has
  // the check-in. `target`: the home.tap target, null when the caller tapped it.
  // True when the host took it.
  const checkInHere = (card: { venueId: string; venueName: string }, target: string | null = 'check_in'): boolean => {
    if (target) tap(target);
    if (checkinHostOwnsNotes()) {
      checkinAtRequested.emit({ id: card.venueId, name: card.venueName });
      return true;
    }
    openCourt(card.venueId);
    return false;
  };
  const canOnMyWay = checkin.canOnMyWay;

  /** The court a card is, for the Check in sheets: friends it shows here now
   *  are listed first on On my way (all start ticked). */
  const courtOf = (card: CourtCard): CheckinCourt => {
    const atCourt = new Map<string, string>();
    for (const l of card.lines) {
      if (l.kind === 'here' && friendIds?.has(l.person.userId)) atCourt.set(l.person.userId, l.viaSession ? 'Playing now' : 'Here now');
    }
    return { venueId: card.venueId, venueName: card.venueName, starred: card.starred, atCourt };
  };
  const onMyWay = (card: CourtCard, from: OnMyWayTarget['from'] = 'feed') => {
    if (busyKey) return;
    tap('on_my_way');
    checkin.onMyWay(courtOf(card), from);
  };

  async function runRoutine(key: string, fn: () => Promise<unknown>, done: string, fail: string) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(friendlySbMessage(e, fail));
    } finally {
      setBusyKey(null);
    }
  }

  /** A one-off plan's Change time / Cancel this visit: its refusals have
   *  their own words (lib/refusals visit.*). */
  async function runPlan(key: string, venueName: string, fn: () => Promise<unknown>, done: string, fail: string) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(explainRefusal(e, fail, { venueName, action: 'plan_checkin' }));
      // Moved or cancelled on another device, or over: drop the dead line now.
      if (refusalCode(e) === 'visit.gone') void plansQ.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  /** My stop's or plan's Shared / Only you (set_court_plan_shared). Over or
   *  gone (plan.gone / visit.gone): the list is re-read so the line goes. */
  async function runShare(line: Extract<FeedSheetLine, { kind: 'stop' | 'plan' }>, card: CourtCard) {
    if (busyKey) return;
    const shared = line.kind === 'stop' ? line.stop.planShared : line.plan.planShared;
    const planId = line.kind === 'stop' ? line.stop.planId : line.plan.planId;
    const kind = line.kind === 'stop' ? 'routine' : 'once';
    tap(shared ? 'plan_unshare' : 'plan_share');
    setBusyKey(line.key);
    try {
      await setCourtPlanShared(planId, !shared);
      toast.success(shareToggledMessage(!shared, kind));
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't change who sees your plan. Try again.", { venueName: card.venueName }));
      const code = refusalCode(e);
      if (code === 'plan.gone') void routinesQ.refresh();
      if (code === 'visit.gone') void plansQ.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  /** A line's sheet, in Doggle's order (lib/checkinOptions lineActionIds). */
  function lineActions(line: FeedSheetLine, card: CourtCard, day: DayBandKey): ActionSheetAction[] {
    const ids = lineActionIds(sheetLineFacts(line, sharing), {
      day,
      nowMs: now,
      hereMine: card.hereMine,
      canOnMyWay,
      onMyWaySent: sentOnMyWayRecently(card.venueId, now),
    });
    const today = day === 'today';
    const stop = line.kind === 'stop' ? line.stop : null;
    const oneOff = line.kind === 'plan' ? line.plan : null;
    const person = line.kind === 'here' || line.kind === 'left' || line.kind === 'friendPlan' ? line.person : null;
    const own = line.kind === 'stop' || line.kind === 'plan' ? line : null;
    const then = (fn: () => void) => () => {
      afterLineSheet.current = fn;
    };
    const item = (id: LineActionId): ActionSheetAction | null => {
      switch (id) {
        case 'extend':
          return { label: 'Stay 1 more hour', iconName: 'clock', onPress: () => void checkin.extend() };
        case 'checkOut':
          // With a session running, Check out opens the play end sheet (a
          // modal): only once this one has gone, or iOS drops it.
          return { label: 'Check out', iconName: 'logout', onPress: then(() => void checkin.checkOut()) };
        case 'checkInNow':
          return {
            label: 'Check in now',
            iconName: 'pin',
            onPress: then(() => checkInHere(card, oneOff ? 'plan_check_in' : 'stop_check_in')),
          };
        case 'checkInHere':
          return { label: 'Check in here', iconName: 'pin', onPress: then(() => checkInHere(card, 'friend_check_in')) };
        case 'onMyWay':
          return { label: 'On my way', iconName: 'megaphone', onPress: then(() => onMyWay(card, 'feed_sheet')) };
        case 'profile':
          return person
            ? {
                label: `See ${person.name.split(/\s+/)[0] || person.name}'s profile`,
                iconName: 'person',
                onPress: () => openPerson(person.userId, person.name),
              }
            : null;
        case 'changeTime':
          if (oneOff) {
            return {
              label: 'Change time',
              iconName: 'clock',
              onPress: then(() =>
                setTimePick({ kind: 'plan', planId: oneOff.planId, at: oneOff.at, venueName: card.venueName, key: line.key }),
              ),
            };
          }
          return stop
            ? {
                label: today ? "Change today's time" : 'Change the time that day',
                iconName: 'calendar-event',
                onPress: then(() => setTimePick({ kind: 'stop', planId: stop.planId, at: stop.at, venueName: card.venueName, key: line.key })),
              }
            : null;
        case 'cancelPlan':
          return oneOff
            ? {
                label: 'Cancel this visit',
                style: 'destructive',
                onPress: () =>
                  void runPlan(
                    line.key,
                    card.venueName,
                    () => cancelCourtPlan(oneOff.planId),
                    cancelledMessage(card.venueName, oneOff.at, now),
                    "Couldn't cancel that check-in. Try again.",
                  ),
              }
            : null;
        case 'share':
        case 'unshare':
          return own
            ? {
                label: SHARE_ACTION_LABEL[id],
                iconName: id === 'share' ? 'group' : 'lock',
                onPress: () => void runShare(own, card),
              }
            : null;
        case 'editRoutine':
          return { label: 'Edit my routine', iconName: 'edit', onPress: () => openRoutines() };
        case 'skipStop':
          return stop
            ? {
                label: today ? 'Skip today' : 'Skip that day',
                style: 'destructive',
                onPress: () =>
                  void runRoutine(line.key, () => skipRoutineOccurrence(stop.planId), `Skipped ${card.venueName}. Undo it here or in My routine.`, "Couldn't skip that stop"),
              }
            : null;
        case 'undoSkip':
          return stop
            ? {
                label: 'Undo skip',
                iconName: 'calendar-event',
                onPress: () =>
                  void runRoutine(line.key, () => unskipRoutineOccurrence(stop.planId), `Back on: ${card.venueName} at ${shortTime(new Date(stop.at))}.`, "Couldn't undo that skip"),
              }
            : null;
      }
    };
    return ids.map(item).filter((a): a is ActionSheetAction => a != null);
  }

  /** A line's sheet title ("You · Lakeside") and subtitle ("Checked in since 5:29 PM"), Doggle's words. */
  function lineSheetText(line: FeedSheetLine, card: CourtCard, day: DayBandKey): { title: string; subtitle: string } {
    const clock = (iso: string) => shortTime(new Date(iso));
    if (line.kind === 'mine') {
      const m = line.checkin;
      return {
        title: `You · ${card.venueName}`,
        subtitle: m.queued
          ? `Saved with no signal · until ${clock(m.expiresAt)}`
          : m.checkedInAt
            ? `Checked in since ${clock(m.checkedInAt)}`
            : `Checked in until ${clock(m.expiresAt)}`,
      };
    }
    if (line.kind === 'stop') {
      const s = line.stop;
      const when = day === 'later' ? `${dayLabel(new Date(s.at), new Date(now))} ${clock(s.at)}` : clock(s.at);
      return {
        title: `You · ${card.venueName}`,
        subtitle: s.status === 'cancelled' ? `Skipped: ${when} (routine)` : `Planned check-in ${day === 'later' ? '' : 'at '}${when} (routine)`,
      };
    }
    if (line.kind === 'plan') {
      const when = day === 'later' ? planWhen(line.plan.at, now) : clock(line.plan.at);
      return { title: `You · ${card.venueName}`, subtitle: `Planned check-in ${day === 'later' ? '' : 'at '}${when}` };
    }
    if (line.kind === 'friendPlan') {
      const when = day === 'later' ? planWhen(line.plan.at, now) : clock(line.plan.at);
      return {
        title: `${line.person.name} · ${card.venueName}`,
        subtitle: `Planned check-in ${day === 'later' ? '' : 'at '}${when}${line.plan.routine ? ' (routine)' : ''}`,
      };
    }
    return {
      title: `${line.person.name} · ${card.venueName}`,
      subtitle: line.kind === 'here' ? `Here since ${clock(line.at)}` : `Was here ${clock(line.at)}–${clock(line.endedAt)}`,
    };
  }

  function agendaRow(line: { row: AgendaRow; mirror: boolean }, i: number, band: DayBandKey) {
    return agendaLine(line.row, i, false, band);
  }

  // My own line's Stay / Check out runs in the hook: its chip shows it.
  const ownBusyKey = checkin.busy === 'extend' || checkin.busy === 'out' ? `mine|${checkin.current?.id ?? ''}` : null;
  // A plan from Check in ▾ or Plan ▾: that court's header control shows it.
  const planBusyKey = checkin.busy === 'plan' ? 'plan' : null;
  // What runs now, if anything: a line's action, my own line's, a plan, or the host's.
  const running = busyKey ?? ownBusyKey ?? planBusyKey ?? (hostBusy != null ? 'checkin-host' : null);
  const courtCardActions: FeedCourtCardActions = {
    toggleShare: sharing
      ? (line, card) => {
          if (!running) void runShare(line, card);
        }
      : undefined,
    openCourt: (card) => { tap('court'); openCourt(card.venueId); },
    checkInOptions: (card) => { if (!running) { tap('check_in_options'); checkin.openCheckin(courtOf(card)); } },
    plan: (card) => { if (!running) { tap('plan_options'); checkin.openPlan(courtOf(card)); } },
    onMyWay: (card) => onMyWay(card),
    headerFacts: (card) => ({ canOnMyWay, onMyWaySent: sentOnMyWayRecently(card.venueId, now), canPlan: checkin.canPlan(card) }),
    headerState: (card, action) => {
      const busy =
        (action === 'checkIn' && hostBusy === 'checkin' && checkingInAt === card.venueId) ||
        (action !== 'onMyWay' && checkin.busy === 'plan' && checkin.planning === card.venueId);
      return { busy, disabled: running != null && !busy };
    },
    renderAgenda: (line, _card, day) => agendaRow(line, 0, day),
    openLine: (line, card, day) => {
      if (running) return;
      afterLineSheet.current = null;
      setLineSheet({ line, card, day });
    },
    openPerson: (id, name) => { tap('person'); openPerson(id, name); },
    lineState: (key) => ({ busy: running === key, disabled: running != null && running !== key }),
  };

  async function confirmDrill(sessionId: string) {
    tap('drill_confirm');
    setConfirmed((prev) => new Set(prev).add(sessionId));
    try {
      await props.onConfirmDrill(sessionId);
    } catch {
      setConfirmed((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  function agendaLine(row: AgendaRow, i: number, highlight: boolean, band?: DayBandKey, place?: string | null) {
    return (
      <FeedAgendaLine
        key={row.key}
        row={row}
        now={now}
        highlight={highlight}
        band={band}
        place={place}
        onOpen={() => { tap(highlight ? 'needs_you' : 'row', i); props.navigate(row.target); }}
        onAction={row.action ? () => { tap(row.action!.slug ?? 'action', i); props.navigate(row.action!.target); } : undefined}
        onConfirm={row.confirmDrillId ? () => void confirmDrill(row.confirmDrillId!) : undefined}
        confirmed={!!row.confirmDrillId && confirmed.has(row.confirmDrillId)}
        onDismiss={row.dismissibleDrillId ? () => { tap('dismiss_drill', i); props.onDismissDrill(row.dismissibleDrillId!); } : undefined}
      />
    );
  }

  function moreLine(key: string, more: number, open: boolean, what: string) {
    if (more === 0 && !open) return null;
    return (
      <TouchableOpacity
        style={styles.more}
        onPress={() => { tap(open ? 'show_fewer' : 'show_more'); setExpanded((e) => ({ ...e, [key]: !open })); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? `Show fewer in ${what}` : `Show ${more} more in ${what}`}
      >
        <Text style={[t.meta, { color: c.primary }]}>{open ? 'Show fewer' : `Show ${more} more`}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={c.primary} />
      </TouchableOpacity>
    );
  }

  // ── Body ──
  const needs = previewRows(feed.needsYou, NEEDS_YOU_PREVIEW, !!expanded.needs);
  const bands: DayBand[] = feed.days.map((d) => {
    const rows = previewRows(d.elsewhere, BAND_ROWS_PREVIEW, !!expanded[d.key]);
    return {
      key: d.key,
      title: d.title,
      date: dayBandDate(d.key, now),
      count: d.count,
      children: (
        <>
          {d.courts.map((card) => (
            <FeedCourtCard
              key={card.key}
              card={card}
              day={d.key}
              now={now}
              modes={d.key === 'today' ? modesByVenue.get(card.venueId) ?? null : null}
              openNow={d.key === 'today' ? modesQ.data?.[card.venueId]?.openNow ?? null : null}
              plupr={plupr}
              friendsFailed={friendsFailed}
              actions={courtCardActions}
            />
          ))}
          {d.elsewhere.length > 0 ? (
            <View style={styles.elsewhere}>
              <Text style={[t.label, { color: c.textSub }]} accessibilityRole="header">
                {d.courts.length > 0 ? 'Elsewhere' : 'Coming up'}
              </Text>
              {rows.shown.map((r, i) => agendaLine(r, i, false, d.key, placeLabel(r) ?? 'No court set'))}
              {moreLine(d.key, rows.more, !!expanded[d.key], `${d.title}, elsewhere`)}
            </View>
          ) : null}
        </>
      ),
    };
  });

  const hasFriends = (myFriendsQ.data?.length ?? 0) > 0;
  // Only what would fill the feed and isn't set up yet. No "find a league"
  // here: a member has leagues, and a non-member gets Join a league right below.
  const canStar = COURT_DISCOVERY_ENABLED && COURT_STARS_ENABLED && starred.length === 0;
  const canFindFriends = FRIENDS_AT_COURTS_ENABLED && myFriendsQ.data !== undefined && !hasFriends;
  const emptyHint = [canStar ? 'star the courts you play at' : null, canFindFriends ? "add friends to see who's playing" : null].filter(Boolean);
  // Left-aligned like the rest of the card (glyphs-ui-plan.md 5.7).
  const emptyBlock = (
    <View style={styles.empty}>
      <Text style={t.sub}>
        {emptyHint.length
          ? `Nothing coming up this week. To fill this, ${emptyHint.join(', or ')}.`
          : 'Nothing coming up this week.'}
      </Text>
      {canStar || canFindFriends ? (
        <View style={styles.ctaRow}>
          {canStar ? (
            <FeedActionPill label="Star a court" iconName="star" filled onPress={() => { tap('empty_courts'); openDiscover(navigation, { tab: 'places' }); }} />
          ) : null}
          {canFindFriends ? (
            <FeedActionPill label="Find friends" iconName="group" filled={!canStar} onPress={() => { tap('empty_friends'); openDiscover(navigation, { tab: 'players', players: 'find' }); }} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
  // An empty starred card already says "nothing here": the block only shows
  // when the feed has no band and nothing needs me.
  const feedEmpty = feed.days.length === 0 && feed.needsYou.length === 0;

  const [pickerOpen, setPickerOpenState] = React.useState(false);
  const setPickerOpen = (open: boolean) => {
    setPickerOpenState(open);
    props.onPickerOpenChange?.(open);
  };
  const propose = () => {
    tap('propose_play_day');
    if (privilegedLeagues.length === 1) props.onProposePlayDay(privilegedLeagues[0].id);
    else if (privilegedLeagues.length > 1) setPickerOpen(true);
  };

  const routineLine = ROUTINES_ENABLED ? routineHeaderLine(routines) : null;
  const hasTournaments = home.myTournaments.length > 0;

  return (
    <Panel>
      {/* The shared Home card header (Get started uses the same one). */}
      <SectionHeader title="Pickleague Feed" size="title" icon="pickle" />
      {routineLine ? (
        <TouchableOpacity
          style={styles.routineLine}
          onPress={() => { tap('routine_line'); openRoutines(); }}
          accessibilityRole="button"
          accessibilityLabel={`${routineLine}. Open My routine`}
        >
          {/* In the header's 32 glyph column, centred under its pickle, so the text lines up with the title. */}
          <View style={styles.lineGlyph}>
            <Icon name="calendar-event" size={14} color={c.textSub} />
          </View>
          <Text style={[t.meta, styles.flex, { color: c.textSub }]} numberOfLines={1}>
            {routineLine}
          </Text>
          <Icon name="chevron-right" size={14} color={c.textMuted} />
        </TouchableOpacity>
      ) : null}

      <View style={styles.body}>
        {feed.needsYou.length > 0 ? (
          <View style={styles.day}>
            <View style={[styles.needsBand, { backgroundColor: c.warningLight }]} accessibilityRole="header">
              <Text style={[t.label, { color: c.text }]}>Needs you</Text>
              <Text style={[t.meta, styles.count, { color: c.text }]}>{feed.needsYou.length}</Text>
            </View>
            {needs.shown.map((r, i) => agendaLine(r, i, true))}
            {moreLine('needs', needs.more, !!expanded.needs, 'Needs you')}
            <TextLink
              label="All requests in Notifications"
              onPress={() => { tap('see_all_notifications'); props.onSeeAllRequests(); }}
              style={styles.centerLink}
            />
          </View>
        ) : null}

        {bands.length > 0 ? (
          <DayBands
            bands={bands}
            single
            leadKey={late ? 'tomorrow' : null}
            modeKey={late ? 'late' : 'day'}
            initialOpen={rememberedBands.late === late ? rememberedBands.open : {}}
            onOpenChange={(o) => { rememberedBands = { late, open: o }; }}
          />
        ) : null}
        {feedEmpty ? emptyBlock : null}

        <RoutineSuggestionCard onOpenRoutines={() => openRoutines()} />

        <View style={styles.links}>
          {privilegedLeagues.length > 0 ? <TextLink label="Propose a play day" onPress={propose} /> : null}
          {hasTournaments ? (
            <TextLink label="My tournaments" onPress={() => { tap('my_tournaments'); openDiscover(navigation, { tab: 'tournaments', mine: true }); }} />
          ) : null}
          {ROUTINES_ENABLED ? <TextLink label="My routine" onPress={() => { tap('routines'); openRoutines(); }} /> : null}
        </View>
      </View>

      <ActionSheetModal
        visible={lineSheet != null}
        title={lineSheet ? lineSheetText(lineSheet.line, lineSheet.card, lineSheet.day).title : undefined}
        subtitle={lineSheet ? lineSheetText(lineSheet.line, lineSheet.card, lineSheet.day).subtitle : undefined}
        actions={lineSheet ? lineActions(lineSheet.line, lineSheet.card, lineSheet.day) : []}
        cancelLabel="Close"
        onClose={() => setLineSheet(null)}
        onDismissed={() => {
          const next = afterLineSheet.current;
          afterLineSheet.current = null;
          next?.();
        }}
      />
      <SingleSelectModal
        visible={timePick != null}
        title={timePick ? `New time at ${timePick.venueName}` : 'New time'}
        items={timePick ? (timePick.kind === 'plan' ? moveSlots(timePick.at, now) : timeSlots(timePick.at, now)) : []}
        selectedId={timePick ? new Date(timePick.at).toISOString() : null}
        onPick={(id) => {
          const tp = timePick;
          setTimePick(null);
          if (!tp || !id || Date.parse(id) === Date.parse(tp.at)) return;
          if (tp.kind === 'plan') {
            void runPlan(
              tp.key,
              tp.venueName,
              () => moveCourtPlan(tp.planId, new Date(id)),
              movedMessage(tp.venueName, id, Date.now()),
              "Couldn't change the time. Try again.",
            );
            return;
          }
          void runRoutine(
            tp.key,
            () => moveRoutineOccurrence(tp.planId, new Date(id)),
            `Moved that ${tp.venueName} check-in to ${shortTime(new Date(id))}. Your routine stays the same.`,
            "Couldn't change the time",
          );
        }}
        onClose={() => setTimePick(null)}
        searchPlaceholder="e.g. 5:30"
        emptyText="No later times left that day."
      />
      {/* Check in ▾, Plan ▾ and On my way. */}
      {checkin.elements}
      <LeaguePickerModal
        visible={pickerOpen}
        leagues={privilegedLeagues}
        selectedId={null}
        onPick={(id) => { tap('propose_pick'); setPickerOpen(false); props.onProposePlayDay(id); }}
        onClose={() => setPickerOpen(false)}
      />
    </Panel>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // The routine line sits under the header, its calendar glyph under the pickle.
  routineLine: { flexDirection: 'row', alignItems: 'center', gap: TITLE_ICON_COLUMN.gap, minHeight: 32 },
  lineGlyph: { width: TITLE_ICON_COLUMN.width, alignItems: 'center' },
  body: { marginTop: SPACE.sm, gap: SPACE.md },
  day: { gap: SPACE.sm },
  needsBand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    borderRadius: RADIUS.sm,
    paddingVertical: SPACE.xs,
    paddingHorizontal: SPACE.md,
  },
  count: { marginLeft: 'auto' },
  more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minHeight: 32 },
  centerLink: { alignSelf: 'center' },
  empty: { gap: SPACE.md, paddingVertical: SPACE.xs },
  ctaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: SPACE.sm },
  // TextLinks carry their own 44 boxes, so the rows need no extra gap. The
  // negative margin keeps the 44 tap boxes but takes back the 14px of empty box
  // above and below the text: the gap to the block above reads as the body's
  // 12, not 29, and the card no longer ends in 26px of padding.
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.lg, marginVertical: -SPACE.md },
  elsewhere: { gap: SPACE.xs, paddingTop: SPACE.xxs },
});

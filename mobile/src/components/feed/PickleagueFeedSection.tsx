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
//     ★ Lakeside        6 here · 2 open    [Check in] [▶ Play]
//        (Ann)  Ann · PLUPR 3.82 · Open to play until 7 PM   [Here now ▾]
//        (📅)   Ladder night · Dinks · you're in            6 PM
//        (📅)   You · your routine · 6–8 PM               [At 6 PM ▾]
//     ★ Star Park       Nothing planned · ▶ Start playing
//     ELSEWHERE
//        (🏆)   Fall Classic · The HUB · registered         Sat 9 AM
//   [Tomorrow  Fri, Oct 23                    1 v]
//   [Later this week                          2 v]
//   My leagues ›  My tournaments ›  Find courts ›
//
// What qualifies is lib/pickleagueFeed.ts (tested): my leagues, tournaments I
// signed up for, starred and routine courts, and my accepted friends. The
// league side comes from the HomeData Home already loaded (no second load).
// The court side reads friends_at_courts (polled each minute while Home is
// focused), my stars, my routines, my friends list (their PLUPR and who counts
// as a friend), and court_play_modes for at most 6 courts with people there.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CommonActions, useIsFocused, useNavigation } from '@react-navigation/native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { usePollWhileActive, useTicker } from '@just-messin-around/expo-foundation/hooks';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { ActionSheetModal, SingleSelectModal, type ActionSheetAction } from '@just-messin-around/expo-foundation/ui';
import { DayBands, FeedActionPill, dayBandDate, type DayBand } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { trackHomeTap } from '../../lib/analytics';
import { openDiscover } from '../../lib/discoverNav';
import { openPlayStart } from '../../lib/playSession';
import { checkinAtRequested, checkinHostOwnsNotes } from '../../lib/checkinHost';
import { dayLabel, shortTime, type AgendaRow, type AgendaTarget } from '../../lib/agenda';
import { inboxAgendaItems } from '../../lib/inboxRequests';
import {
  COURT_DISCOVERY_ENABLED,
  COURT_STARS_ENABLED,
  FRIENDS_AT_COURTS_ENABLED,
  ROUTINES_ENABLED,
} from '../../lib/features';
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
  fetchMyCourtRoutines,
  getCourtPlayModes,
  moveRoutineOccurrence,
  skipRoutineOccurrence,
  unskipRoutineOccurrence,
  type CourtPlayModes,
} from '../../data/courtRoutines';
import RoutineSuggestionCard from '../routines/RoutineSuggestionCard';
import FeedAgendaLine from './FeedAgendaLine';
import FeedCourtCard, { type FeedCourtCardActions } from './FeedCourtCard';

const POLL_MS = 60_000;
const CLOCK_MS = 60_000;
const SLOT_MS = 15 * 60_000;
/** iOS won't present the next modal until the action sheet has faded out. */
const SHEET_FADE_MS = 400;

// Which bands the viewer folded or opened: module scope, so Home remounting
// doesn't spring a folded Today open again. A cold start goes back to the defaults.
let rememberedBands: Partial<Record<string, boolean>> = {};

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
  const friendsFailed = FRIENDS_AT_COURTS_ENABLED && friendsQ.error != null && friendsQ.data === undefined;

  // Home's pull-to-refresh reloads the court side too.
  const refreshers = [
    FRIENDS_AT_COURTS_ENABLED ? friendsQ.refresh : null,
    FRIENDS_AT_COURTS_ENABLED ? myFriendsQ.refresh : null,
    COURT_STARS_ENABLED ? favoritesQ.refresh : null,
    ROUTINES_ENABLED ? routinesQ.refresh : null,
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
      }),
    [now, home.events, home.myTournaments, home.drills, home.drillsToday, home.matches, requests, hideKeys, starred, routines, friendsQ.data, friendIds],
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
  const [courtSheet, setCourtSheet] = React.useState<{ card: CourtCard; day: DayBandKey } | null>(null);
  const [timePick, setTimePick] = React.useState<{ planId: string; at: string; venueName: string; key: string } | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = React.useState<ReadonlySet<string>>(() => new Set());
  const afterSheet = (fn: () => void) => setTimeout(fn, SHEET_FADE_MS);

  const openCourt = (venueId: string) => {
    if (COURT_DISCOVERY_ENABLED) go('CourtDetail', { venueId });
  };
  const openRoutines = (newVenue?: { venueId: string; venueName: string }) => {
    if (ROUTINES_ENABLED) go('Routines', newVenue ? { newVenue } : undefined);
  };
  const openPerson = (userId: string, name: string) => go('PlayerProfile', { userId, userName: name });
  // ▶ Play / Check in at this court (P1's start sheet and CheckinHost). With
  // no host mounted (the bottom bar off), the court page has the check-in.
  const playHere = (card: { venueId: string; venueName: string }, target = 'play_here') => {
    tap(target);
    openPlayStart({ venue: { id: card.venueId, name: card.venueName } });
  };
  const checkInHere = (card: { venueId: string; venueName: string }) => {
    tap('check_in');
    if (checkinHostOwnsNotes()) checkinAtRequested.emit({ id: card.venueId, name: card.venueName });
    else openCourt(card.venueId);
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

  function lineActions(line: FeedSheetLine, card: CourtCard, day: DayBandKey): ActionSheetAction[] {
    if (line.kind === 'here' || line.kind === 'left') {
      const first = line.person.name.split(/\s+/)[0] || line.person.name;
      return [
        ...(line.kind === 'here' && day === 'today'
          ? [{ label: '▶ Play here', onPress: () => playHere(card) }]
          : []),
        { label: `See ${first}'s profile`, iconName: 'person' as const, onPress: () => openPerson(line.person.userId, line.person.name) },
      ];
    }
    const s = line.stop;
    if (s.status === 'cancelled') {
      return [
        {
          label: 'Undo skip',
          iconName: 'calendar',
          onPress: () => void runRoutine(line.key, () => unskipRoutineOccurrence(s.planId), `Back on: ${card.venueName} at ${shortTime(new Date(s.at))}.`, "Couldn't undo that skip"),
        },
        { label: 'Edit my routine', iconName: 'edit', onPress: () => openRoutines() },
      ];
    }
    const soon = day === 'today' && Date.parse(s.at) - now <= 30 * 60_000;
    return [
      ...(soon ? [{ label: '▶ Start playing', onPress: () => playHere(card, 'start_playing') }] : []),
      {
        label: day === 'today' ? "Change today's time" : 'Change the time that day',
        iconName: 'calendar',
        onPress: () => afterSheet(() => setTimePick({ planId: s.planId, at: s.at, venueName: card.venueName, key: line.key })),
      },
      {
        label: day === 'today' ? 'Skip today' : 'Skip that day',
        style: 'destructive',
        onPress: () => void runRoutine(line.key, () => skipRoutineOccurrence(s.planId), `Skipped ${card.venueName}. Undo it here or in My routine.`, "Couldn't skip that stop"),
      },
      { label: 'Edit my routine', iconName: 'edit', onPress: () => openRoutines() },
    ];
  }

  function courtActions(card: CourtCard, day: DayBandKey): ActionSheetAction[] {
    const routine = ROUTINES_ENABLED
      ? [{ label: 'Make this a routine', iconName: 'calendar' as const, onPress: () => openRoutines({ venueId: card.venueId, venueName: card.venueName }) }]
      : [];
    if (day !== 'today') return routine;
    return [
      { label: 'Check in here', iconName: 'pin' as const, onPress: () => checkInHere(card) },
      { label: '▶ Play here', onPress: () => playHere(card) },
      ...routine,
    ];
  }

  function agendaRow(line: { row: AgendaRow; mirror: boolean }, i: number, band: DayBandKey) {
    return agendaLine(line.row, i, false, band);
  }

  const courtCardActions: FeedCourtCardActions = {
    openCourt: (card) => { tap('court'); openCourt(card.venueId); },
    courtOptions: (card, day) => { if (!busyKey) setCourtSheet({ card, day }); },
    checkIn: (card) => checkInHere(card),
    play: (card) => playHere(card),
    renderAgenda: (line, _card, day) => agendaRow(line, 0, day),
    openLine: (line, card, day) => { if (!busyKey) setLineSheet({ line, card, day }); },
    openPerson: (id, name) => { tap('person'); openPerson(id, name); },
    lineState: (key) => ({ busy: busyKey === key, disabled: busyKey != null && busyKey !== key }),
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

  const isMember = home.myLeagues.length > 0;
  const hasFriends = (myFriendsQ.data?.length ?? 0) > 0;
  // Only what would fill the feed and isn't set up yet. No "find a league"
  // here: a member has leagues, and a non-member gets Join a league right below.
  const canStar = COURT_DISCOVERY_ENABLED && COURT_STARS_ENABLED && starred.length === 0;
  const canFindFriends = FRIENDS_AT_COURTS_ENABLED && myFriendsQ.data !== undefined && !hasFriends;
  const emptyHint = [canStar ? 'star the courts you play at' : null, canFindFriends ? "add friends to see who's playing" : null].filter(Boolean);
  const emptyBlock = (
    <View style={styles.empty}>
      <Text style={[t.sub, styles.center]}>
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
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.header}>
        <Text style={styles.headerGlyph} accessibilityElementsHidden importantForAccessibility="no">
          🥒
        </Text>
        <Text style={[t.title, styles.flex]} accessibilityRole="header">
          Pickleague Feed
        </Text>
      </View>
      {routineLine ? (
        <TouchableOpacity
          style={styles.routineLine}
          onPress={() => { tap('routine_line'); openRoutines(); }}
          accessibilityRole="button"
          accessibilityLabel={`${routineLine}. Open My routine`}
        >
          <Icon name="calendar" size={14} color={c.textSub} />
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
            <TouchableOpacity
              style={styles.more}
              onPress={() => { tap('see_all_notifications'); props.onSeeAllRequests(); }}
              accessibilityRole="button"
            >
              <Text style={[t.meta, { color: c.primary }]}>All requests in Notifications ›</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {bands.length > 0 ? (
          <DayBands bands={bands} initialOpen={rememberedBands} onOpenChange={(o) => { rememberedBands = o; }} />
        ) : null}
        {feedEmpty ? emptyBlock : null}

        <RoutineSuggestionCard onOpenRoutines={() => openRoutines()} />

        <View style={styles.links}>
          {privilegedLeagues.length > 0 ? (
            <TouchableOpacity onPress={propose} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>Propose a play day ›</Text>
            </TouchableOpacity>
          ) : null}
          {isMember ? (
            <TouchableOpacity onPress={() => { tap('all_leagues'); openDiscover(navigation, { tab: 'leagues', mine: true }); }} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>My leagues ›</Text>
            </TouchableOpacity>
          ) : null}
          {hasTournaments ? (
            <TouchableOpacity onPress={() => { tap('my_tournaments'); openDiscover(navigation, { tab: 'tournaments', mine: true }); }} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>My tournaments ›</Text>
            </TouchableOpacity>
          ) : null}
          {COURT_DISCOVERY_ENABLED ? (
            <TouchableOpacity onPress={() => { tap('find_courts'); openDiscover(navigation, { tab: 'places' }); }} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>Find courts ›</Text>
            </TouchableOpacity>
          ) : null}
          {ROUTINES_ENABLED ? (
            <TouchableOpacity onPress={() => { tap('routines'); openRoutines(); }} accessibilityRole="button">
              <Text style={[t.meta, { color: c.primary }]}>My routine ›</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ActionSheetModal
        visible={lineSheet != null}
        title={
          lineSheet
            ? lineSheet.line.kind === 'stop'
              ? `Your routine · ${lineSheet.card.venueName}`
              : `${lineSheet.line.person.name} · ${lineSheet.card.venueName}`
            : undefined
        }
        subtitle={
          lineSheet
            ? lineSheet.line.kind === 'stop'
              ? `${lineSheet.line.stop.status === 'cancelled' ? 'Skipped: ' : 'Planned check-in '}${
                  lineSheet.day === 'later'
                    ? `${dayLabel(new Date(lineSheet.line.stop.at), new Date(now))} `
                    : lineSheet.line.stop.status === 'cancelled'
                      ? ''
                      : 'at '
                }${shortTime(new Date(lineSheet.line.stop.at))}`
              : lineSheet.line.kind === 'here'
                ? `Here since ${shortTime(new Date(lineSheet.line.at))}`
                : `Was here ${shortTime(new Date(lineSheet.line.at))}–${shortTime(new Date(lineSheet.line.endedAt))}`
            : undefined
        }
        actions={lineSheet ? lineActions(lineSheet.line, lineSheet.card, lineSheet.day) : []}
        cancelLabel="Close"
        onClose={() => setLineSheet(null)}
      />
      <ActionSheetModal
        visible={courtSheet != null}
        title={courtSheet?.card.venueName}
        subtitle={courtSheet?.day === 'tomorrow' ? 'Tomorrow' : courtSheet?.day === 'later' ? 'Later this week' : undefined}
        actions={courtSheet ? courtActions(courtSheet.card, courtSheet.day) : []}
        cancelLabel="Close"
        onClose={() => setCourtSheet(null)}
      />
      <SingleSelectModal
        visible={timePick != null}
        title={timePick ? `New time at ${timePick.venueName}` : 'New time'}
        items={timePick ? timeSlots(timePick.at, now) : []}
        selectedId={timePick ? new Date(timePick.at).toISOString() : null}
        onPick={(id) => {
          const tp = timePick;
          setTimePick(null);
          if (!tp || !id || Date.parse(id) === Date.parse(tp.at)) return;
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
      <LeaguePickerModal
        visible={pickerOpen}
        leagues={privilegedLeagues}
        selectedId={null}
        onPick={(id) => { tap('propose_pick'); setPickerOpen(false); props.onProposePlayDay(id); }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerGlyph: { fontSize: 20 },
  flex: { flex: 1 },
  routineLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  body: { marginTop: 10, gap: 16 },
  day: { gap: 8 },
  needsBand: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  count: { marginLeft: 'auto' },
  more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 32 },
  empty: { gap: 10, paddingVertical: 4 },
  center: { textAlign: 'center' },
  ctaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 8 },
  elsewhere: { gap: 4, paddingTop: 2 },
});

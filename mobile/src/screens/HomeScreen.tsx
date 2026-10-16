// Home (plan section 3): what's yours first, about 660px tall for an active
// member instead of ~1,590.
//
//   top bar ...... PICKLEAGUE            [Saved] [Bell] [Gear]   fixed, 44
//   greeting ..... (avatar) Hi, Brian ›          🔥 5  🥒 1,240 ›   44
//   NOW .......... check-in / prompt / play session / live event (when any)
//   GET STARTED .. starter quests + guest / DUPR offers (until all claimed)
//   UP NEXT ...... votes, RSVPs, tournaments, drills, and the requests waiting
//                  on me: scores to confirm, invites, drill and join requests
//                  (lib/agenda.ts + lib/inboxRequests.ts)
//   YOUR LEAGUES .. one league's standings at a glance (chips in 2+ leagues),
//                  its next event / open vote, "All my leagues", "My tournaments"
//                  (components/home/LeagueSpotlight.tsx)
//     or JOIN A LEAGUE (no league yet): code, browse, 3 leagues with [Join]
//   quick row .... Record · Play · Drill · Shop · History
//   court row .... "At the courts?  Find my court ›" (idle check-in)
//   OPEN NEAR YOU  open tournaments / joinable leagues (members)
//   unlock ....... next badge on a progress bar (once Get started is gone)
//
// Sections are a KEYED array, so React moves an element between positions
// without remounting it. That is how the check-in card goes from the court row
// to NOW and back while staying mounted (the 'home/' push target relies on it).
//
// Location is never requested here (rule 5): the permission status is read,
// and coordinates are used only when it is already granted.
//
// The bell (P3): its NUMBER counts what needs me (every needs-you agenda item,
// uncapped; built from the source rows, so a request whose target was deleted
// can't count), and plain unread notices only light a dot (and only those
// whose target still exists: homeData's unreadLive).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery, setQueryData, peekQuery } from '@just-messin-around/expo-foundation/cache';
import { AppTopBar, ConfirmModal, EmptyState, SkeletonList, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useCoords } from '@just-messin-around/expo-foundation/hooks';
import { distanceMeters, getForegroundLocationStatus } from '@just-messin-around/expo-foundation/platform';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { RootStackParamList } from '../types';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { trackHomeTap, trackSectionToggle, type HomeSection } from '../lib/analytics';
import {
  buildAgenda,
  drillAgendaItems,
  eventAgendaItems,
  needsYouCount,
  tournamentAgendaItems,
  type AgendaItem,
  type AgendaTarget,
} from '../lib/agenda';
import { inboxAgendaItems } from '../lib/inboxRequests';
import {
  claimDailyLoginStreak,
  hasStreakBeenShown,
  markStreakShown,
  markStreakModalShownToday,
  streakRewardClaimable,
  wasStreakModalShownToday,
  StreakResult,
} from '../lib/loginStreak';
import { useLeagueJoin, type LeagueJoinedEvent } from '../lib/useLeagueJoin';
import { playSession } from '../lib/playSession';
import { useFtueChecklist } from '../components/FtueChecklistCard';
import { useIsGuest } from '../components/GuestUpgradeBanner';
import { useDuprImportOffer } from '../components/DuprImportBanner';
import CourtCheckinCard, { type CourtCardMode } from '../components/CourtCheckinCard';
import ClosestUnlocksCard from '../components/ClosestUnlocksCard';
import { EMPTY_HOME, HOME_KEY, loadHome, type HomeData } from '../components/home/homeData';
import HomeGreeting from '../components/home/HomeGreeting';
import GetStartedPanel from '../components/home/GetStartedPanel';
import NowPanel from '../components/home/NowPanel';
import UpNextSection from '../components/home/UpNextSection';
import LeagueSpotlight, { useLeagueSpotlight } from '../components/home/LeagueSpotlight';
import JoinLeagueSection from '../components/home/JoinLeagueSection';
import JoinCodeModal from '../components/home/JoinCodeModal';
import QuickRow, { type QuickTarget } from '../components/home/QuickRow';
import OpenNearYouSection, { type OpenItem } from '../components/home/OpenNearYouSection';
import StreakBonusModal from '../components/home/StreakBonusModal';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

/** Pop-ups Home may raise on its own. Queued: never two RN Modals at once. */
type QueuedModal = { kind: 'welcome'; balance: number } | { kind: 'streak'; result: StreakResult };

const JOIN_ROWS = 3;
const OPEN_ROWS = 3;
/** The modal handoff pause: longer than RN Modal's ~300ms fade-out. */
const HANDOFF_MS = 350;
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
const METERS_PER_MILE = 1609.344;

function milesLabel(m: number): string {
  const mi = m / METERS_PER_MILE;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

export default function HomeScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const focused = useIsFocused();

  const query = useCachedQuery<HomeData>(HOME_KEY, loadHome, {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  // Spread over EMPTY_HOME: whatever the cache holds, every field exists.
  const data: HomeData = useMemo(() => ({ ...EMPTY_HOME, ...(query.data ?? {}) }), [query.data]);
  const { profile, myLeagues, myTournaments } = data;
  const loadFailed = query.error != null && query.data === undefined;
  const firstLoad = query.loading && query.data === undefined;

  const reload = useCallback(() => query.refresh(), [query.refresh]);
  // "now" for the time labels: re-read on every focus and every new payload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [query.data]);
  useFocusEffect(useCallback(() => {
    setNow(Date.now());
    void reload();
  }, [reload]));

  // YOUR LEAGUES: the chosen league and its standings (loaded apart from the
  // payload above, for that league only). Pull-to-refresh reloads both; focus
  // revalidates the table under its TTL.
  const spotlight = useLeagueSpotlight(myLeagues, profile?.id ?? null, now);
  const { revalidate: revalidateSpotlight, refresh: refreshSpotlight } = spotlight;
  useFocusEffect(useCallback(() => { void revalidateSpotlight(); }, [revalidateSpotlight]));
  const pullReload = useCallback(async () => {
    await Promise.all([reload(), refreshSpotlight()]);
  }, [reload, refreshSpotlight]);
  const refresh = useRefresh(pullReload);

  // Local patches (welcome pickles, FTUE claim, dismissed drill reminder) write
  // through the cache so the next revalidation doesn't clobber them mid-flight.
  // Built from the LIVE cache entry, not this render's query.data: callers (the
  // FTUE claim, the drill dismiss) reach here after an await, and a reload that
  // landed meanwhile would otherwise be overwritten by the older snapshot (and
  // setQueryData restamps it as fresh for the whole TTL).
  function patchHome(fn: (d: HomeData) => HomeData) {
    setQueryData(HOME_KEY, fn({ ...EMPTY_HOME, ...(peekQuery<HomeData>(HOME_KEY) ?? {}) }));
  }

  // A grant / join usually lands while loadHome's request is still in flight,
  // and cachedFetch dedupes a concurrent refresh onto that already-running
  // request (queryCache.ts: `const running = inflight.get(key); if (running)
  // return running`), above the TTL logic, so refresh()'s ttlMs:0 can't bypass
  // it. One reload() would resolve with the PRE-grant data and cache it (a new
  // account used to show 🥒 0 until another screen forced a fetch). Drain the
  // in-flight request first, then force a genuinely fresh one. A refetch, not a
  // patch: the RPCs report what they granted, not the new total, so patching
  // could double-count.
  const reloadFresh = useCallback(async () => {
    try { await reload(); } catch { /* joins the in-flight fetch; the retry covers it */ }
    try { await reload(); } catch { /* offline — focus revalidation catches up */ }
  }, [reload]);

  // ── Analytics ──
  const tap = useCallback((section: HomeSection, target: string, position?: number) => {
    trackHomeTap({ section, target, position });
  }, []);

  // ── Modal queue ──
  // Welcome pickles (first launch only: the RPC grants once per account) and
  // the streak reward (only when today's reward was just claimed, once per user
  // per day) wait their turn; a user-opened sheet (Enter code, the league
  // picker) holds them back; and nothing pops while Home isn't the focused
  // screen, because an RN Modal draws over whatever is on top.
  //
  // Handoff: iOS won't present a Modal while another presentation is still
  // dismissing; it drops the second one silently and the visible prop never
  // changes, so it never retries (PlayerModerationMenu waits 350ms for the
  // same reason). So the next pop-up never goes visible in the commit that
  // hides the previous one: closing a pop-up or one of the sheets holds the
  // queue for HANDOFF_MS (longer than RN's ~300ms fade), and so does gaining
  // focus (a screen presented modally on top may still be dismissing). Harmless
  // on Android and web, where it is only a short pause.
  const [queue, setQueue] = useState<QueuedModal[]>([]);
  const [codeOpen, setCodeOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [handoffHeld, setHandoffHeld] = useState(false);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdHandoff = useCallback(() => {
    setHandoffHeld(true);
    if (handoffTimer.current) clearTimeout(handoffTimer.current);
    handoffTimer.current = setTimeout(() => setHandoffHeld(false), HANDOFF_MS);
  }, []);
  useEffect(() => () => { if (handoffTimer.current) clearTimeout(handoffTimer.current); }, []);
  const [focusSettled, setFocusSettled] = useState(false);
  useEffect(() => {
    if (!focused) { setFocusSettled(false); return; }
    const timer = setTimeout(() => setFocusSettled(true), HANDOFF_MS);
    return () => clearTimeout(timer);
  }, [focused]);

  const activeModal = focused && focusSettled && !handoffHeld && !codeOpen && !pickerOpen ? queue[0] ?? null : null;
  // The pop-up on screen right now (one commit behind, which is enough: a
  // queued one only appears after a HANDOFF_MS pause anyway).
  const shownRef = useRef<QueuedModal | null>(null);
  useEffect(() => { shownRef.current = activeModal; }, [activeModal]);
  const enqueue = useCallback((m: QueuedModal) => {
    setQueue(q => {
      if (m.kind !== 'welcome') return [...q, m];
      // Welcome goes first (it explains the balance the streak adds to), but
      // never in front of a pop-up already on screen: swapping a visible Modal
      // for another in one commit is the iOS drop described above.
      return q.length > 0 && q[0] === shownRef.current ? [q[0], m, ...q.slice(1)] : [m, ...q];
    });
  }, []);
  const closeModal = useCallback(() => {
    holdHandoff();
    setQueue(q => q.slice(1));
    // Dismissing is the moment the header becomes visible and worth being
    // right; also the fallback if the grant's own refetch was still in flight.
    void reload();
  }, [reload, holdHandoff]);
  // Sheets the user opened hold the queue while up, and hand off like a pop-up
  // when they close (same commit as the close, so nothing slips through).
  const closeCodeSheet = useCallback(() => { holdHandoff(); setCodeOpen(false); }, [holdHandoff]);
  const onPickerOpenChange = useCallback((open: boolean) => {
    if (!open) holdHandoff();
    setPickerOpen(open);
  }, [holdHandoff]);

  // "Shown today" is recorded when the streak pop-up is actually on screen,
  // not when it is queued: one that never got to show (a dropped present, the
  // app closed while it waited) can still show later today.
  const streakMarkedFor = useRef<StreakResult | null>(null);
  useEffect(() => {
    const r = activeModal?.kind === 'streak' ? activeModal.result : null;
    if (!r || streakMarkedFor.current === r) return;
    streakMarkedFor.current = r;
    void currentUserId(supabase).then(uid => { if (uid) void markStreakModalShownToday(uid); }).catch(() => {});
  }, [activeModal]);

  // Streak count straight from the claim, until the reload brings it in.
  const [claimedStreak, setClaimedStreak] = useState<number | null>(null);
  // The session's streak result, kept so tapping 🔥 can reopen the pop-up.
  const streakResultRef = useRef<StreakResult | null>(null);

  async function claimWelcomePicklesOnce() {
    const { data: rpc, error } = await supabase.rpc('claim_welcome_pickles');
    if (error) return;
    const row = Array.isArray(rpc) ? rpc[0] : rpc;
    if (row?.granted) {
      enqueue({ kind: 'welcome', balance: row.new_balance ?? 1000 });
      void reloadFresh();
    }
  }

  async function claimStreakOncePerSession() {
    const uid = await currentUserId(supabase);
    if (!uid) return;
    if (hasStreakBeenShown(uid)) return;
    markStreakShown(uid);
    // Claimed every session (day-idempotent RPC), so the streak and its daily
    // pickles are credited even on days the modal stays shut.
    const result = await claimDailyLoginStreak();
    if (!result) return;
    streakResultRef.current = result;
    setClaimedStreak(result.streak_after);
    if (result.claimed_today) void reloadFresh();
    if (!streakRewardClaimable(result)) return;
    if (await wasStreakModalShownToday(uid)) return;
    // Marked shown once it is on screen (the effect above), not here.
    enqueue({ kind: 'streak', result });
  }

  // Tapping 🔥 reopens the streak pop-up (streak, stats, milestone road map).
  // Reuses this session's result; otherwise asks the day-idempotent claim RPC,
  // which only returns today's state once the reward has been credited.
  async function openStreak() {
    const result = streakResultRef.current ?? (await claimDailyLoginStreak());
    if (!result) return;
    streakResultRef.current = result;
    enqueue({ kind: 'streak', result });
  }

  // Both run on Home's FIRST FOCUS, not on mount: the linking config's
  // initialRouteName mounts Home underneath a cold deep link (/leagues/:id,
  // /events/:id, a universal link), and an RN Modal renders over whatever
  // screen is on top, so a mount-time pop-up would cover the screen the link
  // opened. They wait until the user actually lands on Home.
  const greetedRef = useRef(false);
  useFocusEffect(useCallback(() => {
    if (greetedRef.current) return;
    greetedRef.current = true;
    void claimWelcomePicklesOnce();
    void claimStreakOncePerSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, like the mount effects it replaces
  }, []));

  // ── Joining (JOIN A LEAGUE) ──
  const leagueJoin = useLeagueJoin({
    status: { clear() {}, error: toast.error, success: toast.success },
    onJoined: async (e: LeagueJoinedEvent) => {
      // The league just joined is the one YOUR LEAGUES shows (and remembers).
      if (e.via === 'join') spotlight.select(e.leagueId);
      else if (e.scopeType === 'league' && e.scopeId) spotlight.select(e.scopeId);
      // Awaited by the hook while the row stays busy, so it doesn't flash
      // back to [Join] before the league moves into YOUR LEAGUES.
      await reloadFresh();
    },
    onRequested: () => reloadFresh(),
    onWithdrawn: () => reloadFresh(),
  });

  // ── Starter quests + offers (Get started) ──
  const ftue = useFtueChecklist({
    profile,
    navigation,
    inLeague: query.data ? data.inLeague : undefined,
    onClaimed: (newBalance) => patchHome(d => ({
      ...d,
      profile: d.profile ? { ...d.profile, pickles: newBalance } : d.profile,
    })),
  });
  const isGuest = useIsGuest();
  const dupr = useDuprImportOffer();
  const getStartedVisible = !ftue.loading && (!ftue.allClaimed || isGuest || dupr.visible);
  const accountIsNew = profile?.created_at ? now - Date.parse(profile.created_at) < NEW_ACCOUNT_MS : false;

  // ── NOW ──
  const [courtMode, setCourtMode] = useState<CourtCardMode>('idle');
  const live = playSession.useLiveSession();
  const session = live.status !== 'idle' && live.meta
    ? { label: live.meta.label ?? 'Playing', venueName: live.meta.venueName ?? null }
    : null;

  const privilegedLeagues = useMemo(
    () => myLeagues.filter(l => l.role === 'admin' || l.role === 'co-admin').map(l => ({ id: l.id, name: l.name })),
    [myLeagues],
  );

  // ── Agenda ──
  const agendaItems: AgendaItem[] = useMemo(() => [
    ...eventAgendaItems(data.events, now),
    ...tournamentAgendaItems(myTournaments, now),
    // This week's sessions by stage; a payload cached before `drills` has today's.
    ...drillAgendaItems(data.drills ?? data.drillsToday, now),
    ...inboxAgendaItems(data.inbox, profile?.id ?? null, privilegedLeagues, now),
  ], [data.events, data.drills, data.drillsToday, data.inbox, myTournaments, profile?.id, privilegedLeagues, now]);
  // The bell's number. Counted before NOW takes the live events out of UP
  // NEXT: an RSVP still open on a live event still needs you.
  const needYou = useMemo(() => needsYouCount(agendaItems, now), [agendaItems, now]);
  // A live league event shows in NOW, so UP NEXT leaves it out.
  const liveEvents = useMemo(
    () => buildAgenda(agendaItems, now, { cap: Infinity }).rows.filter(r => r.bucket === 'live' && r.kind === 'event'),
    [agendaItems, now],
  );
  const agenda = useMemo(() => {
    const liveKeys = new Set(liveEvents.map(r => r.key));
    return buildAgenda(agendaItems.filter(i => !liveKeys.has(i.key)), now);
  }, [agendaItems, liveEvents, now]);
  const nowActive = courtMode !== 'idle' || !!session || liveEvents.length > 0;

  const isMember = myLeagues.length > 0;

  // ── Location: status only; coords only when already granted ──
  const [locGranted, setLocGranted] = useState(false);
  useFocusEffect(useCallback(() => {
    let on = true;
    void getForegroundLocationStatus().then(s => { if (on) setLocGranted(s === 'granted'); }).catch(() => {});
    return () => { on = false; };
  }, []));
  const { coords: rawCoords } = useCoords({ enabled: locGranted });
  const coords = locGranted ? rawCoords : null;
  const distanceTo = useCallback((lat: number | null, lng: number | null): number | null => {
    if (!coords || lat == null || lng == null) return null;
    return distanceMeters({ lat: coords.lat, lng: coords.lng }, { lat, lng });
  }, [coords]);

  // JOIN A LEAGUE: nearest first when we may know where you are; otherwise
  // open leagues before private ones, the busiest first.
  const joinLeagues = useMemo(() => {
    const rows = data.openLeagues.map(l => ({ l, d: distanceTo(l.lat, l.lng) }));
    rows.sort((a, b) => {
      if (a.d != null || b.d != null) return (a.d ?? Infinity) - (b.d ?? Infinity);
      const ao = a.l.is_open === false ? 1 : 0;
      const bo = b.l.is_open === false ? 1 : 0;
      return ao - bo || b.l.memberCount - a.l.memberCount;
    });
    return rows.slice(0, JOIN_ROWS);
  }, [data.openLeagues, distanceTo]);
  const joinDistances = useMemo(
    () => new Map(joinLeagues.filter(r => r.d != null).map(r => [r.l.id, milesLabel(r.d!)])),
    [joinLeagues],
  );

  // OPEN NEAR YOU (members): open tournaments, then joinable leagues; nearest
  // first when location is granted. Keeps the uncapped total for "See all (N)".
  const openItems: { rows: OpenItem[]; total: number } = useMemo(() => {
    const items: (OpenItem & { d: number | null })[] = [
      ...data.openTournaments.map(tr => {
        const d = distanceTo(tr.lat, tr.lng);
        return { kind: 'tournament' as const, key: `t-${tr.id}`, tournament: tr, distance: d != null ? milesLabel(d) : null, d };
      }),
      ...data.openLeagues.map(l => {
        const d = distanceTo(l.lat, l.lng);
        return { kind: 'league' as const, key: `l-${l.id}`, league: l, distance: d != null ? milesLabel(d) : null, d };
      }),
    ];
    if (coords) items.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
    return { rows: items.slice(0, OPEN_ROWS), total: items.length };
  }, [data.openTournaments, data.openLeagues, distanceTo, coords]);

  // ── Navigation helpers ──
  const go = useCallback((target: AgendaTarget) => {
    switch (target.screen) {
      case 'EventDetail': navigation.navigate('EventDetail', target.params); break;
      case 'TournamentDetail': navigation.navigate('TournamentDetail', target.params); break;
      case 'DrillRequests': navigation.navigate('DrillRequests', target.params); break;
      case 'MatchHistory': navigation.navigate('MatchHistory', target.params); break;
      case 'LeagueMembers': navigation.navigate('LeagueMembers', target.params); break;
      case 'Friends': navigation.navigate('Friends', target.params); break;
    }
  }, [navigation]);
  const openLeague = (l: { id: string; name: string }) =>
    navigation.navigate('LeagueDetail', { leagueId: l.id, leagueName: l.name });

  async function dismissDrill(sessionId: string) {
    const uid = await currentUserId(supabase);
    if (!uid) return;
    patchHome(d => ({
      ...d,
      drillsToday: d.drillsToday.filter(s => s.id !== sessionId),
      ...(d.drills ? { drills: d.drills.filter(s => s.id !== sessionId) } : {}),
    }));
    try {
      // Append to the dismissed list without clobbering the partner's entry.
      const row = await sbCall(() => supabase
        .from('drill_sessions')
        .select('reminder_dismissed_by')
        .eq('id', sessionId)
        .single());
      const prev = ((row as { reminder_dismissed_by?: string[] } | null)?.reminder_dismissed_by ?? []);
      const next = Array.from(new Set([...prev, uid]));
      await sbCall(() => supabase.from('drill_sessions').update({ reminder_dismissed_by: next }).eq('id', sessionId));
    } catch (e) {
      // Couldn't persist the dismissal — the row returns on the next load.
      toast.error(friendlySbMessage(e, "Couldn't hide that drill just now."));
    }
  }

  /** Up next's inline [Confirm] on a locked-in drill (court + time): the
   *  same RPC as the drill screen and the lock-screen button ('on_my_way' is
   *  the stored value behind Confirm). Throws so the row can roll back its
   *  optimistic "✓ Confirmed"; the error toast is here. */
  async function confirmDrill(sessionId: string) {
    try {
      // Idempotent: the RPC returns 'already' for a repeat answer.
      await sbCall(() => supabase.rpc('rsvp_drill_session', { p_session: sessionId, p_status: 'on_my_way' }), { retries: 1, timeoutMs: 9_000 });
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't confirm that drill. Tap Confirm to try again."));
      throw e;
    }
    void reloadFresh();
  }

  function onQuick(target: QuickTarget, position: number) {
    tap('quick', target, position);
    switch (target) {
      case 'record': navigation.navigate('MatchEntry', { fromHome: true }); break;
      case 'play': navigation.navigate('Play'); break;
      case 'drill': navigation.navigate('Drill'); break;
      case 'shop': navigation.navigate('Shop'); break;
      case 'wagers': navigation.navigate('MyWagers'); break;
      // Defaults to this user's own matches, matching where a tapped match push
      // lands (resolvePushTarget in lib/push).
      case 'history': navigation.navigate('MatchHistory', { title: 'Match History', initialMyMatchesOnly: true }); break;
    }
  }

  // ── Sections (keyed: see the file header) ──
  const sections: React.ReactElement[] = [];

  sections.push(
    <HomeGreeting
      key="greeting"
      profile={profile}
      streak={claimedStreak ?? data.streak}
      onProfile={() => { tap('greeting', 'profile'); navigation.navigate('Profile', {}); }}
      onShop={() => { tap('greeting', 'shop'); navigation.navigate('Shop'); }}
      onStreak={() => { tap('greeting', 'streak'); void openStreak(); }}
    />,
  );

  if (nowActive) sections.push(<SectionHeader key="now-header" title="Now" style={styles.tightHeader} />);

  const court = (
    <CourtCheckinCard
      key="court"
      onModeChange={setCourtMode}
      onTap={(target) => tap(courtMode === 'idle' ? 'court' : 'now', target)}
    />
  );
  if (courtMode !== 'idle') sections.push(court);

  if (session || liveEvents.length > 0) {
    sections.push(
      <NowPanel
        key="now-panel"
        session={session}
        liveEvents={liveEvents}
        now={now}
        emphasis={courtMode === 'idle'}
        onEnterScore={() => { tap('now', 'enter_score'); navigation.navigate('MatchEntry', { fromHome: true }); }}
        onEvent={(row, i) => { tap('now', 'live_event', i); go(row.target); }}
      />,
    );
  }

  if (getStartedVisible) {
    sections.push(
      <GetStartedPanel
        key="get-started"
        ftue={ftue}
        isGuest={isGuest}
        dupr={dupr}
        defaultOpen={accountIsNew}
        emphasis={!nowActive}
        onToggle={(open) => {
          tap('get_started', open ? 'expand' : 'collapse');
          trackSectionToggle({ screen: 'Home', section: 'get_started', open });
        }}
        onTap={(target, position) => tap('get_started', target, position)}
      />,
    );
  }

  if (loadFailed) {
    // Only true once a fetch has failed with nothing cached: say so plainly
    // and offer a retry, instead of claiming you have nothing going on.
    sections.push(
      <View key="load-failed" style={[styles.failed, { backgroundColor: c.surface, borderColor: c.border }]}>
        <EmptyState
          compact
          icon="📡"
          title="Couldn't load your leagues"
          subtitle={friendlySbMessage(query.error)}
          actionLabel="Retry"
          onAction={() => { void reload(); }}
        />
      </View>,
    );
  } else if (firstLoad) {
    sections.push(<SkeletonList key="skeleton" rows={4} variant="row" />);
  } else {
    if (agenda.total > 0 || isMember) {
      sections.push(
        <UpNextSection
          key="up-next"
          agenda={agenda}
          now={now}
          privilegedLeagues={privilegedLeagues}
          navigate={go}
          onProposePlayDay={(leagueId) => navigation.navigate('CreateEvent', { leagueId })}
          onDismissDrill={(id) => { void dismissDrill(id); }}
          onConfirmDrill={confirmDrill}
          onTap={(target, position) => tap('up_next', target, position)}
          onPickerOpenChange={onPickerOpenChange}
          onSeeAll={(requests) => navigation.navigate('Notifications', requests ? { initialChip: 'requests' } : undefined)}
        />,
      );
    }

    if (isMember || myTournaments.length > 0) {
      // Not in a league, only the "My tournaments" link renders (above JOIN).
      sections.push(
        <LeagueSpotlight
          key="spotlight"
          leagues={myLeagues}
          spotlight={spotlight}
          tournamentCount={myTournaments.length}
          now={now}
          onSelect={(_id, i) => tap('spotlight', 'league_chip', i)}
          onHeader={(l) => { tap('spotlight', 'header'); openLeague(l); }}
          onRow={(row) => {
            tap('spotlight', 'row', row.rank - 1);
            if (row.isMe) navigation.navigate('Profile', {});
            else navigation.navigate('PlayerProfile', { userId: row.userId, userName: row.name || 'Player' });
          }}
          onSeeAll={(l, d) => {
            tap('spotlight', 'see_all');
            // Real standings page through the full table; a by-PLUPR list
            // through the members (as LeagueDetail's Standings section does).
            const ranked = d.kind === 'live' || d.kind === 'locked' || d.kind === 'final';
            if (ranked && d.seasonId) {
              navigation.navigate('SeasonStandings', { seasonId: d.seasonId, leagueId: l.id, leagueName: l.name });
            } else {
              navigation.navigate('LeagueMembers', { leagueId: l.id, leagueName: l.name });
            }
          }}
          onNext={(target) => { tap('spotlight', 'next'); go(target); }}
          onStartSeason={(l) => { tap('spotlight', 'start_season'); openLeague(l); }}
          onAllLeagues={() => { tap('spotlight', 'all_leagues'); navigation.navigate('Play', { initialTab: 'leagues', mine: true }); }}
          onMyTournaments={() => { tap('spotlight', 'my_tournaments'); navigation.navigate('Play', { initialTab: 'tournaments', mine: true }); }}
        />,
      );
    }

    if (!isMember) {
      sections.push(
        <JoinLeagueSection
          key="join"
          leagues={joinLeagues.map(r => r.l)}
          leagueJoin={leagueJoin}
          distanceById={joinDistances}
          onEnterCode={() => { tap('join', 'enter_code'); setCodeOpen(true); }}
          onBrowse={() => { tap('join', 'browse'); navigation.navigate('Play', { initialTab: 'leagues' }); }}
          onLeague={(l, i) => { tap('join', 'row', i); openLeague(l); }}
          onJoinPressed={(kind, i) => tap('join', kind, i)}
        />,
      );
    }
  }

  sections.push(<QuickRow key="quick" showRecord={isMember} onPress={onQuick} />);

  if (courtMode === 'idle') sections.push(court);

  if (isMember && !loadFailed && !firstLoad && openItems.rows.length > 0) {
    sections.push(
      <OpenNearYouSection
        key="open"
        items={openItems.rows}
        total={openItems.total}
        totalIsFloor={data.openCapped}
        onSeeAll={() => { tap('open_near_you', 'see_all'); navigation.navigate('Play'); }}
        nearby={!!coords}
        now={now}
        onPress={(item, i) => {
          tap('open_near_you', item.kind, i);
          if (item.kind === 'league') openLeague(item.league);
          else navigation.navigate('TournamentDetail', { tournamentId: item.tournament.id, tournamentName: item.tournament.name });
        }}
      />,
    );
  }

  if (!getStartedVisible && !ftue.loading && profile) {
    sections.push(
      <ClosestUnlocksCard
        key="unlock"
        userId={profile.id}
        navigation={navigation}
        onPressed={() => tap('unlock', 'unlock_progress')}
      />,
    );
  }

  const welcome = activeModal?.kind === 'welcome' ? activeModal : null;
  const streakModal = activeModal?.kind === 'streak' ? activeModal : null;

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <AppTopBar
        title="PICKLEAGUE"
        style={[styles.topBar, { backgroundColor: c.bg, borderBottomColor: c.border }]}
        // The app's web column is 720 (AppNavigator's WebMaxWidth).
        contentStyle={styles.topBarContent}
        actions={[
          {
            key: 'saved',
            icon: <Text style={styles.savedGlyph}>🔖</Text>,
            caption: 'Saved',
            a11yLabel: 'Saved',
            onPress: () => { tap('top_bar', 'saved'); navigation.navigate('Bookmarks'); },
          },
          {
            // The number is what needs you (votes, RSVPs, invites, requests,
            // scores to confirm), so its label says so: "Notifications, 2
            // need you". Plain unread is a dot ("Notifications, new").
            key: 'bell',
            icon: 'bell',
            badge: needYou > 0 ? needYou : data.unreadLive > 0 ? 'dot' : undefined,
            a11yLabel: 'Notifications',
            badgeA11yLabel: (n) => `Notifications, ${n} need${n === 1 ? 's' : ''} you`,
            onPress: () => { tap('top_bar', 'bell'); navigation.navigate('Notifications'); },
          },
          {
            key: 'settings',
            icon: 'gear',
            a11yLabel: 'Settings',
            onPress: () => { tap('top_bar', 'settings'); navigation.navigate('Settings'); },
          },
        ]}
      />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        refreshControl={<AppRefreshControl {...refresh} />}
      >
        {sections}
      </ScrollView>

      <JoinCodeModal
        visible={codeOpen}
        leagueJoin={leagueJoin}
        onClose={closeCodeSheet}
        onRedeemed={(r) => {
          // A completed redemption ('enter_code' only counts the sheet opening).
          tap('join', 'code_redeemed');
          closeCodeSheet();
          // A tournament code registers you there: open it. A league code's
          // league moves into YOUR LEAGUES on the reload the hook already runs.
          if (r.scopeType === 'tournament' && r.scopeId) {
            navigation.navigate('TournamentDetail', { tournamentId: r.scopeId, tournamentName: r.scopeName });
          }
        }}
      />

      <ConfirmModal
        visible={!!welcome}
        title="🥒 Welcome to Pickleague!"
        body={
          <View style={styles.welcomeBody}>
            <Text style={[t.body, styles.center]}>
              Here's <Text style={{ color: c.primary, fontWeight: FONT.weight.bold }}>1,000 pickles</Text> to get you started.
            </Text>
            <Text style={[t.sub, styles.center]}>
              Spend them in the Pickle Shop on premium avatars, cosmetic badges, or profile flair.
            </Text>
            <Text style={[t.title, styles.center, { color: c.primary }]}>
              Your balance: 🥒 {(welcome?.balance ?? 0).toLocaleString()}
            </Text>
          </View>
        }
        primaryLabel="Visit Shop"
        cancelLabel="Later"
        onConfirm={() => { closeModal(); navigation.navigate('Shop'); }}
        onClose={closeModal}
      />

      <StreakBonusModal visible={!!streakModal} result={streakModal?.result ?? null} onClose={closeModal} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  topBar: { borderBottomWidth: HAIRLINE },
  topBarContent: { maxWidth: 720 },
  savedGlyph: { fontSize: FONT.size.h2, lineHeight: FONT.size.h1 },
  content: {
    paddingHorizontal: SPACE.lg,
    paddingTop: SPACE.xs,
    paddingBottom: SPACE.xl,
    gap: SPACE.md,
  },
  // NOW's label sits right on its panel.
  tightHeader: { marginBottom: -SPACE.sm },
  failed: { borderWidth: HAIRLINE, borderRadius: RADIUS.lg },
  welcomeBody: { gap: SPACE.sm },
  center: { textAlign: 'center' },
});

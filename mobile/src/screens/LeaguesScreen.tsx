// Discover › Leagues (state/feed-discover-play-plan.md §4; was Play > Leagues).
// The same body is mounted by Discover's Leagues tab and, while Discover is
// off, by the Play tab and the standalone 'Leagues' route (FTUE "Join a
// league", the invite_code push), so all get the same list, anchors and
// Join-with-Code. With Discover on, 'Leagues' and 'Play' are aliases of it.
//
//   [Q] Search leagues, courts, admins      x     fixed chrome, outside the list
//   (chips ... only once Discover > 6 rows)  [Filters]
//   MINE  3                                       hidden at 0; never filtered, only searched
//   [🎾] Dinks              Admin  >
//   DISCOVER  1                     Most active v sort only above 6 rows
//   [🎾] Organized Pickle Pl...    [ Join ]       tour 'leagues/join'
//        + New league  ·  Enter code             only while the list fits one screen
//
// Create actions live in the header "+" (ActionSheet). Filters are saved per
// user (usePlayFilterState); search is not. The data rides on useCachedQuery
// and refreshes on focus, so a league joined elsewhere (Home, LeagueDetail's
// join card) is in MINE when you come back, without pull-to-refresh.
// The old region pills (lib/regions.ts, now deleted) are replaced by distance.
// In Discover (`areaLimited`) the shared search area above the tabs limits
// DISCOVER (a league with no home court location can't be placed, so it is
// left out); MINE never is. The sheet's Distance group goes (the area is the
// distance) and Nearest measures from the area's centre.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TextInput, Modal, ScrollView, Pressable,
  type LayoutChangeEvent, type ListRenderItemInfo,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import {
  ActionSheetModal,
  ErrorState,
  FilterSheet,
  SectionHeader,
  type ActionSheetAction,
  type ActiveFilterEntry,
  type FilterSheetGroup,
  ThemedSwitch,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { RADIUS, SPACE, SMALL_TEXT_MAX_SCALE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { LeagueWithStats, RootStackParamList } from '../types';
import { useCourtName } from '../lib/courtNickname';
import { localIsoDate, seasonDateFacts, seasonDatePart } from '../lib/seasonSummary';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { isGodmodeUserId, countActiveAdminLeagues } from '../lib/godmode';
import { useTheme } from '../lib/ThemeContext';
import { onTourStart, useTour } from '../lib/TourContext';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useLeagueJoin } from '../lib/useLeagueJoin';
import LeagueRow, { LeagueJoinButton } from '../components/LeagueRow';
import {
  LEAGUE_CHIPS,
  LEAGUE_CHIP_LABELS,
  LEAGUE_PERSIST_DEFAULTS,
  LEAGUE_PINNED_CHIPS,
  LEAGUE_SORT_LABELS,
  MINE_PREVIEW,
  MIN_PLAYER_OPTIONS,
  countLabel,
  countSheetFilters,
  distanceLabel,
  distanceMiles,
  leagueSortOptions,
  normalizeQuery,
  pagedCount,
  quickChipsVisible,
  sheetInEffect,
  sortVisible,
  splitLeagues,
  widerDistance,
} from '../lib/playFilters';
import PlayListChrome from '../components/play/PlayListChrome';
import DistanceFilterGroup from '../components/play/DistanceFilterGroup';
import { usePlayHeaderPlus } from '../components/play/HeaderPlusButton';
import { usePlayFilterState } from '../components/play/usePlayFilterState';
import { usePlayLocation } from '../components/play/usePlayLocation';
import { usePlayTour } from '../components/play/usePlayTour';
import { usePlayUserId } from '../components/play/usePlayUserId';
import { fixtureLeagues, isFixtureId, usePlayFixtureOn } from '../lib/__dev__/playFixture';
import { useSearchArea } from '../lib/useSearchArea';
import { searchAreaKey, widerSearchRadius } from '../lib/searchArea';
import { listLeaguePreviews, previewAsLeague, type LeaguePreview } from '../data/leaguePreview';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Leagues'>;
  route: RouteProp<RootStackParamList, 'Leagues'>;
  /** Embedded in Play: whether this tab is the one showing. The standalone
   *  route is always active. Gates the tour anchors and the header "+". */
  active?: boolean;
  /** Play's "All yours (N) >": each new value turns the Mine chip on for this
   *  visit only (never saved). */
  routeMineToken?: number;
  /** Play's toggle count (every league in the list). */
  onCount?: (n: number) => void;
  /** Discover's search area limits DISCOVER (not MINE). */
  areaLimited?: boolean;
};

/** A league row as Play shows it: the stats the list always loaded, plus
 *  whether I saved it and how active it was in the last 30 days. */
type PlayLeagueRow = LeagueWithStats & { saved: boolean; recentMatchCount: number };

type LeaguesData = {
  leagues: PlayLeagueRow[];
  godmode: boolean;
  /** null when the create-limit count failed (the screen keeps the last one). */
  activeAdminLeagueCount: number | null;
};

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

// Short month + day ("Nov 3") for an upcoming season's start date (a DATE).
function fmtShort(iso: string): string {
  return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The row's live facts after court and players, at most two: the season, a
 *  vote, an open tournament. Never "TBD" (content rule 3). A member sees the
 *  season's next date in the short form ("P7 locks Oct 20", "Ends Dec 1": the
 *  date part of LeagueDetail's status line, from the dates alone); Discover
 *  rows keep "In season". The season goes first so a 1-line subtitle that
 *  clips loses the vote flag, not the date. */
function leagueFacts(l: PlayLeagueRow, now: number): string[] {
  const facts: string[] = [];
  if (l.featuredSeasonStatus === 'active') {
    const next = l.myRole && l.featuredSeasonStart && l.featuredSeasonLockWeeks && l.featuredSeasonPeriods
      ? seasonDatePart(seasonDateFacts({
        start_date: l.featuredSeasonStart.slice(0, 10),
        end_date: l.featuredSeasonEnd,
        lock_frequency_weeks: l.featuredSeasonLockWeeks,
        total_periods: l.featuredSeasonPeriods,
      }, localIsoDate(new Date(now))), { now: new Date(now), compact: true })
      : null;
    facts.push(next ?? 'In season');
  }
  else if (l.featuredSeasonStatus === 'upcoming' && l.featuredSeasonStart) facts.push(`Season starts ${fmtShort(l.featuredSeasonStart)}`);
  if (l.openVoteCount > 0) facts.push('Vote open');
  if (l.openRegistrationTournamentCount > 0) facts.push('Tournament open');
  return facts.slice(0, 2);
}

async function loadLeaguesData(): Promise<LeaguesData> {
  // Identity is a LOCAL session read now, and godmode a local id check, so
  // neither costs a round trip. The admin-league count no longer waits on the
  // league list either — it only ever needed the user id.
  const uid = await currentUserId(supabase);

  const [tableRows, adminLeagueCount, previews] = await Promise.all([
    sbCall(() => supabase.from('leagues').select('*').eq('is_active', true).order('created_at', { ascending: false })),
    // Non-fatal on its own: countActiveAdminLeagues throws by design, but a
    // failed create-limit count must not blank the whole league list. The
    // screen keeps the last known count instead.
    uid ? countActiveAdminLeagues(uid).catch(() => null) : Promise.resolve(0),
    // Closed leagues I'm not in: their rows are members-only
    // (migration_closed_league_privacy.sql), so they come as previews (name,
    // member count, activity, a point rounded to about a mile) and still list
    // with "Request code". Soft: [] when signed out or before the RPC exists.
    uid ? listLeaguePreviews() : Promise.resolve([] as LeaguePreview[]),
  ]);

  const seenIds = new Set((tableRows ?? []).map((l) => l.id as string));
  const previewById = new Map(
    previews.filter((p) => p.is_active && !seenIds.has(p.id)).map((p) => [p.id, p] as const),
  );
  const leagueRows = [
    ...(tableRows ?? []),
    ...Array.from(previewById.values()).map((p) => previewAsLeague(p, { withPoint: true })),
  ];

  const ids = leagueRows.map((l) => l.id);
  if (ids.length === 0) return { leagues: [], godmode: isGodmodeUserId(uid), activeAdminLeagueCount: adminLeagueCount };

  // All parallel fetches
  const [memberRes, matchRes, myMemberRes, myRequestRes, seasonRes, tournamentRes, adminRes, eventRes, savedRes] = await Promise.all([
    // PostgREST caps a response at max_rows (1000), so these two can come back
    // truncated at scale. Member counts are a known limit (plan section 4:
    // precomputed in Phase 7).
    sbCall(() => supabase.from('league_members').select('league_id').in('league_id', ids)),
    // Newest first, so a truncated result drops the OLDEST matches: the
    // 30-day activity count behind the default "Most active" sort stays exact
    // while recent matches across all leagues are under the cap.
    sbCall(() => supabase.from('matches').select('league_id, played_at').in('league_id', ids).eq('status', 'completed').order('played_at', { ascending: false })),
    uid
      ? sbCall(() => supabase.from('league_members').select('league_id, role').eq('user_id', uid).in('league_id', ids))
      : Promise.resolve([]),
    uid
      ? sbCall(() => supabase.from('league_join_requests').select('league_id').eq('user_id', uid).eq('status', 'pending').in('league_id', ids))
      : Promise.resolve([]),
    sbCall(() => supabase.from('league_seasons')
      .select('league_id, status, baseline_plupr, start_date, end_date, lock_frequency_weeks, total_periods')
      .in('league_id', ids)
      .in('status', ['active', 'upcoming'])),
    sbCall(() => supabase.from('tournaments')
      .select('league_id, status, start_time')
      .in('league_id', ids)
      .in('status', ['registration', 'active'])),
    // League admins (creator is backfilled as admin): search covers admin names.
    sbCall(() => supabase.from('league_members')
      .select('league_id, user_id, profile:profiles(id, full_name)')
      .eq('role', 'admin')
      .in('league_id', ids)),
    // Open votes + scheduled events (we resolve scheduled slots' times below).
    sbCall(() => supabase.from('league_events')
      .select('id, league_id, status, vote_ends_at, confirmed_slot_id')
      .in('league_id', ids)
      .in('status', ['voting', 'scheduled'])),
    // My saved leagues (the Saved chip). RLS: bookmarks_select_own. Non-fatal:
    // a failed read leaves the chip at 0 rather than blanking the list.
    uid
      ? sbCall(() => supabase.from('bookmarks').select('target_id').eq('user_id', uid).eq('target_type', 'league')).catch(() => [])
      : Promise.resolve([]),
  ]);

  const memberRows     = (memberRes ?? []) as any[];
  const matchRows      = (matchRes ?? []) as any[];
  const myMembers      = (myMemberRes ?? []) as any[];
  const myRequests     = (myRequestRes ?? []) as any[];
  const seasonRows     = (seasonRes ?? []) as { league_id: string; status: string; baseline_plupr: number | null; start_date: string; end_date: string | null; lock_frequency_weeks: number | null; total_periods: number | null }[];
  const tournamentRows = (tournamentRes ?? []) as { league_id: string; status: string; start_time: string | null }[];
  const adminRows      = (adminRes ?? []) as any[];
  const eventRows      = (eventRes ?? []) as { id: string; league_id: string; status: string; vote_ends_at: string; confirmed_slot_id: string | null }[];
  const savedIds       = new Set(((savedRes ?? []) as { target_id: string }[]).map((b) => b.target_id));

  // One admin per league (first admin row). supabase may type the joined
  // profile as an array; handle either shape.
  const adminByLeague = new Map<string, { id: string; name: string }>();
  for (const a of adminRows) {
    const prof = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    if (!adminByLeague.has(a.league_id) && prof) {
      adminByLeague.set(a.league_id, { id: prof.id, name: prof.full_name });
    }
  }

  // Resolve the start times of scheduled events' confirmed slots.
  const slotIds = eventRows.map(e => e.confirmed_slot_id).filter(Boolean) as string[];
  const slotStartsById = new Map<string, string>();
  if (slotIds.length > 0) {
    const slotRows = await sbCall(() => supabase.from('event_slots').select('id, starts_at').in('id', slotIds));
    (slotRows ?? []).forEach((s: any) => slotStartsById.set(s.id, s.starts_at));
  }
  const nowMs = Date.now();

  const leagues: PlayLeagueRow[] = leagueRows.map((l) => {
    // A preview's roster and matches are not readable: its counts come with it.
    const preview    = previewById.get(l.id) ?? null;
    const members    = memberRows.filter((m) => m.league_id === l.id);
    const lMatches   = matchRows.filter((m) => m.league_id === l.id);
    const myMembership = myMembers.find((m: any) => m.league_id === l.id);
    const hasRequested = myRequests.some((r: any) => r.league_id === l.id);
    const distinctDays = new Set(lMatches.map((m) => (m.played_at as string).slice(0, 10))).size;
    const recentMatchCount = lMatches.filter((m) => nowMs - new Date(m.played_at).getTime() <= RECENT_MS).length;

    const leagueSeasons = seasonRows.filter(s => s.league_id === l.id);
    const myActiveSeasonsOnly = leagueSeasons.filter(s => s.status === 'active');
    // Use the most-recently-started active season's baseline for display.
    const currentSeason = myActiveSeasonsOnly
      .slice()
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0];

    // Featured season: prefer active (latest start), else upcoming (earliest
    // start). An upcoming one shows as a row fact ("Season starts Nov 3").
    const upcoming = leagueSeasons
      .filter(s => s.status === 'upcoming')
      .slice()
      .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))[0];
    const featuredSeason = currentSeason ?? upcoming ?? null;
    const featuredStatus: 'active' | 'upcoming' | null = featuredSeason
      ? (featuredSeason.status === 'active' ? 'active' : 'upcoming')
      : null;
    const lTournaments = tournamentRows.filter(t => t.league_id === l.id);
    const openRegistrationTournamentCount = lTournaments.filter(t => t.status === 'registration').length;
    const scheduledTournamentCount = lTournaments.filter(t =>
      t.status === 'active' && t.start_time != null && new Date(t.start_time).getTime() > nowMs).length;

    const lEvents = eventRows.filter(e => e.league_id === l.id);
    const openVoteCount = lEvents.filter(e =>
      e.status === 'voting' && new Date(e.vote_ends_at).getTime() > nowMs).length;
    const upcomingEventCount = lEvents.filter(e =>
      e.status === 'scheduled'
      && e.confirmed_slot_id
      && slotStartsById.has(e.confirmed_slot_id)
      && new Date(slotStartsById.get(e.confirmed_slot_id)!).getTime() > nowMs).length;
    const admin = adminByLeague.get(l.id) ?? null;

    return {
      ...l,
      is_open: l.is_open ?? true,
      memberCount: preview ? preview.member_count : members.length,
      matchCount: preview ? preview.match_count : lMatches.length,
      distinctPlayDays: preview ? preview.play_days : distinctDays,
      myRole: myMembership?.role ?? null,
      hasRequested,
      activeSeasonCount: myActiveSeasonsOnly.length,
      activeTournamentCount: lTournaments.length,
      openRegistrationTournamentCount,
      scheduledTournamentCount,
      upcomingEventCount,
      openVoteCount,
      adminId:   admin?.id ?? null,
      adminName: admin?.name ?? null,
      currentBaselinePlupr: currentSeason?.baseline_plupr != null ? Number(currentSeason.baseline_plupr) : null,
      featuredSeasonStatus: featuredStatus,
      featuredSeasonStart: featuredSeason?.start_date ?? null,
      featuredSeasonEnd:   featuredSeason?.end_date ?? null,
      featuredSeasonLockWeeks: featuredSeason?.lock_frequency_weeks ?? null,
      featuredSeasonPeriods: featuredSeason?.total_periods ?? null,
      saved: savedIds.has(l.id),
      recentMatchCount: preview ? preview.recent_match_count : recentMatchCount,
    };
  });

  return { leagues, godmode: isGodmodeUserId(uid), activeAdminLeagueCount: adminLeagueCount };
}

type Item =
  | { kind: 'mineHeader' }
  | { kind: 'discoverHeader' }
  | { kind: 'row'; section: 'mine' | 'discover'; league: PlayLeagueRow; last: boolean }
  | { kind: 'discoverEmpty' };

const itemKey = (it: Item) => (it.kind === 'row' ? `${it.section}:${it.league.id}` : it.kind);

/** Default height of the "+ New league · Enter code" footer (before it is measured). */
const CREATE_FOOTER_H = 44 + SPACE.sm;

export default function LeaguesScreen({ navigation, route, active = true, routeMineToken, onCount, areaLimited = false }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const courtName = useCourtName();
  const uid = usePlayUserId();
  const { coords, setCoords } = usePlayLocation();
  const { area: searchArea, ready: areaReady, setRadius: setAreaRadius } = useSearchArea();
  const area = areaLimited ? searchArea : null;
  // Until the area is known the list waits (no unlimited flash first).
  const areaPending = areaLimited && !areaReady;
  // Under a search area, distance (Nearest) is measured from its centre.
  const origin = areaLimited ? area?.center ?? null : coords;
  const fixtureOn = usePlayFixtureOn();

  // A tour start (first run or replay) closes the sheet and drops the chips
  // that could hide the first joinable row. Subscribed BEFORE usePlayTour:
  // effects run in declaration order, and its anchor registration can start
  // the tour synchronously (the seen flag already cached), so a later
  // subscription would miss that start. `current` is assigned further down,
  // in render, before any effect runs.
  const onTourStartRef = useRef(() => {});
  useEffect(() => onTourStart((key) => { if (key === 'leagues') onTourStartRef.current(); }), []);

  const tour = usePlayTour(active);
  // A start this list never heard (it fired before this instance mounted, e.g.
  // inside armTour off proxies another Leagues list left registered) still
  // gets the same prep once this list is the live one. Idempotent.
  const { activeTour } = useTour();
  useEffect(() => {
    if (activeTour === 'leagues' && tour.live) onTourStartRef.current();
  }, [activeTour, tour.live]);

  // ── Data ──────────────────────────────────────────────────────────────────
  const query = useCachedQuery<LeaguesData>('play:leagues:list', loadLeaguesData, {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  const reload = useCallback(() => query.refresh(), [query.refresh]);
  // Refresh on focus: a league joined on Home or LeagueDetail lands in MINE
  // when you come back, no pull-to-refresh needed.
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  const refresh = useRefresh(reload);

  // Dev-only scale fixture, added at render time (never cached).
  const allLeagues = useMemo<PlayLeagueRow[]>(() => {
    const real = query.data?.leagues ?? [];
    return fixtureOn ? [...real, ...fixtureLeagues()] : real;
  }, [query.data?.leagues, fixtureOn]);
  const loadFailed = query.error != null && query.data === undefined;

  // Per-account create limit; a failed count keeps the last known one.
  const adminCountRef = useRef(0);
  if (query.data?.activeAdminLeagueCount != null) adminCountRef.current = query.data.activeAdminLeagueCount;
  const godmode = query.data?.godmode ?? false;
  const atLeagueLimit = !godmode && adminCountRef.current >= 1;

  useEffect(() => { onCount?.(allLeagues.length); }, [allLeagues.length, onCount]);

  // ── Filters ───────────────────────────────────────────────────────────────
  const filters = usePlayFilterState({
    list: 'leagues',
    storageKey: uid ? `play:leagues:${uid}` : null,
    defaults: LEAGUE_PERSIST_DEFAULTS,
    routeMineToken,
  });
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searching = normalizeQuery(searchQuery) !== '';
  // What the chip row and the Filters count show: a saved radius without a
  // device location filters nothing, so it isn't shown as on. The sheet
  // itself still gets the raw values, so the saved radius survives an Apply.
  const sheetShown = useMemo(
    () => sheetInEffect(areaLimited ? { ...filters.sheet, distance: 'any' } : filters.sheet, coords),
    [filters.sheet, coords, areaLimited],
  );

  const split = useMemo(() => splitLeagues(allLeagues, {
    query: searchQuery,
    chips: filters.chips,
    sheet: filters.sheet,
    sort: filters.sort,
    coords,
    courtLabel: (raw) => courtName(raw),
    areaLimited,
    area,
  }), [allLeagues, searchQuery, filters.chips, filters.sheet, filters.sort, coords, courtName, areaLimited, area]);

  const [mineExpanded, setMineExpanded] = useState(false);
  const [pages, setPages] = useState(1);
  // A new search / filter / sort starts Discover from page 1.
  const filterSignature = `${searchQuery}|${filters.chips.join(',')}|${JSON.stringify(filters.sheet)}|${filters.sort}|${!!coords}|${searchAreaKey(area)}`;
  useEffect(() => { setPages(1); }, [filterSignature]);

  const shownDiscover = pagedCount(split.discover.length, pages);
  const discoverPage = split.discover.slice(0, shownDiscover);
  const radius = areaLimited ? null : distanceMiles(filters.sheet.distance);

  // ── Overlays (only one RN Modal at a time) ────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [showJoinCode, setShowJoinCode] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showLimitModal, setShowLimitModal] = useState(false);

  // Create modal state
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [isOpen, setIsOpen]           = useState(true);
  const [homeCourt, setHomeCourt]     = useState<CourtResult | null>(null);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating]       = useState(false);

  const status = useStatusMessage();

  // Join / request-a-code / redeem-a-code (shared with Home and LeagueJoinCard).
  // onJoined is awaited while the row stays busy, so it moves from DISCOVER
  // into MINE without flashing back to [Join].
  const leagueJoin = useLeagueJoin({
    status,
    onJoined: () => reload(),
    onRequested: () => reload(),
    onWithdrawn: () => reload(),
  });

  const openCreate = useCallback(() => {
    if (atLeagueLimit) setShowLimitModal(true);
    else setShowCreate(true);
  }, [atLeagueLimit]);

  // Header "+": New league / Enter code. Only the live list owns the header.
  usePlayHeaderPlus(navigation, tour.live, 'New league or enter a code', () => setPlusOpen(true));

  // Notification tap (or deep-link) can pre-populate an invite code and pop the
  // Join modal automatically. Consume the param so navigating back here later
  // doesn't keep re-opening the modal. (Play passes its own param through.)
  // With a sheet open, the Join modal opens from that sheet's onDismissed, once
  // it has fully closed: iOS won't present a second Modal while the first is
  // still animating out.
  const joinAfterCloseRef = useRef(false);
  const openJoinAfterClose = useCallback(() => {
    if (!joinAfterCloseRef.current) return;
    joinAfterCloseRef.current = false;
    setShowJoinCode(true);
  }, []);
  useEffect(() => {
    const code = route.params?.prefillInviteCode;
    if (!code) return;
    setInviteCode(code);
    const anyOpen = sheetOpen || plusOpen || sortOpen;
    setSheetOpen(false); setPlusOpen(false); setSortOpen(false);
    if (anyOpen) joinAfterCloseRef.current = true;
    else setShowJoinCode(true);
    navigation.setParams({ prefillInviteCode: undefined } as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.prefillInviteCode]);

  // The tour-start prep (subscribed at the top, see onTourStartRef).
  onTourStartRef.current = () => {
    setSheetOpen(false); setPlusOpen(false); setSortOpen(false);
    filters.clearChipsQuietly();
  };

  const clearAll = useCallback(() => {
    filters.clearFilters();
    setSearchText('');
    setSearchQuery('');
    tour.searchRef.current?.clear();
  }, [filters.clearFilters, tour.searchRef]);

  async function createLeague() {
    setCreateError('');
    if (atLeagueLimit) {
      setCreateError("You're already running an active league. Close it first or have an admin transfer ownership before starting another.");
      return;
    }
    if (!name.trim()) { setCreateError('Please enter a league name.'); return; }
    setCreating(true);
    try {
      // `user!.id` used to throw a raw TypeError here when the getUser() round
      // trip came back empty, stranding the "Creating…" flag.
      const me = await currentUserId(supabase);
      if (!me) { setCreateError('Please sign in again.'); return; }
      const newLeague = await sbCall(() => supabase.from('leagues').insert({
        name: name.trim(),
        description: description.trim() || null,
        created_by: me,
        is_open: isOpen,
        home_court:     homeCourt?.name ?? null,
        home_court_lat: homeCourt?.lat ?? null,
        home_court_lng: homeCourt?.lng ?? null,
        // A court from our catalog is stored by id (pins and pasted spots aren't).
        home_venue_id:  homeCourt?.catalogId ?? null,
      }).select().single()) as { id: string };

      // Auto-add creator as admin member
      await sbCall(() => supabase.from('league_members').insert({
        league_id: newLeague.id,
        user_id: me,
        role: 'admin',
      }));

      setShowCreate(false);
      setName(''); setDescription(''); setIsOpen(true); setHomeCourt(null); setCreateError('');
      void reload();
    } catch (e) {
      setCreateError(friendlySbMessage(e, 'Failed to create league.'));
    } finally {
      setCreating(false);
    }
  }

  async function joinWithCode() {
    const redeemed = await leagueJoin.redeemCode(inviteCode);
    if (!redeemed) return;
    setShowJoinCode(false);
    setInviteCode('');
  }

  // Cancel, Android back and the iOS swipe-down all close the same way, so a
  // reopened modal never shows the last attempt's code and red error.
  const closeJoinCode = () => {
    setShowJoinCode(false);
    setInviteCode('');
    leagueJoin.setError('');
  };

  // ── Rows ──────────────────────────────────────────────────────────────────
  // The first joinable open league in DISCOVER hosts the 'leagues/join' anchor.
  const firstJoinableId = useMemo(
    () => discoverPage.find((l) =>
      l.myRole == null && l.is_open !== false && !leagueJoin.joinedIds.has(l.id) && !isFixtureId(l.id))?.id ?? null,
    [discoverPage, leagueJoin.joinedIds],
  );

  const mineRows = searching || mineExpanded ? split.mine : split.mine.slice(0, MINE_PREVIEW);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (split.mine.length > 0) {
      out.push({ kind: 'mineHeader' });
      mineRows.forEach((l, i) => out.push({ kind: 'row', section: 'mine', league: l, last: i === mineRows.length - 1 }));
    }
    if (!split.hideDiscover) {
      if (discoverPage.length > 0) {
        out.push({ kind: 'discoverHeader' });
        discoverPage.forEach((l, i) => out.push({ kind: 'row', section: 'discover', league: l, last: i === discoverPage.length - 1 }));
      } else if (split.filtersOn && split.mine.length > 0) {
        // Discover is empty BECAUSE of a filter: say so, with the way out.
        out.push({ kind: 'discoverHeader' }, { kind: 'discoverEmpty' });
      }
    }
    return out;
  }, [split, mineRows, discoverPage]);

  const openLeague = (l: PlayLeagueRow) => {
    if (isFixtureId(l.id)) { status.error('Dev fixture row: it is not in the database.'); return; }
    navigation.navigate('LeagueDetail', { leagueId: l.id, leagueName: l.name });
  };

  function renderRow(l: PlayLeagueRow, section: 'mine' | 'discover') {
    const isMember = l.myRole != null;
    let action: React.ReactNode;
    // A pending request sits in MINE: its button reads "Requested · Withdraw".
    const pendingMine = section === 'mine' && !isMember && !!l.hasRequested && !isFixtureId(l.id);
    if (pendingMine) {
      action = (
        <LeagueJoinButton league={l} leagueJoin={leagueJoin} requested={l.hasRequested} requestLabel="Request code" />
      );
    } else if (section === 'discover' && !isMember) {
      action = isFixtureId(l.id) ? (
        <Button
          size="sm"
          variant={l.is_open === false ? 'outline' : 'primary'}
          title={l.is_open === false ? 'Request code' : 'Join'}
          onPress={() => status.error('Dev fixture row: joining is disabled.')}
        />
      ) : (
        <LeagueJoinButton
          league={l}
          leagueJoin={leagueJoin}
          requested={l.hasRequested}
          requestLabel="Request code"
          anchorRef={l.id === firstJoinableId ? tour.joinRef : undefined}
          onAnchorLayout={l.id === firstJoinableId ? tour.registerJoin : undefined}
        />
      );
    }
    return (
      <LeagueRow
        league={l}
        role={l.myRole}
        // The button says "Requested" itself (MINE and DISCOVER alike), so no
        // chip; a dev fixture row in MINE has no button and keeps the chip.
        requested={section === 'mine' && !isMember && !pendingMine && l.hasRequested}
        memberCount={l.memberCount}
        facts={leagueFacts(l, Date.now())}
        action={action}
        onPress={() => openLeague(l)}
      />
    );
  }

  const renderItem = ({ item }: ListRenderItemInfo<Item>) => {
    switch (item.kind) {
      case 'mineHeader': {
        const capped = !searching && split.mine.length > MINE_PREVIEW;
        return (
          <SectionHeader
            title="Mine"
            count={split.mine.length}
            style={S.firstHeader}
            action={capped
              ? mineExpanded
                ? { label: 'Show less', onPress: () => setMineExpanded(false) }
                : { label: `Show all (${split.mine.length})`, onPress: () => setMineExpanded(true), a11yLabel: `Show all ${split.mine.length} of your leagues` }
              : undefined}
          />
        );
      }
      case 'discoverHeader':
        return (
          <SectionHeader
            title="Discover"
            count={countLabel(shownDiscover, split.discover.length)}
            style={split.mine.length > 0 ? S.header : S.firstHeader}
            action={sortVisible(split.discover.length)
              ? {
                  label: LEAGUE_SORT_LABELS[split.sort],
                  trailingIconName: 'chevron-down',
                  onPress: () => setSortOpen(true),
                  a11yLabel: `Sort: ${LEAGUE_SORT_LABELS[split.sort]}. Change sort`,
                }
              : undefined}
          />
        );
      case 'discoverEmpty':
        return (
          <EmptyState
            compact
            iconName="search"
            title="No leagues match your filters."
            actionLabel="Clear filters"
            onAction={clearAll}
          />
        );
      case 'row':
        return renderRow(item.league, item.section);
    }
  };

  // ── "+ New league · Enter code" footer, only while the list fits ──────────
  const [viewportH, setViewportH] = useState(0);
  const [bodyH, setBodyH] = useState(0);
  const footerHRef = useRef(CREATE_FOOTER_H);
  const footerShownRef = useRef(false);
  const allPaged = shownDiscover >= split.discover.length;
  const fitsOneScreen = viewportH > 0 && allPaged && bodyH + footerHRef.current <= viewportH;
  footerShownRef.current = fitsOneScreen;

  const onListLayout = (e: LayoutChangeEvent) => setViewportH(e.nativeEvent.layout.height);
  // Content height WITHOUT the create footer, so showing it can't flip the
  // decision back (no flicker).
  const onContentSize = (_w: number, h: number) => setBodyH(h - (footerShownRef.current ? footerHRef.current : 0));

  const distanceEnd = radius != null && coords != null && allPaged && !split.hideDiscover && !loadFailed && allLeagues.length > 0;
  const wider = widerDistance(filters.sheet.distance);
  // The search area's end of the list: nothing more within it, and a wider radius.
  const areaEnd = area != null && allPaged && !split.hideDiscover && !loadFailed && items.length > 0;
  const widerArea = area ? widerSearchRadius(area.radiusMi) : null;

  const footer = (
    <View>
      {areaEnd && area ? (
        <EmptyState
          compact
          iconName="pin"
          title={split.discover.length > 0 ? `Nothing more within ${area.radiusMi} mi.` : `No other leagues within ${area.radiusMi} mi.`}
          actionLabel={widerArea ? `Widen to ${widerArea} mi` : undefined}
          onAction={widerArea ? () => setAreaRadius(widerArea) : undefined}
        />
      ) : null}
      {distanceEnd ? (
        <EmptyState
          compact
          iconName="pin"
          title={`Nothing more within ${radius} mi.`}
          actionLabel={wider ? `Widen to ${wider} mi` : undefined}
          onAction={wider ? () => filters.setSheetValue('distance', wider) : undefined}
        />
      ) : null}
      {fitsOneScreen ? (
        <View
          style={S.createFooter}
          onLayout={(e) => { footerHRef.current = e.nativeEvent.layout.height + SPACE.sm; }}
        >
          <Pressable onPress={openCreate} accessibilityRole="button" style={S.footerLink}>
            <Text style={[t.sub, S.footerLinkText]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>+ New league</Text>
          </Pressable>
          <Text style={[t.meta, { color: c.textMuted }]} accessibilityElementsHidden>·</Text>
          <Pressable onPress={() => setShowJoinCode(true)} accessibilityRole="button" style={S.footerLink}>
            <Text style={[t.sub, S.footerLinkText]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Enter code</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const emptyList = loadFailed ? (
    // A failed fetch must never read as "no leagues yet".
    <ErrorState
      iconName="offline"
      error={query.error}
      message={`Couldn't load leagues. ${friendlySbMessage(query.error)}`}
      retryLabel="Retry"
      onRetry={() => { void reload(); }}
    />
  ) : allLeagues.length === 0 ? (
    // The "+ New league · Enter code" footer below carries the actions.
    <EmptyState iconName="pickleball" title="No leagues yet" subtitle="Create one to get started!" />
  ) : area && !searching && !split.filtersOn ? (
    // Nothing near the search area (the area pills above change it).
    <EmptyState
      compact
      iconName="pin"
      title={`No leagues within ${area.radiusMi} mi.`}
      subtitle="Widen the search, or start one here."
      actionLabel={widerArea ? `Widen to ${widerArea} mi` : 'New league'}
      onAction={widerArea ? () => setAreaRadius(widerArea) : openCreate}
    />
  ) : (
    <EmptyState
      compact
      iconName="search"
      title={searching ? `No leagues match "${searchQuery.trim()}".` : 'No leagues match your filters.'}
      actionLabel="Clear filters"
      onAction={clearAll}
    />
  );

  // ── Sheet + sort + "+" ────────────────────────────────────────────────────
  const sheetGroups = useMemo<FilterSheetGroup[]>(() => ([
    {
      key: 'distance',
      title: 'Distance',
      kind: 'custom',
      render: (ctx) => <DistanceFilterGroup ctx={ctx} coords={coords} onCoords={setCoords} noun="leagues" />,
    },
    {
      key: 'private',
      title: 'Private leagues',
      kind: 'single',
      hint: 'Private leagues join by invite code. Tap Request code on one to ask its admins.',
      options: [{ value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide' }],
    },
    {
      key: 'min_players',
      title: 'Min players',
      kind: 'single',
      options: [{ value: 'any', label: 'Any' }, ...MIN_PLAYER_OPTIONS.map((o) => ({ value: o, label: `${o}+` }))],
    },
  ] as FilterSheetGroup[])
    // Under a search area the area is the distance: no second one here.
    .filter((g) => !(areaLimited && g.key === 'distance')), [coords, setCoords, areaLimited]);

  const formatSheetLabel = useCallback((e: ActiveFilterEntry) => {
    if (e.key === 'distance') return distanceLabel(e.value) ?? 'Distance';
    if (e.key === 'private') return e.value === 'hide' ? 'Hiding private' : 'Private';
    if (e.key === 'min_players') return e.value ? `${e.value}+ players` : 'Min players';
    return null;
  }, []);

  const sortActions = useMemo<ActionSheetAction[]>(() =>
    leagueSortOptions({ coords: origin, center: split.center }).map((k) => ({
      label: LEAGUE_SORT_LABELS[k],
      iconName: k === split.sort ? 'check-mark' : undefined,
      onPress: () => filters.setSort(k),
    })), [origin, split.center, split.sort, filters.setSort]);

  // A "+" action's follow-up Modal opens from the sheet's onDismissed, once
  // the sheet has fully closed: iOS won't present a second Modal while the
  // first is still animating out.
  const afterPlusRef = useRef<(() => void) | null>(null);
  const plusActions: ActionSheetAction[] = [
    { label: atLeagueLimit ? 'New league (limit reached)' : 'New league', iconName: 'plus', onPress: () => { afterPlusRef.current = openCreate; } },
    { label: 'Enter code', iconName: 'key', onPress: () => { afterPlusRef.current = () => setShowJoinCode(true); } },
  ];

  const chipOptions = LEAGUE_CHIPS.map((k) => ({ value: k, label: LEAGUE_CHIP_LABELS[k], count: split.chipCounts[k] }));

  return (
    <View style={S.container}>
      <PlayListChrome
        searchRef={tour.searchRef}
        query={searchText}
        onChangeQuery={setSearchText}
        onDebouncedQuery={setSearchQuery}
        placeholder="Search leagues, courts, admins"
        showChips={quickChipsVisible(split.discoverBase, split.filtersOn)}
        chipOptions={chipOptions}
        chips={filters.chips}
        onChangeChips={filters.setChips}
        pinnedKeys={LEAGUE_PINNED_CHIPS}
        sheetValues={sheetShown}
        sheetDefaults={filters.sheetDefaults}
        sheetGroups={sheetGroups}
        formatSheetLabel={formatSheetLabel}
        onRemoveSheetValue={filters.removeSheetValue}
        sheetCount={countSheetFilters(sheetShown, filters.sheetDefaults)}
        onOpenFilters={() => setSheetOpen(true)}
      />

      {(query.loading || areaPending) && !loadFailed ? (
        <View style={S.skeleton}><SkeletonList rows={6} variant="row" /></View>
      ) : (
        <FlatList
          ref={tour.listRef}
          data={items}
          keyExtractor={itemKey}
          renderItem={renderItem}
          onScroll={tour.onScroll}
          scrollEventThrottle={16}
          onLayout={onListLayout}
          onContentSizeChange={onContentSize}
          onEndReached={() => { if (!allPaged) setPages((p) => p + 1); }}
          onEndReachedThreshold={0.5}
          initialNumToRender={14}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={S.listContent}
          refreshControl={<AppRefreshControl {...refresh} />}
          ListHeaderComponent={status.value ? <StatusBanner status={status.value} style={S.banner} /> : null}
          ListEmptyComponent={emptyList}
          ListFooterComponent={footer}
        />
      )}

      <FilterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filter leagues"
        groups={sheetGroups}
        values={filters.sheet}
        defaults={filters.sheetDefaults}
        onApply={filters.applySheet}
        onDismissed={openJoinAfterClose}
      />

      <ActionSheetModal
        visible={sortOpen}
        title="Sort leagues"
        actions={sortActions}
        onClose={() => setSortOpen(false)}
        onDismissed={openJoinAfterClose}
      />

      <ActionSheetModal
        visible={plusOpen}
        actions={plusActions}
        onClose={() => setPlusOpen(false)}
        onDismissed={() => {
          const next = afterPlusRef.current;
          afterPlusRef.current = null;
          next?.();
          openJoinAfterClose();
        }}
      />

      {/* Join with Code modal */}
      <Modal visible={showJoinCode} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeJoinCode}>
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={[t.h1, S.modalTitle]}>Join with Invite Code</Text>
          <Text style={[t.bodySub, S.modalHint]}>
            Enter the invite code shared with you for a league or tournament. Codes look like{' '}
            <Text style={S.bold}>3F7A-B2C9-D1E4</Text>.
          </Text>
          <TextInput
            style={[S.input, S.codeInput]}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={c.textMuted}
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {leagueJoin.error ? (
            <View style={S.errorBox}>
              <Text style={[t.sub, S.errorText]}>{leagueJoin.error}</Text>
            </View>
          ) : null}
          <Button
            title={leagueJoin.joining ? 'Joining...' : 'Redeem Code'}
            onPress={() => { void joinWithCode(); }}
            disabled={leagueJoin.joining}
            style={S.submit}
          />
          <Pressable
            onPress={closeJoinCode}
            accessibilityRole="button"
            style={S.cancel}
          >
            <Text style={[t.sub, { color: c.textMuted }]}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </Modal>

      {/* Create modal */}
      <Modal visible={showCreate} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowCreate(false)}>
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={[t.h1, S.modalTitle]}>Create League</Text>

          <Text style={[t.sub, S.modalLabel]}>League Name</Text>
          <TextInput
            style={[S.input, webInputFontFloor(S.input)]}
            placeholder="e.g. Tuesday Night Rec"
            placeholderTextColor={c.textMuted}
            value={name}
            onChangeText={setName}
          />

          <Text style={[t.sub, S.modalLabel]}>Description (optional)</Text>
          <TextInput
            style={[S.input, S.multiline, webInputFontFloor(S.input)]}
            placeholder="Skill level, location, notes..."
            placeholderTextColor={c.textMuted}
            value={description}
            onChangeText={setDescription}
            multiline
          />

          <View style={S.toggleRow}>
            <View style={S.toggleText}>
              <Text style={[t.sub, S.toggleLabel]}>Open to join</Text>
              <Text style={t.hint}>
                {isOpen ? 'Anyone can join this league.' : 'Players must be invited.'}
              </Text>
            </View>
            <ThemedSwitch value={isOpen} onValueChange={setIsOpen} />
          </View>

          {/* Home court */}
          <Text style={[t.sub, S.modalLabel]}>Home Court</Text>
          <CourtPicker
            value={homeCourt}
            onSelect={setHomeCourt}
            showNoneOption
            active={showCreate}
            placeholder="Search for your home court..."
          />
          {!homeCourt && (
            <View style={S.courtWarning}>
              <Text style={[t.sub, { color: c.text }]}>
                Without a home court, every match entry will require a location to be entered manually.
              </Text>
            </View>
          )}

          {createError ? (
            <View style={S.errorBox}>
              <Text style={[t.sub, S.errorText]}>{createError}</Text>
            </View>
          ) : null}

          <Button
            title={creating ? 'Creating...' : 'Create League'}
            onPress={() => { void createLeague(); }}
            disabled={creating}
            style={S.submit}
          />

          <Pressable onPress={() => { setShowCreate(false); setCreateError(''); }} accessibilityRole="button" style={S.cancel}>
            <Text style={[t.sub, { color: c.textMuted }]}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </Modal>

      <ConfirmModal
        visible={showLimitModal}
        title="Active league limit reached"
        body="You're already running an active league. You can only be admin of one active league at a time. Close it first (or have an admin transfer ownership) before starting another."
        primaryLabel="OK"
        cancelLabel="Close"
        onConfirm={() => setShowLimitModal(false)}
        onClose={() => setShowLimitModal(false)}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    skeleton: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm },
    // No flexGrow: onContentSizeChange reports the content container's height,
    // and a grown container is never shorter than the viewport, so the
    // fits-one-screen check behind the create footer could never pass.
    listContent: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, paddingBottom: SPACE.xl },
    banner: { marginTop: SPACE.sm, marginBottom: SPACE.xs },
    firstHeader: { marginTop: SPACE.xs },
    header: { marginTop: SPACE.md },

    createFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, marginTop: SPACE.sm, minHeight: 44 },
    footerLink: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.sm, alignItems: 'center', justifyContent: 'center' },
    footerLinkText: { color: c.primary, fontWeight: FONT.weight.bold },

    // Join-with-code + create modals
    modal: { padding: SPACE.xl, flexGrow: 1, backgroundColor: c.surface },
    modalTitle: { marginBottom: SPACE.xl },
    modalHint: { marginBottom: SPACE.lg },
    bold: { fontWeight: FONT.weight.bold },
    modalLabel: { fontWeight: FONT.weight.semibold, marginBottom: SPACE.xs, marginTop: SPACE.lg },
    input: {
      borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md,
      // Web raises this to 16 at the input (webInputFontFloor): iOS Safari
      // zooms the page when an input under 16px gets focus.
      padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface,
    },
    multiline: { minHeight: 72, textAlignVertical: 'top' },
    codeInput: { fontSize: FONT.size.h2, fontWeight: FONT.weight.bold, textAlign: 'center', letterSpacing: 4, textTransform: 'uppercase' },
    toggleRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      marginTop: SPACE.lg, backgroundColor: c.surfaceAlt, padding: SPACE.md, borderRadius: RADIUS.md, minHeight: 56,
    },
    toggleText: { flex: 1, marginRight: SPACE.sm },
    toggleLabel: { fontWeight: FONT.weight.semibold, color: c.textSub },
    errorBox: { backgroundColor: c.dangerLight, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
    errorText: { color: c.danger, fontWeight: FONT.weight.semibold },
    courtWarning: {
      backgroundColor: c.warningLight, borderRadius: RADIUS.md, padding: SPACE.sm,
      marginTop: SPACE.sm, borderWidth: 1, borderColor: c.warning,
    },
    submit: { marginTop: SPACE.lg },
    cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: SPACE.sm },
  });
}

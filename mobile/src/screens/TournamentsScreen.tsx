// Play > Tournaments (plan section 4). The same body is mounted by the Play tab
// and by the standalone 'Tournaments' route (LeagueDetail -> Tournaments
// {leagueId}, which keeps its league-scoped list).
//
//   [Q] Search tournaments, courts, leagues  x     search covers EVERY status
//   MINE  2                                        invites first; hidden at 0
//   [🏆] Fall Open    Invited          Sat 9 AM >
//   OPEN FOR REGISTRATION  12          Starting soon v
//   [🏆] Oakland Classic                [ Register ]
//   IN PROGRESS  3
//   > ENDED  40 · incl. cancelled                    collapsed
//
// Today (0 tournaments): "No tournaments yet. Leagues run them. Browse leagues >"
// plus "+ New tournament" while the list fits one screen. Creating moved to
// the header "+". Filters are saved per user for Play's list; the
// league-scoped list keeps them in memory only, so a league page never
// inherits (or overwrites) your Play filters.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable, type LayoutChangeEvent, type ListRenderItemInfo } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import {
  ActionSheetModal,
  FilterSheet,
  SectionHeader,
  type ActionSheetAction,
  type ActiveFilterEntry,
  type FilterSheetGroup,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Tournament, RootStackParamList } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { TOTAL_CELLS } from '../lib/availability';
import { isGodmodeUserId, countActiveOwnedTournaments } from '../lib/godmode';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import ConfirmModal from '../components/ConfirmModal';
import TournamentRow from '../components/TournamentRow';
import {
  MINE_PREVIEW,
  TOURNAMENT_CHIPS,
  TOURNAMENT_CHIP_LABELS,
  TOURNAMENT_PERSIST_DEFAULTS,
  TOURNAMENT_PINNED_CHIPS,
  TOURNAMENT_SORT_LABELS,
  countLabel,
  countSheetFilters,
  distanceLabel,
  isInvite,
  normalizeQuery,
  pagedCount,
  quickChipsVisible,
  registrationOpen,
  sheetInEffect,
  sortVisible,
  splitTournaments,
  tournamentSortOptions,
  type TournamentCtx,
} from '../lib/playFilters';
import PlayListChrome from '../components/play/PlayListChrome';
import DistanceFilterGroup from '../components/play/DistanceFilterGroup';
import { usePlayHeaderPlus } from '../components/play/HeaderPlusButton';
import { usePlayFilterState } from '../components/play/usePlayFilterState';
import { usePlayLocation } from '../components/play/usePlayLocation';
import { usePlayUserId } from '../components/play/usePlayUserId';
import { fixtureTournaments, isFixtureId, usePlayFixtureOn } from '../lib/__dev__/playFixture';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Tournaments'>;
  route: RouteProp<RootStackParamList, 'Tournaments'>;
  /** Embedded in Play: whether this tab is the one showing (owns the header "+"). */
  active?: boolean;
  /** Play's "All yours (N) >": each new value turns the Mine chip on for this visit. */
  routeMineToken?: number;
  /** Play's toggle count (every tournament in the list). */
  onCount?: (n: number) => void;
  /** "Browse leagues >" in the empty state. Play switches its own tab; the
   *  standalone route opens Play on Leagues. */
  onBrowseLeagues?: () => void;
};

type MyReg = { status: 'pending' | 'approved' | 'rejected' | 'waitlisted'; role: string | null; invited_by: string | null };

// Everything one load() used to spray across six useStates. Bundling it lets the
// screen ride on useCachedQuery, which keeps the last good list on screen when a
// refresh fails instead of blanking to "No tournaments yet".
type TournamentsData = {
  tournaments: Tournament[];
  playerCounts: Record<string, number>;
  approvedCounts: Record<string, number>;
  myRegs: Record<string, MyReg>;
  myAvailability: boolean[];
  godmode: boolean;
  activeOwnedTournamentCount: number;
  // Added for Play's search / subtitle / "In my leagues". Optional: a cached
  // value written by an older build lacks them (tournaments:list:* is
  // persisted to disk).
  leagueNames?: Record<string, string>;
  myLeagueIds?: string[];
};

const EMPTY_DATA: TournamentsData = {
  tournaments: [], playerCounts: {}, approvedCounts: {}, myRegs: {},
  myAvailability: [], godmode: false, activeOwnedTournamentCount: 0,
};

type Section = 'mine' | 'open' | 'inProgress' | 'ended';
const SECTION_TITLES: Record<Section, string> = {
  mine: 'Mine',
  open: 'Open for registration',
  inProgress: 'In progress',
  ended: 'Ended',
};

type TItem =
  | { kind: 'header'; section: Section }
  | { kind: 'row'; section: Section; t: Tournament }
  | { kind: 'discoverEmpty' };

const itemKey = (it: TItem) => (it.kind === 'row' ? `${it.section}:${it.t.id}` : it.kind === 'header' ? `h:${it.section}` : it.kind);

const DAY = 86_400_000;

/** "Sat 9 AM" inside the coming week, else "Nov 2" (with the year when it
 *  isn't this year). Null without a start: never "TBD" (content rule 3). */
function startLabel(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms >= now - DAY / 2 && ms <= now + 6 * DAY) {
    const day = d.toLocaleDateString(undefined, { weekday: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
    return `${day} ${time}`;
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

const CREATE_FOOTER_H = 44 + SPACE.sm;

export default function TournamentsScreen({ navigation, route, active = true, routeMineToken, onCount, onBrowseLeagues }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const uid = usePlayUserId();
  const { coords, setCoords } = usePlayLocation();
  const fixtureOn = usePlayFixtureOn();
  const isFocused = useIsFocused();
  const live = isFocused && active;

  const { leagueId, leagueName } = route.params ?? {};
  const [showLimitModal, setShowLimitModal] = useState(false);

  const load = useCallback(async (): Promise<TournamentsData> => {
    // Local session read. getUser() is a network round trip that resolves to
    // null on bad WiFi — which used to demote a signed-in user to the
    // signed-out path and blank out their registrations.
    const me = await currentUserId(supabase);

    const [tData, profileRow, ownedCount, myLeagueRows] = await Promise.all([
      sbCall(() => {
        let q = supabase.from('tournaments').select('*').order('created_at', { ascending: false });
        if (leagueId) q = q.eq('league_id', leagueId);
        return q;
      }),
      me
        ? sbCall(() => supabase.from('profiles').select('availability').eq('id', me).single())
        : Promise.resolve(null),
      // Non-fatal on its own: countActiveOwnedTournaments throws by design, but
      // a failed create-limit count must not blank the whole tournament list.
      me ? countActiveOwnedTournaments(me).catch(() => 0) : Promise.resolve(0),
      // "In my leagues". Non-fatal: the chip just counts 0 without it.
      me
        ? sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', me)).catch(() => [])
        : Promise.resolve([]),
    ]);

    const tList = (tData ?? []) as Tournament[];
    const av = (profileRow as any)?.availability;

    const counts: Record<string, number> = {};
    const approvedOnly: Record<string, number> = {};
    const mine: Record<string, MyReg> = {};
    const leagueNames: Record<string, string> = {};

    if (tList.length > 0) {
      const ids = tList.map(x => x.id);
      const leagueIds = [...new Set(tList.map((x) => x.league_id).filter((x): x is string => !!x))];
      // Count approved members AND outstanding invites (status='pending' with
      // an inviter set) — both occupy a slot on the public roster.
      // Also pull THIS user's own row per tournament so the row can show
      // their registration chip.
      const [regs, mineRows, leagueRows] = await Promise.all([
        sbCall(() => supabase
          .from('tournament_registrations')
          .select('tournament_id, status, invited_by')
          .in('tournament_id', ids)
          .in('status', ['approved', 'pending'])),
        me
          ? sbCall(() => supabase
              .from('tournament_registrations')
              .select('tournament_id, status, role, invited_by')
              .in('tournament_id', ids)
              .eq('user_id', me))
          : Promise.resolve([] as any[]),
        // League names for search + the row subtitle (leagues: select using
        // (true)). Non-fatal: rows just omit the league.
        leagueIds.length > 0
          ? sbCall(() => supabase.from('leagues').select('id, name').in('id', leagueIds)).catch(() => [])
          : Promise.resolve([]),
      ]);
      (regs ?? []).forEach((r: any) => {
        if (r.status === 'approved' || (r.status === 'pending' && r.invited_by != null)) {
          counts[r.tournament_id] = (counts[r.tournament_id] ?? 0) + 1;
        }
        // Capacity (full → waitlist) is decided on APPROVED players only —
        // same rule as the DB waitlist trigger.
        if (r.status === 'approved') {
          approvedOnly[r.tournament_id] = (approvedOnly[r.tournament_id] ?? 0) + 1;
        }
      });
      (mineRows ?? []).forEach((r: any) => {
        mine[r.tournament_id] = { status: r.status, role: r.role ?? null, invited_by: r.invited_by ?? null };
      });
      ((leagueRows ?? []) as { id: string; name: string }[]).forEach((l) => { leagueNames[l.id] = l.name; });
    }

    return {
      tournaments: tList,
      playerCounts: counts,
      approvedCounts: approvedOnly,
      myRegs: mine,
      myAvailability: Array.isArray(av) && av.length === TOTAL_CELLS ? av : [],
      // Local id check instead of checkGodmode()'s getUser() round trip.
      godmode: isGodmodeUserId(me),
      activeOwnedTournamentCount: ownedCount,
      leagueNames,
      myLeagueIds: ((myLeagueRows ?? []) as { league_id: string }[]).map((r) => r.league_id),
    };
  }, [leagueId]);

  const query = useCachedQuery<TournamentsData>(
    `tournaments:list:${leagueId ?? 'all'}`,
    load,
    { ttlMs: 30_000, persistMs: 24 * 60 * 60 * 1000 },
  );
  const data = query.data ?? EMPTY_DATA;
  // Only a first load with nothing cached is a hard failure — otherwise the
  // cache keeps serving the last good list and the user reads on.
  const loadFailed = query.error != null && query.data === undefined;
  const atTournamentLimit = !data.godmode && data.activeOwnedTournamentCount >= 1;

  const reload = useCallback(() => query.refresh(), [query.refresh]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  const refresh = useRefresh(reload);

  // Dev-only scale fixture, merged at render time (never cached), and only
  // into Play's all-tournaments list.
  const view = useMemo(() => {
    if (!fixtureOn || leagueId) return data;
    const f = fixtureTournaments();
    return {
      ...data,
      tournaments: [...data.tournaments, ...f.tournaments],
      playerCounts: { ...data.playerCounts, ...f.playerCounts },
      approvedCounts: { ...data.approvedCounts, ...f.approvedCounts },
      myRegs: { ...data.myRegs, ...f.myRegs },
      leagueNames: { ...(data.leagueNames ?? {}), ...f.leagueNames },
    };
  }, [data, fixtureOn, leagueId]);
  const { tournaments, approvedCounts, myRegs, myAvailability } = view;
  const leagueNames = useMemo(() => view.leagueNames ?? {}, [view.leagueNames]);
  const hasAvailability = myAvailability.some(Boolean);

  useEffect(() => { onCount?.(tournaments.length); }, [tournaments.length, onCount]);

  // ── Filters ───────────────────────────────────────────────────────────────
  const filters = usePlayFilterState({
    list: 'tournaments',
    storageKey: !leagueId && uid ? `play:tournaments:${uid}` : null,
    defaults: TOURNAMENT_PERSIST_DEFAULTS,
    routeMineToken,
    // play.filter is a Play event: LeagueDetail's league-scoped list doesn't
    // emit it, or league-page use would count as Play use.
    track: !leagueId,
  });
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searching = normalizeQuery(searchQuery) !== '';

  // "Fits my schedule" exists only for users who set availability; a saved
  // chip from before they cleared it is ignored rather than emptying the list.
  const chips = useMemo(
    () => (hasAvailability ? filters.chips : filters.chips.filter((k) => k !== 'fits_schedule')),
    [filters.chips, hasAvailability],
  );
  // The row only sees `chips`, but setChips diffs against every effective chip.
  // Put a hidden saved fits_schedule back before the diff, or deselecting
  // another chip finds the hidden one first and removes it instead (a dead
  // tap). The hidden chip stays saved: ignored, not deleted.
  const onChangeChips = useCallback((next: string[]) => {
    filters.setChips(
      !hasAvailability && filters.chips.includes('fits_schedule') && !next.includes('fits_schedule')
        ? [...next, 'fits_schedule']
        : next,
    );
  }, [filters.setChips, filters.chips, hasAvailability]);
  // What the chip row and the Filters count show: a saved radius without a
  // device location filters nothing, so it isn't shown as on. The sheet
  // itself still gets the raw values, so the saved radius survives an Apply.
  const sheetShown = useMemo(() => sheetInEffect(filters.sheet, coords), [filters.sheet, coords]);

  const now = Date.now();
  const ctx = useMemo<TournamentCtx>(() => ({
    myRegs,
    myLeagueIds: new Set(data.myLeagueIds ?? []),
    availability: myAvailability,
    approvedCounts,
    leagueNames,
    coords,
    now: Date.now(),
  }), [myRegs, data.myLeagueIds, myAvailability, approvedCounts, leagueNames, coords]);

  const split = useMemo(
    () => splitTournaments(tournaments, { query: searchQuery, chips, sheet: filters.sheet, sort: filters.sort }, ctx),
    [tournaments, searchQuery, chips, filters.sheet, filters.sort, ctx],
  );

  const [mineExpanded, setMineExpanded] = useState(false);
  const [endedToggled, setEndedToggled] = useState<boolean | null>(null);
  const [pages, setPages] = useState(1);
  const filterSignature = `${searchQuery}|${chips.join(',')}|${JSON.stringify(filters.sheet)}|${filters.sort}|${!!coords}`;
  useEffect(() => { setPages(1); }, [filterSignature]);
  // ENDED (incl. cancelled) starts collapsed. "Show ended" in the sheet opens
  // it; so does a search that only matches there (search covers every status).
  const endedOpen = endedToggled ?? (filters.sheet.ended === 'shown' || (searching && split.ended.length > 0));
  useEffect(() => { setEndedToggled(null); }, [filters.sheet.ended, searchQuery]);

  // ── Overlays ──────────────────────────────────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const openCreate = useCallback(() => {
    if (atTournamentLimit) { setShowLimitModal(true); return; }
    navigation.navigate('CreateTournament', { leagueId });
  }, [atTournamentLimit, navigation, leagueId]);

  usePlayHeaderPlus(navigation, live, 'New tournament', () => setPlusOpen(true));

  const clearAll = useCallback(() => {
    filters.clearFilters();
    setSearchText('');
    setSearchQuery('');
  }, [filters.clearFilters]);

  const browseLeagues = useCallback(() => {
    if (onBrowseLeagues) onBrowseLeagues();
    else navigation.navigate('Play', { initialTab: 'leagues' });
  }, [onBrowseLeagues, navigation]);

  // Registration deadline passed (tournament may still be in 'registration'
  // status until the bracket is locked) — the RLS policy rejects new
  // self-requests after this, so the row must not offer "Register".
  function isFull(item: Tournament): boolean {
    return item.max_players != null && (approvedCounts[item.id] ?? 0) >= item.max_players;
  }

  function openTournament(item: Tournament, focus?: 'invite' | 'next_match') {
    if (isFixtureId(item.id)) return;
    navigation.navigate('TournamentDetail', { tournamentId: item.id, tournamentName: item.name, ...(focus ? { focus } : {}) });
  }

  // ── Items (paged across the Discover sections) ────────────────────────────
  const discoverTotal = split.open.length + split.inProgress.length + (endedOpen ? split.ended.length : 0);
  const limit = pagedCount(discoverTotal, pages);
  const allPaged = limit >= discoverTotal;

  const { items, shownBySection } = useMemo(() => {
    const out: TItem[] = [];
    const shown: Record<Section, number> = { mine: 0, open: 0, inProgress: 0, ended: 0 };
    if (split.mine.length > 0) {
      const rows = searching || mineExpanded ? split.mine : split.mine.slice(0, MINE_PREVIEW);
      out.push({ kind: 'header', section: 'mine' });
      rows.forEach((x) => out.push({ kind: 'row', section: 'mine', t: x }));
      shown.mine = rows.length;
    }
    let budget = limit;
    const addSection = (section: Section, list: Tournament[], open = true) => {
      if (list.length === 0) return;
      out.push({ kind: 'header', section });
      if (!open) return;
      const rows = list.slice(0, Math.max(0, budget));
      budget -= rows.length;
      rows.forEach((x) => out.push({ kind: 'row', section, t: x }));
      shown[section] = rows.length;
    };
    if (!split.hideDiscover) {
      addSection('open', split.open);
      addSection('inProgress', split.inProgress);
      // Filters emptied the live sections but the list still has rows (Mine,
      // or a collapsed ENDED header), so ListEmptyComponent won't render:
      // say so here, with Clear filters.
      if (split.open.length === 0 && split.inProgress.length === 0 && split.filtersOn && (split.mine.length > 0 || split.ended.length > 0)) {
        out.push({ kind: 'discoverEmpty' });
      }
      addSection('ended', split.ended, endedOpen);
    }
    return { items: out, shownBySection: shown };
  }, [split, searching, mineExpanded, limit, endedOpen]);

  const firstDiscoverSection: Section | null = split.open.length > 0 ? 'open' : split.inProgress.length > 0 ? 'inProgress' : null;

  function renderRow(item: Tournament, section: Section) {
    const reg = myRegs[item.id];
    const invited = isInvite(reg);
    const full = isFull(item);
    const regOpen = registrationOpen(item, now);
    const approved = approvedCounts[item.id] ?? 0;

    // The one fact after court + league: the state that decides whether you
    // can still get in.
    let entryFact: string | null = null;
    if (item.status === 'registration') {
      if (!regOpen) entryFact = 'Registration closed';
      else if (item.registration_mode === 'invite_only' && !reg) entryFact = 'Invite only';
      else if (item.max_players != null) entryFact = full ? 'Full, waitlist open' : `${item.max_players - approved} spots left`;
    }
    const fmt = FORMAT_META[item.format]?.label ?? null;
    const type = item.match_type === 'doubles' ? 'Doubles' : 'Singles';

    // Register (or join the waitlist) right from the row: request-mode, open,
    // and I'm not already in it. It opens the detail screen, as it always did.
    const canRegister = section !== 'mine' && regOpen && item.registration_mode === 'request'
      && (!reg || reg.status === 'rejected');
    const action = canRegister ? (
      <Button size="sm" title={full ? 'Waitlist' : 'Register'} onPress={() => openTournament(item)} />
    ) : undefined;

    const focus = invited ? 'invite' : reg?.status === 'approved' && item.status === 'active' ? 'next_match' : undefined;

    return (
      <TournamentRow
        tournament={item}
        leagueName={leagueId ? null : (item.league_id ? leagueNames[item.league_id] : null)}
        facts={[entryFact, fmt, type]}
        myStatus={reg?.status ?? null}
        invited={invited}
        showStatus={section === 'ended'}
        trailingText={action ? null : startLabel(item.start_time, now)}
        action={action}
        onPress={() => openTournament(item, focus)}
      />
    );
  }

  const renderItem = ({ item }: ListRenderItemInfo<TItem>) => {
    if (item.kind === 'discoverEmpty') {
      return (
        <EmptyState compact icon="🔍" title="No tournaments match your filters." actionLabel="Clear filters" onAction={clearAll} />
      );
    }
    if (item.kind === 'row') return renderRow(item.t, item.section);

    const { section } = item;
    const isFirst = itemKey(items[0]) === itemKey(item);
    const style = isFirst ? S.firstHeader : S.header;
    if (section === 'mine') {
      const capped = !searching && split.mine.length > MINE_PREVIEW;
      return (
        <SectionHeader
          title="Mine"
          count={split.mine.length}
          style={style}
          action={capped
            ? mineExpanded
              ? { label: 'Show less', onPress: () => setMineExpanded(false) }
              : { label: `Show all (${split.mine.length})`, onPress: () => setMineExpanded(true), a11yLabel: `Show all ${split.mine.length} of your tournaments` }
            : undefined}
        />
      );
    }
    if (section === 'ended') {
      const cancelled = split.ended.some((x) => x.status === 'cancelled');
      const total = split.ended.length;
      const count = endedOpen ? countLabel(shownBySection.ended, total) : `${total}`;
      return (
        <SectionHeader
          title="Ended"
          count={cancelled ? `${count} · incl. cancelled` : count}
          style={style}
          open={endedOpen}
          onToggle={() => setEndedToggled(!endedOpen)}
        />
      );
    }
    const list = section === 'open' ? split.open : split.inProgress;
    const showSort = section === firstDiscoverSection && sortVisible(split.open.length + split.inProgress.length);
    return (
      <SectionHeader
        title={SECTION_TITLES[section]}
        count={countLabel(shownBySection[section], list.length)}
        style={style}
        action={showSort
          ? {
              label: `${TOURNAMENT_SORT_LABELS[split.sort]} ▾`,
              onPress: () => setSortOpen(true),
              a11yLabel: `Sort: ${TOURNAMENT_SORT_LABELS[split.sort]}. Change sort`,
            }
          : undefined}
      />
    );
  };

  // ── "+ New tournament" footer, only while the list fits one screen ────────
  const [viewportH, setViewportH] = useState(0);
  const [bodyH, setBodyH] = useState(0);
  const footerHRef = useRef(CREATE_FOOTER_H);
  const footerShownRef = useRef(false);
  const fitsOneScreen = viewportH > 0 && allPaged && bodyH + footerHRef.current <= viewportH;
  footerShownRef.current = fitsOneScreen;
  const onListLayout = (e: LayoutChangeEvent) => setViewportH(e.nativeEvent.layout.height);
  const onContentSize = (_w: number, h: number) => setBodyH(h - (footerShownRef.current ? footerHRef.current : 0));

  const footer = fitsOneScreen ? (
    <View style={S.createFooter} onLayout={(e) => { footerHRef.current = e.nativeEvent.layout.height + SPACE.sm; }}>
      <Pressable onPress={openCreate} accessibilityRole="button" style={S.footerLink}>
        <Text style={[t.sub, S.footerLinkText]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>+ New tournament</Text>
      </Pressable>
    </View>
  ) : null;

  const emptyList = loadFailed ? (
    // A failed fetch must never read as "you have no tournaments".
    <EmptyState
      icon="📡"
      title="Couldn't load tournaments"
      subtitle={friendlySbMessage(query.error)}
      actionLabel="Retry"
      onAction={() => { void reload(); }}
    />
  ) : tournaments.length === 0 ? (
    leagueId ? (
      <EmptyState compact icon="🏆" title={`No tournaments in ${leagueName ?? 'this league'} yet.`} />
    ) : (
      <EmptyState
        compact
        icon="🏆"
        title="No tournaments yet."
        subtitle="Leagues run them."
        actionLabel="Browse leagues"
        onAction={browseLeagues}
      />
    )
  ) : (
    <EmptyState
      compact
      icon="🔍"
      title={searching ? `No tournaments match "${searchQuery.trim()}".` : 'No tournaments match your filters.'}
      actionLabel="Clear filters"
      onAction={clearAll}
    />
  );

  // ── Sheet + sort + "+" ────────────────────────────────────────────────────
  const sheetGroups = useMemo<FilterSheetGroup[]>(() => [
    {
      key: 'format',
      title: 'Format',
      kind: 'multi',
      options: Object.entries(FORMAT_META).map(([value, m]) => ({ value, label: m.label })),
    },
    {
      key: 'spots',
      title: 'Spots',
      kind: 'single',
      options: [{ value: 'any', label: 'Any' }, { value: 'open', label: 'Spots left' }],
    },
    {
      key: 'entry',
      title: 'Entry',
      kind: 'single',
      options: [{ value: 'any', label: 'Any' }, { value: 'free', label: 'Free' }, { value: 'ante', label: 'Pickle ante' }],
    },
    {
      key: 'distance',
      title: 'Distance',
      kind: 'custom',
      render: (renderCtx) => <DistanceFilterGroup ctx={renderCtx} coords={coords} onCoords={setCoords} noun="tournaments" />,
    },
    {
      key: 'ended',
      title: 'Ended + cancelled',
      kind: 'single',
      options: [{ value: 'hidden', label: 'Collapsed' }, { value: 'shown', label: 'Show' }],
    },
  ], [coords, setCoords]);

  const formatSheetLabel = useCallback((e: ActiveFilterEntry) => {
    switch (e.key) {
      case 'format': return e.value ? FORMAT_META[e.value as Tournament['format']]?.label ?? e.value : 'Format';
      case 'spots': return 'Spots left';
      case 'entry': return e.value === 'free' ? 'Free entry' : e.value === 'ante' ? 'Pickle ante' : 'Entry';
      case 'distance': return distanceLabel(e.value) ?? 'Distance';
      case 'ended': return 'Showing ended';
      default: return null;
    }
  }, []);

  const sortActions = useMemo<ActionSheetAction[]>(() =>
    tournamentSortOptions(coords).map((k) => ({
      label: `${k === split.sort ? '✓ ' : ''}${TOURNAMENT_SORT_LABELS[k]}`,
      onPress: () => filters.setSort(k),
    })), [coords, split.sort, filters.setSort]);

  // The "+" action runs from the sheet's onDismissed, once the sheet has fully
  // closed: iOS won't present the limit Modal while the sheet animates out.
  const createAfterPlusRef = useRef(false);
  const plusActions: ActionSheetAction[] = [
    {
      label: atTournamentLimit ? 'New tournament (limit reached)' : 'New tournament',
      iconName: 'trophy',
      onPress: () => { createAfterPlusRef.current = true; },
    },
  ];

  const chipOptions = TOURNAMENT_CHIPS
    .filter((k) => k !== 'fits_schedule' || hasAvailability)
    .map((k) => ({ value: k, label: TOURNAMENT_CHIP_LABELS[k], count: split.chipCounts[k] }));

  return (
    <View style={S.container}>
      <PlayListChrome
        query={searchText}
        onChangeQuery={setSearchText}
        onDebouncedQuery={setSearchQuery}
        placeholder="Search tournaments, courts, leagues"
        showChips={quickChipsVisible(split.discoverBase, split.filtersOn)}
        chipOptions={chipOptions}
        chips={chips}
        onChangeChips={onChangeChips}
        pinnedKeys={TOURNAMENT_PINNED_CHIPS}
        sheetValues={sheetShown}
        sheetDefaults={filters.sheetDefaults}
        sheetGroups={sheetGroups}
        formatSheetLabel={formatSheetLabel}
        onRemoveSheetValue={filters.removeSheetValue}
        sheetCount={countSheetFilters(sheetShown, filters.sheetDefaults)}
        onOpenFilters={() => setSheetOpen(true)}
      />

      {query.loading && !loadFailed ? (
        <View style={S.skeleton}><SkeletonList rows={4} variant="row" /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={itemKey}
          renderItem={renderItem}
          onLayout={onListLayout}
          onContentSizeChange={onContentSize}
          onEndReached={() => { if (!allPaged) setPages((p) => p + 1); }}
          onEndReachedThreshold={0.5}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={S.listContent}
          refreshControl={<AppRefreshControl {...refresh} />}
          ListEmptyComponent={emptyList}
          ListFooterComponent={footer}
        />
      )}

      <FilterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filter tournaments"
        groups={sheetGroups}
        values={filters.sheet}
        defaults={filters.sheetDefaults}
        onApply={filters.applySheet}
      />

      <ActionSheetModal
        visible={sortOpen}
        title="Sort tournaments"
        actions={sortActions}
        onClose={() => setSortOpen(false)}
      />

      <ActionSheetModal
        visible={plusOpen}
        actions={plusActions}
        onClose={() => setPlusOpen(false)}
        onDismissed={() => {
          if (!createAfterPlusRef.current) return;
          createAfterPlusRef.current = false;
          openCreate();
        }}
      />

      <ConfirmModal
        visible={showLimitModal}
        title="Active tournament limit reached"
        body="You're already running an active tournament. Wait for it to end (or cancel it) before starting another."
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
    firstHeader: { marginTop: SPACE.xs },
    header: { marginTop: SPACE.md },
    createFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: SPACE.sm, minHeight: 44 },
    footerLink: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.sm, alignItems: 'center', justifyContent: 'center' },
    footerLinkText: { color: c.primary, fontWeight: '700' },
  });
}

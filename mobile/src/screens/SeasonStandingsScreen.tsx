// Season standings (plan section 5, "League screens beyond LeagueDetail"):
//
//   [Manage]            admins/co-admins only, on TOP: Lock period N, Complete
//                       season, the pot's Contribute/Award/Distribute. Opens
//                       itself when a period lock is due, else one 44px row.
//   Fall · P7 of 12 · locks Oct 20          one-line header
//   (P1)(P2)…(dot P7 · Live)…(trophy Final) period strip, opened on the live one
//   # · Player · W-L · PLUPR (+change)      your row tinted
//   Pot                                     non-admins: only when it holds pickles
//   How scoring works                       collapsed (baseline, bonuses, finals)
//   [Wager market]                          gated (WAGERS_ENABLED)
//   ───────────── StickyActionBar "Jump to me" while your row is off screen
//
// The standings math lives in components/standings/standingsModel.ts (pure,
// tested); this file loads, picks the tab, and lays it out.
import { useNavReserve, useScreenBottomInset } from '../lib/appChrome';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView, View, Text, StyleSheet, TouchableOpacity,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import {
  sbCall, classifySbError, friendlySbMessage, currentUserId,
} from '@just-messin-around/expo-foundation/supabase';
import {
  CollapsibleSection, ErrorState, FilterChipRow, RankMedal, StickyActionBar, StatusBanner,
  type FilterChipOption,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import {
  LeagueSeason, SeasonSnapshot, SeasonFinalStanding, RootStackParamList,
} from '../types';
import { getLeagueRole, isPrivileged, LeagueRole } from '../lib/leagueRole';
import PicklePotCard from '../components/PicklePotCard';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import { useStatusMessage } from '../lib/useStatusMessage';
import ActionSheetModal from '../components/ActionSheetModal';
import WagerProposeModal from '../components/WagerProposeModal';
import { WAGERS_ENABLED } from '../lib/features';
import { WagerSubject } from '../lib/wager';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { picklesLabel } from '../components/PickleAmount';
import { trackSectionToggle } from '../lib/analytics';
import StandingsTable, { type StandingsTableRow } from '../components/standings/StandingsTable';
import WagerMarketSection, { type MarketRow } from '../components/standings/WagerMarketSection';
import {
  computePeriodDate, periodStartDate, computeStandings, computeMedianFinals, periodStartPlupr,
  findLivePeriod, nextLockPeriod, isLockDue, seasonHeaderLine, formatPluprChange,
  RANK_BONUSES, type SnapshotPeriod,
} from '../components/standings/standingsModel';
import { localIsoDate } from '../lib/seasonSummary';
import { resolveStandingsTarget } from '../lib/savedStandingsData';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import FinishShareStudio from '../components/share/FinishShareStudio';
import ShareCallout from '../components/share/ShareCallout';
import { cardPodium, ordinal, shortName, type FinishShareData } from '../lib/finishShare';
import { useBlockedIds } from '../lib/moderation';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonStandings'>;
  route: RouteProp<RootStackParamList, 'SeasonStandings'>;
};

const ANALYTICS_SCREEN = 'SeasonStandings';

// Long-press → ActionSheet → optional WagerProposeModal. `periodNumber`
// is null when the row comes from the Final-standings tab (season_rank).
type RowContext = { userId: string; fullName: string; rank: number; periodNumber: number | null };

/**
 * A link can carry only one id (/leagues/:leagueId/standings, or
 * /seasons/:seasonId/standings without ?leagueId): resolve the other first,
 * then render the standings. Saved and LeagueDetail pass both, so they skip
 * straight to the body.
 */
export default function SeasonStandingsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const p = route.params ?? {};
  const both = !!p.seasonId && !!p.leagueId;
  const [ids, setIds] = useState<{ seasonId: string | null; leagueId: string | null } | null>(
    both ? { seasonId: p.seasonId!, leagueId: p.leagueId! } : null,
  );
  const [error, setError] = useState<unknown>(null);

  const resolve = useCallback(async () => {
    setError(null);
    try {
      setIds(await resolveStandingsTarget({ seasonId: p.seasonId, leagueId: p.leagueId }));
    } catch (e) {
      setError(e);
    }
  }, [p.seasonId, p.leagueId]);

  useEffect(() => {
    if (both) setIds({ seasonId: p.seasonId!, leagueId: p.leagueId! });
    else void resolve();
  }, [both, p.seasonId, p.leagueId, resolve]);

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorState
          iconName="offline"
          error={error}
          message={`Couldn't load these standings. ${friendlySbMessage(error)}`}
          retryLabel="Retry"
          onRetry={() => { void resolve(); }}
        />
      </View>
    );
  }
  if (!ids) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} variant="row" /></View>;
  if (!ids.seasonId || !ids.leagueId) {
    const lid = ids.leagueId;
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <EmptyState
          iconName="trophy"
          title={lid ? 'No season yet' : 'Season not found.'}
          subtitle={lid ? "Standings start with the league's first season." : undefined}
          actionLabel={lid ? 'Open the league' : undefined}
          onAction={lid ? () => navigation.replace('LeagueDetail', { leagueId: lid, leagueName: p.leagueName ?? '' }) : undefined}
        />
      </View>
    );
  }
  return <SeasonStandingsBody navigation={navigation} route={route} seasonId={ids.seasonId} leagueId={ids.leagueId} />;
}

function SeasonStandingsBody({ navigation, route, seasonId, leagueId }: Props & { seasonId: string; leagueId: string }) {
  // A cold web URL carries no league name; never render "undefined Season".
  const leagueName = typeof route.params?.leagueName === 'string' && route.params.leagueName !== 'undefined'
    ? route.params.leagueName : '';
  // Saved opens this "at my row": scroll there once, when the table has laid out.
  const pendingFocus = useRef(!!route.params?.focusMe);
  const { colors } = useTheme();
  const t = textStyles(colors);
  const S = makeStyles(colors);
  const isFocused = useIsFocused();
  // The navigator already keeps the bottom bar and the island clear (lib/appChrome).
  const bottomInset = useScreenBottomInset(SPACE.xl);
  const navReserve = useNavReserve();

  const [season, setSeason]           = useState<LeagueSeason | null>(null);
  const [potMembers, setPotMembers]   = useState<{ id: string; full_name: string }[]>([]);
  const [periods, setPeriods]         = useState<SnapshotPeriod[]>([]);
  const [finals, setFinals]           = useState<SeasonFinalStanding[]>([]);
  const [myRole, setMyRole]           = useState<LeagueRole>(null);
  const [myUserId, setMyUserId]       = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  // Separates "this season row is gone" from "we couldn't ask" — the bare
  // "Season not found." was shown for both, with no way back but leaving.
  const [loadError, setLoadError]     = useState<unknown>(null);
  const [locking, setLocking]         = useState(false);
  const [completing, setCompleting]   = useState(false);
  // null until first load completes — load() seeds it to the live period (or Final if completed).
  const [activeTab, setActiveTab]     = useState<number | 'final' | null>(null);
  // Manage: null = not touched yet, so it follows "a lock is due"; a user tap pins it.
  const [manageOpen, setManageOpen]   = useState<boolean | null>(null);

  const [lockConfirmOpen, setLockConfirmOpen]         = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);

  const [rowSheetOpen, setRowSheetOpen]       = useState(false);
  const [rowContext, setRowContext]           = useState<RowContext | null>(null);
  const [wagerModalOpen, setWagerModalOpen]   = useState(false);
  const [wagerSubject, setWagerSubject]       = useState<WagerSubject | null>(null);
  const [wagerTotals, setWagerTotals]         = useState<Record<string, number>>({});

  // ── "Jump to me" geometry ──────────────────────────────────────
  // The table's content offset = the container's top padding + the HEIGHT of
  // the one wrapper around everything above it + the table's y inside its
  // block (below the caption line); the viewer's row reports its y inside the
  // table. Not the table block's onLayout y: react-native-web fires onLayout
  // only from a ResizeObserver, so a block that moves without resizing (Manage
  // opening, the pot card loading, a banner appearing) never reports its new
  // y. A height change of the wrapper above does fire, on web and native.
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const viewportH = useRef(0);
  const aboveH = useRef<number | null>(null);
  const innerY = useRef(0);
  const tableTop = () => (aboveH.current == null ? null : SPACE.lg /* S.container padding */ + aboveH.current + innerY.current);
  const myRow = useRef<{ y: number; h: number } | null>(null);
  const [myRowOffscreen, setMyRowOffscreen] = useState(false);

  const recomputeJump = useCallback(() => {
    const r = myRow.current;
    const tableY = tableTop();
    if (r == null || tableY == null || viewportH.current === 0) {
      setMyRowOffscreen(false);
      return;
    }
    const top = tableY + r.y;
    const off = top + r.h < scrollY.current || top > scrollY.current + viewportH.current - r.h;
    setMyRowOffscreen(prev => (prev === off ? prev : off));
    if (pendingFocus.current) {
      pendingFocus.current = false;
      // Cleared so a web refresh (the param is in the URL) doesn't re-jump.
      navigation.setParams({ focusMe: undefined });
      // A beat for the blocks above the table (pot, banner) to settle; jumpToMe
      // reads the geometry at call time.
      if (off) setTimeout(jumpToMe, 250);
    }
  }, []);

  function jumpToMe() {
    const r = myRow.current;
    const tableY = tableTop();
    if (r == null || tableY == null) return;
    const y = tableY + r.y - viewportH.current / 3;
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
  }

  function openRowSheet(ctx: RowContext) {
    setRowContext(ctx);
    setRowSheetOpen(true);
  }

  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  // Real title on a clean web URL (no leagueName param): the season's name.
  useLayoutEffect(() => {
    if (!leagueName && season?.name) navigation.setOptions({ title: season.name });
  }, [navigation, leagueName, season?.name]);

  // ── Share my finish (PKL-013) ──
  // A completed season where I have a final rank, on a binary that can share
  // an image. Its own headerRight effect, keyed on my rank (not the title-only
  // setOptions above, which skips when a leagueName param is passed).
  const blocked = useBlockedIds();
  const [shareOpen, setShareOpen] = useState(false);
  const myFinal = season?.status === 'completed' && myUserId ? finals.find(r => r.user_id === myUserId) : undefined;
  const myFinalRank = myFinal?.final_rank ?? null;
  const shareData = useMemo<FinishShareData | null>(() => {
    if (!season || myFinalRank == null || !myFinal) return null;
    // Record: my cumulative W-L in the last period that has my row.
    let wins: number | null = null;
    let losses: number | null = null;
    for (let i = periods.length - 1; i >= 0; i--) {
      const row = periods[i].rows.find(r => r.user_id === myUserId);
      if (row) { wins = row.wins_in_season ?? null; losses = row.losses_in_season ?? null; break; }
    }
    const byRank = new Map<number, { id: string; fullName: string | null; deleted: boolean }[]>();
    for (const r of finals) {
      if (r.final_rank > 3) continue;
      const list = byRank.get(r.final_rank) ?? [];
      list.push({ id: r.user_id, fullName: r.profile?.full_name ?? null, deleted: !!(r.profile as any)?.deleted_at });
      byRank.set(r.final_rank, list);
    }
    return {
      kind: 'season',
      title: season.name,
      league: leagueName || null,
      rank: myFinalRank,
      of: finals.length || null,
      wins,
      losses,
      me: shortName(myFinal.profile?.full_name),
      podium: cardPodium([...byRank].map(([rank, players]) => ({ rank, players })), blocked),
    };
  }, [season, myFinal, myFinalRank, finals, periods, myUserId, leagueName, blocked]);
  const canShareFinish = !!shareData && isImageShareAvailable();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canShareFinish
        ? () => (
            <TouchableOpacity
              onPress={() => setShareOpen(true)}
              style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
              accessibilityRole="button"
              accessibilityLabel="Share your finish"
            >
              <Icon name="share" size={20} color={colors.text} />
            </TouchableOpacity>
          )
        : undefined,
    });
  }, [navigation, canShareFinish, myFinalRank, colors.text]);

  async function load() {
    try {
      await loadInner();
      setLoadError(null);
    } catch (e) {
      // Keep the standings already on screen; the error only changes what the
      // "no season yet" branch renders.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }

  async function loadInner() {
    const [seasonRow, snapshotRows, finalRows, role, memberRows, matchRows, wagerRows, uid] = await Promise.all([
      sbCall(() => supabase.from('league_seasons').select('*').eq('id', seasonId).single()),
      sbCall(() => supabase.from('season_snapshots')
        .select('*, profile:profiles(full_name, avatar_id, avatar_url, name_color, list_name_style_id, deleted_at)')
        .eq('season_id', seasonId)
        .order('period_number').order('rank_at_snapshot')),
      sbCall(() => supabase.from('season_final_standings')
        .select('*, profile:profiles(full_name, avatar_id, avatar_url, name_color, list_name_style_id, deleted_at)')
        .eq('season_id', seasonId)
        .order('final_rank')),
      // A failed role read must not strip an admin's lock/complete controls.
      getLeagueRole(leagueId).catch(() => 'unknown' as const),
      sbCall(() => supabase.from('league_members')
        .select('user_id, profile:profiles(full_name, rating, avatar_id, avatar_url, total_matches_played, name_color, list_name_style_id)')
        .eq('league_id', leagueId)),
      // Pull every in-league match (date + winner + per-team PLUPR deltas).
      // We re-filter client-side per-period and for the live tab. The
      // rating_before/after columns drive the per-player season PLUPR.
      sbCall(() => supabase.from('matches')
        .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, played_at, game_scores,'
              + ' player1_rating_before, player1_rating_after,'
              + ' player2_rating_before, player2_rating_after')
        .eq('league_id', leagueId)
        .eq('status', 'completed')),
      // Public "pickles wagered on this player" totals, scoped to this season.
      // Independent of everything above, so it rides along in the same batch
      // rather than adding a round trip after it.
      sbCall(() => supabase.rpc('get_season_wager_totals', { p_season_id: seasonId })),
      // LOCAL session read: which row is "you" (tint + Jump to me).
      currentUserId(supabase),
    ]);

    const s = seasonRow as LeagueSeason;
    setSeason(s);
    setMyUserId(uid);
    if (role !== 'unknown') setMyRole(role);

    const members = (memberRows ?? []) as any[];
    const allMatches = (matchRows ?? []) as any[];

    // Baseline PLUPR — soft-reset target everyone snaps to at period end.
    const baseline = Number((s as any)?.baseline_plupr ?? 3.5);

    // Pot members list (id + name) is all the PicklePotCard needs.
    setPotMembers(members.map(m => ({ id: m.user_id, full_name: m.profile?.full_name ?? 'Player' })));

    const wMap: Record<string, number> = {};
    ((wagerRows ?? []) as any[]).forEach((w: any) => { if (w.user_id) wMap[w.user_id] = w.total; });
    setWagerTotals(wMap);

    // The LOCAL calendar day: periods and matches are bucketed by local day
    // (lib/seasonSummary.ts), as the server's lock is (league's zone).
    const todayIsoDate = localIsoDate(new Date());

    // Group locked snapshots by period
    const lockedByPeriod = new Map<number, SeasonSnapshot[]>();
    for (const row of (snapshotRows ?? []) as SeasonSnapshot[]) {
      if (!lockedByPeriod.has(row.period_number)) lockedByPeriod.set(row.period_number, []);
      lockedByPeriod.get(row.period_number)!.push(row);
    }

    // Build ALL period tabs. Locked periods use stored snapshot rows. Unlocked
    // periods are computed on-the-fly, windowed to that period's date range:
    // start = period start (day after previous period's snapshot date),
    // end   = min(period's snapshot date, today). This means the live period's
    // W/L reflects only matches played within the current period so far.
    const allPeriods: SnapshotPeriod[] = [];
    if (s) {
      for (let p = 1; p <= s.total_periods; p++) {
        const snapshotDate = computePeriodDate(s, p);
        const locked = lockedByPeriod.get(p);
        if (locked) {
          allPeriods.push({ periodNumber: p, date: snapshotDate, rows: locked, locked: true });
        } else {
          const pStart        = periodStartDate(s, p);
          const effectiveEnd  = snapshotDate < todayIsoDate ? snapshotDate : todayIsoDate;
          const computedLive  = computeStandings(members, allMatches, baseline, pStart, effectiveEnd + 'T23:59:59');
          // Re-shape into SeasonSnapshot rows so one renderer covers both.
          const synthRows: SeasonSnapshot[] = computedLive.map((r, i) => ({
            id: `computed-${p}-${r.user_id}`,
            season_id: seasonId,
            league_id: leagueId,
            period_number: p,
            snapshot_date: snapshotDate,
            user_id: r.user_id,
            elo_at_snapshot: r.rating,
            rank_at_snapshot: i + 1,
            wins_in_season: r.wins,
            losses_in_season: r.losses,
            profile: {
              full_name: r.full_name,
              avatar_id: r.avatar_id,
              avatar_url: r.avatar_url,
              name_color: r.name_color,
              list_name_style_id: r.list_name_style_id,
            },
          }));
          allPeriods.push({ periodNumber: p, date: snapshotDate, rows: synthRows, locked: false });
        }
      }
    }
    setPeriods(allPeriods);

    // Final standings: prefer the locked rows if they exist; otherwise compute
    // median rank across all periods (locked + computed).
    const storedFinals = (finalRows ?? []) as SeasonFinalStanding[];
    if (storedFinals.length > 0) {
      setFinals(storedFinals);
    } else if (allPeriods.length > 0) {
      setFinals(computeMedianFinals(allPeriods, members, leagueId, seasonId, baseline));
    } else {
      setFinals([]);
    }

    // Seed activeTab on first load only — preserve user's selection on re-load.
    setActiveTab(prev => {
      if (prev !== null) return prev;
      if (s?.status === 'completed') return 'final';
      // A caller (Saved) named the period its line ranked: open on that tab.
      // Number(): from a deep link it arrives as a string.
      const asked = Number(route.params?.period);
      if (Number.isInteger(asked) && asked >= 1 && asked <= (s?.total_periods ?? 0)) return asked;
      return findLivePeriod(s, new Set(lockedByPeriod.keys()), todayIsoDate) ?? s?.total_periods ?? 1;
    });
  }

  // ── Admin actions ─────────────────────────────────────────────

  const lockedSet = new Set(periods.filter(p => p.locked).map(p => p.periodNumber));
  const nextPeriod = nextLockPeriod(lockedSet);
  const privileged = isPrivileged(myRole);

  function canLock(): boolean {
    if (!season || !privileged) return false;
    return isLockDue(season, nextPeriod, new Date());
  }

  function canComplete(): boolean {
    if (!season || !privileged) return false;
    if (season.elo_reset_applied) return false;
    return periods.some(p => p.locked);
  }

  async function doLockPeriod() {
    if (!season) return;
    const n = nextPeriod;
    setLocking(true);
    const today = localIsoDate(new Date());
    const { error } = await supabase.rpc('lock_season_period', {
      p_season_id: seasonId, p_period_number: n, p_snapshot_date: today,
    });
    setLocking(false);
    setLockConfirmOpen(false);
    if (error) {
      status.error(error.message);
    } else {
      status.success(`Period ${n} standings are locked in.`);
      load();
    }
  }

  async function doCompleteSeason() {
    setCompleting(true);
    const { error } = await supabase.rpc('complete_season', { p_season_id: seasonId });
    setCompleting(false);
    setCompleteConfirmOpen(false);
    if (error) {
      status.error(error.message);
    } else {
      status.success('Season complete! Final standings locked and PLUPR reset applied.');
      load();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  function fmtDay(iso: string) {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function fmtDate(iso: string) {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // `periodNumber === null` ⇒ season_rank subject; otherwise period_rank.
  function buildRankSubject(args: {
    userId: string; userName: string; rank: number; periodNumber: number | null;
  }): WagerSubject {
    return args.periodNumber === null
      ? { type: 'season_rank', seasonId, userId: args.userId, userName: args.userName, rank: args.rank }
      : {
          type: 'period_rank', seasonId, periodNumber: args.periodNumber,
          userId: args.userId, userName: args.userName, rank: args.rank,
        };
  }

  function openWagerForSubject(subject: WagerSubject) {
    setWagerSubject(subject);
    setWagerModalOpen(true);
  }

  function openPlayerWagers(row: StandingsTableRow) {
    navigation.navigate('PlayerWagers', {
      userId: row.userId,
      userName: row.name || 'Player',
      scopeType: 'season',
      scopeId: seasonId,
      scopeName: season?.name ?? leagueName,
    });
  }

  function onSectionToggle(section: string, open: boolean) {
    trackSectionToggle({ screen: ANALYTICS_SCREEN, section, open });
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    scrollY.current = e.nativeEvent.contentOffset.y;
    recomputeJump();
  }

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} variant="row" /></View>;
  if (!season) {
    // Always leave a scroll view + pull-to-refresh mounted here: the bare
    // EmptyState was a dead end that could only be escaped by backing out.
    const missing = loadError == null || classifySbError(loadError) === 'notFound';
    return (
      <ScrollView contentContainerStyle={S.container} refreshControl={<AppRefreshControl {...refresh} />}>
        {missing ? (
          <EmptyState iconName="search" title="Season not found." actionLabel="Retry" onAction={() => { void load(); }} />
        ) : (
          <ErrorState
            iconName="offline"
            error={loadError}
            message={`Couldn't load this season. ${friendlySbMessage(loadError)}`}
            retryLabel="Retry"
            onRetry={() => { void load(); }}
          />
        )}
      </ScrollView>
    );
  }

  const baseline = Number((season as any)?.baseline_plupr ?? 3.5);
  const totalPeriods = season.total_periods;
  const lockedCount = lockedSet.size;
  // Finals are "real" only when every period is locked AND the season is completed.
  // Otherwise it's a historical preview computed from match data.
  const finalsAreComputed = !(lockedCount >= totalPeriods && season.status === 'completed');
  const todayDateOnly = localIsoDate(new Date());
  const livePeriodNumber = findLivePeriod(season, lockedSet, todayDateOnly);
  const lockDue = canLock();
  const pool = season.prize_pool ?? 0;

  const headerLine = seasonHeaderLine({
    // "lock due" is admin information (canLock); members read the live period.
    season, livePeriod: livePeriodNumber, nextPeriod, lockDue,
    todayIso: todayDateOnly, fmtDay,
  });

  // ── Period strip ──
  const tabOptions: FilterChipOption<string>[] = periods.map(p => (
    p.periodNumber === livePeriodNumber
      ? { value: `p${p.periodNumber}`, label: `P${p.periodNumber} · Live`, iconName: 'dot' as const }
      : { value: `p${p.periodNumber}`, label: `P${p.periodNumber}` }
  ));
  if (finals.length > 0 || season.status === 'completed') tabOptions.push({ value: 'final', label: 'Final', iconName: 'trophy' });
  const tabValue = activeTab === 'final' ? 'final' : `p${activeTab ?? 1}`;

  // ── The table for the selected tab ──
  let caption = '';
  let tableRows: StandingsTableRow[] = [];
  let middleLabel = 'W-L';
  let futureNote: string | null = null;
  let marketRows: MarketRow[] = [];
  let marketScope = '';
  let sheetPeriod: number | null = null;

  if (typeof activeTab === 'number') {
    const period = periods.find(p => p.periodNumber === activeTab);
    if (period) {
      sheetPeriod = period.periodNumber;
      const pStart = periodStartDate(season, period.periodNumber);
      // A period is "future" only if its START hasn't happened yet.
      const isFuture = !period.locked && pStart > todayDateOnly;
      const isLive = !period.locked && !isFuture && period.periodNumber === livePeriodNumber;
      if (isFuture) {
        futureNote = `P${period.periodNumber} starts ${fmtDay(pStart)} · locks ${fmtDay(period.date)}`;
      } else {
        caption = period.locked
          ? `Locked ${fmtDay(period.date)}`
          : isLive
            ? `Live · ${fmtDay(pStart)} → ${fmtDay(period.date)} · W-L so far`
            : `Preview · ${fmtDay(pStart)} → ${fmtDay(period.date)} · not locked yet`;
        // The change column is the ending PLUPR against the PLUPR the player
        // opened this period at. Locked periods carry the previous lock's rank
        // bonus in both numbers; computed (unlocked) periods carry it in
        // neither, so they measure from the flat baseline (periodStartPlupr).
        const prevPeriod = periods.find(pp => pp.periodNumber === period.periodNumber - 1);
        const startPluprFor = (userId: string) =>
          periodStartPlupr({ period, prevPeriod, userId, baseline });
        tableRows = period.rows.map(r => {
          const end = Number(r.elo_at_snapshot ?? baseline);
          return {
            userId: r.user_id,
            rank: r.rank_at_snapshot,
            name: r.profile?.full_name ?? '',
            nameColor: r.profile?.name_color,
            styleId: r.profile?.list_name_style_id ?? null,
            avatarId: r.profile?.avatar_id ?? 1,
            middle: `${r.wins_in_season}-${r.losses_in_season}`,
            plupr: end.toFixed(2),
            change: formatPluprChange(end - startPluprFor(r.user_id)),
            wagered: wagerTotals[r.user_id] ?? 0,
          };
        });
        marketRows = period.rows.map(r => ({
          user_id: r.user_id,
          full_name: r.profile?.full_name ?? '',
          name_color: r.profile?.name_color ?? null,
          list_name_style_id: r.profile?.list_name_style_id ?? null,
          plupr: Number(r.elo_at_snapshot ?? baseline),
        }));
        marketScope = `Period ${period.periodNumber} standings`;
      }
    }
  } else if (activeTab === 'final') {
    middleLabel = 'Median';
    caption = finalsAreComputed
      ? `Median rank across ${totalPeriods} period${totalPeriods !== 1 ? 's' : ''} · preview until the season completes`
      : `Median rank across ${lockedCount} locked period${lockedCount !== 1 ? 's' : ''}`;
    tableRows = finals.map(r => ({
      userId: r.user_id,
      rank: r.final_rank,
      name: r.profile?.full_name ?? '',
      nameColor: r.profile?.name_color,
      styleId: r.profile?.list_name_style_id ?? null,
      avatarId: r.profile?.avatar_id ?? 1,
      middle: Number(r.median_rank).toFixed(1),
      plupr: Number(r.new_elo ?? baseline).toFixed(2),
      // On the Final tab the change is the rank bonus on top of the baseline.
      change: formatPluprChange(Number(r.elo_bonus ?? 0)),
      wagered: wagerTotals[r.user_id] ?? 0,
    }));
    marketRows = finals.map(r => ({
      user_id: r.user_id,
      full_name: r.profile?.full_name ?? '',
      name_color: r.profile?.name_color ?? null,
      list_name_style_id: r.profile?.list_name_style_id ?? null,
      plupr: Number(r.new_elo ?? baseline),
    }));
    marketScope = 'Final season standings';
  }

  const mine = myUserId ? tableRows.find(r => r.userId === myUserId) : undefined;

  // ── Manage summary ──
  const manageIsOpen = manageOpen ?? lockDue;
  const manageSummary = lockDue
    ? `Lock period ${nextPeriod} is due`
    : canComplete()
      ? 'Complete the season when play ends'
      : season.status !== 'completed' && nextPeriod <= totalPeriods
        ? `Period ${nextPeriod} locks ${fmtDay(computePeriodDate(season, nextPeriod))}`
        : pool > 0 ? `Pot: ${picklesLabel(pool)}` : 'Pot and season tools';

  return (
    <View style={S.root}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[S.container, { paddingBottom: bottomInset }]}
        refreshControl={<AppRefreshControl {...refresh} />}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onLayout={(e: LayoutChangeEvent) => { viewportH.current = e.nativeEvent.layout.height; recomputeJump(); }}
      >
        {/* Everything above the table, in one wrapper whose height places the
            table for "Jump to me" (see the geometry note above). No gap on the
            container, so the wrapper changes no spacing. */}
        <View onLayout={(e: LayoutChangeEvent) => { aboveH.current = e.nativeEvent.layout.height; recomputeJump(); }}>
        {status.value ? <StatusBanner status={status.value} style={S.banner} /> : null}

        {/* ── Share my finish (PKL-013): big and first on a finished season ── */}
        {canShareFinish && myFinalRank != null ? (
          <ShareCallout
            title={myFinalRank === 1 ? 'You won this season' : `You finished ${ordinal(myFinalRank)}`}
            line="Make an Instagram post or Story of your finish."
            buttonTitle="Share your finish"
            onPress={() => setShareOpen(true)}
            style={S.shareCallout}
          />
        ) : null}

        {/* ── Manage (admins / co-admins) — on top, collapsed unless a lock is due ── */}
        {privileged && (
          <CollapsibleSection
            compact
            title="Manage"
            summary={manageSummary}
            open={manageIsOpen}
            onToggle={(next) => { setManageOpen(next); onSectionToggle('manage', next); }}
          >
            {season.status !== 'completed' && nextPeriod <= totalPeriods && (
              <View style={S.manageRow}>
                <View style={S.manageText}>
                  <Text style={t.title} numberOfLines={1}>Lock period {nextPeriod}</Text>
                  <Text style={t.sub} numberOfLines={2}>
                    {lockDue
                      ? 'Snapshot the current standings as this period, permanently.'
                      : `Opens ${fmtDay(computePeriodDate(season, nextPeriod))}.`}
                  </Text>
                </View>
                {lockDue && (
                  <Button
                    size="sm"
                    title={locking ? 'Locking…' : `Lock P${nextPeriod}`}
                    loading={locking}
                    onPress={() => setLockConfirmOpen(true)}
                  />
                )}
              </View>
            )}
            {canComplete() && (
              <View style={S.manageRow}>
                <View style={S.manageText}>
                  <Text style={t.title} numberOfLines={1}>Complete season</Text>
                  <Text style={t.sub} numberOfLines={2}>Locks final standings and applies the PLUPR reset.</Text>
                </View>
                <Button
                  size="sm"
                  variant="danger"
                  title={completing ? 'Completing…' : 'Complete'}
                  loading={completing}
                  onPress={() => setCompleteConfirmOpen(true)}
                />
              </View>
            )}
            {/* The pot's Contribute / Award / Distribute live in the card. */}
            <PicklePotCard
              scopeType="season"
              scopeId={seasonId}
              scopeLabel="Season"
              pool={pool}
              structure={season.payout_structure ?? [60, 25, 15]}
              isAdmin
              canDistribute={finals.length > 0}
              members={potMembers}
              onChange={() => load()}
            />
          </CollapsibleSection>
        )}

        {/* ── One-line header ── */}
        <View style={S.headerLine}>
          <Text style={[t.sub, S.headerText]} numberOfLines={1}>
            <Text style={S.headerName}>{season.name}</Text>
            {` · ${headerLine}`}
          </Text>
        </View>

        {/* ── Period strip ── */}
        {tabOptions.length > 1 && (
          <FilterChipRow
            size="md"
            scrollToSelected
            options={tabOptions}
            value={tabValue}
            onChange={(v) => setActiveTab(v === 'final' ? 'final' : Number(v.slice(1)))}
            style={S.strip}
          />
        )}
        </View>

        {/* ── Table ── (its onLayout only re-checks the bar; the offset comes
            from the wrapper above) */}
        <View style={S.tableBlock} onLayout={recomputeJump}>
        {futureNote ? (
          <EmptyState compact iconName="calendar-event" title={futureNote} />
        ) : tableRows.length === 0 ? (
          <EmptyState compact iconName="trophy" title="No standings yet" subtitle="No matches recorded yet this season." />
        ) : (
          <>
            {caption ? <Text style={[t.meta, S.caption]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{caption}</Text> : null}
            <View
              onLayout={(e: LayoutChangeEvent) => { innerY.current = e.nativeEvent.layout.y; recomputeJump(); }}
            >
              <StandingsTable
                // Remount per tab so a stale "my row" layout never survives a switch.
                key={tabValue}
                rows={tableRows}
                middleLabel={middleLabel}
                myUserId={myUserId}
                onRowPress={(row) => navigation.navigate('PlayerProfile', { userId: row.userId, userName: row.name })}
                onRowLongPress={(row) => openRowSheet({
                  userId: row.userId,
                  fullName: row.name || 'Player',
                  rank: row.rank,
                  periodNumber: activeTab === 'final' ? null : sheetPeriod,
                })}
                onWagerPress={openPlayerWagers}
                onMyRowLayout={(y, h) => { myRow.current = { y, h }; recomputeJump(); }}
              />
            </View>
          </>
        )}
        </View>

        {/* ── Pot (non-admins: only when it holds pickles; admins have it in Manage) ── */}
        {!privileged && pool > 0 && (
          <View style={S.section}>
            <CollapsibleSection
              compact
              title="Pot"
              summary={`${picklesLabel(pool)} · paid to the top finishers`}
              onToggle={(next) => onSectionToggle('pot', next)}
            >
              <PicklePotCard
                scopeType="season"
                scopeId={seasonId}
                scopeLabel="Season"
                pool={pool}
                structure={season.payout_structure ?? [60, 25, 15]}
                isAdmin={false}
                canDistribute={finals.length > 0}
                members={potMembers}
                onChange={() => load()}
                // The section header already names the pot and shows its total.
                bare
              />
            </CollapsibleSection>
          </View>
        )}

        {/* ── How scoring works ── */}
        <View style={S.section}>
          <CollapsibleSection
            compact
            title="How scoring works"
            summary={`Baseline ${baseline.toFixed(2)} PLUPR · ${totalPeriods} periods · top 5 keep a bonus`}
            onToggle={(next) => onSectionToggle('scoring', next)}
          >
            <Text style={t.sub}>
              {fmtDate(season.start_date)} → {fmtDate(season.end_date)} · {season.total_weeks} weeks · locks every{' '}
              {season.lock_frequency_weeks === 1 ? 'week' : `${season.lock_frequency_weeks} weeks`}.
            </Text>
            <Text style={t.sub}>
              Standings PLUPR counts only this season's in-league matches, starting from the baseline of{' '}
              {baseline.toFixed(2)}. At each period lock everyone soft-resets to the baseline, and the top 5 keep a bonus:
            </Text>
            {RANK_BONUSES.map((b, i) => (
              <View key={b.rank} style={S.bonusRow}>
                <RankMedal place={i + 1} />
                <Text style={[t.sub, S.bonusText]}>
                  → {baseline.toFixed(2)} + {b.bonus.toFixed(2)} = {(baseline + b.bonus).toFixed(2)} PLUPR
                </Text>
              </View>
            ))}
            <Text style={t.hint}>
              All others reset to {baseline.toFixed(2)}. Final standings rank players by their median position across the periods.
            </Text>
          </CollapsibleSection>
        </View>

        {/* ── Wager market (gated: lib/features.ts) ── */}
        {WAGERS_ENABLED && marketRows.length > 0 && (
          <View style={S.section}>
            <WagerMarketSection
              rows={marketRows}
              scopeLabel={marketScope}
              onToggle={(next) => onSectionToggle('wager_market', next)}
              onWager={(row, rank) => openWagerForSubject(buildRankSubject({
                userId: row.user_id,
                userName: row.full_name || 'Player',
                rank,
                periodNumber: activeTab === 'final' ? null : sheetPeriod,
              }))}
            />
          </View>
        )}

        <ConfirmModal
          visible={lockConfirmOpen}
          title={`Lock Period ${nextPeriod}`}
          body={`This will snapshot current standings as Period ${nextPeriod} and lock them in permanently.\n\nContinue?`}
          primaryLabel="Lock In"
          variant="primary"
          busy={locking}
          onConfirm={doLockPeriod}
          onClose={() => setLockConfirmOpen(false)}
        />

        <ConfirmModal
          visible={completeConfirmOpen}
          title="Complete Season & Reset PLUPR"
          body={'This will:\n• Compute final standings from median ranks\n• Reset all participating players\' global PLUPR to 3.25 + rank bonus\n• Mark the season as completed\n\nThis cannot be undone.'}
          primaryLabel="Complete Season"
          variant="danger"
          busy={completing}
          onConfirm={doCompleteSeason}
          onClose={() => setCompleteConfirmOpen(false)}
        />

        <ActionSheetModal
          visible={rowSheetOpen && rowContext !== null}
          title={rowContext?.fullName}
          subtitle={
            rowContext
              ? rowContext.periodNumber === null
                ? `Final rank #${rowContext.rank}`
                : `Period ${rowContext.periodNumber} · rank #${rowContext.rank}`
              : undefined
          }
          actions={rowContext ? [
            {
              label: 'View profile',
              onPress: () => navigation.navigate('PlayerProfile', {
                userId: rowContext.userId,
                userName: rowContext.fullName,
              }),
            },
            // The wager action is gated (lib/features.ts); "View profile"
            // keeps the long-press sheet useful on its own.
            ...(WAGERS_ENABLED ? [{
              label: `Wager: ${rowContext.fullName} finishes #${rowContext.rank}`,
              iconName: 'dice' as const,
              onPress: () => openWagerForSubject(buildRankSubject({
                userId: rowContext.userId,
                userName: rowContext.fullName,
                rank: rowContext.rank,
                periodNumber: rowContext.periodNumber,
              })),
            }] : []),
          ] : []}
          onClose={() => setRowSheetOpen(false)}
        />

        {WAGERS_ENABLED && wagerSubject !== null && (
          <WagerProposeModal
            visible={wagerModalOpen}
            subject={wagerSubject}
            onClose={() => setWagerModalOpen(false)}
          />
        )}
      </ScrollView>

      {/* Last child of the root, outside the ScrollView (foundation rule). */}
      <StickyActionBar
        // It sits above the room the navigator keeps clear: its edge counts from the window bottom.
        bottomOffset={navReserve}
        style={navReserve > 0 ? { paddingBottom: SPACE.sm } : undefined}
        visible={!!mine && myRowOffscreen}
        active={isFocused}
        summary={mine ? `You're #${mine.rank} · ${mine.plupr} PLUPR` : undefined}
        primary={{ title: 'Jump to me', onPress: jumpToMe }}
      />

      {shareData ? (
        <FinishShareStudio visible={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
    container:   { padding: SPACE.lg, backgroundColor: c.bg },
    banner:      { marginTop: 0, marginBottom: SPACE.md },
    shareCallout: { marginBottom: SPACE.md },
    manageRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 56 },
    manageText:  { flex: 1, minWidth: 0 },
    headerLine:  { minHeight: 32, justifyContent: 'center', marginBottom: SPACE.xs },
    headerText:  { color: c.textSub },
    headerName:  { color: c.text, fontWeight: FONT.weight.bold },
    strip:       { marginBottom: SPACE.sm },
    caption:     { marginBottom: SPACE.sm },
    bonusRow:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    bonusText:   { flex: 1, minWidth: 0 },
    // CollapsibleSection compact carries its own SPACE.md bottom margin.
    section:     {},
    tableBlock:  { marginBottom: SPACE.md },
  });
}

import React, { useCallback, useState } from 'react';
import {
  ScrollView, View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import {
  LeagueSeason, SeasonSnapshot, SeasonFinalStanding, RootStackParamList,
} from '../types';
import { getLeagueRole, isPrivileged } from '../lib/leagueRole';
import { AVATARS } from '../data/profileCustomization';
import PicklePotCard from '../components/PicklePotCard';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import ActionSheetModal from '../components/ActionSheetModal';
import WagerProposeModal from '../components/WagerProposeModal';
import { WagerSubject } from '../lib/wager';

const MEDALS = ['🥇', '🥈', '🥉'];

// Local ISO date "YYYY-MM-DD" for a period N's snapshot/end date.
function computePeriodDate(s: { start_date: string; lock_frequency_weeks: number }, periodNumber: number): string {
  const d = new Date(s.start_date + 'T00:00:00');
  d.setDate(d.getDate() + periodNumber * s.lock_frequency_weeks * 7);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local ISO date "YYYY-MM-DD" for the first day of period N.
//   Period 1 starts on the season's start_date.
//   Period N (>1) starts the day after period N-1's snapshot/end date.
function periodStartDate(s: { start_date: string; lock_frequency_weeks: number }, periodNumber: number): string {
  if (periodNumber <= 1) return s.start_date;
  const prevEnd = computePeriodDate(s, periodNumber - 1);
  const d = new Date(prevEnd + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Compute season-scoped standings for league members against an in-league
// match list, optionally windowed by [startIso, endIso] on played_at.
//
// "Season PLUPR" is computed from the season's baseline plus the sum of
// each player's per-match team deltas (player1_rating_after - _before for
// team1 / player2_after - player2_before for team2). Partners on the same
// team share the nominal player's delta. This ignores the player's global
// PLUPR entirely — exactly the contract the user asked for.
//
// Sort: season PLUPR desc → (W-L) desc → W desc.
function computeStandings(
  members: any[],
  matches: any[],
  baseline: number,
  startIso?: string,
  endIso?: string,
): LiveRow[] {
  const inRange = matches.filter(m => {
    if (!m.played_at) return false;
    if (startIso && m.played_at < startIso) return false;
    if (endIso   && m.played_at > endIso)   return false;
    return true;
  });
  return members.map(m => {
    const uid = m.user_id;
    // Each game in a multi-game match counts independently. A best-of-3
    // ending 2-1 produces 2 W + 1 L for the winning side. Single-game
    // matches (game_scores null) keep the old 1 W or 1 L behavior.
    let wins = 0;
    let losses = 0;
    for (const x of inRange) {
      const onTeam1 = x.player1_id === uid || x.partner1_id === uid;
      const onTeam2 = x.player2_id === uid || x.partner2_id === uid;
      if (!onTeam1 && !onTeam2) continue;
      const games = Array.isArray(x.game_scores) && x.game_scores.length > 0
        ? x.game_scores
        : null;
      if (games) {
        for (const g of games as { t1: number; t2: number }[]) {
          if (onTeam1) { if (g.t1 > g.t2) wins++; else if (g.t2 > g.t1) losses++; }
          else         { if (g.t2 > g.t1) wins++; else if (g.t1 > g.t2) losses++; }
        }
      } else {
        if (onTeam1 && x.winner_team === 'team1') wins++;
        else if (onTeam1 && x.winner_team === 'team2') losses++;
        else if (onTeam2 && x.winner_team === 'team2') wins++;
        else if (onTeam2 && x.winner_team === 'team1') losses++;
      }
    }
    let seasonDelta = 0;
    for (const x of inRange) {
      const onTeam1 = x.player1_id === uid || x.partner1_id === uid;
      const onTeam2 = x.player2_id === uid || x.partner2_id === uid;
      if (onTeam1 && x.player1_rating_before != null && x.player1_rating_after != null) {
        seasonDelta += x.player1_rating_after - x.player1_rating_before;
      } else if (onTeam2 && x.player2_rating_before != null && x.player2_rating_after != null) {
        seasonDelta += x.player2_rating_after - x.player2_rating_before;
      }
    }
    const seasonPlupr = baseline + seasonDelta;
    return {
      user_id: uid,
      full_name: m.profile?.full_name ?? 'Unknown',
      rating: seasonPlupr,
      avatar_id: m.profile?.avatar_id ?? 1,
      avatar_url: m.profile?.avatar_url ?? null,
      wins, losses,
      total_matches_played: m.profile?.total_matches_played ?? 0,
    };
  }).sort((a, b) =>
    (b.rating - a.rating) ||
    ((b.wins - b.losses) - (a.wins - a.losses)) ||
    (b.wins - a.wins)
  );
}

// PLUPR rank bonuses for end-of-period soft reset. Mirrors the SQL trigger.
function bonusForRank(rank: number): number {
  switch (rank) {
    case 1: return 0.20;
    case 2: return 0.15;
    case 3: return 0.10;
    case 4: return 0.05;
    case 5: return 0.02;
    default: return 0;
  }
}

// Median-rank final standings derived from period snapshots (locked or computed).
// elo_bonus and new_elo are derived from the season baseline + the bonus
// associated with each player's final_rank, matching the SQL complete_season
// reset logic.
function computeMedianFinals(
  periods: SnapshotPeriod[],
  members: any[],
  leagueId: string,
  seasonId: string,
  baseline: number,
): SeasonFinalStanding[] {
  // Collect each member's ranks across all periods.
  const ranks: Record<string, number[]> = {};
  for (const period of periods) {
    for (const row of period.rows) {
      if (!ranks[row.user_id]) ranks[row.user_id] = [];
      ranks[row.user_id].push(row.rank_at_snapshot);
    }
  }
  function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[Math.floor(mid)];
  }
  const memberProfileById = new Map(members.map(m => [m.user_id, m.profile]));

  const ranked = Object.entries(ranks)
    .map(([user_id, rs]) => ({ user_id, median_rank: median(rs) }))
    .sort((a, b) => a.median_rank - b.median_rank);

  return ranked.map((r, i) => {
    const finalRank = i + 1;
    const bonus = bonusForRank(finalRank);
    return {
      id: `computed-final-${r.user_id}`,
      season_id: seasonId,
      league_id: leagueId,
      user_id: r.user_id,
      final_rank: finalRank,
      median_rank: r.median_rank,
      elo_bonus: bonus,
      new_elo: baseline + bonus,
      profile: memberProfileById.get(r.user_id) ?? undefined,
    };
  });
}

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SeasonStandings'>;
  route: RouteProp<RootStackParamList, 'SeasonStandings'>;
};

type LiveRow = {
  user_id: string; full_name: string; rating: number;
  avatar_id: number; avatar_url: string | null;
  wins: number; losses: number;
  total_matches_played: number;
};

type SnapshotPeriod = {
  periodNumber: number;
  date: string;
  rows: SeasonSnapshot[];
  // True when the row comes from season_snapshots; false when computed
  // on-the-fly from match data for a period that hasn't been locked yet.
  locked: boolean;
};

// Minimal shape the "Wager Market" panel needs from a row — a player + their
// current PLUPR. Used for both period rows (elo_at_snapshot) and final rows
// (new_elo). Sort key is `plupr` desc.
type MarketRow = {
  user_id: string;
  full_name: string;
  avatar_id: number;
  avatar_url: string | null;
  plupr: number;
};

const MARKET_RANKS = [1, 2, 3] as const;
const MARKET_RANK_LABELS: Record<(typeof MARKET_RANKS)[number], string> = {
  1: '🥇 1st',
  2: '🥈 2nd',
  3: '🥉 3rd',
};
const MARKET_TOP_N = 12;

export default function SeasonStandingsScreen({ navigation, route }: Props) {
  const { seasonId, leagueId, leagueName } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [season, setSeason]           = useState<LeagueSeason | null>(null);
  const [potMembers, setPotMembers]   = useState<{ id: string; full_name: string }[]>([]);
  const [periods, setPeriods]         = useState<SnapshotPeriod[]>([]);
  const [finals, setFinals]           = useState<SeasonFinalStanding[]>([]);
  const [myRole, setMyRole]           = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [locking, setLocking]         = useState(false);
  const [completing, setCompleting]   = useState(false);
  // null until first load completes — load() seeds it to the live period (or Final if completed).
  const [activeTab, setActiveTab]     = useState<number | 'final' | null>(null);

  const [lockConfirmOpen, setLockConfirmOpen]         = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);

  // Long-press → ActionSheet → optional WagerProposeModal. `periodNumber`
  // is null when the row comes from the Final-standings tab (season_rank).
  type RowContext = {
    userId: string;
    fullName: string;
    rank: number;
    periodNumber: number | null;
  };
  const [rowSheetOpen, setRowSheetOpen]       = useState(false);
  const [rowContext, setRowContext]           = useState<RowContext | null>(null);
  const [wagerModalOpen, setWagerModalOpen]   = useState(false);
  const [wagerSubject, setWagerSubject]       = useState<WagerSubject | null>(null);

  // "🎲 Wager Market" panel — collapsed by default, with an optional
  // "Show all" toggle when the league has more than MARKET_TOP_N members.
  const [marketExpanded, setMarketExpanded] = useState(false);
  const [marketShowAll, setMarketShowAll]   = useState(false);

  function openRowSheet(ctx: RowContext) {
    setRowContext(ctx);
    setRowSheetOpen(true);
  }

  const status = useStatusMessage();

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const [seasonRes, snapshotsRes, finalsRes, role, membersRes, matchesRes] = await Promise.all([
      supabase.from('league_seasons').select('*').eq('id', seasonId).single(),
      supabase.from('season_snapshots')
        .select('*, profile:profiles(full_name, avatar_id, avatar_url)')
        .eq('season_id', seasonId)
        .order('period_number').order('rank_at_snapshot'),
      supabase.from('season_final_standings')
        .select('*, profile:profiles(full_name, avatar_id, avatar_url)')
        .eq('season_id', seasonId)
        .order('final_rank'),
      getLeagueRole(leagueId),
      supabase.from('league_members')
        .select('user_id, profile:profiles(full_name, rating, avatar_id, avatar_url, total_matches_played)')
        .eq('league_id', leagueId),
      // Pull every in-league match (date + winner + per-team PLUPR deltas).
      // We re-filter client-side per-period and for the live tab. The
      // rating_before/after columns drive the per-player season PLUPR.
      supabase.from('matches')
        .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, played_at, game_scores,'
              + ' player1_rating_before, player1_rating_after,'
              + ' player2_rating_before, player2_rating_after')
        .eq('league_id', leagueId),
    ]);

    const s = seasonRes.data as LeagueSeason;
    setSeason(s);
    setMyRole(role);

    const members = (membersRes.data ?? []) as any[];
    const allMatches = (matchesRes.data ?? []) as any[];

    // Baseline PLUPR — soft-reset target everyone snaps to at period end.
    const baseline = Number((s as any)?.baseline_plupr ?? 3.5);

    // Pot members list (id + name) is all the PicklePotCard needs.
    setPotMembers(members.map(m => ({
      id: m.user_id,
      full_name: m.profile?.full_name ?? 'Unknown',
    })));

    const todayIsoDate = new Date().toISOString().slice(0, 10);

    // Group locked snapshots by period
    const lockedByPeriod = new Map<number, SeasonSnapshot[]>();
    for (const row of (snapshotsRes.data ?? []) as SeasonSnapshot[]) {
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
          // Re-shape into SeasonSnapshot rows so the existing renderer just works.
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
            profile: { full_name: r.full_name, avatar_id: r.avatar_id, avatar_url: r.avatar_url },
          }));
          allPeriods.push({ periodNumber: p, date: snapshotDate, rows: synthRows, locked: false });
        }
      }
    }
    setPeriods(allPeriods);

    // Final standings: prefer the locked rows if they exist; otherwise compute
    // median rank across all periods (locked + computed).
    const storedFinals = (finalsRes.data ?? []) as SeasonFinalStanding[];
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
      // First non-locked period whose snapshot date hasn't passed = the live period.
      for (let p = 1; p <= (s?.total_periods ?? 0); p++) {
        if (lockedByPeriod.has(p)) continue;
        const periodEnd = computePeriodDate(s, p);
        if (todayIsoDate > periodEnd) continue;
        return p;
      }
      return s?.total_periods ?? 1;
    });

    setLoading(false);
  }

  // ── Admin actions ─────────────────────────────────────────────

  function nextPeriodNumber(): number {
    const lockedOnly = periods.filter(p => p.locked);
    if (lockedOnly.length === 0) return 1;
    return Math.max(...lockedOnly.map(p => p.periodNumber)) + 1;
  }

  function canLock(): boolean {
    if (!season || !isPrivileged(myRole as any)) return false;
    if (season.status === 'completed') return false;
    const n = nextPeriodNumber();
    if (n > season.total_periods) return false;
    // Due date for period n
    const start = new Date(season.start_date + 'T00:00:00');
    const due   = new Date(start.getTime() + n * season.lock_frequency_weeks * 7 * 86400000);
    return new Date() >= due;
  }

  function canComplete(): boolean {
    if (!season || !isPrivileged(myRole as any)) return false;
    if (season.elo_reset_applied) return false;
    return periods.some(p => p.locked);
  }

  async function doLockPeriod() {
    if (!season) return;
    const n = nextPeriodNumber();
    setLocking(true);
    const today = new Date().toISOString().split('T')[0];
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

  function fmtDate(iso: string) {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function periodDueDate(n: number): string {
    if (!season) return '';
    const d = new Date(season.start_date + 'T00:00:00');
    d.setDate(d.getDate() + n * season.lock_frequency_weeks * 7);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function AvatarCell({ avatarId, avatarUrl }: { avatarId: number; avatarUrl: string | null }) {
    const av = AVATARS.find(a => a.id === avatarId) ?? AVATARS[0];
    return (
      <View style={[S.av, { backgroundColor: av.bgColor }]}>
        <Text style={S.avEmoji}>{av.emoji}</Text>
      </View>
    );
  }

  // `periodNumber === null` ⇒ season_rank subject; otherwise period_rank.
  function buildRankSubject(args: {
    userId: string; userName: string; rank: number; periodNumber: number | null;
  }): WagerSubject {
    return args.periodNumber === null
      ? {
          type: 'season_rank',
          seasonId,
          userId: args.userId,
          userName: args.userName,
          rank: args.rank,
        }
      : {
          type: 'period_rank',
          seasonId,
          periodNumber: args.periodNumber,
          userId: args.userId,
          userName: args.userName,
          rank: args.rank,
        };
  }

  function openWagerForSubject(subject: WagerSubject) {
    setWagerSubject(subject);
    setWagerModalOpen(true);
  }

  // Shared renderer for the "🎲 Wager Market" panel.
  // - `periodNumber === null` builds season_rank subjects, else period_rank.
  // - Rows are pre-sorted by PLUPR desc, capped to MARKET_TOP_N unless
  //   the user has tapped "Show all".
  function renderWagerMarket(rows: MarketRow[], periodNumber: number | null) {
    if (rows.length === 0) return null;
    const scopeLabel = periodNumber === null
      ? 'Final season standings'
      : `Period ${periodNumber} standings`;
    // Defer sort + slice until the panel is actually expanded.
    const sorted   = marketExpanded ? [...rows].sort((a, b) => b.plupr - a.plupr) : [];
    const overflow = sorted.length > MARKET_TOP_N;
    const visible  = marketShowAll || !overflow ? sorted : sorted.slice(0, MARKET_TOP_N);
    return (
      <View style={S.marketCard}>
        <TouchableOpacity
          style={S.marketHeader}
          onPress={() => setMarketExpanded(v => !v)}
          activeOpacity={0.7}
        >
          <View style={S.marketHeaderText}>
            <Text style={S.marketTitle}>🎲 Wager Market</Text>
            <Text style={S.marketSubtitle}>
              {scopeLabel} · tap any cell to wager on a rank
            </Text>
          </View>
          <Text style={S.marketChevron}>{marketExpanded ? '▾' : '▸'}</Text>
        </TouchableOpacity>

        {marketExpanded && (
          <View style={S.marketBody}>
            <View style={S.marketTableHeader}>
              <Text style={[S.marketTh, S.marketThName]}>Player</Text>
              {MARKET_RANKS.map(r => (
                <Text key={r} style={S.marketTh}>{MARKET_RANK_LABELS[r]}</Text>
              ))}
            </View>
            {visible.map((row, i) => (
              <View key={row.user_id} style={[S.marketRow, i % 2 === 0 && S.marketRowAlt]}>
                <View style={S.marketNameCell}>
                  <AvatarCell avatarId={row.avatar_id} avatarUrl={row.avatar_url} />
                  <Text style={S.marketName} numberOfLines={1}>{row.full_name}</Text>
                </View>
                {MARKET_RANKS.map(rank => (
                  <TouchableOpacity
                    key={rank}
                    style={S.marketCell}
                    onPress={() => openWagerForSubject(buildRankSubject({
                      userId: row.user_id,
                      userName: row.full_name,
                      rank,
                      periodNumber,
                    }))}
                  >
                    <Text style={S.marketCellText}>🎲</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ))}
            {overflow && (
              <TouchableOpacity
                style={S.marketShowAll}
                onPress={() => setMarketShowAll(v => !v)}
              >
                <Text style={S.marketShowAllText}>
                  {marketShowAll ? 'Show top 12' : `Show all ${sorted.length}`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  }

  // ── Render sections ───────────────────────────────────────────

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;
  if (!season) return <Text style={S.empty}>Season not found.</Text>;

  const lockedCount    = periods.filter(p => p.locked).length;
  const totalPeriods   = season.total_periods;
  const nextPeriod     = nextPeriodNumber();
  // Finals are "real" only when every period is locked AND the DB has rows.
  // Otherwise it's a historical preview computed from match data.
  const finalsAreComputed = !(lockedCount >= totalPeriods && season.status === 'completed');

  // The live period is the first non-locked period whose end date hasn't passed.
  // Used for tab highlighting and the "Live" header label.
  const todayDateOnly = new Date().toISOString().slice(0, 10);
  const livePeriodNumber: number | null = (() => {
    if (season.status === 'completed') return null;
    for (let p = 1; p <= totalPeriods; p++) {
      if (periods.find(x => x.periodNumber === p)?.locked) continue;
      const periodEnd = computePeriodDate(season, p);
      if (todayDateOnly > periodEnd) continue;
      return p;
    }
    return null;
  })();

  const statusColor = season.status === 'completed' ? colors.textMuted
                    : season.status === 'active'    ? colors.primary
                    :                                 '#e65100';

  return (
    <ScrollView contentContainerStyle={S.container}>

      <StatusBanner status={status.value} style={{ marginTop: 0 }} />

      {/* ── Season header ──────────────────────────────────────── */}
      <View style={S.headerCard}>
        <View style={S.headerTop}>
          <Text style={S.seasonName}>{season.name}</Text>
          <View style={[S.statusBadge, { backgroundColor: statusColor + '22' }]}>
            <Text style={[S.statusText, { color: statusColor }]}>
              {season.status.charAt(0).toUpperCase() + season.status.slice(1)}
            </Text>
          </View>
        </View>
        <Text style={S.seasonDates}>
          {fmtDate(season.start_date)} → {fmtDate(season.end_date)}
        </Text>
        <Text style={S.seasonMeta}>
          {season.total_weeks} weeks · lock-in every {season.lock_frequency_weeks} week{season.lock_frequency_weeks > 1 ? 's' : ''} · {totalPeriods} periods
        </Text>

        {/* Period progress dots */}
        <View style={S.dotsRow}>
          {Array.from({ length: totalPeriods }, (_, i) => {
            const locked = i + 1 <= lockedCount;
            return (
              <View key={i} style={[S.dot, locked ? S.dotLocked : S.dotOpen]}>
                <Text style={[S.dotText, locked && S.dotTextLocked]}>{i + 1}</Text>
              </View>
            );
          })}
          <Text style={S.dotsLabel}>{lockedCount}/{totalPeriods} periods locked</Text>
        </View>

        {/* Next lock-in info */}
        {season.status !== 'completed' && nextPeriod <= totalPeriods && (
          <Text style={S.nextLock}>
            Period {nextPeriod} lock-in: {periodDueDate(nextPeriod)}
          </Text>
        )}
      </View>

      {/* ── Pickle pot ─────────────────────────────────────────── */}
      <PicklePotCard
        scopeType="season"
        scopeId={seasonId}
        scopeLabel="Season"
        pool={season.prize_pool ?? 0}
        structure={season.payout_structure ?? [60, 25, 15]}
        isAdmin={isPrivileged(myRole as any)}
        canDistribute={finals.length > 0}
        members={potMembers}
        onChange={() => load()}
      />

      {/* ── Admin action bar ───────────────────────────────────── */}
      {isPrivileged(myRole as any) && (
        <View style={S.adminBar}>
          {canLock() && (
            <TouchableOpacity
              style={[S.adminBtn, S.adminBtnGreen]}
              onPress={() => setLockConfirmOpen(true)}
              disabled={locking}
            >
              <Text style={S.adminBtnTextLight}>
                {locking ? 'Locking…' : `🔒 Lock Period ${nextPeriod}`}
              </Text>
            </TouchableOpacity>
          )}
          {!canLock() && season.status !== 'completed' && nextPeriod <= totalPeriods && (
            <View style={S.adminInfoPill}>
              <Text style={S.adminInfoText}>
                Period {nextPeriod} due {periodDueDate(nextPeriod)}
              </Text>
            </View>
          )}
          {canComplete() && (
            <TouchableOpacity
              style={[S.adminBtn, S.adminBtnRed]}
              onPress={() => setCompleteConfirmOpen(true)}
              disabled={completing}
            >
              <Text style={S.adminBtnTextLight}>
                {completing ? 'Completing…' : '🏆 Complete Season'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Baseline reset banner ──────────────────────────────── */}
      {season && (
        <View style={S.baselineBanner}>
          <Text style={S.baselineBannerText}>
            🎯 Baseline PLUPR{' '}
            <Text style={S.baselineBannerValue}>
              {Number((season as any).baseline_plupr ?? 3.5).toFixed(2)}
            </Text>
            {'  '}— everyone soft-resets to this at the end of each period (top-5 finishers keep a small bonus).
            {'\n'}Standings PLUPR is computed from this season's in-league matches only.
          </Text>
        </View>
      )}

      {/* ── Tab strip ──────────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.tabScroll}>
        <View style={S.tabs}>
          {periods.map(p => {
            const isLive     = p.periodNumber === livePeriodNumber;
            const isSelected = activeTab === p.periodNumber;
            return (
              <TouchableOpacity
                key={p.periodNumber}
                style={[
                  S.tab,
                  isLive && S.tabLive,
                  isSelected && S.tabActive,
                ]}
                onPress={() => setActiveTab(p.periodNumber)}
              >
                <Text style={[
                  S.tabText,
                  isLive && !isSelected && S.tabTextLive,
                  isSelected && S.tabTextActive,
                ]}>
                  P{p.periodNumber}{isLive ? ' • Live' : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
          {(finals.length > 0 || season.status === 'completed') && (
            <TouchableOpacity
              style={[S.tab, activeTab === 'final' && S.tabActive, S.tabFinal]}
              onPress={() => setActiveTab('final')}
            >
              <Text style={[S.tabText, activeTab === 'final' && S.tabTextActive]}>🏆 Final</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {/* ── Period snapshot ────────────────────────────────────── */}
      {typeof activeTab === 'number' && (() => {
        const period = periods.find(p => p.periodNumber === activeTab);
        if (!period) return null;
        const baseline = Number((season as any)?.baseline_plupr ?? 3.5);
        const pStart   = periodStartDate(season, period.periodNumber);
        // A period is "future" only if its START hasn't happened yet.
        const isFuture = !period.locked && pStart > todayDateOnly;
        const isLive   = !period.locked && !isFuture && period.periodNumber === livePeriodNumber;

        // Period market rows — PLUPR drives the sort.
        const marketRows: MarketRow[] = !isFuture
          ? period.rows.map(r => ({
              user_id: r.user_id,
              full_name: r.profile?.full_name ?? 'Unknown',
              avatar_id: r.profile?.avatar_id ?? 1,
              avatar_url: r.profile?.avatar_url ?? null,
              plupr: Number(r.elo_at_snapshot ?? baseline),
            }))
          : [];

        // Future periods haven't started yet — no PLUPRs to display.
        if (isFuture) {
          return (
            <View style={S.tableCard}>
              <Text style={S.tableTitle}>
                Period {period.periodNumber} — Upcoming
              </Text>
              <Text style={S.tableSubtitle}>
                Starts {fmtDate(pStart)} · locks in {fmtDate(period.date)}. Standings TBD.
              </Text>
              <View style={[S.bonusLegend, { marginTop: 0 }]}>
                <Text style={S.bonusLegendTitle}>
                  Rank Bonuses Applied (baseline {baseline.toFixed(2)} PLUPR)
                </Text>
                {[
                  { rank: '🥇 #1', bonus: 0.20 },
                  { rank: '🥈 #2', bonus: 0.15 },
                  { rank: '🥉 #3', bonus: 0.10 },
                  { rank: '4th',   bonus: 0.05 },
                  { rank: '5th',   bonus: 0.02 },
                ].map(b => (
                  <Text key={b.rank} style={S.bonusLine}>
                    {b.rank} → {baseline.toFixed(2)} + {b.bonus.toFixed(2)} = {(baseline + b.bonus).toFixed(2)} PLUPR
                  </Text>
                ))}
                <Text style={S.bonusNote}>
                  All others reset to {baseline.toFixed(2)} PLUPR · ranks TBD
                </Text>
              </View>
            </View>
          );
        }

        const headerSuffix = period.locked
          ? '— Locked In'
          : isLive
            ? '— Live'
            : '— Historical Preview';
        const subtitle = period.locked
          ? `Locked ${fmtDate(period.date)}`
          : isLive
            ? `In progress · ${fmtDate(pStart)} → ${fmtDate(period.date)} · W/L from matches played so far`
            : `Computed from matches played ${fmtDate(pStart)} → ${fmtDate(period.date)} — not yet locked in`;

        return (
          <>
          <View style={S.tableCard}>
            <Text style={S.tableTitle}>
              Period {period.periodNumber} {headerSuffix}
            </Text>
            <Text style={S.tableSubtitle}>{subtitle}</Text>
            <View style={S.tableHeader}>
              <Text style={[S.th, S.thRank]}>#</Text>
              <Text style={[S.th, S.thName]}>Player</Text>
              <Text style={S.th}>W</Text>
              <Text style={S.th}>L</Text>
              <Text style={S.th}>STARTING PLUPR</Text>
              <Text style={S.th}>PLUPR</Text>
            </View>
            {period.rows.map((row, i) => {
              const bonus = bonusForRank(row.rank_at_snapshot);
              const newPlupr = baseline + bonus;
              return (
                <TouchableOpacity
                  key={row.user_id}
                  style={[S.tableRow, i % 2 === 0 && S.tableRowAlt]}
                  onPress={() => navigation.navigate('PlayerProfile', { userId: row.user_id, userName: row.profile?.full_name ?? '' })}
                  onLongPress={() => openRowSheet({
                    userId: row.user_id,
                    fullName: row.profile?.full_name ?? 'Unknown',
                    rank: row.rank_at_snapshot,
                    periodNumber: period.periodNumber,
                  })}
                >
                  <Text style={[S.td, S.tdRank]}>
                    {MEDALS[row.rank_at_snapshot - 1] ?? `${row.rank_at_snapshot}`}
                  </Text>
                  <View style={S.tdNameCell}>
                    <AvatarCell avatarId={row.profile?.avatar_id ?? 1} avatarUrl={row.profile?.avatar_url ?? null} />
                    <Text style={S.tdName} numberOfLines={1}>{row.profile?.full_name ?? '?'}</Text>
                  </View>
                  <Text style={[S.td, S.tdWin]}>{row.wins_in_season}</Text>
                  <Text style={[S.td, S.tdLoss]}>{row.losses_in_season}</Text>
                  <Text style={[S.td, S.tdNewElo]}>{newPlupr.toFixed(2)}</Text>
                  <Text style={S.td}>{Number(row.elo_at_snapshot ?? baseline).toFixed(2)}</Text>
                </TouchableOpacity>
              );
            })}

            {/* Rank Bonuses legend — same shape as the final-standings tab. */}
            <View style={S.bonusLegend}>
              <Text style={S.bonusLegendTitle}>
                Rank Bonuses Applied (baseline {baseline.toFixed(2)} PLUPR)
              </Text>
              {[
                { rank: '🥇 #1', bonus: 0.20 },
                { rank: '🥈 #2', bonus: 0.15 },
                { rank: '🥉 #3', bonus: 0.10 },
                { rank: '4th',   bonus: 0.05 },
                { rank: '5th',   bonus: 0.02 },
              ].map(b => (
                <Text key={b.rank} style={S.bonusLine}>
                  {b.rank} → {baseline.toFixed(2)} + {b.bonus.toFixed(2)} = {(baseline + b.bonus).toFixed(2)} PLUPR
                </Text>
              ))}
              <Text style={S.bonusNote}>
                All others reset to {baseline.toFixed(2)} PLUPR
              </Text>
            </View>
          </View>
          {renderWagerMarket(marketRows, period.periodNumber)}
          </>
        );
      })()}

      {/* ── Final standings ────────────────────────────────────── */}
      {activeTab === 'final' && (
        <>
        <View style={S.tableCard}>
          <Text style={S.tableTitle}>
            🏆 {finalsAreComputed ? 'Final Standings — Historical Preview' : 'Final Season Standings'}
          </Text>
          <Text style={S.tableSubtitle}>
            {finalsAreComputed
              ? `Ranked by median position across ${totalPeriods} period${totalPeriods !== 1 ? 's' : ''} (computed from match data — season not yet completed)`
              : `Ranked by median position across ${lockedCount} locked period${lockedCount !== 1 ? 's' : ''}`}
          </Text>
          {finals.length === 0 ? (
            <Text style={S.empty}>No matches recorded yet this season.</Text>
          ) : (
            <>
              <View style={S.tableHeader}>
                <Text style={[S.th, S.thRank]}>#</Text>
                <Text style={[S.th, S.thName]}>Player</Text>
                <Text style={S.th}>Median</Text>
                <Text style={S.th}>Bonus</Text>
                <Text style={S.th}>New PLUPR</Text>
              </View>
              {finals.map((row, i) => (
                <TouchableOpacity
                  key={row.user_id}
                  style={[S.tableRow, i % 2 === 0 && S.tableRowAlt]}
                  onPress={() => navigation.navigate('PlayerProfile', { userId: row.user_id, userName: row.profile?.full_name ?? '' })}
                  onLongPress={() => openRowSheet({
                    userId: row.user_id,
                    fullName: row.profile?.full_name ?? 'Unknown',
                    rank: row.final_rank,
                    periodNumber: null,
                  })}
                >
                  <Text style={[S.td, S.tdRank]}>
                    {MEDALS[row.final_rank - 1] ?? `${row.final_rank}`}
                  </Text>
                  <View style={S.tdNameCell}>
                    <AvatarCell avatarId={row.profile?.avatar_id ?? 1} avatarUrl={row.profile?.avatar_url ?? null} />
                    <Text style={S.tdName} numberOfLines={1}>{row.profile?.full_name ?? '?'}</Text>
                  </View>
                  <Text style={S.td}>{row.median_rank.toFixed(1)}</Text>
                  <Text style={[S.td, row.elo_bonus > 0 && S.tdBonus]}>
                    {row.elo_bonus > 0 ? `+${Number(row.elo_bonus).toFixed(2)}` : '—'}
                  </Text>
                  <Text style={[S.td, S.tdNewElo]}>
                    {Number(row.new_elo ?? Number((season as any)?.baseline_plupr ?? 3.5)).toFixed(2)}
                  </Text>
                </TouchableOpacity>
              ))}

              {/* PLUPR reset legend — anchored to this season's baseline. */}
              {(() => {
                const baseline = Number((season as any)?.baseline_plupr ?? 3.5);
                const bonuses = [
                  { rank: '🥇 #1', bonus: 0.20 },
                  { rank: '🥈 #2', bonus: 0.15 },
                  { rank: '🥉 #3', bonus: 0.10 },
                  { rank: '4th',   bonus: 0.05 },
                  { rank: '5th',   bonus: 0.02 },
                ];
                return (
                  <View style={S.bonusLegend}>
                    <Text style={S.bonusLegendTitle}>
                      Rank Bonuses Applied (baseline {baseline.toFixed(2)} PLUPR)
                    </Text>
                    {bonuses.map(b => (
                      <Text key={b.rank} style={S.bonusLine}>
                        {b.rank} → {baseline.toFixed(2)} + {b.bonus.toFixed(2)} = {(baseline + b.bonus).toFixed(2)} PLUPR
                      </Text>
                    ))}
                    <Text style={S.bonusNote}>
                      All others reset to {baseline.toFixed(2)} PLUPR
                    </Text>
                  </View>
                );
              })()}
            </>
          )}
        </View>
        {renderWagerMarket(
          finals.map(r => ({
            user_id: r.user_id,
            full_name: r.profile?.full_name ?? 'Unknown',
            avatar_id: r.profile?.avatar_id ?? 1,
            avatar_url: r.profile?.avatar_url ?? null,
            plupr: Number(r.new_elo ?? Number((season as any)?.baseline_plupr ?? 3.5)),
          })),
          null,
        )}
        </>
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
        body={'This will:\n• Compute final standings from median ranks\n• Reset all participating players\' global PLUPR to 3.25 + rank bonus\n• Mark the season as completed\n\n⚠️ This cannot be undone.'}
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
          {
            label: `🎲 Wager: ${rowContext.fullName} finishes #${rowContext.rank}`,
            onPress: () => openWagerForSubject(buildRankSubject({
              userId: rowContext.userId,
              userName: rowContext.fullName,
              rank: rowContext.rank,
              periodNumber: rowContext.periodNumber,
            })),
          },
        ] : []}
        onClose={() => setRowSheetOpen(false)}
      />

      {wagerSubject !== null && (
        <WagerProposeModal
          visible={wagerModalOpen}
          subject={wagerSubject}
          onClose={() => setWagerModalOpen(false)}
        />
      )}

    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:      { padding: 16, paddingBottom: 40, backgroundColor: c.bg },
    empty:          { color: c.textMuted, textAlign: 'center', marginTop: 16, fontSize: 14 },

    // Header card
    headerCard:     { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    headerTop:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    seasonName:     { fontSize: 20, fontWeight: '800', color: c.text, flex: 1 },
    statusBadge:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, marginLeft: 8 },
    statusText:     { fontSize: 12, fontWeight: '700' },
    seasonDates:    { fontSize: 13, color: c.textSub, marginBottom: 2 },
    seasonMeta:     { fontSize: 12, color: c.textMuted, marginBottom: 12 },
    dotsRow:        { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    dot:            { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.border, backgroundColor: c.bg },
    dotLocked:      { backgroundColor: c.primary, borderColor: c.primary },
    dotOpen:        {},
    dotText:        { fontSize: 11, fontWeight: '700', color: c.textMuted },
    dotTextLocked:  { color: '#fff' },
    dotsLabel:      { fontSize: 12, color: c.textMuted, marginLeft: 4 },
    nextLock:       { fontSize: 12, color: '#e65100', marginTop: 8, fontWeight: '600' },

    // Admin bar
    adminBar:       { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
    adminBtn:       { flex: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', minWidth: 140 },
    adminBtnGreen:  { backgroundColor: c.primary },
    adminBtnRed:    { backgroundColor: c.danger },
    adminBtnTextLight: { color: '#fff', fontWeight: '700', fontSize: 14 },
    adminInfoPill:  { flex: 1, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt, alignItems: 'center' },
    adminInfoText:  { fontSize: 13, color: c.textMuted },

    // Tab strip
    tabScroll:      { marginBottom: 12 },
    tabs:           { flexDirection: 'row', gap: 6 },
    baselineBanner: { backgroundColor: c.primaryLight, borderColor: c.primary, borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 },
    baselineBannerText: { fontSize: 12, color: c.textSub, lineHeight: 17 },
    baselineBannerValue:{ fontWeight: '800', color: c.primary, fontSize: 13 },
    tab:            { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.border },
    tabActive:      { backgroundColor: c.primary, borderColor: c.primary },
    tabLive:        { borderColor: '#e65100', borderWidth: 2, backgroundColor: '#fff3e0' },
    tabFinal:       { borderColor: '#ffd700' },
    tabText:        { fontSize: 13, fontWeight: '600', color: c.textSub },
    tabTextActive:  { color: '#fff' },
    tabTextLive:    { color: '#e65100', fontWeight: '800' },

    // Table
    tableCard:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    tableTitle:     { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 2 },
    tableSubtitle:  { fontSize: 12, color: c.textMuted, marginBottom: 12 },
    tableHeader:    { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1.5, borderBottomColor: c.border, marginBottom: 4 },
    tableRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.bg },
    tableRowAlt:    { backgroundColor: c.surfaceAlt },
    th:             { flex: 1, fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', textAlign: 'center' },
    thRank:         { flex: 0.6, textAlign: 'left' },
    thName:         { flex: 3, textAlign: 'left' },
    td:             { flex: 1, fontSize: 14, color: c.text, textAlign: 'center' },
    tdRank:         { flex: 0.6, fontSize: 18 },
    tdNameCell:     { flex: 3, flexDirection: 'row', alignItems: 'center', gap: 8 },
    tdName:         { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
    tdWin:          { color: c.primary, fontWeight: '700' },
    tdLoss:         { color: c.danger },
    tdBonus:        { color: c.primary, fontWeight: '700' },
    tdNewElo:       { fontWeight: '700', color: c.text },

    // Avatar
    av:             { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    avEmoji:        { fontSize: 16 },

    // Bonus legend
    bonusLegend:    { marginTop: 16, padding: 12, backgroundColor: c.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: c.border },
    bonusLegendTitle:{ fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
    bonusLine:      { fontSize: 13, color: c.textSub, marginBottom: 2 },
    bonusNote:      { fontSize: 12, color: c.textMuted, marginTop: 4 },

    // "🎲 Wager Market" panel
    marketCard:        { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    marketHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    marketHeaderText:  { flex: 1 },
    marketTitle:       { fontSize: 15, fontWeight: '800', color: c.text },
    marketSubtitle:    { fontSize: 12, color: c.textMuted, marginTop: 2 },
    marketChevron:     { fontSize: 16, color: c.textSub, marginLeft: 10, fontWeight: '700' },
    marketBody:        { marginTop: 10 },
    marketTableHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1.5, borderBottomColor: c.border },
    marketTh:          { flex: 1, fontSize: 11, fontWeight: '700', color: c.textMuted, textAlign: 'center' },
    marketThName:      { flex: 2.4, textAlign: 'left' },
    marketRow:         { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.bg },
    marketRowAlt:      { backgroundColor: c.surfaceAlt },
    marketNameCell:    { flex: 2.4, flexDirection: 'row', alignItems: 'center', gap: 8 },
    marketName:        { flex: 1, fontSize: 13, fontWeight: '600', color: c.text },
    marketCell:        { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, marginHorizontal: 2, borderRadius: 8, backgroundColor: c.primaryLight, borderWidth: 1, borderColor: c.border },
    marketCellText:    { fontSize: 16 },
    marketShowAll:     { marginTop: 10, alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
    marketShowAllText: { fontSize: 12, fontWeight: '700', color: c.textSub },

    // Live-tab info cards
    infoCard:       { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    infoTitle:      { fontSize: 14, fontWeight: '800', color: c.text, marginBottom: 6 },
    infoBody:       { fontSize: 13, color: c.textSub, lineHeight: 19 },
    infoBold:       { fontWeight: '700', color: c.text },
    bonusList:      { marginTop: 8, paddingLeft: 4 },
    badgePrevRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
    badgePrevIcon:  { fontSize: 26, width: 32, textAlign: 'center' },
    badgePrevName:  { fontSize: 14, fontWeight: '700', color: c.text },
    badgePrevDesc:  { fontSize: 12, color: c.textMuted, marginTop: 1 },
  });
}

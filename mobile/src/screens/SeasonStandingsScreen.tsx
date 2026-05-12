import React, { useCallback, useState } from 'react';
import {
  ScrollView, View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert,
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
import { formatPlupr } from '../lib/plupr';

const MEDALS = ['🥇', '🥈', '🥉'];

// Local ISO date "YYYY-MM-DD" for a period N relative to a season's start.
function computePeriodDate(s: { start_date: string; lock_frequency_weeks: number }, periodNumber: number): string {
  const d = new Date(s.start_date + 'T00:00:00');
  d.setDate(d.getDate() + periodNumber * s.lock_frequency_weeks * 7);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Compute W-L standings for league members against a match list, optionally
// windowed by [startIso, endIso] on played_at. Sorts PLUPR desc → (W-L) desc → W desc.
function computeStandings(
  members: any[],
  matches: any[],
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
    const wins = inRange.filter(x =>
      (x.player1_id  === uid && x.winner_team === 'team1') ||
      (x.partner1_id === uid && x.winner_team === 'team1') ||
      (x.player2_id  === uid && x.winner_team === 'team2') ||
      (x.partner2_id === uid && x.winner_team === 'team2')
    ).length;
    const losses = inRange.filter(x =>
      (x.player1_id  === uid && x.winner_team === 'team2') ||
      (x.partner1_id === uid && x.winner_team === 'team2') ||
      (x.player2_id  === uid && x.winner_team === 'team1') ||
      (x.partner2_id === uid && x.winner_team === 'team1')
    ).length;
    return {
      user_id: uid,
      full_name: m.profile?.full_name ?? 'Unknown',
      rating: m.profile?.rating ?? 3.25,
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

// Median-rank final standings derived from period snapshots (locked or computed).
function computeMedianFinals(
  periods: SnapshotPeriod[],
  members: any[],
  leagueId: string,
  seasonId: string,
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

  return ranked.map((r, i) => ({
    id: `computed-final-${r.user_id}`,
    season_id: seasonId,
    league_id: leagueId,
    user_id: r.user_id,
    final_rank: i + 1,
    median_rank: r.median_rank,
    elo_bonus: 0,
    new_elo: 3.25,
    profile: memberProfileById.get(r.user_id) ?? undefined,
  }));
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

export default function SeasonStandingsScreen({ navigation, route }: Props) {
  const { seasonId, leagueId, leagueName } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [season, setSeason]           = useState<LeagueSeason | null>(null);
  const [live, setLive]               = useState<LiveRow[]>([]);
  const [periods, setPeriods]         = useState<SnapshotPeriod[]>([]);
  const [finals, setFinals]           = useState<SeasonFinalStanding[]>([]);
  const [myRole, setMyRole]           = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [locking, setLocking]         = useState(false);
  const [completing, setCompleting]   = useState(false);
  const [activeTab, setActiveTab]     = useState<'live' | number | 'final'>('live');

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
      // Pull every league match (date + winner). We'll re-filter client-side
      // per-period and for the live tab.
      supabase.from('matches')
        .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, played_at')
        .eq('league_id', leagueId),
    ]);

    const s = seasonRes.data as LeagueSeason;
    setSeason(s);
    setMyRole(role);

    const members = (membersRes.data ?? []) as any[];
    const allMatches = (matchesRes.data ?? []) as any[];

    // Live = matches from season start through now
    const todayIso = new Date().toISOString();
    setLive(computeStandings(members, allMatches, s?.start_date, todayIso));

    // Group locked snapshots by period
    const lockedByPeriod = new Map<number, SeasonSnapshot[]>();
    for (const row of (snapshotsRes.data ?? []) as SeasonSnapshot[]) {
      if (!lockedByPeriod.has(row.period_number)) lockedByPeriod.set(row.period_number, []);
      lockedByPeriod.get(row.period_number)!.push(row);
    }

    // Build ALL period tabs (locked use snapshot rows; unlocked are computed
    // on-the-fly from match data filtered by snapshot date).
    const allPeriods: SnapshotPeriod[] = [];
    if (s) {
      for (let p = 1; p <= s.total_periods; p++) {
        const snapshotDate = computePeriodDate(s, p);
        const locked = lockedByPeriod.get(p);
        if (locked) {
          allPeriods.push({ periodNumber: p, date: snapshotDate, rows: locked, locked: true });
        } else {
          const computedLive = computeStandings(members, allMatches, s.start_date, snapshotDate + 'T23:59:59');
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
      setFinals(computeMedianFinals(allPeriods, members, leagueId, seasonId));
    } else {
      setFinals([]);
    }

    setLoading(false);
  }

  // ── Admin actions ─────────────────────────────────────────────

  function nextPeriodNumber(): number {
    const lockedOnly = periods.filter(p => p.locked);
    if (lockedOnly.length === 0) return 1;
    return Math.max(...lockedOnly.map(p => p.periodNumber)) + 1;
  }

  function nextLockDate(): string {
    if (!season) return '';
    const start = new Date(season.start_date);
    const n = nextPeriodNumber();
    start.setDate(start.getDate() + n * season.lock_frequency_weeks * 7);
    return start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

  async function lockPeriod() {
    if (!season) return;
    const n = nextPeriodNumber();
    Alert.alert(
      `Lock Period ${n}`,
      `This will snapshot current standings as Period ${n} and lock them in permanently.\n\nContinue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Lock In', style: 'default',
          onPress: async () => {
            setLocking(true);
            const today = new Date().toISOString().split('T')[0];
            const { error } = await supabase.rpc('lock_season_period', {
              p_season_id: seasonId, p_period_number: n, p_snapshot_date: today,
            });
            setLocking(false);
            if (error) Alert.alert('Error', error.message);
            else { Alert.alert('Period locked!', `Period ${n} standings are locked in.`); load(); }
          },
        },
      ]
    );
  }

  async function completeSeason() {
    Alert.alert(
      'Complete Season & Reset PLUPR',
      'This will:\n• Compute final standings from median ranks\n• Reset all participating players\' global PLUPR to 3.25 + rank bonus\n• Mark the season as completed\n\n⚠️ This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Complete Season', style: 'destructive',
          onPress: async () => {
            setCompleting(true);
            const { error } = await supabase.rpc('complete_season', { p_season_id: seasonId });
            setCompleting(false);
            if (error) Alert.alert('Error', error.message);
            else { Alert.alert('Season complete!', 'Final standings locked and PLUPR reset applied.'); load(); }
          },
        },
      ]
    );
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

  // ── Render sections ───────────────────────────────────────────

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;
  if (!season) return <Text style={S.empty}>Season not found.</Text>;

  const lockedCount    = periods.filter(p => p.locked).length;
  const totalPeriods   = season.total_periods;
  const nextPeriod     = nextPeriodNumber();
  const allPeriodsLocked = lockedCount >= totalPeriods;
  // Finals are "real" only when every period is locked AND the DB has rows.
  // Otherwise it's a historical preview computed from match data.
  const finalsAreComputed = !(lockedCount >= totalPeriods && season.status === 'completed');

  const statusColor = season.status === 'completed' ? colors.textMuted
                    : season.status === 'active'    ? colors.primary
                    :                                 '#e65100';

  return (
    <ScrollView contentContainerStyle={S.container}>

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
        members={live.map(r => ({ id: r.user_id, full_name: r.full_name }))}
        onChange={() => load()}
      />

      {/* ── Admin action bar ───────────────────────────────────── */}
      {isPrivileged(myRole as any) && (
        <View style={S.adminBar}>
          {canLock() && (
            <TouchableOpacity
              style={[S.adminBtn, S.adminBtnGreen]}
              onPress={lockPeriod}
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
              onPress={completeSeason}
              disabled={completing}
            >
              <Text style={S.adminBtnTextLight}>
                {completing ? 'Completing…' : '🏆 Complete Season'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Tab strip ──────────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.tabScroll}>
        <View style={S.tabs}>
          <TouchableOpacity
            style={[S.tab, activeTab === 'live' && S.tabActive]}
            onPress={() => setActiveTab('live')}
          >
            <Text style={[S.tabText, activeTab === 'live' && S.tabTextActive]}>Live</Text>
          </TouchableOpacity>
          {periods.map(p => (
            <TouchableOpacity
              key={p.periodNumber}
              style={[S.tab, activeTab === p.periodNumber && S.tabActive]}
              onPress={() => setActiveTab(p.periodNumber)}
            >
              <Text style={[S.tabText, activeTab === p.periodNumber && S.tabTextActive]}>
                P{p.periodNumber}
              </Text>
            </TouchableOpacity>
          ))}
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

      {/* ── Live standings ─────────────────────────────────────── */}
      {activeTab === 'live' && (
        <>
        <View style={S.tableCard}>
          <Text style={S.tableTitle}>Live Standings</Text>
          <Text style={S.tableSubtitle}>Based on matches played since season start</Text>
          <View style={S.tableHeader}>
            <Text style={[S.th, S.thRank]}>#</Text>
            <Text style={[S.th, S.thName]}>Player</Text>
            <Text style={S.th}>W</Text>
            <Text style={S.th}>L</Text>
            <Text style={S.th}>PLUPR</Text>
          </View>
          {live.length === 0 && (
            <Text style={S.empty}>No matches recorded yet this season.</Text>
          )}
          {live.map((row, i) => (
            <TouchableOpacity
              key={row.user_id}
              style={[S.tableRow, i % 2 === 0 && S.tableRowAlt]}
              onPress={() => navigation.navigate('PlayerProfile', { userId: row.user_id, userName: row.full_name })}
            >
              <Text style={[S.td, S.tdRank]}>
                {MEDALS[i] ?? `${i + 1}`}
              </Text>
              <View style={S.tdNameCell}>
                <AvatarCell avatarId={row.avatar_id} avatarUrl={row.avatar_url} />
                <Text style={S.tdName} numberOfLines={1}>{row.full_name}</Text>
              </View>
              <Text style={[S.td, S.tdWin]}>{row.wins}</Text>
              <Text style={[S.td, S.tdLoss]}>{row.losses}</Text>
              <Text style={S.td}>{formatPlupr(row.rating, row.total_matches_played)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* How a period locks in */}
        <View style={S.infoCard}>
          <Text style={S.infoTitle}>📌 How periods lock in</Text>
          <Text style={S.infoBody}>
            Every {season.lock_frequency_weeks} week{season.lock_frequency_weeks > 1 ? 's' : ''} an admin snapshots the live standings as a locked period. Your rank in each period is what counts toward final standings — your day-to-day PLUPR can't undo a great period finish.
          </Text>
        </View>

        {/* Median final-standings calc */}
        <View style={S.infoCard}>
          <Text style={S.infoTitle}>📊 How final standings are calculated</Text>
          <Text style={S.infoBody}>
            At season end, we take each player's <Text style={S.infoBold}>median rank across all {totalPeriods} periods</Text> and sort by it. Median (vs average) means one bad week won't tank your finish — consistency wins.
          </Text>
        </View>

        {/* PLUPR reset legend */}
        <View style={S.infoCard}>
          <Text style={S.infoTitle}>♻️ End-of-period PLUPR reset</Text>
          <Text style={S.infoBody}>
            Every time a period locks in, everyone's overall, singles, gendered-doubles, and mixed-doubles PLUPR soft-resets — but the top 5 of that period keep a head start going into the next one:
          </Text>
          <View style={S.bonusList}>
            {[
              { rank: '🥇 1st', bonus: 0.400 },
              { rank: '🥈 2nd', bonus: 0.275 },
              { rank: '🥉 3rd', bonus: 0.175 },
              { rank: '4th',   bonus: 0.100 },
              { rank: '5th',   bonus: 0.050 },
            ].map(b => (
              <Text key={b.rank} style={S.bonusLine}>
                {b.rank}  →  3.250 + {b.bonus.toFixed(3)} = <Text style={S.infoBold}>{(3.25 + b.bonus).toFixed(3)} PLUPR</Text>
              </Text>
            ))}
            <Text style={S.bonusNote}>Everyone else snaps back to <Text style={S.infoBold}>3.250</Text>. Finishing each period strong is its own incentive — your boost stacks on a clean slate.</Text>
          </View>
          <Text style={[S.infoBody, { marginTop: 10 }]}>
            At season end, your <Text style={S.infoBold}>median rank across all periods</Text> determines one final reset (same bonus ladder) — that's the PLUPR you carry into next season.
          </Text>
        </View>

        {/* Badge previews */}
        <View style={S.infoCard}>
          <Text style={S.infoTitle}>🏅 Badges up for grabs</Text>
          <Text style={S.infoBody}>
            Finish well to earn unique league badges that show on your profile:
          </Text>
          {[
            { icon: '🥇', name: 'Period Champion',  desc: `Finish #1 in any of the ${totalPeriods} locked periods` },
            { icon: '👑', name: 'Season Crown',     desc: 'Finish #1 in the final season standings' },
            { icon: '🥈', name: 'Season Silver',    desc: 'Finish #2 in the final season standings' },
            { icon: '🥉', name: 'Season Bronze',    desc: 'Finish #3 in the final season standings' },
            { icon: '🌟', name: 'Period Sweeper',   desc: 'Take #1 in every locked period of the season' },
          ].map(b => (
            <View key={b.name} style={S.badgePrevRow}>
              <Text style={S.badgePrevIcon}>{b.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={S.badgePrevName}>{b.name}</Text>
                <Text style={S.badgePrevDesc}>{b.desc}</Text>
              </View>
            </View>
          ))}
        </View>
        </>
      )}

      {/* ── Period snapshot ────────────────────────────────────── */}
      {typeof activeTab === 'number' && (() => {
        const period = periods.find(p => p.periodNumber === activeTab);
        if (!period) return null;
        return (
          <View style={S.tableCard}>
            <Text style={S.tableTitle}>
              Period {period.periodNumber} {period.locked ? '— Locked In' : '— Historical Preview'}
            </Text>
            <Text style={S.tableSubtitle}>
              {period.locked
                ? `Locked ${fmtDate(period.date)}`
                : `Computed from matches played through ${fmtDate(period.date)} — not yet locked in`}
            </Text>
            <View style={S.tableHeader}>
              <Text style={[S.th, S.thRank]}>#</Text>
              <Text style={[S.th, S.thName]}>Player</Text>
              <Text style={S.th}>W</Text>
              <Text style={S.th}>L</Text>
              <Text style={S.th}>PLUPR</Text>
            </View>
            {period.rows.map((row, i) => (
              <TouchableOpacity
                key={row.user_id}
                style={[S.tableRow, i % 2 === 0 && S.tableRowAlt]}
                onPress={() => navigation.navigate('PlayerProfile', { userId: row.user_id, userName: row.profile?.full_name ?? '' })}
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
                <Text style={S.td}>{Number(row.elo_at_snapshot ?? 3.25).toFixed(2)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      })()}

      {/* ── Final standings ────────────────────────────────────── */}
      {activeTab === 'final' && (
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
                    {row.elo_bonus > 0 ? `+${Number(row.elo_bonus).toFixed(3)}` : '—'}
                  </Text>
                  <Text style={[S.td, S.tdNewElo]}>{Number(row.new_elo ?? 3.25).toFixed(3)}</Text>
                </TouchableOpacity>
              ))}

              {/* PLUPR reset legend */}
              <View style={S.bonusLegend}>
                <Text style={S.bonusLegendTitle}>Rank Bonuses Applied</Text>
                {[
                  { rank: '🥇 #1', bonus: 0.400 },
                  { rank: '🥈 #2', bonus: 0.275 },
                  { rank: '🥉 #3', bonus: 0.175 },
                  { rank: '4th',   bonus: 0.100 },
                  { rank: '5th',   bonus: 0.050 },
                ].map(b => (
                  <Text key={b.rank} style={S.bonusLine}>
                    {b.rank} → 3.250 + {b.bonus.toFixed(3)} = {(3.25 + b.bonus).toFixed(3)} PLUPR
                  </Text>
                ))}
                <Text style={S.bonusNote}>All others reset to 3.250 PLUPR</Text>
              </View>
            </>
          )}
        </View>
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
    tab:            { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.border },
    tabActive:      { backgroundColor: c.primary, borderColor: c.primary },
    tabFinal:       { borderColor: '#ffd700' },
    tabText:        { fontSize: 13, fontWeight: '600', color: c.textSub },
    tabTextActive:  { color: '#fff' },

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

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ScrollView, RefreshControl,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList, Wager, LeagueSeason } from '../types';
import { cancelWager, genericSubjectLabel, WagerStatus } from '../lib/wager';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import EmptyState from '../components/EmptyState';
import { LoadingState } from '@just-messin-around/expo-foundation/ui';
import FlairName from '../components/FlairName';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MyWagers'> };

const STATUS_TABS: { key: WagerStatus; label: string }[] = [
  { key: 'open',      label: 'Open' },
  { key: 'won',       label: 'Won' },
  { key: 'lost',      label: 'Lost' },
  { key: 'cancelled', label: 'Cancelled' },
];

type TopTab = 'mine' | 'markets';
const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: 'mine',    label: 'My Wagers' },
  { key: 'markets', label: 'Markets' },
];

// ─────────────────────────────────────────────────────────────────────────
// Markets types
// ─────────────────────────────────────────────────────────────────────────
type TournamentMarket = { id: string; name: string; status: string };

type SeasonMarket = {
  seasonId: string;
  leagueId: string;
  leagueName: string;
  periodNumber: number;
};

type MatchPlayer = {
  full_name: string;
  name_color: string | null;
  list_name_style_id: string | null;
};

type UpcomingMatchMarket = {
  id: string;
  leagueId: string;
  whenIso: string | null;
  team1: { player: MatchPlayer; partner: MatchPlayer | null };
  team2: { player: MatchPlayer; partner: MatchPlayer | null };
};

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

// Date-only formatting in UTC. The server returns date-based ends (season /
// period / tournament) at UTC midnight, so formatting in UTC keeps those dates
// from shifting a day in the user's local timezone.
function fmtEndDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// A muted context line: which league the wager rolls up to (when that isn't
// already the scope shown in the prediction) + when it's expected to end.
function buildWagerContext(w: Wager): string | null {
  const parts: string[] = [];
  if (w.league_name && w.league_name !== w.scope_name) parts.push(`Under ${w.league_name}`);
  if (w.expected_end_at) {
    const settled = w.status === 'won' || w.status === 'lost';
    parts.push(`${settled ? 'Ended' : 'Ends'} ${fmtEndDate(w.expected_end_at)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

// Build a human "you bet X" line plus an optional "actually Y" line so the
// MyWagers row tells the full story: predicted player / scope / rank for
// rank wagers, predicted team / score for match wagers, and the actual
// outcome once the wager has settled.
function buildWagerNarrative(w: Wager): { prediction: string; outcome: string | null } {
  const settled = w.status === 'won' || w.status === 'lost';
  const predRank = w.predicted_rank ?? (w.predicate?.rank as number | undefined);
  const predName = w.predicted_user_name ?? (w.predicate?.user_id ? String(w.predicate.user_id).slice(0, 6) : '');
  const scope    = w.scope_name ?? '';

  switch (w.subject_type) {
    case 'tournament_rank': {
      const rankLabel = predRank ? ordinal(predRank) : '?';
      const prediction = scope
        ? `🏆 ${predName} to finish ${rankLabel} in ${scope}`
        : `🏆 ${predName} to finish ${rankLabel}`;
      if (!settled) return { prediction, outcome: null };
      const actual = w.actual_rank;
      let outcome: string;
      if (actual != null && actual === predRank) {
        outcome = `✓ ${predName} finished ${ordinal(actual)}`;
      } else if (actual != null) {
        outcome = `✗ ${predName} finished ${ordinal(actual)} (you predicted ${rankLabel})`;
      } else if (w.status === 'won') {
        outcome = `✓ ${predName} hit ${rankLabel}`;
      } else {
        outcome = `✗ ${predName} missed ${rankLabel}`;
      }
      return { prediction, outcome };
    }
    case 'period_rank': {
      const rankLabel = predRank ? ordinal(predRank) : '?';
      const period    = w.predicate?.period_number;
      const periodLbl = period ? ` (Period ${period})` : '';
      const prediction = scope
        ? `🏅 ${predName} to finish ${rankLabel} in ${scope}${periodLbl}`
        : `🏅 ${predName} to finish ${rankLabel}${periodLbl}`;
      if (!settled) return { prediction, outcome: null };
      const actual = w.actual_rank;
      const outcome = actual != null
        ? (actual === predRank
            ? `✓ ${predName} finished ${ordinal(actual)}`
            : `✗ ${predName} finished ${ordinal(actual)} (you predicted ${rankLabel})`)
        : (w.status === 'won' ? `✓ ${predName} hit ${rankLabel}` : `✗ ${predName} missed ${rankLabel}`);
      return { prediction, outcome };
    }
    case 'season_rank': {
      const rankLabel = predRank ? ordinal(predRank) : '?';
      const prediction = scope
        ? `🏅 ${predName} to finish ${rankLabel} of ${scope}`
        : `🏅 ${predName} to finish ${rankLabel}`;
      if (!settled) return { prediction, outcome: null };
      const actual = w.actual_rank;
      const outcome = actual != null
        ? (actual === predRank
            ? `✓ ${predName} finished ${ordinal(actual)}`
            : `✗ ${predName} finished ${ordinal(actual)} (you predicted ${rankLabel})`)
        : (w.status === 'won' ? `✓ Won` : `✗ Didn't hit`);
      return { prediction, outcome };
    }
    case 'match':
    case 'tournament_match': {
      const pickedTeam: 'team1' | 'team2' = w.predicate?.winner_team === 'team2' ? 'team2' : 'team1';
      const teamA = w.team_label_a ?? 'Team 1';
      const teamB = w.team_label_b ?? 'Team 2';
      const pickedLabel = pickedTeam === 'team1' ? teamA : teamB;
      const prediction = scope
        ? `🥒 ${pickedLabel} to beat ${pickedTeam === 'team1' ? teamB : teamA} · ${scope}`
        : `🥒 ${pickedLabel} to beat ${pickedTeam === 'team1' ? teamB : teamA}`;
      if (!settled) return { prediction, outcome: null };
      const winnerTeam = w.actual_winner_team;
      const s1 = w.actual_team1_score;
      const s2 = w.actual_team2_score;
      const scoreSuffix = s1 != null && s2 != null ? ` (${s1}-${s2})` : '';
      const outcome = winnerTeam
        ? (winnerTeam === pickedTeam
            ? `✓ ${pickedLabel} won${scoreSuffix}`
            : `✗ ${winnerTeam === 'team1' ? teamA : teamB} won${scoreSuffix}`)
        : (w.status === 'won' ? '✓ Hit' : '✗ Miss');
      return { prediction, outcome };
    }
    case 'match_score':
    case 'tournament_match_score': {
      const teamA = w.team_label_a ?? 'Team 1';
      const teamB = w.team_label_b ?? 'Team 2';
      const ps1 = w.predicate?.team1_score;
      const ps2 = w.predicate?.team2_score;
      const prediction = scope
        ? `🎯 Exact: ${teamA} ${ps1}-${ps2} ${teamB} · ${scope}`
        : `🎯 Exact: ${teamA} ${ps1}-${ps2} ${teamB}`;
      if (!settled) return { prediction, outcome: null };
      const s1 = w.actual_team1_score;
      const s2 = w.actual_team2_score;
      const outcome = s1 != null && s2 != null
        ? `Final: ${teamA} ${s1}-${s2} ${teamB}${w.status === 'won' ? ' — exact!' : ''}`
        : (w.status === 'won' ? '✓ Exact hit' : '✗ Score missed');
      return { prediction, outcome };
    }
    default:
      return { prediction: genericSubjectLabel(w.subject_type, w.predicate || {}), outcome: null };
  }
}

// Compute the current period number (1-based) within an active season,
// given today's date. Clamps to [1, total_periods].
function currentPeriodFor(s: { start_date: string; lock_frequency_weeks: number; total_periods: number }): number {
  const start = new Date(s.start_date + 'T00:00:00');
  const today = new Date();
  const msPerPeriod = s.lock_frequency_weeks * 7 * 24 * 60 * 60 * 1000;
  if (today.getTime() < start.getTime()) return 1;
  const elapsed = today.getTime() - start.getTime();
  const p = Math.floor(elapsed / msPerPeriod) + 1;
  if (p < 1) return 1;
  if (p > s.total_periods) return s.total_periods;
  return p;
}

export default function MyWagersScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = useMemo(() => makeStyles(c), [c]);
  const status = useStatusMessage();

  const [topTab, setTopTab] = useState<TopTab>('mine');

  // ── My Wagers state (existing) ─────────────────────────────────────────
  const [wagers, setWagers]   = useState<Wager[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<WagerStatus>('open');
  const [cancelTarget, setCancelTarget] = useState<Wager | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // ── Markets state ──────────────────────────────────────────────────────
  const [marketsLoading, setMarketsLoading]       = useState(false);
  const [marketsRefreshing, setMarketsRefreshing] = useState(false);
  const [tournaments, setTournaments]             = useState<TournamentMarket[]>([]);
  const [seasonMarkets, setSeasonMarkets]         = useState<SeasonMarket[]>([]);
  const [upcomingMatches, setUpcomingMatches]     = useState<UpcomingMatchMarket[]>([]);

  useFocusEffect(useCallback(() => {
    loadWagers();
    loadMarkets();
  }, []));

  // ────────────────────────────────────────────────────────────────────────
  // My Wagers loaders + handlers
  // ────────────────────────────────────────────────────────────────────────
  async function loadWagers() {
    setLoading(true);
    // The RPC joins the predicate's user/scope back to profiles + tournaments
    // + season snapshots so each row can be rendered with names + actual
    // outcomes (e.g. "Alice finished 4th — you predicted 3rd"). Falls back to
    // a raw select if the RPC isn't deployed (the row shape is a superset).
    const { data, error } = await supabase.rpc('get_my_wagers_with_details');
    if (error) {
      const { data: rawData, error: rawErr } = await supabase
        .from('wagers')
        .select('*')
        .order('placed_at', { ascending: false });
      if (rawErr) status.error(rawErr.message);
      setWagers((rawData ?? []) as Wager[]);
    } else {
      setWagers((data ?? []) as Wager[]);
    }
    setLoading(false);
  }

  const counts = useMemo(() => {
    const out: Record<WagerStatus, number> = { open: 0, won: 0, lost: 0, cancelled: 0 };
    for (const w of wagers) out[w.status] += 1;
    return out;
  }, [wagers]);

  const visible = useMemo(() => wagers.filter(w => w.status === tab), [wagers, tab]);

  async function confirmCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    const r = await cancelWager(cancelTarget.id);
    setCancelling(false);
    setCancelTarget(null);
    if (!r.success) {
      status.error(r.message || 'Could not cancel wager.');
      return;
    }
    status.success(r.message || 'Wager cancelled.');
    loadWagers();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Markets loader
  // ────────────────────────────────────────────────────────────────────────
  async function loadMarkets(mode: 'initial' | 'refresh' = 'initial') {
    const setBusy = mode === 'refresh' ? setMarketsRefreshing : setMarketsLoading;
    setBusy(true);
    try {
      await fetchMarkets();
    } finally {
      setBusy(false);
    }
  }

  async function fetchMarkets() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;

    const nowIso = new Date().toISOString();

    const myLeaguesPromise = uid
      ? supabase
          .from('league_members')
          .select('league_id, league:leagues(id, name)')
          .eq('user_id', uid)
      : null;

    const [tournamentsRes, myLeaguesRes, upcomingRes] = await Promise.all([
      supabase
        .from('tournaments')
        .select('id, name, status')
        .in('status', ['registration', 'active'])
        .order('start_time', { ascending: true, nullsFirst: false }),
      myLeaguesPromise,
      supabase
        .from('matches')
        .select(
          'id, league_id, scheduled_at, played_at, status,'
          + ' player1:profiles!matches_player1_id_fkey(full_name, name_color, list_name_style_id),'
          + ' partner1:profiles!matches_partner1_id_fkey(full_name, name_color, list_name_style_id),'
          + ' player2:profiles!matches_player2_id_fkey(full_name, name_color, list_name_style_id),'
          + ' partner2:profiles!matches_partner2_id_fkey(full_name, name_color, list_name_style_id)'
        )
        .eq('status', 'scheduled')
        .gt('scheduled_at', nowIso)
        .order('scheduled_at', { ascending: true })
        .limit(50),
    ]);

    if (tournamentsRes.error) status.error(tournamentsRes.error.message);
    setTournaments((tournamentsRes.data ?? []) as TournamentMarket[]);

    // Live league periods: for each league the user belongs to, find the
    // active season and compute the current period.
    const leagueRows = ((myLeaguesRes?.data ?? []) as any[]);
    const leagueIds = leagueRows.map(r => r.league_id).filter(Boolean);
    const leagueNameById = new Map<string, string>();
    for (const r of leagueRows) {
      const league = (r.league as any) ?? null;
      if (league?.id) leagueNameById.set(league.id, league.name);
    }
    let seasons: LeagueSeason[] = [];
    if (leagueIds.length > 0) {
      const { data: seasonsData, error: seasonsErr } = await supabase
        .from('league_seasons')
        .select('*')
        .in('league_id', leagueIds)
        .eq('status', 'active');
      if (seasonsErr) status.error(seasonsErr.message);
      seasons = (seasonsData ?? []) as LeagueSeason[];
    }
    setSeasonMarkets(seasons.map(s => ({
      seasonId: s.id,
      leagueId: s.league_id,
      leagueName: leagueNameById.get(s.league_id) ?? 'League',
      periodNumber: currentPeriodFor(s),
    })));

    if (upcomingRes.error) status.error(upcomingRes.error.message);
    const matchRows = (upcomingRes.data ?? []) as any[];
    const toPlayer = (p: any, fallback: string): MatchPlayer => ({
      full_name: p?.full_name ?? fallback,
      name_color: p?.name_color ?? null,
      list_name_style_id: p?.list_name_style_id ?? null,
    });
    setUpcomingMatches(matchRows.map(m => ({
      id: m.id,
      leagueId: m.league_id,
      whenIso: m.scheduled_at ?? m.played_at ?? null,
      team1: {
        player:  toPlayer(m.player1,  'Player 1'),
        // Match the previous behavior: only include a partner if full_name is
        // present. Avoids rendering " / " followed by an empty FlairName when
        // the partner join returns an object with a null name.
        partner: m.partner1?.full_name ? toPlayer(m.partner1, '') : null,
      },
      team2: {
        player:  toPlayer(m.player2,  'Player 2'),
        partner: m.partner2?.full_name ? toPlayer(m.partner2, '') : null,
      },
    })));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Renderers
  // ────────────────────────────────────────────────────────────────────────
  function renderWagerItem({ item }: { item: Wager }) {
    const { prediction, outcome } = buildWagerNarrative(item);
    const context      = buildWagerContext(item);
    const settledLabel = item.settled_at ? timeAgo(item.settled_at) : '';
    const placedLabel  = timeAgo(item.placed_at);

    return (
      <View style={S.row}>
        <View style={{ flex: 1 }}>
          <Text style={S.rowSubject} numberOfLines={3}>{prediction}</Text>
          {outcome && (
            <Text style={[S.outcomeLine, item.status === 'won' && S.outcomeWon, item.status === 'lost' && S.outcomeLost]}>
              {outcome}
            </Text>
          )}
          {context && <Text style={S.contextLine}>{context}</Text>}
          <View style={S.metaRow}>
            <Text style={S.metaText}>Stake: <Text style={S.metaValue}>{item.stake} 🥒</Text></Text>
            <Text style={S.metaText}>Odds: <Text style={S.metaValue}>{Number(item.odds).toFixed(2)}×</Text></Text>
            <Text style={S.metaText}>To win: <Text style={S.metaValue}>{item.potential_payout} 🥒</Text></Text>
          </View>
          <Text style={S.timestamp}>
            {item.status === 'open'
              ? `Placed ${placedLabel}`
              : `Placed ${placedLabel} · ${STATUS_LABEL[item.status]} ${settledLabel}`}
          </Text>
        </View>
        {item.status === 'open' && (
          <TouchableOpacity style={S.cancelBtn} onPress={() => setCancelTarget(item)}>
            <Text style={S.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  function renderTournamentCard(t: TournamentMarket) {
    return (
      <TouchableOpacity
        key={t.id}
        style={S.row}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('TournamentDetail', { tournamentId: t.id, tournamentName: t.name })}
      >
        <View style={{ flex: 1 }}>
          <Text style={S.rowSubject} numberOfLines={2}>{t.name}</Text>
          <Text style={S.marketTag}>
            {t.status === 'registration' ? 'Registration open' : 'Active'}
          </Text>
          <Text style={S.marketLink}>Open wager market →</Text>
        </View>
      </TouchableOpacity>
    );
  }

  function renderSeasonCard(m: SeasonMarket) {
    return (
      <TouchableOpacity
        key={m.seasonId}
        style={S.row}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('SeasonStandings', {
          seasonId: m.seasonId, leagueId: m.leagueId, leagueName: m.leagueName,
        })}
      >
        <View style={{ flex: 1 }}>
          <Text style={S.rowSubject} numberOfLines={2}>
            Period {m.periodNumber} · {m.leagueName}
          </Text>
          <Text style={S.marketTag}>Live league season</Text>
          <Text style={S.marketLink}>Wager on period leaders →</Text>
        </View>
      </TouchableOpacity>
    );
  }

  function renderMatchCard(m: UpcomingMatchMarket) {
    // Render team labels inline so each player name picks up their list-mode
    // FlairName styling. RN <Text> nestable supports inlining <FlairName>
    // (which is itself a <Text>) inside an outer <Text> for proper layout.
    const renderPlayer = (p: MatchPlayer) => (
      // TODO: smoke-test in browser — list mode FlairName wire-up
      <FlairName
        name={p.full_name}
        nameColor={p.name_color}
        styleId={p.list_name_style_id}
        mode="list"
        style={S.rowSubject}
      />
    );
    return (
      <TouchableOpacity
        key={m.id}
        style={S.row}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('MatchHistory', {
          leagueId: m.leagueId, title: 'Upcoming Match',
        })}
      >
        <View style={{ flex: 1 }}>
          <Text style={S.rowSubject} numberOfLines={2}>
            {renderPlayer(m.team1.player)}
            {m.team1.partner ? <>{' / '}{renderPlayer(m.team1.partner)}</> : null}
            {' vs '}
            {renderPlayer(m.team2.player)}
            {m.team2.partner ? <>{' / '}{renderPlayer(m.team2.partner)}</> : null}
          </Text>
          <Text style={S.marketTag}>Scheduled for {formatWhen(m.whenIso)}</Text>
          <Text style={S.marketLink}>Open in match history →</Text>
        </View>
      </TouchableOpacity>
    );
  }

  function renderEmpty(text: string) {
    return <Text style={S.sectionEmpty}>{text}</Text>;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Layout
  // ────────────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />

      <View style={S.topTabs}>
        {TOP_TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[S.topTab, topTab === t.key && S.topTabActive]}
            onPress={() => setTopTab(t.key)}
            activeOpacity={0.7}
          >
            <Text style={[S.topTabText, topTab === t.key && S.topTabTextActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {topTab === 'mine' ? (
        <>
          <View style={S.tabs}>
            {STATUS_TABS.map(t => (
              <TouchableOpacity
                key={t.key}
                style={[S.tab, tab === t.key && S.tabActive]}
                onPress={() => setTab(t.key)}
                activeOpacity={0.7}
              >
                <Text style={[S.tabText, tab === t.key && S.tabTextActive]}>
                  {t.label} {counts[t.key] > 0 ? `(${counts[t.key]})` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {loading ? (
            <LoadingState label="Loading…" />
          ) : visible.length === 0 ? (
            <View style={S.center}>
              <EmptyState
                icon="🎲"
                title={`No ${tab} wagers`}
                subtitle={tab === 'open'
                  ? 'Place a wager from a match or tournament to see it here.'
                  : `You don't have any ${tab} wagers yet.`}
              />
            </View>
          ) : (
            <FlatList
              data={visible}
              keyExtractor={(w) => w.id}
              renderItem={renderWagerItem}
              contentContainerStyle={{ padding: 16 }}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            />
          )}
        </>
      ) : (
        marketsLoading && !marketsRefreshing ? (
          <LoadingState label="Loading…" />
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
            refreshControl={
              <RefreshControl
                refreshing={marketsRefreshing}
                onRefresh={() => loadMarkets('refresh')}
                tintColor={c.primary}
                colors={[c.primary]}
              />
            }
          >
            <Text style={S.sectionHeader}>Active Tournaments</Text>
            {tournaments.length === 0
              ? renderEmpty('No active tournaments. Tournaments unlock wagers on the champion.')
              : (
                <View style={S.sectionList}>
                  {tournaments.map(renderTournamentCard)}
                </View>
              )}

            <Text style={S.sectionHeader}>Live League Periods</Text>
            {seasonMarkets.length === 0
              ? renderEmpty('No live league seasons yet. Start a season to wager on period leaders.')
              : (
                <View style={S.sectionList}>
                  {seasonMarkets.map(renderSeasonCard)}
                </View>
              )}

            <Text style={S.sectionHeader}>Upcoming Matches</Text>
            {upcomingMatches.length === 0
              ? renderEmpty('No upcoming matches yet — schedule one to bet on it.')
              : (
                <View style={S.sectionList}>
                  {upcomingMatches.map(renderMatchCard)}
                </View>
              )}
          </ScrollView>
        )
      )}

      <ConfirmModal
        visible={cancelTarget != null}
        title="Cancel wager?"
        body="Your stake will be refunded immediately."
        primaryLabel="Cancel wager"
        cancelLabel="Keep"
        variant="danger"
        busy={cancelling}
        onConfirm={confirmCancel}
        onClose={() => (cancelling ? null : setCancelTarget(null))}
      />
    </View>
  );
}

const STATUS_LABEL: Record<WagerStatus, string> = {
  open: 'Open', won: 'Won', lost: 'Lost', cancelled: 'Cancelled',
};

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    topTabs:      { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
    topTab:       { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    topTabActive: { backgroundColor: c.primary, borderColor: c.primary },
    topTabText:   { fontSize: 14, fontWeight: '800', color: c.textSub },
    topTabTextActive: { color: '#fff' },

    tabs:        { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
    tab:         { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    tabActive:   { backgroundColor: c.primary, borderColor: c.primary },
    tabText:     { fontSize: 12, fontWeight: '700', color: c.textSub },
    tabTextActive:{ color: '#fff' },

    center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

    row:         { flexDirection: 'row', alignItems: 'center', gap: 10,
                   backgroundColor: c.surface, borderRadius: 12, padding: 14,
                   borderWidth: 1, borderColor: c.border },
    rowSubject:  { fontSize: 14, fontWeight: '700', color: c.text, lineHeight: 19 },
    outcomeLine: { fontSize: 13, color: c.textSub, marginTop: 4, lineHeight: 18 },
    outcomeWon:  { color: c.primary, fontWeight: '700' },
    outcomeLost: { color: c.danger, fontWeight: '700' },
    contextLine: { fontSize: 12, color: c.textMuted, marginTop: 4, fontStyle: 'italic' },
    metaRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
    metaText:    { fontSize: 12, color: c.textSub },
    metaValue:   { color: c.text, fontWeight: '700' },
    timestamp:   { fontSize: 11, color: c.textMuted, marginTop: 6 },

    cancelBtn:    { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    cancelBtnText:{ color: c.danger, fontWeight: '700', fontSize: 12 },

    sectionHeader: { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
    sectionList:   { gap: 10, marginBottom: 18 },
    sectionEmpty:  { fontSize: 13, color: c.textMuted, fontStyle: 'italic', marginBottom: 18, lineHeight: 19 },
    marketTag:     { fontSize: 12, color: c.textSub, marginTop: 4 },
    marketLink:    { fontSize: 12, color: c.primary, fontWeight: '700', marginTop: 6 },
  });
}

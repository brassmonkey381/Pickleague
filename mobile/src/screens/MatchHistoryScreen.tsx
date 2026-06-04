import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { REGIONS, inRegion } from '../lib/regions';
import { Match, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import StatusBanner from '../components/StatusBanner';
import { displayCourtName } from '../lib/courtNickname';
import { useStatusMessage } from '../lib/useStatusMessage';
import ActionSheetModal from '../components/ActionSheetModal';
import ConfirmModal from '../components/ConfirmModal';
import FlairName from '../components/FlairName';
// Resolves once Unit 1 (wager foundation) merges to master.
import WagerProposeModal from '../components/WagerProposeModal';
import type { WagerSubject } from '../lib/wager';
import type { Profile } from '../types';

type HomeAwayFilter     = 'all' | 'home' | 'away';
type TypeFilter         = 'all' | 'singles' | 'doubles';
type RecencyFilter      = 3 | 7 | 30 | 90 | null; // days; null = all time
type IndoorOutdoorFilter = 'all' | 'outdoor' | 'indoor' | 'unknown';
type DoublesCategoryFilter = 'all' | 'gendered' | 'mixed' | 'unspecified';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchHistory'>;
  route: RouteProp<RootStackParamList, 'MatchHistory'>;
};

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: c.border, elevation: 3, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 6 },
    win:  { borderLeftColor: c.primary },
    loss: { borderLeftColor: c.danger },

    // Brief gold ring flashed on a deep-linked match (from a match-confirm notif).
    highlightCard:     { borderWidth: 2, borderColor: '#ffe082', backgroundColor: '#fff8e1' },
    pendingCard:       { borderLeftColor: '#d4a72c', backgroundColor: '#fffaeb' },
    pendingHeader:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    pendingBadgeText:  { fontSize: 12, fontWeight: '800', color: '#8a6d00', textTransform: 'uppercase', letterSpacing: 0.5 },
    pendingDeadline:   { fontSize: 12, fontWeight: '700', color: '#8a6d00' },
    upcomingCard:      { borderLeftColor: c.primary, backgroundColor: c.primaryLight },
    upcomingBadgeText: { fontSize: 12, fontWeight: '800', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.5 },
    upcomingMenuText:  { fontSize: 18, fontWeight: '900', color: c.primary, lineHeight: 18 },
    upcomingMatchup:   { fontSize: 14, fontWeight: '700', color: c.text },
    upcomingVs:        { fontSize: 13, fontWeight: '600', color: c.textSub, marginVertical: 4 },
    upcomingWhen:      { fontSize: 12, fontWeight: '700', color: c.primary, marginTop: 8 },
    sectionTitle:      { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4, marginBottom: 8 },
    pendingMatchup:    { fontSize: 14, fontWeight: '700', color: c.text },
    pendingScore:      { fontSize: 22, fontWeight: '900', color: c.text, marginVertical: 4 },
    pendingTeamRow:    { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
    pendingTeamStatus: { fontSize: 11, fontWeight: '700' },
    pendingTeamDone:   { color: '#2e7d32' },
    pendingTeamWaiting:{ color: '#8a6d00' },
    confirmBtn:        { backgroundColor: c.primary, paddingVertical: 10, borderRadius: 10, alignItems: 'center', marginTop: 4 },
    confirmBtnText:    { color: '#fff', fontWeight: '800', fontSize: 14 },
    pendingNote:       { fontSize: 12, color: c.textSub, fontStyle: 'italic', marginTop: 6 },
    leagueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
    typeTag: { fontSize: 11, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase' },
    cardHeader: { flexDirection: 'row', alignItems: 'center' },
    result: { fontSize: 22, fontWeight: '800', width: 28 },
    winText:  { color: c.primary },
    lossText: { color: c.danger },
    cardInfo: { flex: 1, marginLeft: 10 },
    opponent: { fontSize: 15, fontWeight: '600', color: c.text },
    dateText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    locationText: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    partnerText: { fontSize: 12, color: c.primary, marginTop: 1 },
    cardRight: { alignItems: 'flex-end' },
    matchup: { fontSize: 15, fontWeight: '600', color: c.text, flex: 1, marginRight: 8 },
    score: { fontSize: 15, fontWeight: '700', color: c.textSub },
    elo: { fontSize: 12, fontWeight: '600', marginTop: 2 },
    eloUp:   { color: c.primary },
    eloDown: { color: c.danger },
    filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    countText: { flex: 1, fontSize: 13, color: c.textMuted },
    filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: c.border },
    filterBtnActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    filterBtnText: { fontSize: 13, fontWeight: '600', color: c.textSub },
    filterBtnTextActive: { color: c.primary },
    clearText: { fontSize: 13, color: c.danger, fontWeight: '600' },
    filterPanel: { backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    filterLabel: { fontSize: 12, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
    pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    pillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    pillText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
    pillTextActive: { color: c.primary, fontWeight: '700' },
    resultMini: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    resultMiniWin: { backgroundColor: c.primary },
    resultMiniLoss: { backgroundColor: c.danger },
    resultMiniText: { color: '#fff', fontSize: 12, fontWeight: '800' },
    matchupWinner: { fontWeight: '800', color: c.text },
    searchRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    searchInput: {
      flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 8, fontSize: 14,
      backgroundColor: c.surface, color: c.text,
    },
    clearSearch: { paddingHorizontal: 10, paddingVertical: 8 },
    clearSearchText: { fontSize: 14, color: c.textMuted, fontWeight: '600' },
    leagueMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
    homeAwayBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
    homeBadge: { backgroundColor: c.primaryLight },
    awayBadge: { backgroundColor: c.bg },
    homeAwayText: { fontSize: 11, fontWeight: '700' },
    homeText: { color: c.primary },
    awayText: { color: c.textMuted },
    indoorBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, marginTop: 2 },
    outdoorBg: { backgroundColor: '#fff8e1' },
    indoorBg:  { backgroundColor: '#e3f2fd' },
    unknownBg: { backgroundColor: c.bg },
    indoorText: { fontSize: 11, fontWeight: '700' },
    outdoorColor: { color: '#f57f17' },
    indoorColor:  { color: '#1565c0' },
    unknownColor: { color: c.textMuted },
    catBadge:        { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, marginTop: 2 },
    catGenderedBg:   { backgroundColor: c.primaryLight },
    catMixedBg:      { backgroundColor: '#f3e5f5' },
    catUnspecBg:     { backgroundColor: c.bg },
    catText:         { fontSize: 11, fontWeight: '700' },
    catGenderedColor:{ color: c.primary },
    catMixedColor:   { color: '#8e24aa' },
    catUnspecColor:  { color: c.textMuted },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },
    calendarBtn: { backgroundColor: c.primaryLight, borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' },
    calendarBtnText: { color: c.primary, fontWeight: '700', fontSize: 15 },
    pendingMenuBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
    pendingMenuText: { fontSize: 18, fontWeight: '900', color: '#8a6d00', lineHeight: 18 },
    pendingHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    scoreInputRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8, marginBottom: 4 },
    scoreInput: {
      flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontWeight: '700',
      backgroundColor: c.surface, color: c.text, textAlign: 'center',
    },
    scoreInputDash: { fontSize: 18, fontWeight: '800', color: c.textMuted },
    scoreInputLabel: { fontSize: 11, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  });
}

type WagerRowCtx = {
  matchId: string;
  team1Label: string;
  team2Label: string;
};

// Renders a 1-or-2-player team with each player's FlairName styling (list mode).
// Falls back to plain "Unknown" when a profile is missing. Designed to be
// embedded inside a parent <Text>, which carries the text style + numberOfLines.
// TODO: smoke-test in browser — list mode FlairName wire-up
function TeamFlair({
  player,
  partner,
  textStyle,
}: {
  player?: Partial<Profile> | null;
  partner?: Partial<Profile> | null;
  textStyle?: any;
}) {
  if (!player) return <Text style={textStyle}>Unknown</Text>;
  const playerEl = (
    <FlairName
      name={player.full_name ?? '?'}
      nameColor={player.name_color}
      styleId={player.list_name_style_id ?? null}
      mode="list"
      style={textStyle}
    />
  );
  if (!partner?.full_name) return playerEl;
  return (
    <Text style={textStyle}>
      {playerEl}
      {' & '}
      <FlairName
        name={partner.full_name}
        nameColor={partner.name_color}
        styleId={partner.list_name_style_id ?? null}
        mode="list"
        style={textStyle}
      />
    </Text>
  );
}

export default function MatchHistoryScreen({ navigation, route }: Props) {
  const { leagueId, userId, initialMatchType, initialDoublesCategory, initialMyMatchesOnly, highlightMatchId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [matches, setMatches]       = useState<Match[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  // Open filter drawer by default when arriving with pre-applied filters so
  // the user can see what's been narrowed for them.
  const [showFilters, setShowFilters] = useState(!!(initialMatchType || initialDoublesCategory || initialMyMatchesOnly));
  const [homeAway, setHomeAway]     = useState<HomeAwayFilter>('all');
  const [matchType, setMatchType]   = useState<TypeFilter>(initialMatchType ?? 'all');
  const [region, setRegion]         = useState<string | null>(null);
  const [recency, setRecency]       = useState<RecencyFilter>(null);
  const [playerSearch, setPlayerSearch] = useState('');
  const [myMatchesOnly, setMyMatchesOnly] = useState(!!initialMyMatchesOnly);
  const [indoorOutdoor, setIndoorOutdoor] = useState<IndoorOutdoorFilter>('all');
  const [doublesCategory, setDoublesCategory] = useState<DoublesCategoryFilter>(initialDoublesCategory ?? 'all');

  // Deep-link highlight: when arriving from a match-confirm notification, scroll
  // to that match and flash a gold ring so the inline Confirm/Reject controls
  // jump out. The highlight clears after a couple seconds.
  const listRef = useRef<FlatList<Match>>(null);
  // Tracks the highlightMatchId we've already auto-scrolled to, so later filter
  // edits don't re-yank the viewport. `filteredRef` always holds the latest
  // filtered list so deferred scrolls recompute a fresh (never stale) index.
  const scrolledForRef = useRef<string | null>(null);
  const filteredRef = useRef<Match[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightMatchId ?? null);

  const status = useStatusMessage();
  const refresh = useRefresh(loadMatches);

  // wagerCtx is the row the user opened the menu for; team labels are frozen
  // there so the UI stays stable if `matches` reloads mid-flow.
  const [wagerCtx, setWagerCtx] = useState<WagerRowCtx | null>(null);
  const [wagerSheetOpen, setWagerSheetOpen] = useState(false);
  const [scoreInput, setScoreInput] = useState<{ t1: string; t2: string } | null>(null);
  const [wagerSubject, setWagerSubject] = useState<WagerSubject | null>(null);

  function openWagerSheet(ctx: WagerRowCtx) {
    setWagerCtx(ctx);
    setWagerSheetOpen(true);
  }

  function startWinnerWager(pickedTeam: 'team1' | 'team2') {
    if (!wagerCtx) return;
    setWagerSubject({
      type: 'match',
      matchId: wagerCtx.matchId,
      teamLabels: { team1: wagerCtx.team1Label, team2: wagerCtx.team2Label },
      pickedTeam,
    });
  }

  function confirmScoreWager() {
    if (!wagerCtx || !scoreInput) return;
    const t1 = parseInt(scoreInput.t1, 10);
    const t2 = parseInt(scoreInput.t2, 10);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 < 0 || t2 < 0) {
      status.error('Enter valid scores for both teams.');
      return;
    }
    setWagerSubject({
      type: 'match_score',
      matchId: wagerCtx.matchId,
      team1Score: t1,
      team2Score: t2,
      teamLabels: { team1: wagerCtx.team1Label, team2: wagerCtx.team2Label },
    });
    setScoreInput(null);
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setCurrentUserId(user?.id ?? null);
    });
    loadMatches();
  }, []);

  async function loadMatches() {
    let query = supabase
      .from('matches')
      .select(`
        *,
        player1:profiles!matches_player1_id_fkey(id, full_name, name_color, list_name_style_id),
        partner1:profiles!matches_partner1_id_fkey(id, full_name, name_color, list_name_style_id),
        player2:profiles!matches_player2_id_fkey(id, full_name, name_color, list_name_style_id),
        partner2:profiles!matches_partner2_id_fkey(id, full_name, name_color, list_name_style_id)
      `)
      .order('played_at', { ascending: false });

    if (leagueId) query = query.eq('league_id', leagueId);

    const { data, error } = await query;
    let results = data ?? [];

    // Filter to only matches involving the target player (including as a doubles partner)
    if (userId) {
      results = results.filter((m) =>
        m.player1_id === userId || m.player2_id === userId ||
        m.partner1_id === userId || m.partner2_id === userId
      );
    }

    setMatches(results);
    setLoading(false);
  }

  function isOnTeam1(match: Match, uid: string) {
    return match.player1_id === uid || match.partner1_id === uid;
  }

  async function confirmMatch(matchId: string) {
    const { error } = await supabase.rpc('confirm_match', { p_match_id: matchId });
    if (error) {
      status.error(`Confirm failed: ${error.message}`);
      return;
    }
    status.success('Match confirmed.');
    loadMatches();
  }

  function didWin(match: Match, uid: string) {
    return isOnTeam1(match, uid) ? match.winner_team === 'team1' : match.winner_team === 'team2';
  }

  function ratingChange(match: Match, uid: string): number | null {
    const onTeam1 = isOnTeam1(match, uid);
    const before = onTeam1 ? match.player1_rating_before : match.player2_rating_before;
    const after  = onTeam1 ? match.player1_rating_after  : match.player2_rating_after;
    if (before == null || after == null) return null;
    return after - before;
  }

  function teamNames(item: Match): { team1: string; team2: string } {
    const isDoubles = item.match_type === 'doubles';
    const team1 = isDoubles && item.partner1?.full_name
      ? `${item.player1?.full_name ?? '?'} & ${item.partner1.full_name}`
      : (item.player1?.full_name ?? 'Unknown');
    const team2 = isDoubles && item.partner2?.full_name
      ? `${item.player2?.full_name ?? '?'} & ${item.partner2.full_name}`
      : (item.player2?.full_name ?? 'Unknown');
    return { team1, team2 };
  }

  function renderUpcoming(item: Match) {
    const { team1: team1Name, team2: team2Name } = teamNames(item);
    const isDoubles = item.match_type === 'doubles';

    let whenLabel = 'Time TBD';
    if (item.scheduled_at) {
      const when = new Date(item.scheduled_at);
      const dateStr = when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      whenLabel = `Scheduled for ${dateStr} at ${timeStr}`;
    }

    return (
      <View key={item.id} style={[S.card, S.upcomingCard]}>
        <View style={S.pendingHeader}>
          <Text style={S.upcomingBadgeText}>🗓️ Upcoming</Text>
          <TouchableOpacity
            style={S.pendingMenuBtn}
            accessibilityRole="button"
            accessibilityLabel="Wager options"
            onPress={() => openWagerSheet({
              matchId: item.id,
              team1Label: team1Name,
              team2Label: team2Name,
            })}
          >
            <Text style={S.upcomingMenuText}>⋯</Text>
          </TouchableOpacity>
        </View>
        <Text style={S.upcomingMatchup} numberOfLines={1}>
          <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={S.upcomingMatchup} />
        </Text>
        <Text style={S.upcomingVs}>vs</Text>
        <Text style={S.upcomingMatchup} numberOfLines={1}>
          <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={S.upcomingMatchup} />
        </Text>
        <Text style={S.upcomingWhen}>{whenLabel}</Text>
      </View>
    );
  }

  function renderMatch({ item }: { item: Match }) {
    // Determine perspective: userId param wins, then fall back to logged-in user IF they're in this match
    const inMatch = (uid: string) =>
      item.player1_id === uid || item.player2_id === uid ||
      item.partner1_id === uid || item.partner2_id === uid;

    const viewAs = userId ?? (currentUserId && inMatch(currentUserId) ? currentUserId : null);

    // Gold ring flashed on the deep-linked match (cleared after a couple seconds).
    const isHighlighted = item.id === highlightedId;

    // Pending match — custom card with a Confirm button when the viewer's
    // team hasn't confirmed yet. PLUPRs aren't applied until both teams sign off.
    if (item.status === 'pending') {
      const isDoubles = item.match_type === 'doubles';
      const team1Name = isDoubles && item.partner1?.full_name
        ? `${item.player1?.full_name ?? '?'} & ${item.partner1.full_name}`
        : (item.player1?.full_name ?? 'Unknown');
      const team2Name = isDoubles && item.partner2?.full_name
        ? `${item.player2?.full_name ?? '?'} & ${item.partner2.full_name}`
        : (item.player2?.full_name ?? 'Unknown');
      const team1Done = !!item.team1_confirmed_by;
      const team2Done = !!item.team2_confirmed_by;
      const callerOnTeam1 = !!currentUserId && (currentUserId === item.player1_id || currentUserId === item.partner1_id);
      const callerOnTeam2 = !!currentUserId && (currentUserId === item.player2_id || currentUserId === item.partner2_id);
      const myTeamConfirmed = (callerOnTeam1 && team1Done) || (callerOnTeam2 && team2Done);
      const canCallerConfirm = (callerOnTeam1 && !team1Done) || (callerOnTeam2 && !team2Done);

      // Deadline countdown
      let deadlineLabel = '';
      if (item.confirm_deadline) {
        const msLeft = new Date(item.confirm_deadline).getTime() - Date.now();
        if (msLeft > 0) {
          const m = Math.max(1, Math.round(msLeft / 60000));
          deadlineLabel = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
        } else {
          deadlineLabel = 'expired';
        }
      }

      return (
        <View style={[S.card, S.pendingCard, isHighlighted && S.highlightCard]}>
          <View style={S.pendingHeader}>
            <Text style={S.pendingBadgeText}>⏳ Pending confirmation</Text>
            <View style={S.pendingHeaderRight}>
              {deadlineLabel ? <Text style={S.pendingDeadline}>{deadlineLabel}</Text> : null}
              <TouchableOpacity
                style={S.pendingMenuBtn}
                accessibilityRole="button"
                accessibilityLabel="Wager options"
                onPress={() => openWagerSheet({
                  matchId: item.id,
                  team1Label: team1Name,
                  team2Label: team2Name,
                })}
              >
                <Text style={S.pendingMenuText}>⋯</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={S.pendingMatchup} numberOfLines={1}>
            <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={S.pendingMatchup} />
          </Text>
          <Text style={S.pendingScore}>{item.player1_score} – {item.player2_score}</Text>
          <Text style={S.pendingMatchup} numberOfLines={1}>
            {'vs '}
            <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={S.pendingMatchup} />
          </Text>
          <View style={S.pendingTeamRow}>
            <Text style={[S.pendingTeamStatus, team1Done ? S.pendingTeamDone : S.pendingTeamWaiting]}>
              {team1Done ? '✓ Team 1 confirmed' : '… Team 1 waiting'}
            </Text>
            <Text style={[S.pendingTeamStatus, team2Done ? S.pendingTeamDone : S.pendingTeamWaiting]}>
              {team2Done ? '✓ Team 2 confirmed' : '… Team 2 waiting'}
            </Text>
          </View>
          {canCallerConfirm && (
            <TouchableOpacity style={S.confirmBtn} onPress={() => confirmMatch(item.id)}>
              <Text style={S.confirmBtnText}>✓ Confirm this match</Text>
            </TouchableOpacity>
          )}
          {!canCallerConfirm && myTeamConfirmed && (
            <Text style={S.pendingNote}>Your team confirmed. Waiting on the other team.</Text>
          )}
          {!canCallerConfirm && !myTeamConfirmed && !inMatch(currentUserId ?? '') && (
            <Text style={S.pendingNote}>Awaiting confirmation from both teams.</Text>
          )}
        </View>
      );
    }

    const playedAt = new Date(item.played_at);
    const dateStr  = playedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr  = playedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const isDoubles = item.match_type === 'doubles';

    const locationLine = item.location_name
      ? <Text style={S.locationText}>📍 {displayCourtName(item.location_name)}</Text>
      : null;

    const indoorOutdoorBadge = (
      <View style={[S.indoorBadge, item.is_outdoor === true ? S.outdoorBg : item.is_outdoor === false ? S.indoorBg : S.unknownBg]}>
        <Text style={[S.indoorText, item.is_outdoor === true ? S.outdoorColor : item.is_outdoor === false ? S.indoorColor : S.unknownColor]}>
          {item.is_outdoor === true ? '☀️ Outdoor' : item.is_outdoor === false ? '🏢 Indoor' : '❓ Unknown'}
        </Text>
      </View>
    );

    const categoryBadge = isDoubles ? (
      <View style={[
        S.catBadge,
        item.doubles_category === 'gendered' ? S.catGenderedBg :
        item.doubles_category === 'mixed'    ? S.catMixedBg    : S.catUnspecBg,
      ]}>
        <Text style={[
          S.catText,
          item.doubles_category === 'gendered' ? S.catGenderedColor :
          item.doubles_category === 'mixed'    ? S.catMixedColor    : S.catUnspecColor,
        ]}>
          {item.doubles_category === 'gendered' ? 'Gendered Doubles' :
           item.doubles_category === 'mixed'    ? 'Mixed Doubles'    :
                                                  'Unspecified Doubles'}
        </Text>
      </View>
    ) : null;

    const homeAwayBadge = item.is_home_court != null
      ? (
        <View style={[S.homeAwayBadge, item.is_home_court ? S.homeBadge : S.awayBadge]}>
          <Text style={[S.homeAwayText, item.is_home_court ? S.homeText : S.awayText]}>
            {item.is_home_court ? '🏠 Home' : '✈️ Away'}
          </Text>
        </View>
      ) : null;

    // League-wide view — always show who won so every card has a result indicator
    if (!viewAs) {
      const team1Won = item.winner_team === 'team1';
      return (
        <View style={[S.card, team1Won ? S.win : S.loss, isHighlighted && S.highlightCard]}>
          <View style={S.leagueRow}>
            <View style={[S.resultMini, team1Won ? S.resultMiniWin : S.resultMiniLoss]}>
              <Text style={S.resultMiniText}>{team1Won ? 'W' : 'L'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[S.matchup, team1Won && S.matchupWinner]} numberOfLines={1}>
                <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={[S.matchup, team1Won && S.matchupWinner]} />
              </Text>
              <Text style={[S.matchup, !team1Won && S.matchupWinner]} numberOfLines={1}>
                {'vs '}
                <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={[S.matchup, !team1Won && S.matchupWinner]} />
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <View style={S.leagueMeta}>
                <Text style={S.score}>{item.player1_score} – {item.player2_score}</Text>
                <Text style={S.typeTag}>{item.match_type === 'doubles' ? 'Doubles' : 'Singles'}</Text>
              </View>
              {homeAwayBadge}
              {indoorOutdoorBadge}
              {categoryBadge}
            </View>
          </View>
          <Text style={S.dateText}>{dateStr} at {timeStr}</Text>
          {locationLine}
        </View>
      );
    }

    const won      = didWin(item, viewAs);
    const onTeam1  = isOnTeam1(item, viewAs);
    const myScore  = onTeam1 ? item.player1_score : item.player2_score;
    const oppScore = onTeam1 ? item.player2_score : item.player1_score;
    const delta    = ratingChange(item, viewAs);

    // Build opponent line — for doubles show both opponents
    const oppPlayer  = onTeam1 ? item.player2  : item.player1;
    const oppPartner = onTeam1 ? item.partner2 : item.partner1;
    // Build partner line — for doubles show your partner
    const myPartner = onTeam1 ? item.partner1 : item.partner2;
    const partnerLine = isDoubles && myPartner?.full_name
      ? (
        <Text style={S.partnerText}>
          {'🤝 '}
          <FlairName
            name={myPartner.full_name}
            nameColor={myPartner.name_color}
            styleId={myPartner.list_name_style_id ?? null}
            mode="list"
            style={S.partnerText}
          />
        </Text>
      )
      : null;

    return (
      <View style={[S.card, won ? S.win : S.loss, isHighlighted && S.highlightCard]}>
        <View style={S.cardHeader}>
          <Text style={[S.result, won ? S.winText : S.lossText]}>
            {won ? 'W' : 'L'}
          </Text>
          <View style={S.cardInfo}>
            <Text style={S.opponent} numberOfLines={1}>
              {'vs '}
              <TeamFlair player={oppPlayer} partner={isDoubles ? oppPartner : null} textStyle={S.opponent} />
            </Text>
            {partnerLine}
            <Text style={S.dateText}>{dateStr} at {timeStr}</Text>
            {locationLine}
          </View>
          <View style={S.cardRight}>
            <Text style={S.score}>{myScore} – {oppScore}</Text>
            {delta != null && (
              <Text style={[S.elo, delta >= 0 ? S.eloUp : S.eloDown]}>
                {delta >= 0 ? '+' : ''}{delta.toFixed(2)} PLUPR
              </Text>
            )}
            {homeAwayBadge}
            {indoorOutdoorBadge}
            {categoryBadge}
          </View>
        </View>
      </View>
    );
  }

  const { filtered, upcoming } = useMemo(() => {
    const cutoff = recency ? Date.now() - recency * 86400000 : null;
    const searchLower = playerSearch.trim().toLowerCase();

    const pred = (m: Match, opts: { skipDateFilters?: boolean } = {}) => {
      if (matchType !== 'all' && m.match_type !== matchType) return false;
      if (homeAway === 'home' && !m.is_home_court) return false;
      if (homeAway === 'away' && m.is_home_court) return false;
      if (region !== null && !inRegion(m.location_lat, m.location_lng, region)) return false;
      if (!opts.skipDateFilters && cutoff && new Date(m.played_at).getTime() < cutoff) return false;
      if (indoorOutdoor === 'outdoor' && m.is_outdoor !== true) return false;
      if (indoorOutdoor === 'indoor'  && m.is_outdoor !== false) return false;
      if (indoorOutdoor === 'unknown' && m.is_outdoor !== null) return false;
      if (doublesCategory !== 'all') {
        if (m.match_type !== 'doubles') return false;
        if (m.doubles_category !== doublesCategory) return false;
      }

      // My matches only — show matches where the logged-in user participated
      if (myMatchesOnly && currentUserId) {
        const involved = m.player1_id === currentUserId || m.player2_id === currentUserId ||
                         m.partner1_id === currentUserId || m.partner2_id === currentUserId;
        if (!involved) return false;
      }

      // Player name search — match against all four player names
      if (searchLower) {
        const names = [
          m.player1?.full_name,
          (m as any).partner1?.full_name,
          m.player2?.full_name,
          (m as any).partner2?.full_name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!names.includes(searchLower)) return false;
      }

      return true;
    };

    // Scheduled (future) matches go above the existing list. We skip the
    // recency filter because that pill is about how recently a match was
    // played — irrelevant to something that hasn't happened yet.
    const upcomingList = matches
      .filter((m) => m.status === 'scheduled' && pred(m, { skipDateFilters: true }))
      .sort((a, b) => {
        const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
        const tb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
        return ta - tb;
      });

    const rest = matches.filter((m) => m.status !== 'scheduled' && pred(m));

    return { filtered: rest, upcoming: upcomingList };
  }, [matches, matchType, homeAway, region, recency, myMatchesOnly, currentUserId, playerSearch, indoorOutdoor, doublesCategory]);

  // Keep a live handle on the latest filtered list for deferred scrolls.
  filteredRef.current = filtered;

  // TODO: smoke-test in browser — deep-link scroll-to + gold highlight flash.
  // Scroll to the deep-linked match once it actually appears in the filtered
  // list, then flash its highlight (fades after 2.5s). Depends on `filtered`
  // so it re-checks as the list settles (e.g. `myMatchesOnly` kicks in only
  // after currentUserId resolves). We auto-scroll at most once per target
  // (scrolledForRef) so later user filter edits don't yank the viewport, and
  // the deferred scroll recomputes the index from filteredRef to avoid a stale
  // index if the list changed length in the meantime.
  useEffect(() => {
    if (loading || !highlightMatchId) return;
    if (scrolledForRef.current === highlightMatchId) return;
    if (!filtered.some((m) => m.id === highlightMatchId)) return; // not in list yet — wait for it to settle

    scrolledForRef.current = highlightMatchId;
    setHighlightedId(highlightMatchId);
    const scrollTimer = setTimeout(() => {
      const liveIdx = filteredRef.current.findIndex((m) => m.id === highlightMatchId);
      if (liveIdx >= 0) listRef.current?.scrollToIndex({ index: liveIdx, animated: true, viewPosition: 0.3 });
    }, 200);
    const fadeTimer = setTimeout(() => setHighlightedId(null), 2700);
    return () => { clearTimeout(scrollTimer); clearTimeout(fadeTimer); };
  }, [loading, highlightMatchId, filtered]);

  const activeFilterCount =
    (homeAway !== 'all' ? 1 : 0) +
    (matchType !== 'all' ? 1 : 0) +
    (region !== null ? 1 : 0) +
    (recency !== null ? 1 : 0) +
    (myMatchesOnly ? 1 : 0) +
    (playerSearch.trim() ? 1 : 0) +
    (indoorOutdoor !== 'all' ? 1 : 0) +
    (doublesCategory !== 'all' ? 1 : 0);

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  return (
    <View style={S.container}>
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />
      {/* Filter bar */}
      <View style={S.filterBar}>
        <Text style={S.countText}>{filtered.length} match{filtered.length !== 1 ? 'es' : ''}</Text>
        <TouchableOpacity
          style={[S.filterBtn, activeFilterCount > 0 && S.filterBtnActive]}
          onPress={() => setShowFilters(v => !v)}
        >
          <Text style={[S.filterBtnText, activeFilterCount > 0 && S.filterBtnTextActive]}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </TouchableOpacity>
        {/* My matches quick toggle — only useful in league-wide view */}
        {!userId && (
          <TouchableOpacity
            style={[S.filterBtn, myMatchesOnly && S.filterBtnActive]}
            onPress={() => setMyMatchesOnly(v => !v)}
          >
            <Text style={[S.filterBtnText, myMatchesOnly && S.filterBtnTextActive]}>
              👤 Mine
            </Text>
          </TouchableOpacity>
        )}
        {activeFilterCount > 0 && (
          <TouchableOpacity onPress={() => { setHomeAway('all'); setMatchType('all'); setRegion(null); setRecency(null); setMyMatchesOnly(false); setPlayerSearch(''); setIndoorOutdoor('all'); setDoublesCategory('all'); }}>
            <Text style={S.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter panel */}
      {showFilters && (
        <View style={S.filterPanel}>
          {/* Player name search */}
          <Text style={S.filterLabel}>Player Name</Text>
          <View style={S.searchRow}>
            <TextInput
              style={S.searchInput}
              placeholder="Search by player name..."
              placeholderTextColor={colors.textMuted}
              value={playerSearch}
              onChangeText={setPlayerSearch}
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
            />
            {playerSearch.length > 0 && (
              <TouchableOpacity
                style={S.clearSearch}
                accessibilityRole="button"
                accessibilityLabel="Clear player name search"
                onPress={() => setPlayerSearch('')}
              >
                <Text style={S.clearSearchText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={S.filterLabel}>Recency</Text>
          <View style={S.pillRow}>
            {([null, 3, 7, 30, 90] as RecencyFilter[]).map((v) => (
              <TouchableOpacity key={String(v)} style={[S.pill, recency === v && S.pillActive]} onPress={() => setRecency(v)}>
                <Text style={[S.pillText, recency === v && S.pillTextActive]}>
                  {v === null ? 'All time' : `Last ${v}d`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={S.filterLabel}>Home / Away</Text>
          <View style={S.pillRow}>
            {(['all', 'home', 'away'] as HomeAwayFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[S.pill, homeAway === v && S.pillActive]} onPress={() => setHomeAway(v)}>
                <Text style={[S.pillText, homeAway === v && S.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'home' ? '🏠 Home' : '✈️ Away'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={S.filterLabel}>Match Type</Text>
          <View style={S.pillRow}>
            {(['all', 'singles', 'doubles'] as TypeFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[S.pill, matchType === v && S.pillActive]} onPress={() => setMatchType(v)}>
                <Text style={[S.pillText, matchType === v && S.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'singles' ? 'Singles' : 'Doubles'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={S.filterLabel}>Doubles Category</Text>
          <View style={S.pillRow}>
            {([
              { v: 'all',         label: 'All' },
              { v: 'gendered',    label: 'Gendered Doubles' },
              { v: 'mixed',       label: 'Mixed Doubles' },
              { v: 'unspecified', label: 'Unspecified Doubles' },
            ] as { v: DoublesCategoryFilter; label: string }[]).map(({ v, label }) => (
              <TouchableOpacity key={v} style={[S.pill, doublesCategory === v && S.pillActive]} onPress={() => setDoublesCategory(v)}>
                <Text style={[S.pillText, doublesCategory === v && S.pillTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={S.filterLabel}>Indoor / Outdoor</Text>
          <View style={S.pillRow}>
            {([
              { v: 'all',     label: 'All' },
              { v: 'outdoor', label: '☀️ Outdoor' },
              { v: 'indoor',  label: '🏢 Indoor' },
              { v: 'unknown', label: '❓ Unknown' },
            ] as { v: IndoorOutdoorFilter; label: string }[]).map(({ v, label }) => (
              <TouchableOpacity key={v} style={[S.pill, indoorOutdoor === v && S.pillActive]} onPress={() => setIndoorOutdoor(v)}>
                <Text style={[S.pillText, indoorOutdoor === v && S.pillTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={S.filterLabel}>Region</Text>
          <View style={S.pillRow}>
            <TouchableOpacity style={[S.pill, region === null && S.pillActive]} onPress={() => setRegion(null)}>
              <Text style={[S.pillText, region === null && S.pillTextActive]}>All</Text>
            </TouchableOpacity>
            {REGIONS.map((r) => (
              <TouchableOpacity key={r.name} style={[S.pill, region === r.name && S.pillActive]} onPress={() => setRegion(r.name)}>
                <Text style={[S.pillText, region === r.name && S.pillTextActive]}>{r.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderMatch}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<AppRefreshControl {...refresh} />}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          // Target row isn't measured yet (it's below the render window). Nudge
          // toward it by estimated offset, then retry. Recompute the index from
          // the live filtered list (by id when deep-linking) so a list that
          // shrank between attempts can't park us on the wrong row.
          listRef.current?.scrollToOffset({ offset: index * (averageItemLength || 120), animated: false });
          setTimeout(() => {
            const liveIdx = highlightMatchId
              ? filteredRef.current.findIndex((m) => m.id === highlightMatchId)
              : index;
            if (liveIdx >= 0 && liveIdx < filteredRef.current.length) {
              listRef.current?.scrollToIndex({ index: liveIdx, animated: true, viewPosition: 0.3 });
            }
          }, 120);
        }}
        ListEmptyComponent={
          upcoming.length === 0
            ? <EmptyState icon="🏓" title="No matches yet" subtitle="No matches recorded yet." />
            : null
        }
        ListHeaderComponent={
          (matches.length > 0 || upcoming.length > 0) ? (
            <View>
              {upcoming.length > 0 && (
                <View>
                  <Text style={S.sectionTitle}>🗓️ Upcoming ({upcoming.length})</Text>
                  {upcoming.map(renderUpcoming)}
                </View>
              )}
              {matches.length > 0 && (
                <TouchableOpacity
                  style={S.calendarBtn}
                  onPress={() => navigation.navigate('CalendarAnalytics', {
                    userId,
                    leagueId,
                    title: route.params.title + ' Calendar',
                  })}
                >
                  <Text style={S.calendarBtnText}>📅  View Calendar Analytics</Text>
                </TouchableOpacity>
              )}
              {upcoming.length > 0 && filtered.length > 0 && (
                <Text style={S.sectionTitle}>Match History</Text>
              )}
            </View>
          ) : null
        }
      />

      <ActionSheetModal
        visible={wagerSheetOpen}
        title="Place a wager"
        subtitle={wagerCtx ? `${wagerCtx.team1Label} vs ${wagerCtx.team2Label}` : undefined}
        onClose={() => setWagerSheetOpen(false)}
        actions={wagerCtx ? [
          { label: `🎲 Wager: ${wagerCtx.team1Label} wins`, onPress: () => startWinnerWager('team1') },
          { label: `🎲 Wager: ${wagerCtx.team2Label} wins`, onPress: () => startWinnerWager('team2') },
          { label: '🎲 Wager: exact score',                 onPress: () => setScoreInput({ t1: '', t2: '' }) },
        ] : []}
      />

      <ConfirmModal
        visible={scoreInput != null}
        title="Wager: exact score"
        body={wagerCtx ? `${wagerCtx.team1Label} vs ${wagerCtx.team2Label}` : undefined}
        primaryLabel="Continue"
        primaryDisabled={!scoreInput || scoreInput.t1.trim() === '' || scoreInput.t2.trim() === ''}
        extraField={scoreInput ? (
          <View>
            <Text style={S.scoreInputLabel}>Predicted final score</Text>
            <View style={S.scoreInputRow}>
              <TextInput
                style={S.scoreInput}
                value={scoreInput.t1}
                onChangeText={(v) => setScoreInput({ ...scoreInput, t1: v.replace(/[^0-9]/g, '') })}
                keyboardType="number-pad"
                maxLength={3}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={S.scoreInputDash}>–</Text>
              <TextInput
                style={S.scoreInput}
                value={scoreInput.t2}
                onChangeText={(v) => setScoreInput({ ...scoreInput, t2: v.replace(/[^0-9]/g, '') })}
                keyboardType="number-pad"
                maxLength={3}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
              />
            </View>
          </View>
        ) : undefined}
        onConfirm={confirmScoreWager}
        onClose={() => setScoreInput(null)}
      />

      <WagerProposeModal
        visible={wagerSubject != null}
        subject={wagerSubject}
        onClose={() => setWagerSubject(null)}
      />
    </View>
  );
}

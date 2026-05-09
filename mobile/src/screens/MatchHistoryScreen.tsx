import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, TextInput } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { REGIONS, inRegion } from '../lib/regions';
import { Match, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

type HomeAwayFilter     = 'all' | 'home' | 'away';
type TypeFilter         = 'all' | 'singles' | 'doubles';
type RecencyFilter      = 3 | 7 | 30 | 90 | null; // days; null = all time
type IndoorOutdoorFilter = 'all' | 'outdoor' | 'indoor' | 'unknown';

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
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },
    calendarBtn: { backgroundColor: c.primaryLight, borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' },
    calendarBtnText: { color: c.primary, fontWeight: '700', fontSize: 15 },
  });
}

export default function MatchHistoryScreen({ navigation, route }: Props) {
  const { leagueId, userId } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [matches, setMatches]       = useState<Match[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [homeAway, setHomeAway]     = useState<HomeAwayFilter>('all');
  const [matchType, setMatchType]   = useState<TypeFilter>('all');
  const [region, setRegion]         = useState<string | null>(null);
  const [recency, setRecency]       = useState<RecencyFilter>(null);
  const [playerSearch, setPlayerSearch] = useState('');
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [indoorOutdoor, setIndoorOutdoor] = useState<IndoorOutdoorFilter>('all');

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
        player1:profiles!matches_player1_id_fkey(id, full_name),
        partner1:profiles!matches_partner1_id_fkey(id, full_name),
        player2:profiles!matches_player2_id_fkey(id, full_name),
        partner2:profiles!matches_partner2_id_fkey(id, full_name)
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

  function renderMatch({ item }: { item: Match }) {
    // Determine perspective: userId param wins, then fall back to logged-in user IF they're in this match
    const inMatch = (uid: string) =>
      item.player1_id === uid || item.player2_id === uid ||
      item.partner1_id === uid || item.partner2_id === uid;

    const viewAs = userId ?? (currentUserId && inMatch(currentUserId) ? currentUserId : null);

    const playedAt = new Date(item.played_at);
    const dateStr  = playedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr  = playedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const isDoubles = item.match_type === 'doubles';

    // Build display names for each side
    const team1Name = isDoubles && item.partner1?.full_name
      ? `${item.player1?.full_name ?? '?'} & ${item.partner1.full_name}`
      : (item.player1?.full_name ?? 'Unknown');
    const team2Name = isDoubles && item.partner2?.full_name
      ? `${item.player2?.full_name ?? '?'} & ${item.partner2.full_name}`
      : (item.player2?.full_name ?? 'Unknown');

    const locationLine = item.location_name
      ? <Text style={S.locationText}>📍 {item.location_name}</Text>
      : null;

    const indoorOutdoorBadge = (
      <View style={[S.indoorBadge, item.is_outdoor === true ? S.outdoorBg : item.is_outdoor === false ? S.indoorBg : S.unknownBg]}>
        <Text style={[S.indoorText, item.is_outdoor === true ? S.outdoorColor : item.is_outdoor === false ? S.indoorColor : S.unknownColor]}>
          {item.is_outdoor === true ? '☀️ Outdoor' : item.is_outdoor === false ? '🏢 Indoor' : '❓ Unknown'}
        </Text>
      </View>
    );

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
        <View style={[S.card, team1Won ? S.win : S.loss]}>
          <View style={S.leagueRow}>
            <View style={[S.resultMini, team1Won ? S.resultMiniWin : S.resultMiniLoss]}>
              <Text style={S.resultMiniText}>{team1Won ? 'W' : 'L'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[S.matchup, team1Won && S.matchupWinner]} numberOfLines={1}>
                {team1Name}
              </Text>
              <Text style={[S.matchup, !team1Won && S.matchupWinner]} numberOfLines={1}>
                vs {team2Name}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <View style={S.leagueMeta}>
                <Text style={S.score}>{item.player1_score} – {item.player2_score}</Text>
                <Text style={S.typeTag}>{item.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
              </View>
              {homeAwayBadge}
              {indoorOutdoorBadge}
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
    const oppTeamName = onTeam1 ? team2Name : team1Name;
    // Build partner line — for doubles show your partner
    const myPartner = onTeam1 ? item.partner1 : item.partner2;
    const partnerLine = isDoubles && myPartner?.full_name
      ? <Text style={S.partnerText}>🤝 {myPartner.full_name}</Text>
      : null;

    return (
      <View style={[S.card, won ? S.win : S.loss]}>
        <View style={S.cardHeader}>
          <Text style={[S.result, won ? S.winText : S.lossText]}>
            {won ? 'W' : 'L'}
          </Text>
          <View style={S.cardInfo}>
            <Text style={S.opponent} numberOfLines={1}>
              vs {oppTeamName}
            </Text>
            {partnerLine}
            <Text style={S.dateText}>{dateStr} at {timeStr}</Text>
            {locationLine}
          </View>
          <View style={S.cardRight}>
            <Text style={S.score}>{myScore} – {oppScore}</Text>
            {delta != null && (
              <Text style={[S.elo, delta >= 0 ? S.eloUp : S.eloDown]}>
                {delta >= 0 ? '+' : ''}{delta} ELO
              </Text>
            )}
            {homeAwayBadge}
            {indoorOutdoorBadge}
          </View>
        </View>
      </View>
    );
  }

  const filtered = useMemo(() => {
    const cutoff = recency ? Date.now() - recency * 86400000 : null;
    const searchLower = playerSearch.trim().toLowerCase();

    return matches.filter((m) => {
      if (matchType !== 'all' && m.match_type !== matchType) return false;
      if (homeAway === 'home' && !m.is_home_court) return false;
      if (homeAway === 'away' && m.is_home_court) return false;
      if (region !== null && !inRegion(m.location_lat, m.location_lng, region)) return false;
      if (cutoff && new Date(m.played_at).getTime() < cutoff) return false;
      if (indoorOutdoor === 'outdoor' && m.is_outdoor !== true) return false;
      if (indoorOutdoor === 'indoor'  && m.is_outdoor !== false) return false;
      if (indoorOutdoor === 'unknown' && m.is_outdoor !== null) return false;

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
    });
  }, [matches, matchType, homeAway, region, recency, myMatchesOnly, currentUserId, playerSearch, indoorOutdoor]);

  const activeFilterCount =
    (homeAway !== 'all' ? 1 : 0) +
    (matchType !== 'all' ? 1 : 0) +
    (region !== null ? 1 : 0) +
    (recency !== null ? 1 : 0) +
    (myMatchesOnly ? 1 : 0) +
    (playerSearch.trim() ? 1 : 0) +
    (indoorOutdoor !== 'all' ? 1 : 0);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

  return (
    <View style={S.container}>
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
          <TouchableOpacity onPress={() => { setHomeAway('all'); setMatchType('all'); setRegion(null); setRecency(null); setMyMatchesOnly(false); setPlayerSearch(''); setIndoorOutdoor('all'); }}>
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
              <TouchableOpacity style={S.clearSearch} onPress={() => setPlayerSearch('')}>
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
                  {v === 'all' ? 'All' : v === 'singles' ? '1v1' : '2v2'}
                </Text>
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
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderMatch}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={<Text style={S.empty}>No matches recorded yet.</Text>}
        ListHeaderComponent={
          matches.length > 0 ? (
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
          ) : null
        }
      />
    </View>
  );
}

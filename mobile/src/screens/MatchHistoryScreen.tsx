import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { REGIONS, inRegion } from '../lib/regions';
import { Match, RootStackParamList } from '../types';

type HomeAwayFilter = 'all' | 'home' | 'away';
type TypeFilter     = 'all' | 'singles' | 'doubles';
type RecencyFilter  = 3 | 7 | 30 | 90 | null; // days; null = all time

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchHistory'>;
  route: RouteProp<RootStackParamList, 'MatchHistory'>;
};

export default function MatchHistoryScreen({ navigation, route }: Props) {
  const { leagueId, userId } = route.params;
  const [matches, setMatches]       = useState<Match[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [homeAway, setHomeAway]     = useState<HomeAwayFilter>('all');
  const [matchType, setMatchType]   = useState<TypeFilter>('all');
  const [region, setRegion]         = useState<string | null>(null);
  const [recency, setRecency]       = useState<RecencyFilter>(null);

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
        player2:profiles!matches_player2_id_fkey(id, full_name)
      `)   /* location_name, location_lat, location_lng included via * */
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
    const typeTag  = item.match_type === 'doubles' ? ' · 2v2' : '';

    const locationLine = item.location_name
      ? <Text style={styles.locationText}>📍 {item.location_name}</Text>
      : null;

    const homeAwayBadge = item.is_home_court != null
      ? (
        <View style={[styles.homeAwayBadge, item.is_home_court ? styles.homeBadge : styles.awayBadge]}>
          <Text style={[styles.homeAwayText, item.is_home_court ? styles.homeText : styles.awayText]}>
            {item.is_home_court ? '🏠 Home' : '✈️ Away'}
          </Text>
        </View>
      ) : null;

    // League-wide view — always show who won so every card has a result indicator
    if (!viewAs) {
      const team1Won = item.winner_team === 'team1';
      return (
        <View style={[styles.card, team1Won ? styles.win : styles.loss]}>
          <View style={styles.leagueRow}>
            <View style={[styles.resultMini, team1Won ? styles.resultMiniWin : styles.resultMiniLoss]}>
              <Text style={styles.resultMiniText}>{team1Won ? 'W' : 'L'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.matchup, team1Won && styles.matchupWinner]} numberOfLines={1}>
                {item.player1?.full_name}
              </Text>
              <Text style={[styles.matchup, !team1Won && styles.matchupWinner]} numberOfLines={1}>
                vs {item.player2?.full_name}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <View style={styles.leagueMeta}>
                <Text style={styles.score}>{item.player1_score} – {item.player2_score}</Text>
                <Text style={styles.typeTag}>{item.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
              </View>
              {homeAwayBadge}
            </View>
          </View>
          <Text style={styles.dateText}>{dateStr} at {timeStr}</Text>
          {locationLine}
        </View>
      );
    }

    const won      = didWin(item, viewAs);
    const onTeam1  = isOnTeam1(item, viewAs);
    const opponent = onTeam1 ? item.player2 : item.player1;
    const myScore  = onTeam1 ? item.player1_score : item.player2_score;
    const oppScore = onTeam1 ? item.player2_score : item.player1_score;
    const delta    = ratingChange(item, viewAs);

    return (
      <View style={[styles.card, won ? styles.win : styles.loss]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.result, won ? styles.winText : styles.lossText]}>
            {won ? 'W' : 'L'}
          </Text>
          <View style={styles.cardInfo}>
            <Text style={styles.opponent} numberOfLines={1}>
              vs {opponent?.full_name ?? 'Unknown'}{typeTag}
            </Text>
            <Text style={styles.dateText}>{dateStr} at {timeStr}</Text>
            {locationLine}
          </View>
          <View style={styles.cardRight}>
            <Text style={styles.score}>{myScore} – {oppScore}</Text>
            {delta != null && (
              <Text style={[styles.elo, delta >= 0 ? styles.eloUp : styles.eloDown]}>
                {delta >= 0 ? '+' : ''}{delta} ELO
              </Text>
            )}
            {homeAwayBadge}
          </View>
        </View>
      </View>
    );
  }

  const filtered = useMemo(() => {
    const cutoff = recency ? Date.now() - recency * 86400000 : null;
    return matches.filter((m) => {
      if (matchType !== 'all' && m.match_type !== matchType) return false;
      if (homeAway === 'home' && !m.is_home_court) return false;
      if (homeAway === 'away' && m.is_home_court) return false;
      if (region !== null && !inRegion(m.location_lat, m.location_lng, region)) return false;
      if (cutoff && new Date(m.played_at).getTime() < cutoff) return false;
      return true;
    });
  }, [matches, matchType, homeAway, region, recency]);

  const activeFilterCount = (homeAway !== 'all' ? 1 : 0) + (matchType !== 'all' ? 1 : 0) + (region !== null ? 1 : 0) + (recency !== null ? 1 : 0);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <View style={styles.container}>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        <Text style={styles.countText}>{filtered.length} match{filtered.length !== 1 ? 'es' : ''}</Text>
        <TouchableOpacity
          style={[styles.filterBtn, activeFilterCount > 0 && styles.filterBtnActive]}
          onPress={() => setShowFilters(v => !v)}
        >
          <Text style={[styles.filterBtnText, activeFilterCount > 0 && styles.filterBtnTextActive]}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </TouchableOpacity>
        {activeFilterCount > 0 && (
          <TouchableOpacity onPress={() => { setHomeAway('all'); setMatchType('all'); setRegion(null); setRecency(null); }}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter panel */}
      {showFilters && (
        <View style={styles.filterPanel}>
          <Text style={styles.filterLabel}>Recency</Text>
          <View style={styles.pillRow}>
            {([null, 3, 7, 30, 90] as RecencyFilter[]).map((v) => (
              <TouchableOpacity key={String(v)} style={[styles.pill, recency === v && styles.pillActive]} onPress={() => setRecency(v)}>
                <Text style={[styles.pillText, recency === v && styles.pillTextActive]}>
                  {v === null ? 'All time' : `Last ${v}d`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.filterLabel}>Home / Away</Text>
          <View style={styles.pillRow}>
            {(['all', 'home', 'away'] as HomeAwayFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[styles.pill, homeAway === v && styles.pillActive]} onPress={() => setHomeAway(v)}>
                <Text style={[styles.pillText, homeAway === v && styles.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'home' ? '🏠 Home' : '✈️ Away'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.filterLabel}>Match Type</Text>
          <View style={styles.pillRow}>
            {(['all', 'singles', 'doubles'] as TypeFilter[]).map((v) => (
              <TouchableOpacity key={v} style={[styles.pill, matchType === v && styles.pillActive]} onPress={() => setMatchType(v)}>
                <Text style={[styles.pillText, matchType === v && styles.pillTextActive]}>
                  {v === 'all' ? 'All' : v === 'singles' ? '1v1' : '2v2'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.filterLabel}>Region</Text>
          <View style={styles.pillRow}>
            <TouchableOpacity style={[styles.pill, region === null && styles.pillActive]} onPress={() => setRegion(null)}>
              <Text style={[styles.pillText, region === null && styles.pillTextActive]}>All</Text>
            </TouchableOpacity>
            {REGIONS.map((r) => (
              <TouchableOpacity key={r.name} style={[styles.pill, region === r.name && styles.pillActive]} onPress={() => setRegion(r.name)}>
                <Text style={[styles.pillText, region === r.name && styles.pillTextActive]}>{r.name}</Text>
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
        ListEmptyComponent={<Text style={styles.empty}>No matches recorded yet.</Text>}
        ListHeaderComponent={
          matches.length > 0 ? (
            <TouchableOpacity
              style={styles.calendarBtn}
              onPress={() => navigation.navigate('CalendarAnalytics', {
                userId,
                leagueId,
                title: route.params.title + ' Calendar',
              })}
            >
              <Text style={styles.calendarBtnText}>📅  View Calendar Analytics</Text>
            </TouchableOpacity>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  card: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: '#ddd' },
  win:  { borderLeftColor: '#2e7d32' },
  loss: { borderLeftColor: '#c62828' },
  leagueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  typeTag: { fontSize: 11, color: '#aaa', fontWeight: '600', textTransform: 'uppercase' },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  result: { fontSize: 22, fontWeight: '800', width: 28 },
  winText:  { color: '#2e7d32' },
  lossText: { color: '#c62828' },
  cardInfo: { flex: 1, marginLeft: 10 },
  opponent: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  dateText: { fontSize: 12, color: '#888', marginTop: 2 },
  locationText: { fontSize: 11, color: '#aaa', marginTop: 1 },
  cardRight: { alignItems: 'flex-end' },
  matchup: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', flex: 1, marginRight: 8 },
  score: { fontSize: 15, fontWeight: '700', color: '#333' },
  elo: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  eloUp:   { color: '#2e7d32' },
  eloDown: { color: '#c62828' },
  filterBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee', gap: 8 },
  countText: { flex: 1, fontSize: 13, color: '#888' },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd' },
  filterBtnActive: { borderColor: '#2e7d32', backgroundColor: '#e8f5e9' },
  filterBtnText: { fontSize: 13, fontWeight: '600', color: '#666' },
  filterBtnTextActive: { color: '#2e7d32' },
  clearText: { fontSize: 13, color: '#c62828', fontWeight: '600' },
  filterPanel: { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee', gap: 8 },
  filterLabel: { fontSize: 12, fontWeight: '700', color: '#555', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd', backgroundColor: '#fafafa' },
  pillActive: { borderColor: '#2e7d32', backgroundColor: '#e8f5e9' },
  pillText: { fontSize: 13, color: '#666', fontWeight: '500' },
  pillTextActive: { color: '#2e7d32', fontWeight: '700' },
  resultMini: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  resultMiniWin: { backgroundColor: '#2e7d32' },
  resultMiniLoss: { backgroundColor: '#c62828' },
  resultMiniText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  matchupWinner: { fontWeight: '800', color: '#1a1a1a' },
  leagueMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  homeAwayBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  homeBadge: { backgroundColor: '#e8f5e9' },
  awayBadge: { backgroundColor: '#f5f5f5' },
  homeAwayText: { fontSize: 11, fontWeight: '700' },
  homeText: { color: '#2e7d32' },
  awayText: { color: '#888' },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 16 },
  calendarBtn: { backgroundColor: '#e8f5e9', borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' },
  calendarBtnText: { color: '#2e7d32', fontWeight: '700', fontSize: 15 },
});

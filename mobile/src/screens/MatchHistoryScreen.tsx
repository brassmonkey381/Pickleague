import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Match, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchHistory'>;
  route: RouteProp<RootStackParamList, 'MatchHistory'>;
};

export default function MatchHistoryScreen({ navigation, route }: Props) {
  const { leagueId, userId } = route.params;
  const [matches, setMatches] = useState<Match[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
    const typeTag  = item.match_type === 'doubles' ? ' · 2v2' : '';

    // League-wide view (no personal perspective): show both sides
    if (!viewAs) {
      return (
        <View style={styles.card}>
          <View style={styles.leagueRow}>
            <Text style={styles.matchup} numberOfLines={1}>
              {item.player1?.full_name} vs {item.player2?.full_name}
            </Text>
            <Text style={styles.typeTag}>{item.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
          </View>
          <Text style={styles.score}>{item.player1_score} – {item.player2_score}</Text>
          <Text style={styles.dateText}>{dateStr} at {timeStr}</Text>
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
          </View>
          <View style={styles.cardRight}>
            <Text style={styles.score}>{myScore} – {oppScore}</Text>
            {delta != null && (
              <Text style={[styles.elo, delta >= 0 ? styles.eloUp : styles.eloDown]}>
                {delta >= 0 ? '+' : ''}{delta} ELO
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <View style={styles.container}>
      <FlatList
        data={matches}
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
  cardRight: { alignItems: 'flex-end' },
  matchup: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', flex: 1, marginRight: 8 },
  score: { fontSize: 15, fontWeight: '700', color: '#333' },
  elo: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  eloUp:   { color: '#2e7d32' },
  eloDown: { color: '#c62828' },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 16 },
  calendarBtn: { backgroundColor: '#e8f5e9', borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' },
  calendarBtnText: { color: '#2e7d32', fontWeight: '700', fontSize: 15 },
});

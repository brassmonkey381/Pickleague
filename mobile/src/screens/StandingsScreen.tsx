import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';

type Props = {
  route: RouteProp<RootStackParamList, 'Standings'>;
  navigation: NativeStackNavigationProp<RootStackParamList, 'Standings'>;
};

type Standing = {
  user_id: string;
  full_name: string;
  rating: number;
  wins: number;
  losses: number;
  winRate: number;
  totalMatches: number;
};

const MEDALS = ['🥇', '🥈', '🥉'];

export default function StandingsScreen({ route, navigation }: Props) {
  const { leagueId } = route.params;
  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadStandings(); }, []);

  async function loadStandings() {
    const { data: members } = await supabase
      .from('league_members')
      .select('user_id, profile:profiles(full_name, rating)')
      .eq('league_id', leagueId);

    // Fetch all match columns needed for correct doubles W/L
    const { data: matches } = await supabase
      .from('matches')
      .select('player1_id, partner1_id, player2_id, partner2_id, winner_team')
      .eq('league_id', leagueId);

    const standings: Standing[] = (members ?? []).map((m: any) => {
      const uid = m.user_id;

      const playerMatches = (matches ?? []).filter((match: any) =>
        match.player1_id  === uid || match.player2_id  === uid ||
        match.partner1_id === uid || match.partner2_id === uid
      );

      const wins = playerMatches.filter((match: any) => {
        const onTeam1 = match.player1_id === uid || match.partner1_id === uid;
        return onTeam1 ? match.winner_team === 'team1' : match.winner_team === 'team2';
      }).length;

      const losses = playerMatches.length - wins;
      const total  = playerMatches.length;

      return {
        user_id:      uid,
        full_name:    m.profile?.full_name ?? 'Unknown',
        rating:       m.profile?.rating ?? 1000,
        wins,
        losses,
        winRate:      total > 0 ? Math.round((wins / total) * 100) : 0,
        totalMatches: total,
      };
    });

    standings.sort((a, b) => b.rating - a.rating);
    setStandings(standings);
    setLoading(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  const topRating  = standings[0]?.rating ?? 1000;
  const baseRating = 1000;

  return (
    <FlatList
      data={standings}
      keyExtractor={(item) => item.user_id}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{standings.length} Players</Text>
        </View>
      }
      renderItem={({ item, index }) => {
        const medal = MEDALS[index] ?? null;
        const barWidth = topRating > baseRating
          ? Math.max(4, ((item.rating - baseRating) / (topRating - baseRating)) * 100)
          : item.totalMatches > 0 ? 50 : 4;

        return (
          <TouchableOpacity
            style={[styles.row, index === 0 && styles.rowFirst]}
            onPress={() => navigation.navigate('MatchHistory', {
              userId: item.user_id,
              title: item.full_name,
            })}
            activeOpacity={0.75}
          >
            {/* Rank */}
            <View style={styles.rankCol}>
              {medal
                ? <Text style={styles.medal}>{medal}</Text>
                : <Text style={styles.rank}>#{index + 1}</Text>
              }
            </View>

            {/* Name + record + ELO bar */}
            <View style={styles.info}>
              <Text style={[styles.name, index === 0 && styles.nameFirst]} numberOfLines={1}>
                {item.full_name}
              </Text>
              <Text style={styles.record}>
                {item.wins}W – {item.losses}L
                {item.totalMatches > 0 ? `  ·  ${item.winRate}%` : '  ·  No matches'}
              </Text>
              {item.totalMatches > 0 && (
                <View style={styles.barBg}>
                  <View style={[styles.barFill, { width: `${barWidth}%` as any }, index === 0 && styles.barFillFirst]} />
                </View>
              )}
            </View>

            {/* ELO */}
            <View style={styles.ratingCol}>
              <Text style={[styles.rating, index === 0 && styles.ratingFirst]}>{item.rating}</Text>
              <Text style={styles.ratingLabel}>ELO</Text>
            </View>
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={styles.empty}>No members yet.</Text>}
    />
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  header: { marginBottom: 12 },
  headerTitle: { fontSize: 13, color: '#999', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    marginBottom: 8, elevation: 1,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4,
  },
  rowFirst: { borderWidth: 1.5, borderColor: '#ffd700', backgroundColor: '#fffef5' },
  rankCol: { width: 36, alignItems: 'center' },
  rank: { fontSize: 14, fontWeight: '700', color: '#bbb' },
  medal: { fontSize: 20 },
  info: { flex: 1, marginHorizontal: 10 },
  name: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 2 },
  nameFirst: { color: '#b8860b' },
  record: { fontSize: 12, color: '#888', marginBottom: 5 },
  barBg: { height: 4, backgroundColor: '#f0f0f0', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: GREEN, borderRadius: 2 },
  barFillFirst: { backgroundColor: '#ffd700' },
  ratingCol: { alignItems: 'flex-end', minWidth: 52 },
  rating: { fontSize: 20, fontWeight: '800', color: GREEN },
  ratingFirst: { color: '#b8860b' },
  ratingLabel: { fontSize: 10, color: '#bbb', textTransform: 'uppercase', letterSpacing: 0.5 },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 16 },
});

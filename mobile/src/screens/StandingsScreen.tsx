import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';

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

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    header: { marginBottom: 12 },
    headerTitle: { fontSize: 13, color: c.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    row: {
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: c.surface, borderRadius: 14, padding: 14,
      marginBottom: 8, elevation: 3,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    },
    rowFirst: { borderWidth: 1.5, borderColor: '#ffd700', backgroundColor: '#fffef5' },
    rankCol: { width: 36, alignItems: 'center' },
    rank: { fontSize: 14, fontWeight: '700', color: c.textMuted },
    medal: { fontSize: 20 },
    info: { flex: 1, marginHorizontal: 10 },
    name: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 2 },
    nameFirst: { color: '#b8860b' },
    record: { fontSize: 12, color: c.textMuted, marginBottom: 5 },
    barBg: { height: 4, backgroundColor: c.border, borderRadius: 2, overflow: 'hidden' },
    barFill: { height: 4, backgroundColor: c.primary, borderRadius: 2 },
    barFillFirst: { backgroundColor: '#ffd700' },
    ratingCol: { alignItems: 'flex-end', minWidth: 52 },
    rating: { fontSize: 20, fontWeight: '800', color: c.primary },
    ratingFirst: { color: '#b8860b' },
    ratingLabel: { fontSize: 10, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15 },
  });
}

export default function StandingsScreen({ route, navigation }: Props) {
  const { leagueId } = route.params;
  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);
  const { colors } = useTheme();
  const S = makeStyles(colors);

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

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

  const topRating  = standings[0]?.rating ?? 1000;
  const baseRating = 1000;

  return (
    <FlatList
      data={standings}
      keyExtractor={(item) => item.user_id}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      ListHeaderComponent={
        <View style={S.header}>
          <Text style={S.headerTitle}>{standings.length} Players</Text>
        </View>
      }
      renderItem={({ item, index }) => {
        const medal = MEDALS[index] ?? null;
        const barWidth = topRating > baseRating
          ? Math.max(4, ((item.rating - baseRating) / (topRating - baseRating)) * 100)
          : item.totalMatches > 0 ? 50 : 4;

        return (
          <TouchableOpacity
            style={[S.row, index === 0 && S.rowFirst]}
            onPress={() => navigation.navigate('PlayerProfile', {
              userId: item.user_id,
              userName: item.full_name,
            })}
            activeOpacity={0.75}
          >
            {/* Rank */}
            <View style={S.rankCol}>
              {medal
                ? <Text style={S.medal}>{medal}</Text>
                : <Text style={S.rank}>#{index + 1}</Text>
              }
            </View>

            {/* Name + record + ELO bar */}
            <View style={S.info}>
              <Text style={[S.name, index === 0 && S.nameFirst]} numberOfLines={1}>
                {item.full_name}
              </Text>
              <Text style={S.record}>
                {item.wins}W – {item.losses}L
                {item.totalMatches > 0 ? `  ·  ${item.winRate}%` : '  ·  No matches'}
              </Text>
              {item.totalMatches > 0 && (
                <View style={S.barBg}>
                  <View style={[S.barFill, { width: `${barWidth}%` as any }, index === 0 && S.barFillFirst]} />
                </View>
              )}
            </View>

            {/* ELO */}
            <View style={S.ratingCol}>
              <Text style={[S.rating, index === 0 && S.ratingFirst]}>{item.rating}</Text>
              <Text style={S.ratingLabel}>ELO</Text>
            </View>
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={S.empty}>No members yet.</Text>}
    />
  );
}

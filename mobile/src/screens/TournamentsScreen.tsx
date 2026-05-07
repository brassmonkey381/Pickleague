import React, { useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Tournament, RootStackParamList } from '../types';
import { FORMAT_META } from '../lib/tournament';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Tournaments'>;
  route: RouteProp<RootStackParamList, 'Tournaments'>;
};

const STATUS_META: Record<Tournament['status'], { label: string; color: string }> = {
  registration: { label: 'Registration Open', color: '#2e7d32' },
  active:       { label: 'In Progress',        color: '#1565c0' },
  completed:    { label: 'Completed',           color: '#888'   },
  cancelled:    { label: 'Cancelled',           color: '#c62828' },
};

export default function TournamentsScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params ?? {};
  const [tournaments, setTournaments] = React.useState<Tournament[]>([]);
  const [playerCounts, setPlayerCounts] = React.useState<Record<string, number>>({});

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    let q = supabase.from('tournaments').select('*').order('created_at', { ascending: false });
    if (leagueId) q = q.eq('league_id', leagueId);

    const { data } = await q;
    const t = (data ?? []) as Tournament[];
    setTournaments(t);

    if (t.length > 0) {
      const ids = t.map(x => x.id);
      const { data: regs } = await supabase
        .from('tournament_registrations')
        .select('tournament_id')
        .in('tournament_id', ids)
        .eq('status', 'approved');
      const counts: Record<string, number> = {};
      (regs ?? []).forEach(r => { counts[r.tournament_id] = (counts[r.tournament_id] ?? 0) + 1; });
      setPlayerCounts(counts);
    }
  }

  function renderCard({ item }: { item: Tournament }) {
    const fmt    = FORMAT_META[item.format];
    const status = STATUS_META[item.status];
    const count  = playerCounts[item.id] ?? 0;

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('TournamentDetail', { tournamentId: item.id, tournamentName: item.name })}
        activeOpacity={0.75}
      >
        <View style={styles.cardTop}>
          <Text style={styles.fmtIcon}>{fmt.icon}</Text>
          <View style={styles.cardInfo}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.fmt}>{fmt.label} · {item.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: status.color + '22' }]}>
            <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
          </View>
        </View>

        <View style={styles.meta}>
          <Text style={styles.metaItem}>👥 {count}{item.max_players ? ` / ${item.max_players}` : ''} players</Text>
          {item.start_time && (
            <Text style={styles.metaItem}>
              📅 {new Date(item.start_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </Text>
          )}
          {item.location_name && (
            <Text style={styles.metaItem} numberOfLines={1}>📍 {item.location_name}</Text>
          )}
        </View>

        <Text style={styles.regMode}>
          {item.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Request to join'}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={tournaments}
        keyExtractor={i => i.id}
        renderItem={renderCard}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        ListEmptyComponent={
          <Text style={styles.empty}>No tournaments yet.{'\n'}Create one to get started!</Text>
        }
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('CreateTournament', { leagueId })}
      >
        <Text style={styles.fabText}>+ New Tournament</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0' },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  fmtIcon: { fontSize: 28, marginRight: 10 },
  cardInfo: { flex: 1 },
  name: { fontSize: 16, fontWeight: '800', color: '#1a1a1a' },
  fmt: { fontSize: 12, color: '#888', marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  statusText: { fontSize: 11, fontWeight: '700' },
  meta: { gap: 3, marginBottom: 8 },
  metaItem: { fontSize: 12, color: '#666' },
  regMode: { fontSize: 12, color: '#aaa' },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 15, lineHeight: 22 },
  fab: { position: 'absolute', bottom: 24, right: 24, backgroundColor: '#2e7d32', paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

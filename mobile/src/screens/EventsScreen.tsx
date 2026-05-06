import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole } from '../lib/leagueRole';
import { LeagueEvent, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Events'>;
  route: RouteProp<RootStackParamList, 'Events'>;
};

function statusLabel(event: LeagueEvent): { text: string; color: string } {
  if (event.status === 'cancelled') return { text: 'Cancelled', color: '#999' };
  if (event.status === 'scheduled') return { text: 'Scheduled', color: '#1565c0' };
  const open = new Date(event.vote_ends_at) > new Date();
  return open
    ? { text: 'Voting open', color: '#2e7d32' }
    : { text: 'Vote closed', color: '#e65100' };
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return `${h}h ${m}m left`;
}

export default function EventsScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const [events, setEvents] = useState<LeagueEvent[]>([]);
  const [myRole, setMyRole] = useState<LeagueRole>(null);

  useFocusEffect(useCallback(() => {
    loadEvents();
    getLeagueRole(leagueId).then(setMyRole);
  }, []));

  async function loadEvents() {
    const { data } = await supabase
      .from('league_events')
      .select('*')
      .eq('league_id', leagueId)
      .order('created_at', { ascending: false });
    setEvents(data ?? []);
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => {
          const { text, color } = statusLabel(item);
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => navigation.navigate('EventDetail', { eventId: item.id, title: item.title })}
            >
              <View style={styles.cardTop}>
                <Text style={styles.eventTitle}>{item.title}</Text>
                <View style={[styles.badge, { backgroundColor: color + '22' }]}>
                  <Text style={[styles.badgeText, { color }]}>{text}</Text>
                </View>
              </View>
              {item.description ? <Text style={styles.desc}>{item.description}</Text> : null}
              {item.status === 'voting' && (
                <Text style={styles.meta}>
                  🗳  Vote deadline: {new Date(item.vote_ends_at).toLocaleString()} · {timeUntil(item.vote_ends_at)}
                </Text>
              )}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>No events yet.{'\n'}Create one to start scheduling league play.</Text>
        }
      />

      {isPrivileged(myRole) && (
        <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('CreateEvent', { leagueId })}>
          <Text style={styles.fabText}>+ New Event</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  eventTitle: { fontSize: 17, fontWeight: '700', color: '#1a1a1a', flex: 1, marginRight: 8 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  desc: { fontSize: 13, color: '#666', marginBottom: 6 },
  meta: { fontSize: 12, color: '#888', marginTop: 4 },
  empty: { textAlign: 'center', color: '#999', marginTop: 60, fontSize: 15, lineHeight: 22 },
  fab: { position: 'absolute', bottom: 24, right: 24, backgroundColor: '#2e7d32', paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});

import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Notifications'> };

type Notification = {
  id: string;
  title: string;
  body: string;
  type: string;
  entity_id: string | null;
  entity_type: string | null;
  is_read: boolean;
  created_at: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TYPE_ICON: Record<string, string> = {
  tournament: '🏆', league: '🎾', match: '🏓', info: '📣',
};

export default function NotificationsScreen({ navigation }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading]             = useState(true);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false });
    setNotifications((data ?? []) as Notification[]);
    setLoading(false);
  }

  async function markRead(id: string) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  }

  async function markAllRead() {
    await supabase.from('notifications').update({ is_read: true }).eq('is_read', false);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
  }

  async function deleteNotification(id: string) {
    await supabase.from('notifications').delete().eq('id', id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  }

  function handleTap(n: Notification) {
    markRead(n.id);
    if (n.entity_type === 'tournament' && n.entity_id) {
      navigation.navigate('TournamentDetail', { tournamentId: n.entity_id, tournamentName: n.title.replace('🏆 ', '') });
    } else if (n.entity_type === 'league' && n.entity_id) {
      navigation.navigate('LeagueDetail', { leagueId: n.entity_id, leagueName: n.title });
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  return (
    <View style={styles.container}>
      {unreadCount > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={markAllRead}>
          <Text style={styles.markAllText}>Mark all as read ({unreadCount})</Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={notifications}
        keyExtractor={n => n.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.card, !item.is_read && styles.cardUnread]}
            onPress={() => handleTap(item)}
            onLongPress={() => deleteNotification(item.id)}
          >
            <View style={styles.iconCol}>
              <Text style={styles.typeIcon}>{TYPE_ICON[item.type] ?? '📣'}</Text>
              {!item.is_read && <View style={styles.unreadDot} />}
            </View>
            <View style={styles.content}>
              <Text style={[styles.title, !item.is_read && styles.titleUnread]}>{item.title}</Text>
              <Text style={styles.body}>{item.body}</Text>
              <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.empty}>No notifications yet.</Text>
            <Text style={styles.emptySub}>You'll be notified when brackets are set, invites arrive, and more.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  markAllBtn: { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  markAllText: { color: '#2e7d32', fontWeight: '600', fontSize: 14 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, flexDirection: 'row', gap: 12, elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: '#2e7d32', backgroundColor: '#f9fffe' },
  iconCol: { alignItems: 'center', gap: 6 },
  typeIcon: { fontSize: 22 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#2e7d32' },
  content: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 3 },
  titleUnread: { color: '#1a1a1a', fontWeight: '700' },
  body: { fontSize: 13, color: '#444', lineHeight: 18 },
  time: { fontSize: 11, color: '#aaa', marginTop: 5 },
  emptyWrap: { alignItems: 'center', marginTop: 80, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  empty: { fontSize: 17, fontWeight: '700', color: '#555', marginBottom: 6 },
  emptySub: { fontSize: 13, color: '#aaa', textAlign: 'center', lineHeight: 18 },
});

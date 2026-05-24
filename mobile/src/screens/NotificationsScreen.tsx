import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

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
  tournament: '🏆', league: '🥎', match: '🥒', drill: '🥒', info: '📣',
};

// Invite-broadcast bodies have the form "...use invite code TOKEN to join.".
// Server format lives in supabase/migration_invite_code_broadcast.sql.
function extractInviteCode(body: string): string | null {
  const m = body.match(/invite code ([A-Z0-9-]+)/i);
  return m ? m[1] : null;
}

export default function NotificationsScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

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
    } else if (n.entity_type === 'league') {
      // League invites land in Leagues with the code prefilled — recipient isn't
      // a member yet, so LeagueDetail would fail. Other league notifications
      // (no embedded code) fall through to LeagueDetail.
      const code = extractInviteCode(n.body);
      if (code) {
        navigation.navigate('Leagues', { prefillInviteCode: code });
      } else if (n.entity_id) {
        navigation.navigate('LeagueDetail', { leagueId: n.entity_id, leagueName: n.title });
      }
    } else if (n.entity_type === 'drill') {
      navigation.navigate('DrillRequests');
    } else if (n.entity_type === 'shop') {
      navigation.navigate('Shop');
    } else if (n.entity_type === 'profile') {
      // entity_id is the recipient's own user_id (self-targeting).
      navigation.navigate('Profile', { userId: n.entity_id ?? undefined });
    } else if (n.entity_type === 'plupr_history') {
      navigation.navigate('CalendarAnalytics', {
        userId: n.entity_id ?? undefined,
        title: 'My PLUPR History',
      });
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;

  return (
    <View style={S.container}>
      {unreadCount > 0 && (
        <TouchableOpacity style={S.markAllBtn} onPress={markAllRead}>
          <Text style={S.markAllText}>Mark all as read ({unreadCount})</Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={notifications}
        keyExtractor={n => n.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[S.card, !item.is_read && S.cardUnread]}
            onPress={() => handleTap(item)}
            onLongPress={() => deleteNotification(item.id)}
          >
            <View style={S.iconCol}>
              <Text style={S.typeIcon}>{TYPE_ICON[item.type] ?? '📣'}</Text>
              {!item.is_read && <View style={S.unreadDot} />}
            </View>
            <View style={S.content}>
              <Text style={[S.title, !item.is_read && S.titleUnread]}>{item.title}</Text>
              <Text style={S.body}>{item.body}</Text>
              <Text style={S.time}>{timeAgo(item.created_at)}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={S.emptyWrap}>
            <Text style={S.emptyIcon}>🔔</Text>
            <Text style={S.empty}>All quiet here!</Text>
            <Text style={S.emptySub}>You'll be notified when brackets are set, invites arrive, and more.</Text>
          </View>
        }
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:   { flex: 1, backgroundColor: c.bg },
    markAllBtn:  { backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
    markAllText: { color: c.primary, fontWeight: '600', fontSize: 14 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      flexDirection: 'row',
      gap: 12,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    cardUnread:  { borderLeftWidth: 3, borderLeftColor: c.primary, backgroundColor: c.primaryLight },
    iconCol:     { alignItems: 'center', gap: 6 },
    typeIcon:    { fontSize: 22 },
    unreadDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary },
    content:     { flex: 1 },
    title:       { fontSize: 14, fontWeight: '600', color: c.textSub, marginBottom: 3 },
    titleUnread: { color: c.text, fontWeight: '700' },
    body:        { fontSize: 13, color: c.textSub, lineHeight: 18 },
    time:        { fontSize: 11, color: c.textMuted, marginTop: 5 },
    emptyWrap:   { alignItems: 'center', marginTop: 80, paddingHorizontal: 32 },
    emptyIcon:   { fontSize: 48, marginBottom: 12 },
    empty:       { fontSize: 17, fontWeight: '700', color: c.textSub, marginBottom: 6 },
    emptySub:    { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
  });
}

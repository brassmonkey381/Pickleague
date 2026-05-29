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
import { DumbbellIcon, BallIcon } from '../components/PickleIcons';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';

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

const TYPE_ICON: Record<string, React.ReactNode> = {
  tournament: '🏆',
  league:     <BallIcon size={22} />,
  match:      '🏅',
  drill:      <DumbbellIcon size={22} />,
  info:       '📣',
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
  const status = useStatusMessage();

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

  // League/tournament invite notifications embed a code in their body. Tapping
  // one auto-redeems it and jumps straight to the joined scope's detail. If the
  // redeem fails (revoked/expired/etc.) we fall back to the manual Join-with-Code
  // page so the user can retry. Returns true if it handled an invite code.
  async function tryAutoAcceptInvite(n: Notification): Promise<boolean> {
    const code = extractInviteCode(n.body);
    if (!code) return false;

    const { data, error } = await supabase.rpc('redeem_invite_code', { p_token: code });
    const row = Array.isArray(data) ? data[0] : data;

    if (error || !row?.success) {
      // Fall back to the current behavior — manual retry on the Leagues
      // Join-with-Code page.
      navigation.navigate('Leagues', { prefillInviteCode: code });
      return true;
    }

    // Landing on the joined scope's detail is itself the confirmation. We don't
    // set a success banner here: this screen unmounts on navigate before it
    // could paint (and the banner would otherwise resurface stale on back-nav).
    if (row.scope_type === 'tournament') {
      navigation.navigate('TournamentDetail', { tournamentId: row.scope_id, tournamentName: row.scope_name });
    } else {
      navigation.navigate('LeagueDetail', { leagueId: row.scope_id, leagueName: row.scope_name });
    }
    return true;
  }

  async function handleTap(n: Notification) {
    markRead(n.id);
    if (n.entity_type === 'tournament') {
      // Tournament invites carry an embedded code → auto-accept. Other
      // tournament notifications (no code) fall through to TournamentDetail.
      if (await tryAutoAcceptInvite(n)) return;
      if (n.entity_id) {
        navigation.navigate('TournamentDetail', { tournamentId: n.entity_id, tournamentName: n.title.replace('🏆 ', '') });
      }
    } else if (n.entity_type === 'league') {
      // League invites carry an embedded code → auto-accept. Other league
      // notifications (no code) fall through to LeagueDetail.
      if (await tryAutoAcceptInvite(n)) return;
      if (n.entity_id) {
        navigation.navigate('LeagueDetail', { leagueId: n.entity_id, leagueName: n.title });
      }
    } else if (n.entity_type === 'match') {
      // Deep-link to the exact match row so the user sees its inline
      // Confirm/Reject controls right away.
      navigation.navigate('MatchHistory', {
        title: 'Match History',
        initialMyMatchesOnly: true,
        highlightMatchId: n.entity_id ?? undefined,
      });
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
      {/* TODO: smoke-test in browser — auto-accept invite toast + deep-link */}
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />
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
              {typeof TYPE_ICON[item.type] === 'string' || TYPE_ICON[item.type] == null
                ? <Text style={S.typeIcon}>{(TYPE_ICON[item.type] as string) ?? '📣'}</Text>
                : <View style={{ alignItems: 'center', justifyContent: 'center' }}>{TYPE_ICON[item.type]}</View>}
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

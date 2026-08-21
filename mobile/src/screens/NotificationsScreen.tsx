import React, { useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery, setQueryData } from '@just-messin-around/expo-foundation/cache';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { WAGERS_ENABLED } from '../lib/features';
import { DumbbellIcon, BallIcon } from '../components/PickleIcons';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

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

const NOTIFICATIONS_KEY = 'notifications:list';

export default function NotificationsScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const status = useStatusMessage();

  const query = useCachedQuery<Notification[]>(
    NOTIFICATIONS_KEY,
    () => sbCall(() => supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })) as Promise<Notification[]>,
    { ttlMs: 30_000, persistMs: 24 * 60 * 60 * 1000 },
  );
  const notifications = query.data ?? [];
  // "All quiet here!" is only honest once a fetch actually succeeded — a dead
  // connection with nothing cached gets a retry affordance instead.
  const loadFailed = query.error != null && query.data === undefined;

  const reload = useCallback(() => query.refresh(), [query.refresh]);
  const refresh = useRefresh(reload);

  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  // The list lives in the query cache, so local edits write through it rather
  // than to component state (which the next revalidation would overwrite).
  function patchList(fn: (list: Notification[]) => Notification[]) {
    setQueryData(NOTIFICATIONS_KEY, fn(notifications));
  }

  async function markRead(id: string) {
    patchList(list => list.map(n => n.id === id ? { ...n, is_read: true } : n));
    try {
      await sbCall(() => supabase.from('notifications').update({ is_read: true }).eq('id', id));
    } catch {
      // Roll the optimistic read-state back so the badge count stays truthful.
      patchList(list => list.map(n => n.id === id ? { ...n, is_read: false } : n));
    }
  }

  async function markAllRead() {
    const previous = notifications;
    patchList(list => list.map(n => ({ ...n, is_read: true })));
    try {
      await sbCall(() => supabase.from('notifications').update({ is_read: true }).eq('is_read', false));
    } catch (e) {
      setQueryData(NOTIFICATIONS_KEY, previous);
      status.error(friendlySbMessage(e, "Couldn't mark them read."));
    }
  }

  async function deleteNotification(id: string) {
    const previous = notifications;
    patchList(list => list.filter(n => n.id !== id));
    try {
      await sbCall(() => supabase.from('notifications').delete().eq('id', id));
    } catch (e) {
      setQueryData(NOTIFICATIONS_KEY, previous);
      status.error(friendlySbMessage(e, "Couldn't delete that notification."));
    }
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
    } else if (n.entity_type === 'event') {
      // Event reminders deep-link to the event page (confirmed time + record button).
      if (n.entity_id) navigation.navigate('EventDetail', { eventId: n.entity_id, title: n.title });
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
    } else if (n.entity_type === 'wager_on_me') {
      // entity_id is the recipient's own user_id — show the wagers on them.
      // Gated (lib/features.ts): the wager screens are not registered while
      // wagering is off, so navigating would throw. A historical wager
      // notification just stays inert rather than crashing the tap.
      if (WAGERS_ENABLED && n.entity_id) {
        navigation.navigate('PlayerWagers', { userId: n.entity_id, userName: 'You' });
      }
    } else if (n.entity_type === 'wager') {
      // Settlement notifications (to the bettor) → their own wager list.
      if (WAGERS_ENABLED) navigation.navigate('MyWagers');
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;

  if (query.loading && !loadFailed) {
    return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;
  }

  return (
    <View style={S.container}>
      {/* TODO: smoke-test in browser — auto-accept invite toast + deep-link */}
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />
      {unreadCount > 0 && (
        <TouchableOpacity
          style={S.markAllBtn}
          onPress={markAllRead}
          accessibilityRole="button"
          accessibilityLabel={`Mark all ${unreadCount} notifications as read`}
        >
          <Text style={S.markAllText}>Mark all as read ({unreadCount})</Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={notifications}
        keyExtractor={n => n.id}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<AppRefreshControl {...refresh} />}
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
          loadFailed
            ? <EmptyState
                icon="📡"
                title="Couldn't load notifications"
                subtitle={friendlySbMessage(query.error)}
                actionLabel="Retry"
                onAction={() => { void reload(); }}
              />
            : <EmptyState
                icon="🔔"
                title="All quiet here!"
                subtitle="You'll be notified when brackets are set, invites arrive, and more."
              />
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

// Settings → Blocked players. Every block made from a "⋯" menu is undoable
// here, which is the half of blocking people actually go looking for.
import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Image, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import AppRefreshControl from '../components/AppRefreshControl';
import { useRefresh } from '../lib/useRefresh';
import { BlockedPlayer, loadBlockedPlayers, unblockUser, SUPPORT_EMAIL } from '../lib/moderation';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'BlockedPlayers'> };

export default function BlockedPlayersScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const toast = useToast();
  const [rows, setRows]       = useState<BlockedPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId]   = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      setRows(await loadBlockedPlayers(force));
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't load your blocked players."));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const refresh = useRefresh(() => load(true));
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function undo(player: BlockedPlayer) {
    setBusyId(player.user_id);
    try {
      await unblockUser(player.user_id);
      setRows(prev => prev.filter(r => r.user_id !== player.user_id));
      toast.success(`${player.full_name} is unblocked.`);
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't unblock them just now."));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <View style={S.page}><SkeletonList rows={4} /></View>;

  return (
    <FlatList
      style={S.page}
      contentContainerStyle={S.content}
      data={rows}
      keyExtractor={r => r.user_id}
      refreshControl={<AppRefreshControl {...refresh} />}
      ListHeaderComponent={
        rows.length > 0 ? (
          <Text style={S.blurb}>
            You and these players can't send each other drill requests or messages, and you
            won't see each other in search. Matches you already played together stay in both
            histories — they're shared results.
          </Text>
        ) : null
      }
      ListEmptyComponent={
        <EmptyState
          icon="🛡️"
          title="No blocked players"
          subtitle={`Block someone from the "⋯" menu on their profile. To report content, use the same menu — we review reports within 24 hours (${SUPPORT_EMAIL}).`}
        />
      }
      renderItem={({ item }) => (
        <View style={S.row}>
          <TouchableOpacity
            style={S.who}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('PlayerProfile', { userId: item.user_id, userName: item.full_name })}
          >
            {item.avatar_url
              ? <Image source={{ uri: item.avatar_url }} style={S.avatar} />
              : <View style={[S.avatar, S.avatarFallback]}><Text style={S.avatarGlyph}>🚫</Text></View>}
            <View style={{ flex: 1 }}>
              <Text style={S.name} numberOfLines={1}>{item.full_name}</Text>
              {item.username ? <Text style={S.handle} numberOfLines={1}>@{item.username}</Text> : null}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={S.undoBtn}
            onPress={() => { void undo(item); }}
            disabled={busyId === item.user_id}
          >
            {busyId === item.user_id
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Text style={S.undoText}>Unblock</Text>}
          </TouchableOpacity>
        </View>
      )}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    page:      { flex: 1, backgroundColor: c.bg },
    content:   { padding: 16, flexGrow: 1 },
    blurb:     { fontSize: 13, color: c.textMuted, lineHeight: 19, marginBottom: 14 },
    row:       { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: 12, padding: 12, marginBottom: 10, gap: 10 },
    who:       { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
    avatar:    { width: 40, height: 40, borderRadius: 20 },
    avatarFallback: { backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    avatarGlyph: { fontSize: 18 },
    name:      { fontSize: 15, fontWeight: '700', color: c.text },
    handle:    { fontSize: 12, color: c.textMuted, marginTop: 1 },
    undoBtn:   { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1.5, borderColor: c.primary, minWidth: 88, alignItems: 'center' },
    undoText:  { color: c.primary, fontWeight: '700', fontSize: 13 },
  });
}

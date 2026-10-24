// Settings → Blocked players. Every block made from a player's More menu is undoable
// here, which is the half of blocking people actually go looking for.
import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
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
  // A failed load must not read as "No blocked players": that copy is a claim
  // about the account, and offline it would be false.
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async (force = false) => {
    try {
      setRows(await loadBlockedPlayers(force));
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
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
        loadError ? (
          <ErrorState error={loadError} onRetry={() => { void load(true); }} />
        ) : (
        <EmptyState
          iconName="shield"
          title="No blocked players"
          subtitle={`Block someone from the More menu on their profile. To report content, use the same menu — we review reports within 24 hours (${SUPPORT_EMAIL}).`}
        />
        )
      }
      renderItem={({ item }) => (
        <View style={S.row}>
          <TouchableOpacity
            style={S.who}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('PlayerProfile', { userId: item.user_id, userName: item.full_name })}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.full_name}'s profile`}
          >
            {item.avatar_url
              ? <CachedImage source={{ uri: item.avatar_url }} style={S.avatar} />
              : <View style={[S.avatar, S.avatarFallback]}><Icon name="block" size={18} color={colors.textMuted} /></View>}
            <View style={S.flex}>
              <Text style={S.name} numberOfLines={1}>{item.full_name}</Text>
              {item.username ? <Text style={S.handle} numberOfLines={1}>@{item.username}</Text> : null}
            </View>
          </TouchableOpacity>
          <Button
            title="Unblock"
            size="sm"
            variant="outline"
            onPress={() => { void undo(item); }}
            loading={busyId === item.user_id}
            accessibilityLabel={`Unblock ${item.full_name}`}
            style={S.undoBtn}
          />
        </View>
      )}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    page:      { flex: 1, backgroundColor: c.bg },
    content:   { padding: SPACE.lg, flexGrow: 1 },
    blurb:     { ...t.hint, marginBottom: SPACE.md },
    row:       { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.md, marginBottom: SPACE.sm, gap: SPACE.sm },
    who:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flex: 1, minHeight: 44 },
    flex:      { flex: 1, minWidth: 0 },
    avatar:    { width: 40, height: 40, borderRadius: RADIUS.pill },
    avatarFallback: { backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    name:      t.title,
    handle:    { ...t.hint, marginTop: SPACE.xxs / 2 },
    undoBtn:   { minWidth: 88 },
  });
}

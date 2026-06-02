import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PlayerWagers'>;
  route: RouteProp<RootStackParamList, 'PlayerWagers'>;
};

type WagerOnPlayer = {
  wager_id: string;
  bettor_id: string;
  bettor_name: string;
  stake: number;
  potential_payout: number;
  odds: number;
  status: 'open' | 'won' | 'lost';
  rank: number;
  subject_type: string;
  scope_name: string | null;
  placed_at: string;
  expected_end_at: string | null;
  league_name: string | null;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_LABEL: Record<string, string> = { open: 'Open', won: 'Won', lost: 'Lost' };

// Date-only, formatted in UTC so date-based ends (season / period / tournament,
// returned at UTC midnight) don't shift a day in the local timezone.
function fmtEndDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// "Under <league> · Ends <date>" — league shown only when it isn't already the
// scope named in the condition line.
function wagerContext(w: WagerOnPlayer): string | null {
  const parts: string[] = [];
  if (w.league_name && w.league_name !== w.scope_name) parts.push(`Under ${w.league_name}`);
  if (w.expected_end_at) {
    const settled = w.status === 'won' || w.status === 'lost';
    parts.push(`${settled ? 'Ended' : 'Ends'} ${fmtEndDate(w.expected_end_at)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export default function PlayerWagersScreen({ navigation, route }: Props) {
  const { userId, userName, scopeType, scopeId, scopeName } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [wagers, setWagers] = useState<WagerOnPlayer[]>([]);
  const [name, setName]     = useState(userName ?? '');
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => { load(); /* eslint-disable-next-line */ }, []));

  async function load() {
    // The notification route only carries the user id — look up the name.
    if (!name) {
      const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', userId).maybeSingle();
      if (prof?.full_name) { setName(prof.full_name); navigation.setOptions({ title: `Wagers on ${prof.full_name}` }); }
    } else {
      navigation.setOptions({ title: `Wagers on ${name}` });
    }

    const { data } = await supabase.rpc('get_wagers_on_player', {
      p_user_id:    userId,
      p_scope_type: scopeType ?? null,
      p_scope_id:   scopeId ?? null,
    });
    setWagers((data ?? []) as WagerOnPlayer[]);
    setLoading(false);
  }

  const total = wagers.reduce((sum, w) => sum + w.stake, 0);

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: c.bg }} size="large" color={c.primary} />;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.bg }}
      data={wagers}
      keyExtractor={w => w.wager_id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        <View style={S.header}>
          <Text style={S.headerTotal}>🥒 {total.toLocaleString()} wagered on {name || 'this player'}</Text>
          <Text style={S.headerSub}>
            {wagers.length} wager{wagers.length !== 1 ? 's' : ''}
            {scopeName ? ` · ${scopeName}` : ''}
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const statusColor = item.status === 'won' ? c.primary : item.status === 'lost' ? c.danger : c.textSub;
        return (
          <View style={S.card}>
            <View style={S.cardTop}>
              <TouchableOpacity
                style={S.bettorWrap}
                onPress={() => navigation.navigate('PlayerProfile', { userId: item.bettor_id, userName: item.bettor_name })}
                activeOpacity={0.7}
              >
                <View style={S.bettorAvatar}>
                  <Text style={S.bettorAvatarText}>{(item.bettor_name || '?')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.bettorLabel}>Wagered by</Text>
                  <Text style={S.bettor} numberOfLines={1}>{item.bettor_name}</Text>
                </View>
              </TouchableOpacity>
              <View style={[S.statusChip, { borderColor: statusColor }]}>
                <Text style={[S.statusText, { color: statusColor }]}>{STATUS_LABEL[item.status] ?? item.status}</Text>
              </View>
            </View>
            <Text style={S.condition}>
              to finish #{item.rank}{item.scope_name ? ` in ${item.scope_name}` : ''}
            </Text>
            {wagerContext(item) && <Text style={S.context}>{wagerContext(item)}</Text>}
            <View style={S.metaRow}>
              <View style={S.metaCol}>
                <Text style={S.metaLabel}>Size</Text>
                <Text style={S.metaValue}>🥒 {item.stake.toLocaleString()}</Text>
              </View>
              <View style={S.metaCol}>
                <Text style={S.metaLabel}>Payout</Text>
                <Text style={S.metaValue}>🥒 {item.potential_payout.toLocaleString()}</Text>
              </View>
              <View style={S.metaCol}>
                <Text style={S.metaLabel}>Odds</Text>
                <Text style={S.metaValue}>{Number(item.odds).toFixed(2)}×</Text>
              </View>
            </View>
            <Text style={S.placed}>Placed {timeAgo(item.placed_at)}</Text>
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={S.emptyWrap}>
          <Text style={S.emptyIcon}>🎲</Text>
          <Text style={S.empty}>No wagers on {name || 'this player'} yet.</Text>
        </View>
      }
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    header:      { marginBottom: 14 },
    headerTotal: { fontSize: 18, fontWeight: '800', color: c.text },
    headerSub:   { fontSize: 13, color: c.textMuted, marginTop: 2 },

    card:        { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border },
    cardTop:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    bettorWrap:  { flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1 },
    bettorAvatar:{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center' },
    bettorAvatarText: { fontSize: 14, fontWeight: '700', color: c.primary },
    bettorLabel: { fontSize: 10, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    bettor:      { fontSize: 15, fontWeight: '700', color: c.text },
    statusChip:  { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
    statusText:  { fontSize: 11, fontWeight: '700' },
    condition:   { fontSize: 13, color: c.textSub, marginTop: 4 },
    context:     { fontSize: 12, color: c.textMuted, marginTop: 3, fontStyle: 'italic' },
    metaRow:     { flexDirection: 'row', marginTop: 12, gap: 16 },
    metaCol:     {},
    metaLabel:   { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    metaValue:   { fontSize: 14, fontWeight: '700', color: c.text, marginTop: 1 },
    placed:      { fontSize: 11, color: c.textMuted, marginTop: 10 },

    emptyWrap:   { alignItems: 'center', marginTop: 70 },
    emptyIcon:   { fontSize: 44, marginBottom: 10 },
    empty:       { fontSize: 15, color: c.textMuted },
  });
}

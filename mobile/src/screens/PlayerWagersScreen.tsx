import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { PickleAmount } from '../components/PickleAmount';
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

// Season and period ends are dates returned at UTC midnight, so they format in
// UTC to keep from shifting a day in the local timezone. A tournament's end
// (start + length) is a real moment, so it formats in the device zone.
function fmtEndDate(iso: string, subjectType: string): string {
  const dateOnly = subjectType === 'season_rank' || subjectType === 'period_rank';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
}

// "Under <league> · Ends <date>" — league shown only when it isn't already the
// scope named in the condition line.
function wagerContext(w: WagerOnPlayer): string | null {
  const parts: string[] = [];
  if (w.league_name && w.league_name !== w.scope_name) parts.push(`Under ${w.league_name}`);
  if (w.expected_end_at) {
    const settled = w.status === 'won' || w.status === 'lost';
    parts.push(`${settled ? 'Ended' : 'Ends'} ${fmtEndDate(w.expected_end_at, w.subject_type)}`);
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); /* eslint-disable-next-line */ }, []));

  async function load() {
    try {
      // The notification route only carries the user id — look up the name.
      if (!name) {
        const prof = await sbCall(() =>
          supabase.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
        );
        if (prof?.full_name) { setName(prof.full_name); navigation.setOptions({ title: `Wagers on ${prof.full_name}` }); }
      } else {
        navigation.setOptions({ title: `Wagers on ${name}` });
      }

      const data = await sbCall(() => supabase.rpc('get_wagers_on_player', {
        p_user_id:    userId,
        p_scope_type: scopeType ?? null,
        p_scope_id:   scopeId ?? null,
      }));
      setWagers((data ?? []) as WagerOnPlayer[]);
      setLoadError(null);
    } catch (e) {
      // "0 pickles wagered" from a failed read is a claim about other people's
      // money — never present it as fact.
      setLoadError(friendlySbMessage(e, "Couldn't load wagers."));
    } finally {
      setLoading(false);
    }
  }

  const total = wagers.reduce((sum, w) => sum + w.stake, 0);

  if (loading) return <View style={S.screen}><SkeletonList rows={6} /></View>;

  if (loadError && wagers.length === 0) {
    return (
      <View style={S.screen}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load wagers. ${loadError}`}
          onRetry={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  return (
    <FlatList
      style={S.screen}
      data={wagers}
      keyExtractor={w => w.wager_id}
      contentContainerStyle={S.list}
      refreshControl={<AppRefreshControl {...refresh} />}
      ListHeaderComponent={
        <View style={S.header}>
          <View
            style={S.headerTotalRow}
            accessible
            accessibilityLabel={`${total.toLocaleString()} ${total === 1 ? 'pickle' : 'pickles'} wagered on ${name || 'this player'}`}
          >
            <PickleAmount amount={total} preset="h3" color={c.text} iconColor={c.primary} />
            <Text style={[S.headerTotal, S.flex1]} numberOfLines={2}>wagered on {name || 'this player'}</Text>
          </View>
          <Text style={S.headerSub}>
            {wagers.length} wager{wagers.length !== 1 ? 's' : ''}
            {scopeName ? ` · ${scopeName}` : ''}
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const statusColor = item.status === 'won' ? c.success : item.status === 'lost' ? c.danger : c.textSub;
        return (
          <View style={S.card}>
            <View style={S.cardTop}>
              <TouchableOpacity
                style={S.bettorWrap}
                onPress={() => navigation.navigate('PlayerProfile', { userId: item.bettor_id, userName: item.bettor_name })}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Wagered by ${item.bettor_name}. Open profile`}
              >
                <View style={S.bettorAvatar}>
                  <Text style={S.bettorAvatarText}>{(item.bettor_name || '?')[0].toUpperCase()}</Text>
                </View>
                <View style={S.flex1}>
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
                <PickleAmount amount={item.stake} preset="bodySub" color={c.text} iconColor={c.primary} textStyle={S.metaValueText} style={S.metaValue} />
              </View>
              <View style={S.metaCol}>
                <Text style={S.metaLabel}>Payout</Text>
                <PickleAmount amount={item.potential_payout} preset="bodySub" color={c.text} iconColor={c.primary} textStyle={S.metaValueText} style={S.metaValue} />
              </View>
              <View style={S.metaCol}>
                <Text style={S.metaLabel}>Odds</Text>
                <Text style={[S.metaValueText, S.metaValue, { color: c.text }]}>{Number(item.odds).toFixed(2)}×</Text>
              </View>
            </View>
            <Text style={S.placed}>Placed {timeAgo(item.placed_at)}</Text>
          </View>
        );
      }}
      ListEmptyComponent={
        <EmptyState iconName="dice" title="No wagers yet" subtitle={`No wagers on ${name || 'this player'} yet.`} />
      }
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen:      { flex: 1, backgroundColor: c.bg },
    list:        { padding: SPACE.lg },
    flex1:       { flex: 1, minWidth: 0 },
    header:      { marginBottom: SPACE.md },
    headerTotalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs },
    headerTotal: t.h3,
    headerSub:   { ...t.hint, marginTop: SPACE.xxs },

    card:        { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    cardTop:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
    bettorWrap:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flex: 1, minHeight: 44 },
    bettorAvatar:{ width: 32, height: 32, borderRadius: RADIUS.pill, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center' },
    bettorAvatarText: { fontSize: FONT.size.md, fontWeight: FONT.weight.bold, color: c.primary },
    bettorLabel: t.fieldLabel,
    bettor:      t.title,
    statusChip:  { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs, borderRadius: RADIUS.pill, borderWidth: HAIRLINE },
    statusText:  { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold },
    condition:   { ...t.sub, marginTop: SPACE.xs },
    context:     { fontSize: FONT.size.sm, color: c.textMuted, marginTop: SPACE.xs, fontStyle: 'italic' },
    metaRow:     { flexDirection: 'row', marginTop: SPACE.md, gap: SPACE.lg },
    metaCol:     {},
    metaLabel:   t.fieldLabel,
    metaValue:   { marginTop: SPACE.xxs },
    metaValueText: { fontSize: FONT.size.md, fontWeight: FONT.weight.bold },
    placed:      { ...t.caption, marginTop: SPACE.sm },
  });
}

// Godmode-only list of courts by outline coverage, busiest first. Tap one to
// draw or fix its outline (AdminBoundaryEditor). Mirrors Doggle's
// AdminBoundariesScreen. Self-guards via is_godmode_user() (amIGodmode); the
// RPC checks again.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { FilterChipRow } from '@just-messin-around/expo-foundation/ui';
import { TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import EmptyState from '../components/EmptyState';
import type { RootStackParamList } from '../types';
import { amIGodmode, adminListVenueBoundaries, type BoundaryFilter, type VenueBoundaryRow } from '../data/venueAdmin';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'AdminBoundaries'> };

const FILTERS: { value: BoundaryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'missing', label: 'No outline' },
  { value: 'has', label: 'Outlined' },
];

export default function AdminBoundariesScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoundaryFilter>('all');
  const [rows, setRows] = useState<VenueBoundaryRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void amIGodmode().then(setAuthorized);
  }, []);

  const load = useCallback(async () => {
    if (!authorized) return;
    setLoading(true);
    try {
      setRows(await adminListVenueBoundaries(query, filter));
    } catch (e) {
      toast.error((e as Error)?.message ?? "Couldn't load courts.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, query, filter]);

  // Debounced search; also reloads on return from the editor.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (authorized === null) return <ActivityIndicator style={styles.center} color={c.primary} />;
  if (!authorized) {
    return <EmptyState iconName="lock" title="Admin access required" subtitle="This screen is for app admins." />;
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(r) => r.id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={t.bodySub}>
            An outline lets a check-in pass anywhere inside a building, however far the court's pin is. Courts
            without one use a 100 m circle around the pin.
          </Text>
          <TextField placeholder="Search courts or cities" value={query} onChangeText={setQuery} autoCorrect={false} />
          <FilterChipRow options={FILTERS} value={filter} onChange={setFilter} />
          {loading ? <ActivityIndicator color={c.primary} /> : null}
        </View>
      }
      ListEmptyComponent={loading ? null : <EmptyState iconName="map" title="No courts match" subtitle="Try another name or filter." />}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => navigation.navigate('AdminBoundaryEditor', { venueId: item.id })}
          style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}. ${item.has_boundary ? 'Has an outline' : 'No outline'}. Edit`}
        >
          <View style={styles.flex}>
            <Text style={t.title} numberOfLines={1}>{item.name}</Text>
            <Text style={[t.sub, styles.sub]} numberOfLines={1}>
              {[item.city, `${item.checkins} check-in${item.checkins === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Text style={[t.sub, styles.badge, { color: item.has_boundary ? c.success : c.textSub }]}>
            {item.has_boundary ? `${Math.round(item.area_sqm ?? 0).toLocaleString()} m²` : 'No outline'}
          </Text>
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
  header: { gap: SPACE.md, marginBottom: SPACE.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE },
  flex: { flex: 1, minWidth: 0 },
  sub: { marginTop: SPACE.xxs },
  badge: { fontWeight: FONT.weight.semibold },
});

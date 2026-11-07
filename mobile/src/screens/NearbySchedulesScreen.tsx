// Weekly sessions near you (the Events page's one collapsed row): courts with a
// schedule within 40 km of my home location, nearest first. A court's page has
// the week. Sessions never reach the events feed
// (supabase/migration_court_schedules.sql).
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useNearbyCourtSchedules } from '../data/courtSchedules';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'NearbySchedules'>;

export default function NearbySchedulesScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const q = useNearbyCourtSchedules();
  const courts = q.data?.courts ?? [];
  const refresh = useRefresh(() => q.refresh());

  return (
    <View style={[S.fill, { backgroundColor: c.bg }]}>
      <FlatList
        data={courts}
        keyExtractor={(x) => x.venue_id}
        contentContainerStyle={S.list}
        refreshControl={<AppRefreshControl {...refresh} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            style={[S.row, { borderBottomColor: c.border }]}
            onPress={() => navigation.navigate('CourtDetail', { venueId: item.venue_id })}
          >
            <Text style={t.body}>{item.name}</Text>
            <Text style={t.meta}>
              {[item.city, `${item.session_count} weekly ${item.session_count === 1 ? 'session' : 'sessions'}`]
                .filter(Boolean)
                .join(', ')}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          q.error && courts.length === 0 ? (
            <ErrorState
              iconName="offline"
              error={q.error}
              message={`Couldn't load schedules. ${friendlySbMessage(q.error)}`}
              retryLabel="Retry"
              onRetry={() => void q.refresh()}
            />
          ) : q.loading ? (
            <SkeletonList rows={4} variant="row" />
          ) : (
            <EmptyState
              iconName="calendar-event"
              title="No weekly sessions near you yet"
              subtitle="Know one? Open the court's page and suggest it."
            />
          )
        }
      />
    </View>
  );
}

const S = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: SPACE.lg, paddingTop: SPACE.sm },
  row: { minHeight: 44, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
});

// Events (Home's center tile, Brian 2026-11-06: "its own distinct events
// page"): pickleball events other organizers run near my home court
// (supabase/migration_outside_events.sql), soonest first.
//
//   Pickleball events near your home court, run by clubs, rec centers...
//   My tournaments ›
//   (Open play)(Round robin)(Clinic)(Ladder)(Tournament)(Social)   any of them
//   Saturday open play  NEW                         (Interested)
//   Sat, 9 AM to 11 AM, Ocean View Park
//   [via City of Albany]  Open play, Social
//
// The tile used to open My tournaments: that's the link at the top now. The
// chips filter on the phone (one list read, shared with the court badges).
// What's on screen counts as seen (the NEW tags stay up for this visit).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { ErrorState, FilterChipRow, TextLink, type FilterChipOption } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import { track } from '../lib/analytics';
import { openDiscover } from '../lib/discoverNav';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import OutsideEventRow from '../components/events/OutsideEventRow';
import {
  EVENTS_EMPTY,
  EVENTS_EMPTY_FILTERED,
  EVENTS_INTRO,
  KIND_FILTERS,
  MY_TOURNAMENTS_LINK,
  type OutsideEventKind,
} from '../lib/outsideEvents';
import { outsideSeen, useOutsideEvents } from '../data/outsideEvents';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'PublicEvents'>;

export default function PublicEventsScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const q = useOutsideEvents();
  const all = useMemo(() => q.data ?? [], [q.data]);
  const [kinds, setKinds] = useState<OutsideEventKind[]>([]);
  const refresh = useRefresh(() => q.refresh());

  useFocusEffect(
    useCallback(() => {
      void q.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // NEW for this visit: what was unseen when it first showed. Then it's seen.
  const newIds = useRef(new Set<string>());
  const [, bump] = useState(0);
  useEffect(() => {
    const fresh = all.filter((e) => outsideSeen.isUnseen(e) && !newIds.current.has(e.id));
    if (fresh.length === 0) return;
    fresh.forEach((e) => newIds.current.add(e.id));
    bump((n) => n + 1);
    void outsideSeen.markSeen(fresh.map((e) => e.id));
  }, [all]);

  useEffect(() => {
    if (q.data) track('events.view', { count: q.data.length });
    // Once per load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data != null]);

  const counts = useMemo(() => {
    const m: Partial<Record<OutsideEventKind, number>> = {};
    for (const e of all) for (const k of e.kinds) m[k] = (m[k] ?? 0) + 1;
    return m;
  }, [all]);
  const options: FilterChipOption<OutsideEventKind>[] = KIND_FILTERS.map((f) => ({
    value: f.key,
    label: f.label,
    count: counts[f.key] ?? 0,
  }));
  // Chips earn their row only when they split the list.
  const showChips = KIND_FILTERS.filter((f) => (counts[f.key] ?? 0) > 0).length > 1;
  const visible = useMemo(
    () => (kinds.length === 0 ? all : all.filter((e) => e.kinds.some((k) => kinds.includes(k)))),
    [all, kinds],
  );

  const header = (
    <View style={S.header}>
      <Text style={t.sub}>{EVENTS_INTRO}</Text>
      <TextLink
        label={MY_TOURNAMENTS_LINK}
        iconName="bracket"
        onPress={() => openDiscover(navigation, { tab: 'tournaments', mine: true })}
      />
      {showChips ? (
        <FilterChipRow
          multi
          size="md"
          options={options}
          values={kinds}
          onChangeValues={(next) => {
            setKinds(next);
            track('events.filter', { kinds: next.length });
          }}
          hideZero
          wrapAtWidth={600}
        />
      ) : null}
    </View>
  );

  return (
    <View style={[S.fill, { backgroundColor: c.bg }]}>
      <FlatList
        data={visible}
        keyExtractor={(e) => e.id}
        contentContainerStyle={S.list}
        ListHeaderComponent={header}
        refreshControl={<AppRefreshControl {...refresh} />}
        renderItem={({ item: e, index }) => (
          <OutsideEventRow
            event={e}
            isNew={newIds.current.has(e.id)}
            lastRow={index === visible.length - 1}
            onPress={() => navigation.navigate('PublicEvent', { eventId: e.id })}
          />
        )}
        ListEmptyComponent={
          q.error && all.length === 0 ? (
            <ErrorState
              iconName="offline"
              error={q.error}
              message={`Couldn't load events. ${friendlySbMessage(q.error)}`}
              retryLabel="Retry"
              onRetry={() => void q.refresh()}
            />
          ) : q.loading && all.length === 0 ? (
            <SkeletonList rows={4} variant="row" />
          ) : all.length === 0 ? (
            <EmptyState iconName="calendar-event" title={EVENTS_EMPTY.title} subtitle={EVENTS_EMPTY.subtitle} />
          ) : (
            <EmptyState
              compact
              iconName="search"
              title={EVENTS_EMPTY_FILTERED.title}
              subtitle={EVENTS_EMPTY_FILTERED.subtitle}
              actionLabel="Clear chips"
              onAction={() => setKinds([])}
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
  header: { gap: SPACE.sm, marginBottom: SPACE.sm },
});

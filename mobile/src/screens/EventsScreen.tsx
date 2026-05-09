import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole } from '../lib/leagueRole';
import { LeagueEvent, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Events'>;
  route: RouteProp<RootStackParamList, 'Events'>;
};

type ConfirmedSlot = { id: string; starts_at: string; ends_at: string };

type Category = 'voting_open' | 'vote_closed' | 'scheduled' | 'past' | 'cancelled';

const CATEGORY_META: Record<Category, { label: string; emoji: string; color: string }> = {
  voting_open:  { label: 'Voting open',  emoji: '🗳',  color: '#2e7d32' },
  vote_closed:  { label: 'Vote closed',  emoji: '🔒', color: '#e65100' },
  scheduled:    { label: 'Scheduled',    emoji: '📅', color: '#1565c0' },
  past:         { label: 'Past',         emoji: '⏳', color: '#888'    },
  cancelled:    { label: 'Cancelled',    emoji: '✖',  color: '#999'    },
};

const ALL_CATEGORIES: Category[] = ['voting_open', 'vote_closed', 'scheduled', 'past', 'cancelled'];
const DEFAULT_ENABLED: Category[] = ['voting_open', 'vote_closed', 'scheduled', 'cancelled']; // past hidden by default

const DATE_OPTS = {
  weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
} as const;

// "Past" rule: an event becomes past at midnight ENDING the scheduled play day.
// In other words, if the slot's calendar date is strictly before today's calendar date.
function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function categorize(event: LeagueEvent, confirmedStartsAt: string | null): Category {
  if (event.status === 'cancelled') return 'cancelled';

  // Past detection — any event with a confirmed slot whose calendar day is
  // strictly before today's calendar day. Applies regardless of `status`,
  // so stale "voting" events that ended up with a confirmed slot don't get
  // stuck reading "vote closed" forever.
  if (confirmedStartsAt) {
    const slotDay  = startOfDay(new Date(confirmedStartsAt));
    const todayDay = startOfDay(new Date());
    if (slotDay < todayDay) return 'past';
  }

  if (event.status === 'scheduled') return 'scheduled';
  // status === 'voting'
  return new Date(event.vote_ends_at) > new Date() ? 'voting_open' : 'vote_closed';
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return `${h}h ${m}m left`;
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    filterBar: { backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 10 },
    filterScroll: { paddingHorizontal: 12, gap: 8, alignItems: 'center' },
    filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg, marginRight: 8 },
    filterChipActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    filterChipText: { fontSize: 13, color: c.textMuted, fontWeight: '600' },
    filterChipTextActive: { color: c.primary },
    countBar: { paddingHorizontal: 16, paddingVertical: 6, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    countText: { fontSize: 12, color: c.textMuted },
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
    eventTitle: { fontSize: 17, fontWeight: '700', color: c.text, flex: 1, marginRight: 8 },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
    badgeText: { fontSize: 12, fontWeight: '700' },
    desc: { fontSize: 13, color: c.textSub, marginBottom: 6 },
    meta: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    empty: { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15, lineHeight: 22 },
    fab: { position: 'absolute', bottom: 24, right: 24, backgroundColor: c.primary, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
    fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  });
}

export default function EventsScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  const [events, setEvents] = useState<LeagueEvent[]>([]);
  const [confirmedSlots, setConfirmedSlots] = useState<Record<string, ConfirmedSlot>>({});
  const [myRole, setMyRole] = useState<LeagueRole>(null);
  const [enabled, setEnabled] = useState<Set<Category>>(new Set(DEFAULT_ENABLED));
  const { colors } = useTheme();
  const S = makeStyles(colors);

  useFocusEffect(useCallback(() => {
    loadEvents();
    getLeagueRole(leagueId).then(setMyRole);
  }, []));

  async function loadEvents() {
    const { data } = await supabase
      .from('league_events')
      .select('*')
      .eq('league_id', leagueId)
      .order('created_at', { ascending: false });
    const evs = (data ?? []) as LeagueEvent[];
    setEvents(evs);

    const slotIds = evs.map(e => e.confirmed_slot_id).filter(Boolean) as string[];
    if (slotIds.length === 0) { setConfirmedSlots({}); return; }
    const { data: slots } = await supabase
      .from('event_slots')
      .select('id, starts_at, ends_at')
      .in('id', slotIds);
    const lookup: Record<string, ConfirmedSlot> = {};
    (slots ?? []).forEach((s: any) => { lookup[s.id] = s; });
    setConfirmedSlots(lookup);
  }

  // Annotate every event with its category once, so filter & render share the result.
  const categorized = useMemo(() => {
    return events.map(e => {
      const slot = e.confirmed_slot_id ? confirmedSlots[e.confirmed_slot_id] : null;
      return { event: e, slot, category: categorize(e, slot?.starts_at ?? null) };
    });
  }, [events, confirmedSlots]);

  const counts = useMemo(() => {
    const c: Record<Category, number> = {
      voting_open: 0, vote_closed: 0, scheduled: 0, past: 0, cancelled: 0,
    };
    for (const row of categorized) c[row.category]++;
    return c;
  }, [categorized]);

  const visible = useMemo(
    () => categorized.filter(row => enabled.has(row.category)),
    [categorized, enabled],
  );

  function toggleCategory(cat: Category) {
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  return (
    <View style={S.container}>
      {/* Filter chips */}
      <View style={S.filterBar}>
        <ScrollView horizontal contentContainerStyle={S.filterScroll} showsHorizontalScrollIndicator={false}>
          {ALL_CATEGORIES.map(cat => {
            const meta = CATEGORY_META[cat];
            const active = enabled.has(cat);
            return (
              <TouchableOpacity
                key={cat}
                style={[S.filterChip, active && S.filterChipActive]}
                onPress={() => toggleCategory(cat)}
                activeOpacity={0.8}
              >
                <Text style={[S.filterChipText, active && S.filterChipTextActive]}>
                  {meta.emoji} {meta.label} ({counts[cat]})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <View style={S.countBar}>
        <Text style={S.countText}>
          Showing {visible.length} of {categorized.length} event{categorized.length !== 1 ? 's' : ''}
          {!enabled.has('past') && counts.past > 0 ? ` · ${counts.past} past hidden` : ''}
        </Text>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(row) => row.event.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item: row }) => {
          const meta = CATEGORY_META[row.category];
          return (
            <TouchableOpacity
              style={S.card}
              onPress={() => navigation.navigate('EventDetail', { eventId: row.event.id, title: row.event.title })}
            >
              <View style={S.cardTop}>
                <Text style={S.eventTitle}>{row.event.title}</Text>
                <View style={[S.badge, { backgroundColor: meta.color + '22' }]}>
                  <Text style={[S.badgeText, { color: meta.color }]}>{meta.label}</Text>
                </View>
              </View>
              {row.event.description ? <Text style={S.desc}>{row.event.description}</Text> : null}
              {(row.category === 'scheduled' || row.category === 'past') && row.slot && (
                <Text style={S.meta}>
                  📅  {new Date(row.slot.starts_at).toLocaleString(undefined, DATE_OPTS)}
                </Text>
              )}
              {row.event.status === 'voting' && (
                <Text style={S.meta}>
                  🗳  Vote deadline: {new Date(row.event.vote_ends_at).toLocaleString(undefined, DATE_OPTS)} · {timeUntil(row.event.vote_ends_at)}
                </Text>
              )}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={S.empty}>
            {categorized.length === 0
              ? 'No events yet.\nCreate one to start scheduling league play.'
              : 'No events match your filters.'}
          </Text>
        }
      />

      {isPrivileged(myRole) && (
        <TouchableOpacity style={S.fab} onPress={() => navigation.navigate('CreateEvent', { leagueId })}>
          <Text style={S.fabText}>+ New Event</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

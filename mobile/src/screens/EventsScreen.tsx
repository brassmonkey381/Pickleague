// A league's events (plan section 5, "Events list"):
//   (All)(Needs your vote 1)(Upcoming 3)(Past 8)   single-select, 0-count chips hidden
//   [📅] Thu play day   (Vote needed)       1d left
//        3 times proposed · Lake Merritt
//   ...sorted by event date: live, then upcoming soonest first, then ended newest first
// Each row shows the viewer's own vote / RSVP state. The header "+" (new event)
// is for admins and co-admins only (same gate as the old floating button).
import React, { useState, useCallback, useMemo, useLayoutEffect } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, friendlySbMessage, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { ErrorState, FilterChipRow, type FilterChipOption } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { getLeagueRole, isPrivileged, LeagueRole } from '../lib/leagueRole';
import { LeagueEvent, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import HeaderPlusButton from '../components/play/HeaderPlusButton';
import EntityRow, { type EntityRowChip } from '../components/EntityRow';
import { joinFacts } from '../lib/entityGlyph';
import { displayCourtName } from '../lib/courtNickname';
import {
  categorizeEvent, eventStatusLabel, eventStatusTone, timeLeftLabel, myEventState, myEventChip,
  matchesEventFilter, countEventFilters, sortEventsByDate,
  type EventCategory, type EventListFilter, type MyEventState,
} from '../components/event/eventModel';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Events'>;
  route: RouteProp<RootStackParamList, 'Events'>;
};

/** A proposed time, with whether the viewer marked it. */
type SlotLite = { id: string; starts_at: string; ends_at: string; mine: boolean };

type EventsData = {
  events: LeagueEvent[];
  /** event id -> its proposed times. */
  slots: Record<string, SlotLite[]>;
  /** Event ids the viewer said "Can't make it" to. */
  declined: string[];
};

type Row = {
  event: LeagueEvent;
  category: EventCategory;
  myState: MyEventState;
  dateIso: string | null;
  slotCount: number;
  confirmed: SlotLite | null;
};

const FILTER_LABELS: Record<EventListFilter, string> = {
  all: 'All',
  needs_vote: 'Needs your vote',
  upcoming: 'Upcoming',
  past: 'Past',
};
const FILTERS: EventListFilter[] = ['all', 'needs_vote', 'upcoming', 'past'];

// PostgREST takes `in` lists in the URL; chunk so a long-running league never
// builds a URL a proxy truncates.
const IN_CHUNK = 100;
async function inChunks<T>(ids: string[], run: (chunk: string[]) => Promise<T[] | null>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    out.push(...((await run(ids.slice(i, i + IN_CHUNK))) ?? []));
  }
  return out;
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export default function EventsScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  // 'unknown' until the first role read lands: no header "+" yet, and the
  // viewer's own vote state still shows (a member is the common case).
  const [myRole, setMyRole] = useState<LeagueRole>('unknown');
  const [filter, setFilter] = useState<EventListFilter>('all');
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const loadEvents = useCallback(async (): Promise<EventsData> => {
    const [evRows, uid] = await Promise.all([
      sbCall(() => supabase
        .from('league_events')
        .select('*')
        .eq('league_id', leagueId)
        .order('created_at', { ascending: false })),
      currentUserId(supabase),
    ]);
    const evs = (evRows ?? []) as LeagueEvent[];
    const ids = evs.map(e => e.id);
    if (ids.length === 0) return { events: evs, slots: {}, declined: [] };

    // Every proposed time (the confirmed one among them), with the viewer's own
    // vote embedded: the embedded filter narrows event_slot_votes to this user
    // without dropping slots nobody voted for. Votes and slots are readable by
    // everyone (RLS), same reads EventDetail makes.
    const [slotRows, declineRows] = await Promise.all([
      inChunks<any>(ids, chunk => sbCall(() => {
        let q = supabase
          .from('event_slots')
          .select('id, event_id, starts_at, ends_at, event_slot_votes(user_id)')
          .in('event_id', chunk);
        if (uid) q = q.eq('event_slot_votes.user_id', uid);
        return q;
      })),
      uid
        ? inChunks<any>(ids, chunk => sbCall(() => supabase
            .from('event_declines')
            .select('event_id')
            .eq('user_id', uid)
            .in('event_id', chunk)))
        : Promise.resolve([]),
    ]);

    const slots: Record<string, SlotLite[]> = {};
    for (const s of slotRows) {
      (slots[s.event_id] ??= []).push({
        id: s.id,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        mine: !!uid && Array.isArray(s.event_slot_votes) && s.event_slot_votes.some((v: any) => v.user_id === uid),
      });
    }
    return { events: evs, slots, declined: declineRows.map((d: any) => d.event_id) };
  }, [leagueId]);

  // v2: the cached shape changed (all slots + the viewer's answers), so a 24h
  // persisted v1 entry is never read into it.
  const query = useCachedQuery(`league:${leagueId}:events:v2`, loadEvents, {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  // Nothing cached AND the fetch failed — the one case where we genuinely have
  // nothing to show. Anything cached keeps rendering instead of blanking.
  const loadFailed = query.error != null && query.data === undefined;

  // A failed role read must not strip the admin's header "+", so an
  // unknown/errored outcome leaves the last known role in place. A cold web
  // URL (/leagues/:id/events) carries no league name: fetch it for the title.
  const hasRouteName = typeof route.params.leagueName === 'string' && route.params.leagueName !== 'undefined';
  const loadMyRole = useCallback(async () => {
    const [role, league] = await Promise.all([
      getLeagueRole(leagueId).catch(() => 'unknown' as const),
      hasRouteName
        ? Promise.resolve(null)
        : sbCall(() => supabase.from('leagues').select('name').eq('id', leagueId).maybeSingle()).catch(() => null),
    ]);
    if (role !== 'unknown') setMyRole(role);
    if ((league as any)?.name) navigation.setOptions({ title: `${(league as any).name} Events` });
  }, [leagueId, hasRouteName, navigation]);

  const reload = useCallback(
    () => Promise.all([query.refresh(), loadMyRole()]),
    [query.refresh, loadMyRole],
  );
  const refresh = useRefresh(reload);

  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  const privileged = isPrivileged(myRole);
  const openCreate = useCallback(() => navigation.navigate('CreateEvent', { leagueId }), [navigation, leagueId]);

  // The header "+" (was a floating button), admins/co-admins only.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: privileged ? () => <HeaderPlusButton onPress={openCreate} accessibilityLabel="New event" /> : undefined,
    });
  }, [navigation, privileged, openCreate]);

  const rows: Row[] = useMemo(() => {
    const data = query.data;
    if (!data) return [];
    const declined = new Set(data.declined);
    const now = Date.now();
    // A definite non-member has nothing to vote on; anyone else sees their state.
    const answers = myRole !== null;
    const built = data.events.map((e): Row => {
      const slots = data.slots[e.id] ?? [];
      const confirmed = e.confirmed_slot_id ? slots.find(s => s.id === e.confirmed_slot_id) ?? null : null;
      const category = categorizeEvent(e, confirmed?.starts_at ?? null, now);
      const earliest = slots.reduce<string | null>((min, s) => (min == null || s.starts_at < min ? s.starts_at : min), null);
      const rsvpOpen = !!confirmed && now < new Date(confirmed.ends_at).getTime();
      const myState = answers
        ? myEventState(category, {
            votes: slots.filter(s => s.mine).length,
            inConfirmed: !!confirmed?.mine,
            declined: declined.has(e.id),
          }, rsvpOpen)
        : null;
      return {
        event: e,
        category,
        myState,
        dateIso: confirmed?.starts_at ?? earliest ?? e.vote_ends_at ?? null,
        slotCount: slots.length,
        confirmed,
      };
    });
    return sortEventsByDate(built);
  }, [query.data, myRole]);

  const counts = useMemo(() => countEventFilters(rows), [rows]);
  // A chip whose count fell to 0 (you just voted) falls back to All, so the
  // list never sits empty behind a chip that is no longer shown.
  const activeFilter: EventListFilter = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const visible = useMemo(() => rows.filter(r => matchesEventFilter(r, activeFilter)), [rows, activeFilter]);

  const chipOptions: FilterChipOption<EventListFilter>[] = FILTERS.map(f => ({
    value: f,
    label: FILTER_LABELS[f],
    count: f === 'all' ? undefined : counts[f],
  }));
  // Chips earn their row only when they split the list.
  const showChips = FILTERS.filter(f => f !== 'all' && counts[f] > 0 && counts[f] < counts.all).length > 0;

  function rowSubtitle(r: Row): string {
    const where = r.event.location_name ? displayCourtName(r.event.location_name) : null;
    switch (r.category) {
      case 'voting_open':
        return joinFacts([r.slotCount > 0 ? `${r.slotCount} time${r.slotCount === 1 ? '' : 's'} proposed` : 'Vote on a time', where]);
      // vote_closed and live carry a status chip ('Picking a time' / 'Live
      // now'), so the subtitle doesn't repeat it; the short lead keeps the
      // line from going blank when there's no court.
      case 'vote_closed':
        return joinFacts(['Voting ended', where]);
      case 'live':
        return joinFacts(['Tap to record matches', where]);
      default:
        return joinFacts([r.confirmed ? fmtWhen(r.confirmed.starts_at) : null, where]);
    }
  }

  function rowChips(r: Row): EntityRowChip[] {
    const chips: EntityRowChip[] = [];
    // The status chip only where the subtitle doesn't already say it.
    if (r.category === 'live' || r.category === 'cancelled' || r.category === 'vote_closed' || r.category === 'past') {
      chips.push({ label: eventStatusLabel(r.category), tone: eventStatusTone(r.category) });
    }
    const mine = myEventChip(r.myState);
    if (mine) chips.push(mine);
    return chips;
  }

  return (
    <View style={S.container}>
      {showChips && (
        <View style={S.chipBar}>
          <FilterChipRow
            size="md"
            options={chipOptions}
            value={activeFilter}
            onChange={setFilter}
            hideZero
            pinnedKeys={['all']}
            wrapAtWidth={600}
          />
        </View>
      )}

      <FlatList
        data={visible}
        keyExtractor={(r) => r.event.id}
        contentContainerStyle={S.list}
        refreshControl={<AppRefreshControl {...refresh} />}
        renderItem={({ item: r }) => (
          <EntityRow
            kind="event"
            title={r.event.title}
            subtitle={rowSubtitle(r)}
            chips={rowChips(r)}
            trailingText={r.category === 'voting_open' ? timeLeftLabel(r.event.vote_ends_at) : null}
            highlighted={r.category === 'live'}
            onPress={() => navigation.navigate('EventDetail', {
              eventId: r.event.id,
              title: r.event.title,
              // Land on the control the row is asking about.
              ...(r.myState === 'needs_vote' ? { focus: 'vote' as const } : r.myState === 'rsvp_needed' ? { focus: 'rsvp' as const } : {}),
            })}
          />
        )}
        ListEmptyComponent={
          loadFailed
            ? <ErrorState
                iconName="offline"
                error={query.error}
                message={`Couldn't load events. ${friendlySbMessage(query.error)}`}
                retryLabel="Retry"
                onRetry={() => { void reload(); }}
              />
            : query.loading && rows.length === 0
            ? <SkeletonList rows={4} variant="row" />
            : rows.length === 0
            ? privileged
              ? <EmptyState iconName="calendar-event" title="No events yet" subtitle="Schedule a play day and let the league vote on a time." actionLabel="New event" onAction={openCreate} />
              : <EmptyState iconName="calendar-event" title="No events yet." subtitle="Your league admin schedules play days." />
            : <EmptyState compact iconName="search" title="Nothing here" actionLabel="Clear filters" onAction={() => setFilter('all')} />
        }
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    // Fixed chrome outside the FlatList (no sticky headers under RNW).
    chipBar: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.xs, backgroundColor: c.bg },
    list: { padding: SPACE.lg, paddingTop: SPACE.sm },
  });
}

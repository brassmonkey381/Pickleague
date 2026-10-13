import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/useToast';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { listBookmarks, removeBookmark, Bookmark, BookmarkTargetType } from '../lib/bookmarks';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import EntityRow, { type EntityRowChip } from '../components/EntityRow';
import { joinFacts, tournamentStatusChip, type EntityKind } from '../lib/entityGlyph';
import { displayCourtName } from '../lib/courtNickname';
import { dateLabel, dateSubLabel, durationLabel, slotLabel } from '../lib/drillTime';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Bookmarks'> };

type EnrichedBookmark = Bookmark & {
  title: string;
  subtitle?: string | null;
  /** At most one status chip next to the title (content rule 2 allows two). */
  chip?: EntityRowChip | null;
  missing?: boolean;
};

// Each group's glyph comes from the one entity map (lib/entityGlyph), so a
// saved league shows the same ball here as on Home and Play.
const TYPE_META: Record<BookmarkTargetType, { kind: EntityKind; label: string }> = {
  tournament:    { kind: 'tournament', label: 'Tournaments' },
  league:        { kind: 'league',     label: 'Leagues' },
  event:         { kind: 'event',      label: 'Events' },
  drill_session: { kind: 'drill',      label: 'Drill sessions' },
  profile:       { kind: 'player',     label: 'People' },
};

const TYPE_ORDER: BookmarkTargetType[] = ['tournament', 'league', 'event', 'drill_session', 'profile'];

export default function BookmarksScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [items, setItems]     = useState<EnrichedBookmark[]>([]);
  // A failed load must not render as "No bookmarks yet" — that reads as data
  // loss to someone who saved a dozen things.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded]       = useState(false);

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    setLoading(true);
    try {
      const rows = await listBookmarks();
      const enriched = await enrich(rows);
      setItems(enriched);
      setLoaded(true);
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load your bookmarks."));
    } finally {
      // Always: an early return on the error path left the skeleton spinning.
      setLoading(false);
    }
  }

  async function handleRemove(b: EnrichedBookmark) {
    setItems(prev => prev.filter(x => !(x.target_type === b.target_type && x.target_id === b.target_id)));
    const ok = await removeBookmark(b.target_type, b.target_id);
    // The row is still there — put it back rather than let the list lie until
    // the next load quietly resurrects it.
    if (!ok) {
      setItems(prev => (prev.some(x => x.target_type === b.target_type && x.target_id === b.target_id)
        ? prev
        : [...prev, b]));
      toast.error("Couldn't remove that bookmark — check your connection.");
    }
  }

  function handleTap(b: EnrichedBookmark) {
    if (b.missing) return;
    switch (b.target_type) {
      case 'tournament':
        navigation.navigate('TournamentDetail', { tournamentId: b.target_id, tournamentName: b.title });
        break;
      case 'league':
        navigation.navigate('LeagueDetail', { leagueId: b.target_id, leagueName: b.title });
        break;
      case 'event':
        navigation.navigate('EventDetail', { eventId: b.target_id, title: b.title });
        break;
      case 'drill_session':
        navigation.navigate('DrillRequests');
        break;
      case 'profile':
        navigation.navigate('PlayerProfile', { userId: b.target_id, userName: b.title });
        break;
    }
  }

  const grouped = useMemo(() => {
    const map: Record<BookmarkTargetType, EnrichedBookmark[]> = {
      tournament: [], league: [], event: [], drill_session: [], profile: [],
    };
    for (const b of items) map[b.target_type].push(b);
    return map;
  }, [items]);

  // Only the very first load shows the skeleton. A refocus reload (this screen
  // reloads on every focus) keeps the list on screen instead of blanking it,
  // which also keeps a just-tapped remove from flashing the whole page. A retry
  // after a failed first load shows it too, so "Try again" visibly responds.
  if (loading && !loaded) {
    return (
      <View style={S.screen}>
        <SkeletonList rows={6} variant="row" />
      </View>
    );
  }

  if (loadError && !loaded) {
    return (
      <View style={S.screen}>
        <EmptyState
          icon="📡"
          title="Couldn't load your bookmarks"
          subtitle={loadError}
          actionLabel="Try again"
          onAction={load}
        />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={S.screen}>
        <EmptyState
          icon="🔖"
          title="No bookmarks yet"
          subtitle="Tap the 🔖 icon on any tournament, league, event, drill session or player profile to save it here."
        />
      </View>
    );
  }

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content} refreshControl={<AppRefreshControl {...refresh} />}>
      {TYPE_ORDER.map(t => {
        const list = grouped[t];
        // Empty groups don't render (content rule 4).
        if (list.length === 0) return null;
        const meta = TYPE_META[t];
        return (
          <View key={t} style={S.group}>
            <SectionHeader title={meta.label} count={list.length} />
            {list.map(b => (
              <EntityRow
                key={`${b.target_type}-${b.target_id}`}
                kind={meta.kind}
                title={b.title}
                subtitle={b.subtitle}
                chips={b.chip ? [b.chip] : undefined}
                onPress={b.missing ? undefined : () => handleTap(b)}
                // A deleted target reads as gone, not as a live row whose tap
                // does nothing. Opacity doesn't block touches, so remove works.
                style={b.missing ? S.missingRow : undefined}
                // The trailing slot holds the remove button and, for a row that
                // still opens something, the chevron. The button is its own
                // 44x44 pressable nested in the row's pressable; react-native-web
                // stops the click there, so removing never also opens the row.
                action={
                  <View style={S.trailing}>
                    <Pressable
                      onPress={() => handleRemove(b)}
                      style={({ pressed }) => [S.removeBox, pressed && S.pressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${b.title} from bookmarks`}
                    >
                      <Text style={S.removeGlyph} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>🔖</Text>
                    </Pressable>
                    {b.missing ? null : <Text style={S.chevron}>›</Text>}
                  </View>
                }
              />
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    screen:      { flex: 1, backgroundColor: c.bg },
    content:     { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl },
    group:       { marginBottom: SPACE.xs },
    missingRow:  { opacity: 0.55 },
    trailing:    { flexDirection: 'row', alignItems: 'center' },
    removeBox:   { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    pressed:     { opacity: 0.6 },
    removeGlyph: { fontSize: FONT.size.xl },
    chevron:     { fontSize: FONT.size.h2, fontWeight: '700', color: c.textMuted },
  });
}

/** "Oct 3, 6:30 PM" for a timestamp; null when there is no date (a row never says TBD). */
function shortWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Event status as a row chip; null for anything unrecognised (never a raw enum). */
function eventStatusChip(status: string | null | undefined): EntityRowChip | null {
  switch (status) {
    case 'voting':    return { label: 'Voting', tone: 'info' };
    case 'scheduled': return { label: 'Scheduled', tone: 'success' };
    case 'cancelled': return { label: 'Cancelled', tone: 'danger' };
    default:          return null;
  }
}

async function enrich(rows: Bookmark[]): Promise<EnrichedBookmark[]> {
  const byType: Record<BookmarkTargetType, string[]> = {
    tournament: [], league: [], event: [], drill_session: [], profile: [],
  };
  for (const r of rows) byType[r.target_type].push(r.target_id);

  // sbCall (throws) rather than a discarded `error`: a failed lookup used to
  // come back as an empty list, and every bookmark in that section then
  // rendered as deleted — the worst possible lie about a failed fetch.
  // The throw propagates to load(), which shows a retry.
  const [tRes, lRes, eRes, dRes, pRes] = await Promise.all([
    byType.tournament.length
      ? sbCall(() => supabase.from('tournaments').select('id, name, start_time, status').in('id', byType.tournament))
      : Promise.resolve([] as any[]),
    byType.league.length
      ? sbCall(() => supabase.from('leagues').select('id, name, home_court').in('id', byType.league))
      : Promise.resolve([] as any[]),
    byType.event.length
      ? sbCall(() => supabase.from('league_events').select('id, title, status, vote_ends_at').in('id', byType.event))
      : Promise.resolve([] as any[]),
    byType.drill_session.length
      ? sbCall(() => supabase.from('drill_sessions').select('id, session_date, session_slot, length_minutes').in('id', byType.drill_session))
      : Promise.resolve([] as any[]),
    byType.profile.length
      ? sbCall(() => supabase.from('profiles').select('id, full_name, tagline').in('id', byType.profile))
      : Promise.resolve([] as any[]),
  ]);

  const tMap = new Map<string, any>(((tRes ?? []) as any[]).map(r => [r.id, r]));
  const lMap = new Map<string, any>(((lRes ?? []) as any[]).map(r => [r.id, r]));
  const eMap = new Map<string, any>(((eRes ?? []) as any[]).map(r => [r.id, r]));
  const dMap = new Map<string, any>(((dRes ?? []) as any[]).map(r => [r.id, r]));
  const pMap = new Map<string, any>(((pRes ?? []) as any[]).map(r => [r.id, r]));

  // A target that is gone stays listed (so it can be removed) but greyed: no
  // chevron, no navigation.
  const gone = (b: Bookmark, what: string): EnrichedBookmark =>
    ({ ...b, title: `Deleted ${what}`, subtitle: 'No longer available', missing: true });

  return rows.map(b => {
    switch (b.target_type) {
      case 'tournament': {
        const t = tMap.get(b.target_id);
        if (!t) return gone(b, 'tournament');
        return { ...b, title: t.name, subtitle: shortWhen(t.start_time), chip: tournamentStatusChip(t.status) };
      }
      case 'league': {
        const l = lMap.get(b.target_id);
        if (!l) return gone(b, 'league');
        return { ...b, title: l.name, subtitle: displayCourtName(l.home_court) || null };
      }
      case 'event': {
        const e = eMap.get(b.target_id);
        if (!e) return gone(b, 'event');
        const ends = e.status === 'voting' ? shortWhen(e.vote_ends_at) : null;
        return { ...b, title: e.title, subtitle: ends ? `Vote ends ${ends}` : null, chip: eventStatusChip(e.status) };
      }
      case 'drill_session': {
        const d = dMap.get(b.target_id);
        if (!d) return gone(b, 'drill session');
        const day = d.session_date ? `${dateLabel(d.session_date)} ${dateSubLabel(d.session_date)}` : null;
        return {
          ...b,
          title: day ? `Drill ${day}` : 'Drill session',
          subtitle: joinFacts([
            d.session_slot != null ? slotLabel(d.session_slot) : null,
            d.length_minutes ? durationLabel(d.length_minutes) : null,
          ]) || null,
        };
      }
      case 'profile': {
        const p = pMap.get(b.target_id);
        if (!p) return gone(b, 'profile');
        return { ...b, title: p.full_name ?? 'Player', subtitle: p.tagline ?? null };
      }
    }
  });
}

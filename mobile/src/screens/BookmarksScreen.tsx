import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { RootStackParamList } from '../types';
import { listBookmarks, removeBookmark, Bookmark, BookmarkTargetType } from '../lib/bookmarks';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Bookmarks'> };

type EnrichedBookmark = Bookmark & {
  title: string;
  subtitle?: string | null;
  missing?: boolean;
};

const TYPE_META: Record<BookmarkTargetType, { icon: string; label: string }> = {
  tournament:    { icon: '🏆', label: 'Tournaments' },
  league:        { icon: '🎾', label: 'Leagues' },
  event:         { icon: '📅', label: 'Events' },
  drill_session: { icon: '🏓', label: 'Drill sessions' },
  profile:       { icon: '😎', label: 'People' },
};

const TYPE_ORDER: BookmarkTargetType[] = ['tournament', 'league', 'event', 'drill_session', 'profile'];

export default function BookmarksScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = gs(c);

  const [loading, setLoading] = useState(true);
  const [items, setItems]     = useState<EnrichedBookmark[]>([]);

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    setLoading(true);
    const rows = await listBookmarks();
    const enriched = await enrich(rows);
    setItems(enriched);
    setLoading(false);
  }

  async function handleRemove(b: EnrichedBookmark) {
    setItems(prev => prev.filter(x => !(x.target_type === b.target_type && x.target_id === b.target_id)));
    await removeBookmark(b.target_type, b.target_id);
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

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <SkeletonList rows={6} />
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
    <ScrollView style={S.screen} contentContainerStyle={S.scrollPad} refreshControl={<AppRefreshControl {...refresh} />}>
      {TYPE_ORDER.map(t => {
        const list = grouped[t];
        if (list.length === 0) return null;
        const meta = TYPE_META[t];
        return (
          <View key={t}>
            <Text style={S.sectionHeader}>{meta.icon}  {meta.label}</Text>
            {list.map(b => (
              <View key={`${b.target_type}-${b.target_id}`} style={S.card}>
                <TouchableOpacity
                  onPress={() => handleTap(b)}
                  activeOpacity={b.missing ? 1 : 0.7}
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[S.h3, b.missing && { color: c.textMuted, fontStyle: 'italic' }]} numberOfLines={1}>
                      {b.title}
                    </Text>
                    {b.subtitle ? <Text style={[S.sub, { marginTop: 2 }]}>{b.subtitle}</Text> : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => handleRemove(b)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={{ paddingHorizontal: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${b.title} from bookmarks`}
                  >
                    <Text style={{ fontSize: 20 }}>🔖</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

async function enrich(rows: Bookmark[]): Promise<EnrichedBookmark[]> {
  const byType: Record<BookmarkTargetType, string[]> = {
    tournament: [], league: [], event: [], drill_session: [], profile: [],
  };
  for (const r of rows) byType[r.target_type].push(r.target_id);

  const [tRes, lRes, eRes, dRes, pRes] = await Promise.all([
    byType.tournament.length
      ? supabase.from('tournaments').select('id, name, start_time, status').in('id', byType.tournament)
      : Promise.resolve({ data: [] as any[] }),
    byType.league.length
      ? supabase.from('leagues').select('id, name, home_court').in('id', byType.league)
      : Promise.resolve({ data: [] as any[] }),
    byType.event.length
      ? supabase.from('league_events').select('id, title, status, vote_ends_at').in('id', byType.event)
      : Promise.resolve({ data: [] as any[] }),
    byType.drill_session.length
      ? supabase.from('drill_sessions').select('id, session_date, session_slot, length_minutes').in('id', byType.drill_session)
      : Promise.resolve({ data: [] as any[] }),
    byType.profile.length
      ? supabase.from('profiles').select('id, full_name, tagline').in('id', byType.profile)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const tMap = new Map<string, any>(((tRes.data ?? []) as any[]).map(r => [r.id, r]));
  const lMap = new Map<string, any>(((lRes.data ?? []) as any[]).map(r => [r.id, r]));
  const eMap = new Map<string, any>(((eRes.data ?? []) as any[]).map(r => [r.id, r]));
  const dMap = new Map<string, any>(((dRes.data ?? []) as any[]).map(r => [r.id, r]));
  const pMap = new Map<string, any>(((pRes.data ?? []) as any[]).map(r => [r.id, r]));

  return rows.map(b => {
    switch (b.target_type) {
      case 'tournament': {
        const t = tMap.get(b.target_id);
        if (!t) return { ...b, title: '(deleted tournament)', missing: true };
        const when = t.start_time
          ? new Date(t.start_time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : 'Date TBD';
        return { ...b, title: t.name, subtitle: `${when} · ${t.status}` };
      }
      case 'league': {
        const l = lMap.get(b.target_id);
        if (!l) return { ...b, title: '(deleted league)', missing: true };
        return { ...b, title: l.name, subtitle: l.home_court ?? null };
      }
      case 'event': {
        const e = eMap.get(b.target_id);
        if (!e) return { ...b, title: '(deleted event)', missing: true };
        const sub = e.status === 'voting'
          ? `Voting ends ${new Date(e.vote_ends_at).toLocaleDateString()}`
          : e.status;
        return { ...b, title: e.title, subtitle: sub };
      }
      case 'drill_session': {
        const d = dMap.get(b.target_id);
        if (!d) return { ...b, title: '(deleted drill session)', missing: true };
        return { ...b, title: `Drill on ${d.session_date}`, subtitle: `Slot ${d.session_slot} · ${d.length_minutes}m` };
      }
      case 'profile': {
        const p = pMap.get(b.target_id);
        if (!p) return { ...b, title: '(deleted profile)', missing: true };
        return { ...b, title: p.full_name, subtitle: p.tagline ?? null };
      }
    }
  });
}

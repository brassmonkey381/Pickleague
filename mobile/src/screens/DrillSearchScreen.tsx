import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import {
  DateSlot, overlapSlots, rollingDates, expandWeeklyToDates, toWeeklyTemplate,
} from '../lib/drillTime';
import { findShotPref, findPartnerPref } from '../data/drillOptions';
import { AVATARS } from '../data/profileCustomization';
import DrillRequestModal from '../components/DrillRequestModal';
import { formatPlupr } from '../lib/plupr';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DrillSearch'> };

type Candidate = {
  id: string;
  full_name: string;
  username: string;
  rating: number;
  total_matches_played: number;
  avatar_id: number;
  avatar_url: string | null;
  drill_availability: boolean[];
  drill_shot_prefs: string[];
  drill_partner_prefs: string[];
  drill_custom_tags: string[];
  overlap: DateSlot[];
  sharedShots: number;
  sharedPartner: number;
};

type SortMode = 'overlap' | 'shots' | 'elo';

export default function DrillSearchScreen({}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [me, setMe] = useState<{
    id: string; rating: number;
    avail: boolean[]; shots: string[]; partner: string[];
  } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [sort, setSort]       = useState<SortMode>('overlap');
  const [requestTarget, setRequestTarget] = useState<Candidate | null>(null);

  const refresh = useRefresh(load);

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const myProfileRes = await supabase
      .from('profiles')
      .select('rating, drill_availability, drill_shot_prefs, drill_partner_prefs')
      .eq('id', user.id)
      .single();

    const myWeekly  = toWeeklyTemplate(myProfileRes.data?.drill_availability ?? []);
    const myShots   = (myProfileRes.data?.drill_shot_prefs ?? []) as string[];
    const myPartner = (myProfileRes.data?.drill_partner_prefs ?? []) as string[];
    const myRating  = myProfileRes.data?.rating ?? 3.25;
    setMe({ id: user.id, rating: myRating, avail: myWeekly, shots: myShots, partner: myPartner });

    const { data: others } = await supabase
      .from('profiles')
      .select('id, full_name, username, rating, total_matches_played, avatar_id, avatar_url, drill_availability, drill_shot_prefs, drill_partner_prefs, drill_custom_tags')
      .eq('drilling_enabled', true)
      .neq('id', user.id)
      .limit(100);

    const dates   = rollingDates();
    const myDated = expandWeeklyToDates(myWeekly, dates);
    const list: Candidate[] = (others ?? []).map((p: any) => {
      const theirWeekly = toWeeklyTemplate(p.drill_availability ?? []);
      const overlap     = overlapSlots(myDated, expandWeeklyToDates(theirWeekly, dates), dates);
      const sharedShots   = (p.drill_shot_prefs ?? []).filter((s: string) => myShots.includes(s)).length;
      const sharedPartner = (p.drill_partner_prefs ?? []).filter((s: string) => myPartner.includes(s)).length;
      return {
        id: p.id,
        full_name: p.full_name ?? 'Unknown',
        username: p.username ?? '',
        rating: p.rating ?? 3.25,
        total_matches_played: p.total_matches_played ?? 0,
        avatar_id: p.avatar_id ?? 1,
        avatar_url: p.avatar_url,
        drill_availability: theirWeekly,
        drill_shot_prefs: p.drill_shot_prefs ?? [],
        drill_partner_prefs: p.drill_partner_prefs ?? [],
        drill_custom_tags: p.drill_custom_tags ?? [],
        overlap,
        sharedShots,
        sharedPartner,
      };
    });

    setCandidates(list);
    setLoading(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = candidates;
    if (q) {
      list = list.filter(c =>
        c.full_name.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sort === 'overlap') {
      sorted.sort((a, b) => b.overlap.length - a.overlap.length || b.sharedShots - a.sharedShots);
    } else if (sort === 'shots') {
      sorted.sort((a, b) => b.sharedShots - a.sharedShots || b.overlap.length - a.overlap.length);
    } else {
      sorted.sort((a, b) => Math.abs(a.rating - (me?.rating ?? 3.25)) - Math.abs(b.rating - (me?.rating ?? 3.25)));
    }
    return sorted;
  }, [candidates, search, sort, me]);

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  return (
    <View style={S.container}>
      <View style={S.searchBar}>
        <TextInput
          style={S.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search drillers by name..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearch('')}
            style={S.clearBtn}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Text style={S.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={S.sortRow}>
        {([
          { v: 'overlap', label: '⏰ Overlap' },
          { v: 'shots',   label: '🎯 Shared shots' },
          { v: 'elo',     label: '⚖️ Skill match' },
        ] as { v: SortMode; label: string }[]).map(({ v, label }) => (
          <TouchableOpacity
            key={v}
            style={[S.sortPill, sort === v && S.sortPillActive]}
            onPress={() => setSort(v)}
          >
            <Text style={[S.sortPillText, sort === v && S.sortPillTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListEmptyComponent={
          <EmptyState
            icon="🔍"
            title="No drillers found"
            subtitle={'Either nobody\'s set "Open to drilling" yet, or your search is too narrow.'}
          />
        }
        renderItem={({ item }) => {
          const avatar = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
          const overlapHrs = (item.overlap.length * 0.5).toFixed(1).replace(/\.0$/, '');
          const eloDiff    = item.rating - (me?.rating ?? 3.25);
          const eloDiffLabel = Math.abs(eloDiff) < 0.005 ? 'same PLUPR' :
                               `${eloDiff > 0 ? '+' : ''}${eloDiff.toFixed(2)} vs you`;

          return (
            <View style={S.card}>
              <View style={S.cardTop}>
                <View style={[S.avatar, { backgroundColor: avatar.bgColor }]}>
                  <Text style={S.avatarEmoji}>{avatar.emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.name} numberOfLines={1}>{item.full_name}</Text>
                  <Text style={S.username}>@{item.username} · {formatPlupr(item.rating, item.total_matches_played)} PLUPR ({eloDiffLabel})</Text>
                </View>
              </View>

              <View style={S.statsRow}>
                <View style={[S.statPill, item.overlap.length > 0 ? S.statPillGood : S.statPillEmpty]}>
                  <Text style={[S.statPillText, item.overlap.length > 0 ? S.statPillGoodText : S.statPillEmptyText]}>
                    {item.overlap.length > 0 ? `${overlapHrs}h overlap` : 'No overlap'}
                  </Text>
                </View>
                {item.sharedShots > 0 && (
                  <View style={S.statPillShots}>
                    <Text style={S.statPillShotsText}>{item.sharedShots} shared shot{item.sharedShots !== 1 ? 's' : ''}</Text>
                  </View>
                )}
                {item.sharedPartner > 0 && (
                  <View style={S.statPillPartner}>
                    <Text style={S.statPillPartnerText}>{item.sharedPartner} aligned pref{item.sharedPartner !== 1 ? 's' : ''}</Text>
                  </View>
                )}
              </View>

              {item.drill_shot_prefs.length > 0 && (
                <View style={S.tagRow}>
                  {item.drill_shot_prefs.slice(0, 6).map(slug => {
                    const p = findShotPref(slug);
                    if (!p) return null;
                    const shared = me?.shots.includes(slug);
                    return (
                      <View key={slug} style={[S.tagChip, shared && S.tagChipShared]}>
                        <Text style={[S.tagChipText, shared && S.tagChipTextShared]}>
                          {p.emoji} {p.label}
                        </Text>
                      </View>
                    );
                  })}
                  {item.drill_shot_prefs.length > 6 && (
                    <Text style={S.moreText}>+{item.drill_shot_prefs.length - 6}</Text>
                  )}
                </View>
              )}

              {item.drill_custom_tags.length > 0 && (
                <View style={S.tagRow}>
                  {item.drill_custom_tags.slice(0, 4).map(tag => (
                    <View key={tag} style={S.customChip}>
                      <Text style={S.customChipText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}

              <TouchableOpacity
                style={[S.requestBtn, item.overlap.length === 0 && S.requestBtnDisabled]}
                onPress={() => setRequestTarget(item)}
                disabled={item.overlap.length === 0}
              >
                <Text style={S.requestBtnText}>
                  {item.overlap.length === 0 ? 'No overlapping times' : '📨 Send Drill Request'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />

      {requestTarget && me && (
        <DrillRequestModal
          visible={!!requestTarget}
          onClose={() => setRequestTarget(null)}
          onSent={() => { /* badge will refresh on screen focus */ }}
          fromUserId={me.id}
          toUserId={requestTarget.id}
          toName={requestTarget.full_name}
          overlapSlots={requestTarget.overlap}
        />
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:     { flex: 1, backgroundColor: c.bg },
    searchBar:     { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput:   { flex: 1, fontSize: 14, color: c.text, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1.5, borderColor: c.border, borderRadius: 10, backgroundColor: c.surfaceAlt },
    clearBtn:      { paddingHorizontal: 10, paddingVertical: 8, marginLeft: 4 },
    clearText:     { fontSize: 16, color: c.textMuted },

    sortRow:       { flexDirection: 'row', gap: 8, padding: 12, paddingTop: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    sortPill:      { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    sortPillActive:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    sortPillText:  { fontSize: 12, color: c.textSub, fontWeight: '600' },
    sortPillTextActive: { color: c.primary, fontWeight: '800' },

    emptyWrap:     { alignItems: 'center', padding: 40, marginTop: 40 },
    emptyEmoji:    { fontSize: 48, marginBottom: 12 },
    emptyText:     { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20 },

    card:          {
      backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    cardTop:       { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
    avatar:        { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji:   { fontSize: 24 },
    name:          { fontSize: 16, fontWeight: '800', color: c.text },
    username:      { fontSize: 12, color: c.textMuted, marginTop: 2 },

    statsRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    statPill:      { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
    statPillGood:  { backgroundColor: c.primaryLight },
    statPillEmpty: { backgroundColor: c.surfaceAlt },
    statPillText:  { fontSize: 11, fontWeight: '700' },
    statPillGoodText:  { color: c.primary },
    statPillEmptyText: { color: c.textMuted },
    statPillShots: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: '#fff8e1' },
    statPillShotsText: { fontSize: 11, fontWeight: '700', color: '#b8860b' },
    statPillPartner:{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: '#e3f2fd' },
    statPillPartnerText:{ fontSize: 11, fontWeight: '700', color: '#1565c0' },

    tagRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    tagChip:       { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    tagChipShared: { backgroundColor: c.primaryLight, borderColor: c.primary },
    tagChipText:   { fontSize: 11, color: c.textSub, fontWeight: '600' },
    tagChipTextShared: { color: c.primary, fontWeight: '800' },
    moreText:      { fontSize: 11, color: c.textMuted, alignSelf: 'center' },
    customChip:    { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, borderStyle: 'dashed' },
    customChipText:{ fontSize: 11, color: c.textSub, fontStyle: 'italic' },

    requestBtn:    { backgroundColor: c.primary, borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 4 },
    requestBtnDisabled: { backgroundColor: c.border },
    requestBtnText:{ color: '#fff', fontSize: 14, fontWeight: '700' },
  });
}

// Find Drillers. Limited to Discover's one search area (the pills at the top,
// shared with every Discover tab): drillers who PLAY there, by their leagues'
// home courts and, when their presence privacy names them to you, their
// starred and frequent courts (data/playersNear; never where they are now).
// The list waits until the area is known (lib/useSearchArea's `ready`).
// Without any area (no location, no city, no located league court): the 100
// drillers nearest your level, as before.
// "Find a new time" (a push, `partnerId`) opens the request form for that
// partner even when they don't play inside the area: they are fetched alone.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import {
  DateSlot, overlapSlots, rollingDates, expandWeeklyToDates, toWeeklyTemplate,
} from '../lib/drillTime';
import { findShotPref, findPartnerPref } from '../data/drillOptions';
import { useBlockedIds } from '../lib/moderation';
import { AVATARS } from '../data/profileCustomization';
import DrillRequestModal from '../components/DrillRequestModal';
import { formatPlupr } from '../lib/plupr';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import SearchAreaBar from '../components/SearchAreaBar';
import { useSearchArea } from '../lib/useSearchArea';
import { searchAreaKey, type SearchArea } from '../lib/searchArea';
import { listPlayersNear } from '../data/playersNear';
import { playsAtLabel } from '../lib/playersNear';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DrillSearch'>;
  route: RouteProp<RootStackParamList, 'DrillSearch'>;
};

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
  /** "Plays at Lakeside Park · 2 mi" (search area only). */
  playsAt: string | null;
};

type SortMode = 'overlap' | 'shots' | 'elo';

type Me = { id: string; rating: number; avail: boolean[]; shots: string[]; partner: string[] };

const DRILLER_COLUMNS =
  'id, full_name, username, rating, total_matches_played, avatar_id, avatar_url, drill_availability, drill_shot_prefs, drill_partner_prefs, drill_custom_tags';

/** A driller row scored against me (shared slots, shots, partner prefs). */
function toCandidate(p: any, me: Me, withPlace: boolean): Candidate {
  const dates   = rollingDates();
  const myDated = expandWeeklyToDates(me.avail, dates);
  const theirWeekly = toWeeklyTemplate(p.drill_availability ?? []);
  const overlap     = overlapSlots(myDated, expandWeeklyToDates(theirWeekly, dates), dates);
  const sharedShots   = (p.drill_shot_prefs ?? []).filter((s: string) => me.shots.includes(s)).length;
  const sharedPartner = (p.drill_partner_prefs ?? []).filter((s: string) => me.partner.includes(s)).length;
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
    playsAt: withPlace && p.distance_m != null ? playsAtLabel(p) : null,
  };
}

/** One driller by id (a push's partner), or null when they can't be offered:
 *  a deleted account, or drilling turned off since. */
async function fetchDriller(id: string): Promise<any | null> {
  const p = await sbCall(() => supabase
    .from('profiles')
    .select(`${DRILLER_COLUMNS}, drilling_enabled, deleted_at`)
    .eq('id', id)
    .maybeSingle()) as any;
  return p && !p.deleted_at && p.drilling_enabled ? p : null;
}

export default function DrillSearchScreen({ route }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [search, setSearch]   = useState('');
  const [sort, setSort]       = useState<SortMode>('overlap');
  const [requestTarget, setRequestTarget] = useState<Candidate | null>(null);
  const { area, ready: areaReady } = useSearchArea();
  const areaKey = searchAreaKey(area);
  const areaRef = useRef<SearchArea | null>(area);
  areaRef.current = area;
  // "Find a new time" from a push: open the request form for that partner,
  // once, as soon as they are in the list.
  const partnerId = route.params?.partnerId;
  const prefilledFor = useRef<string | null>(null);

  const load = useCallback(async (): Promise<{ me: Me; candidates: Candidate[] }> => {
    // Local session read. The old getUser() round trip returned null on a dead
    // connection and the loader bailed WITHOUT clearing `loading`, leaving the
    // screen shimmering forever with no refresh control mounted to escape it.
    const uid = await currentUserId(supabase);
    if (!uid) throw new Error('Not signed in.');

    const myProfile = await sbCall(() => supabase
      .from('profiles')
      .select('rating, drill_availability, drill_shot_prefs, drill_partner_prefs')
      .eq('id', uid)
      .single()) as any;

    const myWeekly  = toWeeklyTemplate(myProfile?.drill_availability ?? []);
    const myShots   = (myProfile?.drill_shot_prefs ?? []) as string[];
    const myPartner = (myProfile?.drill_partner_prefs ?? []) as string[];
    const myRating  = myProfile?.rating ?? 3.25;
    const me: Me = { id: uid, rating: myRating, avail: myWeekly, shots: myShots, partner: myPartner };

    // discover_players (migration_hide_test_accounts.sql) leaves out deleted
    // accounts (deletion also clears drilling_enabled, but the exclusion should
    // not depend on a side effect of the scrub) and test accounts while God
    // mode hides them. p_near_rating: the 100 drillers nearest my level, so the
    // pool scored below is never just the first 100 names alphabetically.
    const near = areaRef.current;
    const others = near
      ? await listPlayersNear(near, { drillingOnly: true, exclude: [uid], limit: 200 }) as any[]
      : await sbCall(() => supabase
        .rpc('discover_players', { p_drilling_only: true, p_exclude: [uid], p_limit: 100, p_near_rating: myRating })
        .select(DRILLER_COLUMNS)) as any[];

    const list: Candidate[] = (others ?? []).map((p: any) => toCandidate(p, me, !!near));

    return { me, candidates: list };
  }, []);

  // Keyed by the area: a new area is a new list. Not fetched (and nothing
  // cached as "anywhere") until the area is known.
  const query = useCachedQuery(`drill:search:${areaKey}`, load, {
    ttlMs: 60_000,
    persistMs: 12 * 60 * 60 * 1000,
    enabled: areaReady,
  });
  const me         = query.data?.me ?? null;
  const candidates = query.data?.candidates ?? [];
  const loadFailed = query.error != null && query.data === undefined;

  const reload = useCallback(() => query.refresh(), [query.refresh]);

  const refresh = useRefresh(reload);

  // A blocked player must not come back as a drilling suggestion. The database
  // already refuses the request itself; this keeps them out of the list that
  // offers to send one.
  const blockedIds = useBlockedIds();

  // "Find a new time": the partner from the list, else (they don't play inside
  // the area, or are past the list's cap) fetched alone. Once per partner.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const listReady = query.data !== undefined;
  useEffect(() => {
    if (!partnerId || prefilledFor.current === partnerId || !me || !listReady) return;
    if (blockedIds.has(partnerId) || partnerId === me.id) return;
    prefilledFor.current = partnerId;
    const match = candidates.find(c => c.id === partnerId);
    if (match) {
      setRequestTarget(match);
      return;
    }
    void fetchDriller(partnerId)
      .then((p) => { if (mounted.current && p) setRequestTarget(toCandidate(p, me, false)); })
      .catch(() => { /* the list is still there to pick from */ });
  }, [partnerId, candidates, me, listReady, blockedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = blockedIds.size ? candidates.filter(c => !blockedIds.has(c.id)) : candidates;
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
  }, [candidates, search, sort, me, blockedIds]);

  // Only gate on the very first load, and never when it failed — the failure
  // path has to fall through to the list so its pull-to-refresh stays mounted.
  const areaBar = <SearchAreaBar surface="drill" style={S.areaBar} />;
  if ((query.loading || !areaReady) && !loadFailed) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}>{areaBar}<SkeletonList rows={6} /></View>;
  }

  return (
    <View style={S.container}>
      {areaBar}
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
            <Icon name="close" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={S.sortRow}>
        {([
          { v: 'overlap', label: 'Overlap', icon: 'clock' },
          { v: 'shots',   label: 'Shared shots', icon: 'target' },
          { v: 'elo',     label: 'Skill match', icon: 'scale' },
        ] as { v: SortMode; label: string; icon: IconName }[]).map(({ v, label, icon }) => (
          <TouchableOpacity
            key={v}
            style={[S.sortPill, sort === v && S.sortPillActive]}
            onPress={() => setSort(v)}
            accessibilityRole="button"
            accessibilityState={{ selected: sort === v }}
          >
            <Icon name={icon} size={12} color={sort === v ? colors.primary : colors.textSub} />
            <Text style={[S.sortPillText, sort === v && S.sortPillTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        contentContainerStyle={{ padding: SPACE.lg }}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListEmptyComponent={
          loadFailed
            ? <ErrorState
                iconName="offline"
                error={query.error}
                message={`Couldn't load drillers. ${friendlySbMessage(query.error)}`}
                retryLabel="Retry"
                onRetry={() => { void reload(); }}
              />
            : area && !search.trim()
              ? <EmptyState
                  iconName="pin"
                  title={`No drillers within ${area.radiusMi} mi`}
                  subtitle="Drillers show up here by their leagues' courts and the courts they star. Try a wider radius above."
                />
              : <EmptyState
                  iconName="search"
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
                  {item.playsAt ? <Text style={S.username} numberOfLines={1}>{item.playsAt}</Text> : null}
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
                        <Icon name={p.iconName} size={12} color={shared ? colors.primary : colors.textSub} />
                        <Text style={[S.tagChipText, shared && S.tagChipTextShared]}>
                          {p.label}
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
                accessibilityRole="button"
              >
                {item.overlap.length > 0 ? <Icon name="mail" size={16} color={colors.textInverse} /> : null}
                <Text style={[S.requestBtnText, item.overlap.length === 0 && S.requestBtnTextDisabled]}>
                  {item.overlap.length === 0 ? 'No overlapping times' : 'Send Drill Request'}
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
    areaBar:       { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchBar:     { flexDirection: 'row', alignItems: 'center', padding: SPACE.md, backgroundColor: c.surface, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    searchInput:   { flex: 1, minHeight: 44, fontSize: FONT.size.md, color: c.text, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderWidth: 1.5, borderColor: c.border, borderRadius: RADIUS.md, backgroundColor: c.surfaceAlt },
    clearBtn:      { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginLeft: SPACE.xs },

    sortRow:       { flexDirection: 'row', gap: SPACE.sm, padding: SPACE.md, paddingTop: SPACE.sm, backgroundColor: c.surface, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    sortPill:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 32, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    sortPillActive:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    sortPillText:  { fontSize: FONT.size.sm, color: c.textSub, fontWeight: FONT.weight.semibold },
    sortPillTextActive: { color: c.primary, fontWeight: FONT.weight.heavy },

    card:          {
      backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm,
      shadowColor: c.shadow, shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    cardTop:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginBottom: SPACE.sm },
    avatar:        { width: 48, height: 48, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji:   { fontSize: FONT.size.h1 },
    name:          { fontSize: FONT.size.lg, fontWeight: FONT.weight.heavy, color: c.text },
    username:      { fontSize: FONT.size.sm, color: c.textMuted, marginTop: SPACE.xxs },

    statsRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.sm },
    statPill:      { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill },
    statPillGood:  { backgroundColor: c.primaryLight },
    statPillEmpty: { backgroundColor: c.surfaceAlt },
    statPillText:  { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold },
    statPillGoodText:  { color: c.primary },
    statPillEmptyText: { color: c.textMuted },
    statPillShots: { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, backgroundColor: c.rarityLegendaryLight },
    statPillShotsText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.rarityLegendary },
    statPillPartner:{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, backgroundColor: c.infoLight },
    statPillPartnerText:{ fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.info },

    tagRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: SPACE.sm },
    tagChip:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    tagChipShared: { backgroundColor: c.primaryLight, borderColor: c.primary },
    tagChipText:   { fontSize: FONT.size.xs, color: c.textSub, fontWeight: FONT.weight.semibold },
    tagChipTextShared: { color: c.primary, fontWeight: FONT.weight.heavy },
    moreText:      { fontSize: FONT.size.xs, color: c.textMuted, alignSelf: 'center' },
    customChip:    { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border, borderStyle: 'dashed' },
    customChipText:{ fontSize: FONT.size.xs, color: c.textSub, fontStyle: 'italic' },

    requestBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, minHeight: 44, backgroundColor: c.primary, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.xs },
    requestBtnDisabled: { backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    requestBtnText:{ color: c.textInverse, fontSize: FONT.size.md, fontWeight: FONT.weight.bold },
    requestBtnTextDisabled: { color: c.textMuted },
  });
}

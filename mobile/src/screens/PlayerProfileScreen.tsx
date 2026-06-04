import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  TouchableOpacity, ActivityIndicator, Image,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile, PlayerLocationRating, RootStackParamList } from '../types';
import BadgeDisplay, { BadgeItem } from '../components/BadgeDisplay';
import FlairName from '../components/FlairName';
import { AVATARS, PLAY_TAGS } from '../data/profileCustomization';
import { computeReliability } from '../lib/reliability';
import { computeChemistry, fmtDelta, chemistryColor, DoublesMatch } from '../lib/chemistry';
import { formatPlupr, formatPluprShort } from '../lib/plupr';
import BookmarkButton from '../components/BookmarkButton';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PlayerProfile'>;
  route: RouteProp<RootStackParamList, 'PlayerProfile'>;
};

export default function PlayerProfileScreen({ navigation, route }: Props) {
  const { userId } = route.params;
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [profile, setProfile]             = useState<Profile | null>(null);
  const [badges, setBadges]               = useState<BadgeItem[]>([]);
  const [cosmeticPurchases, setCosmeticPurchases] = useState<{
    id: string; shop_item_id: string; purchased_at: string;
    gifted_by_user_id: string | null; gift_message: string | null;
    item: { name: string; description: string; icon: string };
  }[]>([]);
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [matchCount, setMatchCount]       = useState(0);
  const [loading, setLoading]             = useState(true);
  const [myChemistry, setMyChemistry]     = useState<ReturnType<typeof computeChemistry> | null>(null);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    const [profileRes, badgesRes, locRes, matchRes, purchasesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('player_badges')
        .select('*, badge:badges(*), league:leagues(name)')
        .eq('user_id', userId)
        .eq('is_hidden', false)   // only show public badges
        .order('earned_at'),
      supabase.from('player_location_ratings')
        .select('*').eq('user_id', userId)
        .order('rating', { ascending: false })
        .limit(6),
      supabase.from('matches')
        .select('id', { count: 'exact', head: true })
        .or(`player1_id.eq.${userId},player2_id.eq.${userId},partner1_id.eq.${userId},partner2_id.eq.${userId}`),
      supabase.from('player_shop_purchases')
        .select('id, shop_item_id, purchased_at, gifted_by_user_id, gift_message, item:shop_items(category, name, description, icon)')
        .eq('user_id', userId)
        .eq('is_hidden', false)
        .order('purchased_at', { ascending: false }),
    ]);

    setProfile(profileRes.data as Profile);
    setBadges((badgesRes.data ?? []) as BadgeItem[]);
    setLocationRatings((locRes.data ?? []) as PlayerLocationRating[]);
    setMatchCount(matchRes.count ?? 0);
    setCosmeticPurchases(
      ((purchasesRes.data ?? []) as any[])
        .filter(r => r.item && r.item.category === 'cosmetic_badge')
    );
    setLoading(false);

    // Load mutual chemistry in background
    if (user) loadMutualChemistry(user.id);
  }

  async function loadMutualChemistry(myId: string) {
    if (myId === userId) return; // viewing own profile
    const { data } = await supabase
      .from('matches')
      .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, player1_rating_before, player2_rating_before')
      .eq('match_type', 'doubles')
      .or(`player1_id.eq.${myId},partner1_id.eq.${myId},player2_id.eq.${myId},partner2_id.eq.${myId}`)
      .limit(500);
    if (!data || data.length === 0) return;
    const result = computeChemistry(myId, userId, data as DoublesMatch[]);
    if (result.matchesTogether > 0) setMyChemistry(result);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;
  if (!profile) return <Text style={styles.error}>Player not found.</Text>;

  const reliability   = computeReliability(profile.total_matches_played ?? 0, profile.last_match_at ?? null);

  // Group repeats of the same badge into a single stack so the tile can
  // render "Badge ×N" instead of N identical tiles. Key on the badge's
  // display name (always populated via the join) so awards always
  // collapse regardless of any badge_id quirk.
  function groupBadges(list: BadgeItem[]) {
    const groups = new Map<string, BadgeItem[]>();
    for (const b of list) {
      const key = `${b.badge.name}::${b.league_id ?? ''}`;
      const existing = groups.get(key);
      if (existing) existing.push(b);
      else groups.set(key, [b]);
    }
    return Array.from(groups.values())
      .map(stack => {
        const sorted = [...stack].sort((a, b) =>
          new Date(b.earned_at).getTime() - new Date(a.earned_at).getTime()
        );
        return { rep: sorted[0], stack: sorted };
      })
      .sort((a, b) =>
        new Date(b.rep.earned_at).getTime() - new Date(a.rep.earned_at).getTime()
      );
  }
  const cosmeticBadgeItems: BadgeItem[] = cosmeticPurchases.map(p => ({
    id:         p.id,
    badge_id:   `cosmetic:${p.shop_item_id}`,
    is_hidden:  false,
    earned_at:  p.purchased_at,
    context:    p.gift_message ?? (p.gifted_by_user_id ? 'A gift' : null),
    league_id:  null,
    badge: {
      name:        p.item.name,
      description: p.item.description,
      icon:        p.item.icon,
      category:    'cosmetic',
    },
    league: null,
  }));

  const profileBadgeGroups  = groupBadges(badges.filter(b => b.badge.category === 'profile'));
  const leagueBadgeGroups   = groupBadges(badges.filter(b => b.badge.category === 'league'));
  const cosmeticBadgeGroups = groupBadges(cosmeticBadgeItems);
  const hasAnyVisibleBadges = badges.length > 0 || cosmeticBadgeItems.length > 0;

  const locationGroups: Record<string, {
    singles?: PlayerLocationRating;
    doubles_gendered?: PlayerLocationRating;
    doubles_mixed?: PlayerLocationRating;
  }> = {};
  for (const r of locationRatings) {
    if (!locationGroups[r.location_name]) locationGroups[r.location_name] = {};
    locationGroups[r.location_name][r.match_type] = r;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ position: 'absolute', top: 12, right: 16 }}>
          <BookmarkButton targetType="profile" targetId={userId} />
        </View>
        {profile.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={styles.avatarPhoto} />
        ) : (
          <View style={[styles.avatar, { backgroundColor: (AVATARS.find(a => a.id === (profile.avatar_id ?? 1)) ?? AVATARS[0]).bgColor }]}>
            <Text style={styles.avatarEmoji}>
              {(AVATARS.find(a => a.id === (profile.avatar_id ?? 1)) ?? AVATARS[0]).emoji}
            </Text>
          </View>
        )}
        {/* TODO: smoke-test in browser — hero mode FlairName wire-up */}
        <FlairName
          style={styles.fullName}
          nameColor={profile.name_color}
          styleId={profile.profile_name_style_id}
          mode="hero"
          name={profile.full_name}
        />
        {profile.tagline ? <Text style={styles.tagline}>{profile.tagline}</Text> : null}
        <Text style={styles.username}>@{profile.username}</Text>
        {(profile.selected_tags ?? []).length > 0 && (
          <View style={styles.tagsRow}>
            {(profile.selected_tags ?? []).map(slug => {
              const tag = PLAY_TAGS.find(t => t.slug === slug);
              return tag ? (
                <View key={slug} style={styles.tagChip}>
                  <Text style={styles.tagChipText}>{tag.label}</Text>
                </View>
              ) : null;
            })}
          </View>
        )}
        <Text style={styles.matchCount}>{matchCount} matches played</Text>
      </View>

      {/* PLUPR strip + reliability (hidden) — global PLUPR is intentionally not
          shown on other players' profiles; PLUPR is being kept contained within
          a league. Re-add this block to restore. */}

      {/* Mutual chemistry card */}
      {myChemistry && myChemistry.matchesTogether > 0 && (
        <View style={styles.chemCard}>
          <Text style={styles.chemTitle}>Your Chemistry Together</Text>
          <View style={styles.chemMain}>
            <Text style={[styles.chemDelta, { color: chemistryColor(myChemistry.overallDelta) }]}>
              {fmtDelta(myChemistry.overallDelta)}
            </Text>
            <Text style={styles.chemSub}>win rate vs your baseline · {myChemistry.matchesTogether} doubles matches</Text>
          </View>
          {myChemistry.insights.map((ins, i) => (
            <Text key={i} style={styles.chemInsight}>• {ins}</Text>
          ))}
          {!myChemistry.significant && (
            <Text style={styles.chemHint}>Play {5 - myChemistry.matchesTogether} more doubles matches together for deeper stats</Text>
          )}
        </View>
      )}

      {/* Badges */}
      {profile.badges_public !== false && hasAnyVisibleBadges && (
        <>
          {profileBadgeGroups.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Profile Badges</Text>
              <View style={styles.badgeGrid}>
                {profileBadgeGroups.map(g => (
                  <BadgeDisplay key={g.rep.id} badge={g.rep} stack={g.stack} />
                ))}
              </View>
            </View>
          )}
          {leagueBadgeGroups.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>League Badges</Text>
              <View style={styles.badgeGrid}>
                {leagueBadgeGroups.map(g => (
                  <BadgeDisplay key={g.rep.id} badge={g.rep} stack={g.stack} />
                ))}
              </View>
            </View>
          )}
          {cosmeticBadgeGroups.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Cosmetic Badges</Text>
              <View style={styles.badgeGrid}>
                {cosmeticBadgeGroups.map(g => (
                  <BadgeDisplay key={g.rep.id} badge={g.rep} stack={g.stack} />
                ))}
              </View>
            </View>
          )}
        </>
      )}
      {profile.badges_public === false && (
        <View style={styles.privateBox}>
          <Text style={styles.privateText}>🔒  This player's badges are private.</Text>
        </View>
      )}

      {/* Court ratings (hidden) — per-court PLUPR is intentionally not shown on
          other players' profiles; PLUPR is being kept contained within a league.
          The locationGroups data is left intact so this can be restored. */}

      {/* Actions */}
      <TouchableOpacity
        style={styles.actionBtn}
        onPress={() => navigation.navigate('MatchHistory', { userId, title: `${profile.full_name}'s History` })}
      >
        <Text style={styles.actionBtnText}>📜  View Match History</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 20, backgroundColor: c.bg, flexGrow: 1 },
    error: { textAlign: 'center', marginTop: 60, color: c.textMuted },
    header: { alignItems: 'center', marginBottom: 16 },
    avatar: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4, elevation: 3 },
    avatarPhoto: { width: 80, height: 80, borderRadius: 40, marginBottom: 10 },
    avatarEmoji: { fontSize: 40 },
    fullName: { fontSize: 22, fontWeight: '800', color: c.text },
    tagline: { fontSize: 14, color: c.textSub, fontStyle: 'italic', marginTop: 3, marginBottom: 2 },
    username: { fontSize: 14, color: c.textMuted, marginTop: 2 },
    matchCount: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 6 },
    tagChip: { backgroundColor: c.primaryLight, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
    tagChipText: { fontSize: 12, color: c.primary, fontWeight: '600' },
    eloCard:    { flexDirection: 'row', backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 4, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    eloItem:    { flex: 1, alignItems: 'center' },
    eloValue:   { fontSize: 24, fontWeight: '800', color: c.primary },
    eloLabel:   { fontSize: 12, color: c.textMuted, marginTop: 2 },
    eloDivider: { width: 1, height: 32, backgroundColor: c.border },
    relRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 14, gap: 5 },
    relDots:    { flexDirection: 'row', gap: 3 },
    relDot:     { width: 7, height: 7, borderRadius: 4, backgroundColor: c.border },
    relLabel:   { fontSize: 12, fontWeight: '700' },
    relDetail:  { fontSize: 11, color: c.textMuted, flex: 1 },
    chemCard:   { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1.5, borderColor: c.primaryLight },
    chemTitle:  { fontSize: 13, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
    chemMain:   { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 6 },
    chemDelta:  { fontSize: 28, fontWeight: '900' },
    chemSub:    { fontSize: 12, color: c.textMuted, flex: 1, flexWrap: 'wrap' },
    chemInsight:{ fontSize: 13, color: c.text, marginBottom: 3 },
    chemHint:   { fontSize: 11, color: c.textMuted, marginTop: 4 },
    section: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
    sectionTitle: { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
    badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', margin: -4 },
    privateBox: { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 16, alignItems: 'center', marginBottom: 12 },
    privateText: { color: c.textMuted, fontSize: 14 },
    locRow: { marginBottom: 10 },
    locName: { fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 4 },
    locRatings: { flexDirection: 'row', gap: 8 },
    locPill: { backgroundColor: c.primaryLight, borderRadius: 8, padding: 8, alignItems: 'center', minWidth: 80 },
    locPillD: { backgroundColor: '#e3f2fd' },
    locPillM: { backgroundColor: '#f3e5f5' },
    locVal: { fontSize: 18, fontWeight: '800', color: c.text },
    locType: { fontSize: 10, color: c.textSub, marginTop: 2 },
    actionBtn: { backgroundColor: c.surface, borderRadius: 12, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: c.border, marginTop: 4 },
    actionBtnText: { fontSize: 15, fontWeight: '600', color: c.textSub },
  });
}

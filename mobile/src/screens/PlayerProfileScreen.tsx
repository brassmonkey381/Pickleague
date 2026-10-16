// Another player's profile (plan section 8, P6: "row header, merged badges,
// Leagues in common"). Order:
//   1. Row header   avatar 64 beside name / @username · matches / tagline, then
//                   one chip row (DUPR, tags +N) with Share · Save · ⋯ at its end,
//                   then Add friend (FriendButton; friends at the courts only)
//   2. Quick row    [Head-to-head] (not on yourself) [Match history]
//   3. Chemistry    your doubles chemistry together, when you've partnered
//   4. Leagues in common  rows -> LeagueDetail (hidden when none / yourself)
//   5. Badges (n)   one merged grid, newest first (was three category cards)
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
} from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { Panel, SectionHeader, Chip } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import {
  sbCall, currentUserId, classifySbError, friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile, PlayerLocationRating, RootStackParamList } from '../types';
import BadgeDisplay, { BadgeItem } from '../components/BadgeDisplay';
import FlairName from '../components/FlairName';
import LeagueRow, { LeagueRowRole } from '../components/LeagueRow';
import { AVATARS, PLAY_TAGS } from '../data/profileCustomization';
import { computeChemistry, fmtDelta, chemistryColor, DoublesMatch } from '../lib/chemistry';
import BookmarkButton from '../components/BookmarkButton';
import ShareLinkButton from '../components/ShareLinkButton';
import PlayerModerationMenu from '../components/PlayerModerationMenu';
import ClaimAccountButton from '../components/ClaimAccountButton';
import FriendButton from '../components/FriendButton';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PlayerProfile'>;
  route: RouteProp<RootStackParamList, 'PlayerProfile'>;
};

type CommonLeague = {
  id: string; name: string; home_court: string | null; is_open: boolean | null;
  /** THEIR role in it (both of you are members). */
  role: LeagueRowRole;
};

/** Tag chips shown before "+N". */
const TAG_CHIPS_SHOWN = 2;
/** Leagues in common shown before "Show N more". */
const COMMON_CAP = 4;
const AVATAR = 64;

export default function PlayerProfileScreen({ navigation, route }: Props) {
  const { userId } = route.params;
  const { colors } = useTheme();
  const t = textStyles(colors);
  const styles = makeStyles(colors);
  const [profile, setProfile]             = useState<Profile | null>(null);
  // "+N" on the tag row expands it to every tag; "Show less" folds it back.
  const [tagsExpanded, setTagsExpanded]   = useState(false);
  const [badges, setBadges]               = useState<BadgeItem[]>([]);
  const [cosmeticPurchases, setCosmeticPurchases] = useState<{
    id: string; shop_item_id: string; purchased_at: string;
    gifted_by_user_id: string | null; gift_message: string | null;
    item: { name: string; description: string; icon: string };
  }[]>([]);
  // Per-court PLUPR stays loaded for the hidden court card (see the render).
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [matchCount, setMatchCount]       = useState(0);
  const [loading, setLoading]             = useState(true);
  // Distinguishes "this player really doesn't exist" from "we couldn't ask".
  // A .single() that fails on bad WiFi used to render "Player not found."
  const [loadError, setLoadError]         = useState<unknown>(null);
  const [meId, setMeId]                   = useState<string | null>(null);
  const [myChemistry, setMyChemistry]     = useState<ReturnType<typeof computeChemistry> | null>(null);
  const [commonLeagues, setCommonLeagues] = useState<CommonLeague[]>([]);
  const [showAllCommon, setShowAllCommon] = useState(false);

  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      const uid = await currentUserId(supabase);   // local session read, no round trip
      setMeId(uid);
      const [profileRow, badgeRows, locRows, matchCountRes, purchaseRows] = await Promise.all([
        sbCall(() => supabase.from('profiles').select('*').eq('id', userId).single()),
        sbCall(() => supabase.from('player_badges')
          .select('*, badge:badges(*), league:leagues(name)')
          .eq('user_id', userId)
          .eq('is_hidden', false)   // only show public badges
          .order('earned_at')),
        sbCall(() => supabase.from('player_location_ratings')
          .select('*').eq('user_id', userId)
          .order('rating', { ascending: false })
          .limit(6)),
        supabase.from('matches')
          .select('id', { count: 'exact', head: true })
          .or(`player1_id.eq.${userId},player2_id.eq.${userId},partner1_id.eq.${userId},partner2_id.eq.${userId}`),
        sbCall(() => supabase.from('player_shop_purchases')
          .select('id, shop_item_id, purchased_at, gifted_by_user_id, gift_message, item:shop_items(category, name, description, icon)')
          .eq('user_id', userId)
          .eq('is_hidden', false)
          .order('purchased_at', { ascending: false })),
      ]);

      setProfile(profileRow as Profile);
      // A push or a web link opens this with a placeholder name ("Player").
      navigation.setOptions({ title: (profileRow as Profile).full_name });
      setBadges((badgeRows ?? []) as BadgeItem[]);
      setLocationRatings((locRows ?? []) as PlayerLocationRating[]);
      setMatchCount(matchCountRes.count ?? 0);
      setCosmeticPurchases(
        ((purchaseRows ?? []) as any[])
          .filter(r => r.item && r.item.category === 'cosmetic_badge')
      );
      setLoadError(null);

      // Best-effort enrichment in the background.
      if (uid) {
        loadMutualChemistry(uid);
        loadCommonLeagues(uid);
      }
    } catch (e) {
      // Keep whatever is already on screen; the error only decides which
      // fallback the "no profile yet" branch renders.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }

  async function loadMutualChemistry(myId: string) {
    if (myId === userId) return; // viewing own profile
    // Best-effort enrichment — a failure here must not disturb the profile.
    let data: DoublesMatch[] | null = null;
    try {
      data = await sbCall(() => supabase
        .from('matches')
        .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, player1_rating_before, player2_rating_before')
        .eq('match_type', 'doubles')
        .or(`player1_id.eq.${myId},partner1_id.eq.${myId},player2_id.eq.${myId},partner2_id.eq.${myId}`)
        .limit(500)) as DoublesMatch[];
    } catch {
      return;
    }
    if (!data || data.length === 0) return;
    const result = computeChemistry(myId, userId, data);
    if (result.matchesTogether > 0) setMyChemistry(result);
  }

  // Leagues you're both in. league_members is readable by everyone (RLS
  // "Members viewable by everyone"), so one read covers both players.
  async function loadCommonLeagues(myId: string) {
    if (myId === userId) { setCommonLeagues([]); return; }
    try {
      const rows = await sbCall(() => supabase
        .from('league_members')
        .select('user_id, role, league:leagues(id, name, home_court, is_open, is_active)')
        .in('user_id', [myId, userId])) as any[] | null;
      const mine = new Set<string>();
      const theirs = new Map<string, CommonLeague>();
      for (const r of rows ?? []) {
        const l = r.league;
        if (!l || l.is_active === false) continue;
        if (r.user_id === myId) mine.add(l.id);
        else theirs.set(l.id, { id: l.id, name: l.name, home_court: l.home_court ?? null, is_open: l.is_open ?? null, role: r.role ?? 'member' });
      }
      setCommonLeagues(
        Array.from(theirs.values())
          .filter(l => mine.has(l.id))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      // Enrichment only: keep what's shown.
    }
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} variant="row" /></View>;
  if (!profile) {
    // Keep a scroll view + pull-to-refresh mounted either way: the old bare
    // <Text> was a dead end that could only be escaped by leaving the screen.
    const missing = loadError == null || classifySbError(loadError) === 'notFound';
    return (
      <ScrollView contentContainerStyle={styles.container} refreshControl={<AppRefreshControl {...refresh} />}>
        <EmptyState
          icon={missing ? '🔍' : '📡'}
          title={missing ? 'Player not found.' : "Couldn't load this player"}
          subtitle={missing ? undefined : friendlySbMessage(loadError)}
          actionLabel="Retry"
          onAction={() => { void load(); }}
        />
      </ScrollView>
    );
  }

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

  // One merged grid, newest first. Each tile's detail still names its
  // category (Profile / League / Cosmetic), so nothing is lost by merging.
  const badgeGroups = groupBadges([...badges, ...cosmeticBadgeItems]);
  const badgeCount = badges.length + cosmeticBadgeItems.length;
  const badgesPublic = profile.badges_public !== false;

  // Per-court PLUPR (hidden) — grouped exactly as the court card needs it.
  const locationGroups: Record<string, {
    singles?: PlayerLocationRating;
    doubles_gendered?: PlayerLocationRating;
    doubles_mixed?: PlayerLocationRating;
  }> = {};
  for (const r of locationRatings) {
    if (!locationGroups[r.location_name]) locationGroups[r.location_name] = {};
    locationGroups[r.location_name][r.match_type] = r;
  }

  const avatarDef = AVATARS.find(a => a.id === (profile.avatar_id ?? 1)) ?? AVATARS[0];
  const tagLabels = (profile.selected_tags ?? [])
    .map(slug => PLAY_TAGS.find(tg => tg.slug === slug)?.label)
    .filter((l): l is string => !!l);
  const tagOverflow = tagLabels.length - TAG_CHIPS_SHOWN;
  const tagsShown = tagsExpanded ? tagLabels : tagLabels.slice(0, TAG_CHIPS_SHOWN);
  const isOther = !!meId && meId !== userId;

  const shownCommon = showAllCommon ? commonLeagues : commonLeagues.slice(0, COMMON_CAP);
  const commonHidden = commonLeagues.length - shownCommon.length;

  return (
    <ScrollView contentContainerStyle={styles.container} refreshControl={<AppRefreshControl {...refresh} />}>
      {/* ── 1. Row header ─────────────────────────────────────── */}
      <View style={styles.identity}>
        {profile.avatar_url ? (
          <CachedImage source={{ uri: profile.avatar_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, { backgroundColor: avatarDef.bgColor }]}>
            <Text style={styles.avatarEmoji}>{avatarDef.emoji}</Text>
          </View>
        )}
        <View style={styles.identityText}>
          {/* TODO: smoke-test in browser — hero mode FlairName wire-up */}
          <FlairName
            style={styles.fullName}
            nameColor={profile.name_color}
            styleId={profile.profile_name_style_id}
            mode="hero"
            name={profile.full_name}
            numberOfLines={1}
          />
          <Text style={t.sub} numberOfLines={1}>
            @{profile.username}{matchCount > 0 ? ` · ${matchCount} ${matchCount === 1 ? 'match' : 'matches'}` : ''}
          </Text>
          {profile.tagline ? <Text style={[t.sub, styles.tagline]} numberOfLines={1}>{profile.tagline}</Text> : null}
        </View>
      </View>

      {/* Seeded from a DUPR roster and not yet claimed? Offer to claim it.
          Self-hides for every normal profile. */}
      <ClaimAccountButton profileId={userId} isUnclaimed={profile.is_unclaimed} />

      <View style={styles.chipRow}>
        <View style={styles.chips}>
          {/* The one place a linked DUPR profile is visible. Until this existed the
              claim flow had no confirmation surface at all — profiles.dupr_id was
              written and never shown. */}
          {profile.dupr_id ? (
            <Chip label={`DUPR ${profile.dupr_id}`} tone="neutral" size="sm" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
          ) : null}
          {tagsShown.map(label => (
            <Chip key={label} label={label} tone="brand" size="sm" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
          ))}
          {tagOverflow > 0 ? (
            <Chip
              label={tagsExpanded ? 'Show less' : `+${tagOverflow}`}
              tone="neutral"
              size="sm"
              hitBox
              onPress={() => setTagsExpanded(v => !v)}
              accessibilityRole="button"
              accessibilityLabel={tagsExpanded ? 'Show fewer tags' : `Show ${tagOverflow} more tags`}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            />
          ) : null}
        </View>
        <View style={styles.utilities}>
          {/* The player URL unfurls into their OG card, which mirrors this
              screen's public view and honours badges_public / hidden badges. */}
          <ShareLinkButton
            url={`https://www.pickleague.club/players/${userId}`}
            title={profile.full_name}
            message={`${profile.full_name} on Pickleague`}
            style={styles.shareBtn}
          />
          <BookmarkButton targetType="profile" targetId={userId} style={styles.box44} />
          {/* Report / block. Hides itself on your own profile. */}
          <PlayerModerationMenu
            userId={userId}
            userName={profile.full_name}
            meId={meId}
            subjectType="profile"
            snapshot={{
              full_name:  profile.full_name,
              username:   profile.username,
              tagline:    profile.tagline ?? null,
              avatar_url: profile.avatar_url ?? null,
            }}
            compact
          />
        </View>
      </View>

      {/* Add friend / Requested / Accept / Friends ✓ (renders nothing on
          yourself, unclaimed placeholders, or while friends are off). */}
      <FriendButton userId={userId} meId={meId} profile={profile} style={styles.friendRow} />

      {/* ── 2. Quick row ───────────────────────────────────────── */}
      <View style={styles.quickRow}>
        {isOther && (
          <Button
            size="sm"
            title="⚔️ Head-to-head"
            onPress={() => navigation.navigate('HeadToHead', { opponentId: userId, opponentName: profile.full_name })}
            style={styles.quickBtn}
          />
        )}
        <Button
          size="sm"
          variant="outline"
          title="Match history"
          onPress={() => navigation.navigate('MatchHistory', { userId, title: `${profile.full_name}'s History` })}
          style={styles.quickBtn}
        />
      </View>

      {/* PLUPR strip + reliability (hidden) — global PLUPR is intentionally not
          shown on other players' profiles; PLUPR is being kept contained within
          a league. Re-add this block to restore. */}

      {/* ── 3. Chemistry together ──────────────────────────────── */}
      {myChemistry && myChemistry.matchesTogether > 0 && (
        <Panel style={styles.block}>
          <View style={styles.chemMain}>
            <Text style={[t.title, styles.flexText]} numberOfLines={1}>Your chemistry together</Text>
            <Text style={[styles.chemDelta, { color: chemistryColor(myChemistry.overallDelta) }]}>
              {fmtDelta(myChemistry.overallDelta)}
            </Text>
          </View>
          <Text style={t.sub} numberOfLines={1}>
            Win rate vs your baseline · {myChemistry.matchesTogether} doubles {myChemistry.matchesTogether === 1 ? 'match' : 'matches'}
          </Text>
          {myChemistry.insights.map((ins, i) => (
            <Text key={i} style={[t.sub, styles.insight]} numberOfLines={2}>• {ins}</Text>
          ))}
          {!myChemistry.significant && (
            <Text style={[t.meta, styles.insight]}>
              Play {5 - myChemistry.matchesTogether} more doubles matches together for deeper stats
            </Text>
          )}
        </Panel>
      )}

      {/* ── 4. Leagues in common ───────────────────────────────── */}
      {commonLeagues.length > 0 && (
        <View style={styles.block}>
          <SectionHeader title="Leagues in common" count={commonLeagues.length} />
          <Panel padded={false}>
            {shownCommon.map((l, i) => (
              <LeagueRow
                key={l.id}
                layout="row"
                league={{ id: l.id, name: l.name, home_court: l.home_court, is_open: l.is_open }}
                role={l.role}
                onPress={() => navigation.navigate('LeagueDetail', { leagueId: l.id, leagueName: l.name })}
                lastRow={commonHidden === 0 && i === shownCommon.length - 1}
              />
            ))}
            {commonHidden > 0 && (
              <TouchableOpacity
                style={styles.moreRow}
                onPress={() => setShowAllCommon(true)}
                accessibilityRole="button"
              >
                <Text style={[t.meta, { color: colors.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  Show {commonHidden} more
                </Text>
              </TouchableOpacity>
            )}
          </Panel>
        </View>
      )}

      {/* ── 5. Badges (merged) ─────────────────────────────────── */}
      {badgesPublic && badgeCount > 0 && (
        <View style={styles.block}>
          <SectionHeader title="Badges" count={badgeCount} />
          <Panel>
            <View style={styles.badgeGrid}>
              {badgeGroups.map(g => (
                <BadgeDisplay key={g.rep.id} badge={g.rep} stack={g.stack} />
              ))}
            </View>
          </Panel>
        </View>
      )}
      {!badgesPublic && (
        <Text style={[t.hint, styles.block]}>🔒  This player's badges are private.</Text>
      )}

      {/* Court ratings (hidden) — per-court PLUPR is intentionally not shown on
          other players' profiles; PLUPR is being kept contained within a league.
          The locationGroups data is left intact so this can be restored. */}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: SPACE.lg, paddingBottom: SPACE.xl, backgroundColor: c.bg, flexGrow: 1 },
    flexText:  { flex: 1, minWidth: 0 },
    box44:     { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    block:     { marginBottom: SPACE.md },

    identity:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
    identityText: { flex: 1, minWidth: 0, gap: SPACE.xxs },
    avatar:       { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji:  { fontSize: 34 },
    fullName:     { fontSize: FONT.size.h2, fontWeight: '700', color: c.text },
    tagline:      { fontStyle: 'italic' },

    // Chips wrap on the left; Share · Save · ⋯ stay together on the right.
    chipRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, marginTop: SPACE.xs },
    chips:     { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
    utilities: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    shareBtn:  { alignSelf: 'center' },
    friendRow: { marginBottom: SPACE.xs },

    quickRow: { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.sm },
    quickBtn: { flexGrow: 1 },

    chemMain:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    chemDelta: { fontSize: FONT.size.h2, fontWeight: '800' },
    insight:   { marginTop: SPACE.xs },

    moreRow:   { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderTopWidth: HAIRLINE, borderTopColor: c.border },
    badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', margin: -SPACE.xs, borderRadius: RADIUS.md },
  });
}

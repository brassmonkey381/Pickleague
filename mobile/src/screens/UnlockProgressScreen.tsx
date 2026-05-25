import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';
import { computeBadgeProgress } from '../lib/unlockProgress';
import FlairName from '../components/FlairName';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'UnlockProgress'> };

type Progress = { text: string; pct: number; showBar: boolean };

// Minimal shape we need from a shop_items row tied to an unlock badge. Each
// row represents a name-style reward attached to a badge — when the user
// earns the badge, the trigger auto-grants the item, and the equipped style
// becomes available on their profile.
type NameStyleReward = {
  id: string;
  slug: string;
  name: string;
  category: 'list_name_style' | 'profile_name_style';
  unlock_badge_id: string;
};

function ProgressRow({ prog, c }: { prog: Progress; c: any }) {
  if (!prog.showBar) {
    return <Text style={{ fontSize: 11, color: c.textMuted, fontStyle: 'italic' }}>{prog.text}</Text>;
  }
  const filled = Math.max(prog.pct, 0.02);
  const empty  = 1 - filled;
  return (
    <>
      <View style={{ flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginBottom: 3, backgroundColor: c.border }}>
        <View style={{ backgroundColor: c.primary, flex: filled }} />
        {empty > 0 && <View style={{ backgroundColor: c.border, flex: empty }} />}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, fontWeight: '600' }}>{prog.text}</Text>
    </>
  );
}

// TODO: smoke-test in browser — verify the per-badge name-style reward row
// renders with the muted preview when locked and "✓ Unlocked" when earned,
// and that tapping it routes to the Shop.
export default function UnlockProgressScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [earnedBadgeNames, setEarnedBadgeNames] = useState<string[]>([]);
  const [badgeProgress, setBadgeProgress] = useState<Record<string, Progress>>({});
  // Map from badge name → the name-style shop item that unlocks with it.
  // We index by badge name to match the existing rendering pattern in this
  // file (avatars/tags/slots are also keyed by badge name).
  const [nameStyleRewards, setNameStyleRewards] = useState<Record<string, NameStyleReward>>({});
  // Preview name on the reward chip — same source of truth as ShopScreen.
  const [myFullName, setMyFullName] = useState<string>('You');

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const [profileRes, badgesRes, rewardsRes, allBadgesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('player_badges').select('badge:badges(name)').eq('user_id', user.id),
      // All unlock-gated name-style items. We resolve badge id→name from a
      // separate fetch (next call) rather than embedding via PostgREST,
      // because the FK's auto-generated constraint name isn't guaranteed
      // across environments and embedding can fail silently.
      supabase
        .from('shop_items')
        .select('id, slug, name, category, unlock_badge_id')
        .not('unlock_badge_id', 'is', null)
        .eq('is_active', true)
        .in('category', ['list_name_style', 'profile_name_style']),
      supabase.from('badges').select('id, name'),
    ]);

    const names = ((badgesRes.data ?? []) as any[])
      .map(b => b.badge?.name)
      .filter(Boolean) as string[];
    setEarnedBadgeNames(Array.from(new Set(names)));

    const badgeIdToName = new Map<string, string>(
      ((allBadgesRes.data ?? []) as { id: string; name: string }[]).map(b => [b.id, b.name]),
    );
    const rewardMap: Record<string, NameStyleReward> = {};
    for (const row of ((rewardsRes.data ?? []) as any[])) {
      const badgeName = row.unlock_badge_id ? badgeIdToName.get(row.unlock_badge_id) : undefined;
      if (!badgeName) continue; // Orphaned FK — skip rather than show a broken row.
      if (row.category !== 'list_name_style' && row.category !== 'profile_name_style') continue;
      rewardMap[badgeName] = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        category: row.category,
        unlock_badge_id: row.unlock_badge_id,
      };
    }
    setNameStyleRewards(rewardMap);

    const prof = profileRes.data;
    if (prof) {
      setMyFullName(prof.full_name ?? 'You');

      // Badge-progress math lives in lib/unlockProgress so Home cards and the
      // post-match nudge share the same source of truth. Map its
      // BadgeProgress shape onto this screen's { text, pct, showBar } Progress.
      const progressList = await computeBadgeProgress(user.id);
      const progressMap: Record<string, Progress> = {};
      for (const p of progressList) {
        progressMap[p.badge] = {
          text: p.perLeague ? 'Progress tracked per-league' : p.label,
          pct: p.pct,
          showBar: !p.perLeague,
        };
      }
      setBadgeProgress(progressMap);
    }
    setLoading(false);
  }

  // Renders the per-badge name-style reward row when the badge has a
  // corresponding entry in shop_items.unlock_badge_id. Tapping opens the
  // Shop where the locked row is visible (or the inventory if owned).
  function renderNameStyleReward(badgeName: string) {
    const reward = nameStyleRewards[badgeName];
    if (!reward) return null;
    const earned = earnedBadgeNames.includes(badgeName);
    return (
      <TouchableOpacity
        onPress={() => navigation.navigate('Shop')}
        activeOpacity={0.75}
        style={styles.rewardRow}
      >
        <View style={styles.rewardPreviewBox}>
          <FlairName
            name={myFullName}
            styleId={reward.slug}
            // Locked rewards preview in 'list' mode so animated styles
            // degrade to their base color — keeps the row calm even for
            // hero-tier styles like the Champion / Top Rated effects.
            mode="list"
            style={[styles.rewardPreviewText, !earned && styles.rewardPreviewTextMuted]}
            numberOfLines={1}
          />
        </View>
        <View style={styles.rewardTextCol}>
          <Text style={styles.rewardLabel} numberOfLines={1}>
            {earned ? '✓ Unlocked' : 'Reward'} · {reward.name}
          </Text>
          <Text style={styles.rewardSubLabel} numberOfLines={1}>
            Name style · {reward.category === 'profile_name_style' ? 'Profile' : 'List'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

  const lockedAvatars = AVATARS.filter(a => !!a.unlock);
  const lockedTags    = PLAY_TAGS.filter(t => !!t.unlock);
  const earnedAvatars = lockedAvatars.filter(a => earnedBadgeNames.includes(a.unlock!.badge)).length;
  const earnedTags    = lockedTags.filter(t => earnedBadgeNames.includes(t.unlock!.badge)).length;
  const earnedSlots   = TAG_SLOT_UNLOCKS.filter(u => earnedBadgeNames.includes(u.badge)).length;
  // Name-style rewards section — list every badge that has a name-style
  // reward, even those that don't gate an avatar/tag/slot (e.g. First Rally,
  // Tournament Champion). This way every progression-unlock style surfaces
  // in the progress UI.
  const nameStyleBadgeNames = Object.keys(nameStyleRewards);
  const earnedNameStyles = nameStyleBadgeNames.filter(n => earnedBadgeNames.includes(n)).length;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>🔓 Unlockable Rewards</Text>
      <Text style={styles.subtitle}>
        Earn the gating badge to unlock each cosmetic. Progress is tracked across your account.
      </Text>

      <View style={styles.summaryRow}>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedAvatars}/{lockedAvatars.length}</Text>
          <Text style={styles.summaryLabel}>Avatars</Text>
        </View>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedTags}/{lockedTags.length}</Text>
          <Text style={styles.summaryLabel}>Tags</Text>
        </View>
        <View style={styles.summaryPill}>
          <Text style={styles.summaryValue}>{earnedSlots}/{TAG_SLOT_UNLOCKS.length}</Text>
          <Text style={styles.summaryLabel}>Tag Slots</Text>
        </View>
        {nameStyleBadgeNames.length > 0 && (
          <View style={styles.summaryPill}>
            <Text style={styles.summaryValue}>{earnedNameStyles}/{nameStyleBadgeNames.length}</Text>
            <Text style={styles.summaryLabel}>Name Styles</Text>
          </View>
        )}
      </View>

      <Text style={styles.catLabel}>Special Avatars</Text>
      {lockedAvatars.map(av => {
        const earned = earnedBadgeNames.includes(av.unlock!.badge);
        const prog   = badgeProgress[av.unlock!.badge];
        return (
          <View key={av.id} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? av.bgColor : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>{av.emoji}</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{av.name} Avatar</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{av.unlock!.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{av.unlock!.description}</Text>}
              {renderNameStyleReward(av.unlock!.badge)}
            </View>
          </View>
        );
      })}

      <Text style={styles.catLabel}>Extra Tag Slots</Text>
      {TAG_SLOT_UNLOCKS.map(u => {
        const earned = earnedBadgeNames.includes(u.badge);
        const prog   = badgeProgress[u.badge];
        return (
          <View key={u.badge} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? '#e8f5e9' : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>🏷️</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>+1 Tag Slot</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{u.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{u.description}</Text>}
              {renderNameStyleReward(u.badge)}
            </View>
          </View>
        );
      })}

      <Text style={styles.catLabel}>Exclusive Tags</Text>
      {lockedTags.map(t => {
        const earned = earnedBadgeNames.includes(t.unlock!.badge);
        const prog   = badgeProgress[t.unlock!.badge];
        return (
          <View key={t.slug} style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: earned ? '#e8f5e9' : '#eeeeee' }]}>
              <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>🏷️</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{t.label}</Text>
                {earned
                  ? <Text style={styles.earned}>✓ Earned</Text>
                  : <Text style={styles.locked}>Locked</Text>}
              </View>
              <Text style={styles.badgeName}>{t.unlock!.badge}</Text>
              {!earned && prog
                ? <ProgressRow prog={prog} c={colors} />
                : <Text style={styles.req}>{t.unlock!.description}</Text>}
              {renderNameStyleReward(t.unlock!.badge)}
            </View>
          </View>
        );
      })}

      {/* Name-style rewards section — covers badges that don't gate an
          avatar/tag/slot but DO gate a name style (First Rally, Tournament
          Champion, etc.) so every progression-unlock style is discoverable. */}
      {(() => {
        const coveredBadges = new Set<string>([
          ...lockedAvatars.map(a => a.unlock!.badge),
          ...TAG_SLOT_UNLOCKS.map(u => u.badge),
          ...lockedTags.map(t => t.unlock!.badge),
        ]);
        const uncovered = nameStyleBadgeNames.filter(n => !coveredBadges.has(n));
        if (uncovered.length === 0) return null;
        return (
          <>
            <Text style={styles.catLabel}>Exclusive Name Styles</Text>
            {uncovered.map(badgeName => {
              const reward = nameStyleRewards[badgeName];
              const earned = earnedBadgeNames.includes(badgeName);
              const prog   = badgeProgress[badgeName];
              return (
                <View key={reward.slug} style={styles.row}>
                  <View style={[styles.iconCircle, { backgroundColor: earned ? '#fff7ed' : '#eeeeee' }]}>
                    <Text style={[styles.iconEmoji, !earned && { opacity: 0.4 }]}>🎨</Text>
                  </View>
                  <View style={styles.info}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name}>{reward.name}</Text>
                      {earned
                        ? <Text style={styles.earned}>✓ Earned</Text>
                        : <Text style={styles.locked}>Locked</Text>}
                    </View>
                    <Text style={styles.badgeName}>{badgeName}</Text>
                    {!earned && prog
                      ? <ProgressRow prog={prog} c={colors} />
                      : <Text style={styles.req}>Earn the {badgeName} badge to unlock.</Text>}
                    {renderNameStyleReward(badgeName)}
                  </View>
                </View>
              );
            })}
          </>
        );
      })()}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { padding: 20, backgroundColor: c.bg, flexGrow: 1 },
    title:        { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 4 },
    subtitle:     { fontSize: 13, color: c.textMuted, marginBottom: 16 },
    summaryRow:   { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
    summaryPill:  { flex: 1, minWidth: 70, backgroundColor: c.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    summaryValue: { fontSize: 18, fontWeight: '800', color: c.text },
    summaryLabel: { fontSize: 11, color: c.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.6 },
    catLabel:     { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 8, marginBottom: 8 },
    row:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10, backgroundColor: c.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.border },
    iconCircle:   { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
    iconEmoji:    { fontSize: 22 },
    info:         { flex: 1 },
    nameRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 },
    name:         { fontSize: 14, fontWeight: '700', color: c.text, flex: 1 },
    earned:       { fontSize: 11, color: c.primary, fontWeight: '700' },
    locked:       { fontSize: 11, color: c.textMuted, fontWeight: '600' },
    badgeName:    { fontSize: 11, color: c.primary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
    req:          { fontSize: 12, color: c.textMuted },
    rewardRow:    {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      marginTop: 6, paddingVertical: 6, paddingHorizontal: 8,
      backgroundColor: c.surfaceAlt, borderRadius: 8,
      borderWidth: 1, borderColor: c.border,
    },
    rewardPreviewBox:     { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.bg, minWidth: 60, maxWidth: 110, alignItems: 'center' },
    rewardPreviewText:    { fontSize: 12, fontWeight: '700' },
    rewardPreviewTextMuted:{ opacity: 0.55 },
    rewardTextCol:        { flex: 1 },
    rewardLabel:          { fontSize: 11, fontWeight: '700', color: c.text },
    rewardSubLabel:       { fontSize: 10, color: c.textMuted, marginTop: 1 },
  });
}

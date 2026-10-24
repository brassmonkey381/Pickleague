// Every cosmetic you can earn and how close you are (plan section 8, P6:
// compacted). Profile's status strip ("Next unlock: ... 3/5 >") lands here, so
// this screen now also carries what the old ~900px Unlockable Rewards card on
// Profile held: the Getting started checklist (collapsed) and the avatar / tag
// slot / tag rows.
//
// Layout: one summary strip, then a SectionHeader + grouped Panel of 64px rows
// per category. Each row: glyph tile · name + Earned/Locked chip · gating badge
// · a thin foundation ProgressBar (or the requirement) · the name-style reward
// that unlocks with the same badge, if any (tap -> Shop).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Panel, SectionHeader, CollapsibleSection, Badge, ErrorState } from '@just-messin-around/expo-foundation/ui';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile, RootStackParamList } from '../types';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';
import { computeBadgeProgress } from '../lib/unlockProgress';
import { trackSectionToggle } from '../lib/analytics';
import FlairName from '../components/FlairName';
import FtueChecklistCard from '../components/FtueChecklistCard';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';

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

type Colors = ReturnType<typeof useTheme>['colors'];

// TODO: smoke-test in browser — verify the per-badge name-style reward row
// renders with the muted preview when locked and "✓ Unlocked" when earned,
// and that tapping it routes to the Shop.
export default function UnlockProgressScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const t = textStyles(colors);
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [earnedBadgeNames, setEarnedBadgeNames] = useState<string[]>([]);
  const [badgeProgress, setBadgeProgress] = useState<Record<string, Progress>>({});
  // Map from badge name → the name-style shop item that unlocks with it.
  // We index by badge name to match the existing rendering pattern in this
  // file (avatars/tags/slots are also keyed by badge name).
  const [nameStyleRewards, setNameStyleRewards] = useState<Record<string, NameStyleReward>>({});
  // Preview name on the reward chip — same source of truth as ShopScreen.
  const [myFullName, setMyFullName] = useState<string>('You');
  // The Getting started checklist reads profile fields to decide what's done.
  const [profile, setProfile] = useState<Profile | null>(null);
  const refresh = useRefresh(load);

  useEffect(() => { load(); }, []);

  // Back from Profile (Getting started's "Set up your profile" step pushes it)
  // or the Shop: re-read, so a profile saved there flips the step to its Claim
  // button, and new badges show, without a pull-to-refresh. The checklist's own
  // focus reload only re-reads grants and memberships; it takes the profile
  // from here. The mount effect covers the first focus; load() never sets
  // `loading` back, so the skeleton doesn't flash, and a failed re-read keeps
  // what is shown (the error state needs an empty screen).
  const focusCount = useRef(0);
  useFocusEffect(useCallback(() => {
    focusCount.current += 1;
    if (focusCount.current > 1) void load();
    // load() only calls setters and module clients, so the first closure stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  async function load() {
    try {
      await loadInner();
      setLoadError(null);
    } catch (e) {
      // Every badge showing as un-earned is a bad way to say "network error".
      setLoadError(friendlySbMessage(e, "Couldn't load your unlock progress."));
    } finally {
      // Always: the old happy-path-only setLoading(false) stranded the skeleton.
      setLoading(false);
    }
  }

  async function loadInner() {
    // LOCAL session read (getUser() is a network call that fails offline).
    const uid = await currentUserId(supabase);
    if (!uid) return;

    const [profileRes, badgesRes, rewardsRes, allBadgesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).single(),
      supabase.from('player_badges').select('badge:badges(name)').eq('user_id', uid),
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

    // A discarded error here rendered as "you've earned nothing" — fail loud
    // so load()'s catch can offer a retry instead.
    const firstError = [profileRes, badgesRes, rewardsRes, allBadgesRes]
      .map(r => (r as { error?: unknown }).error)
      .find(Boolean);
    if (firstError) throw firstError;

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
      setProfile(prof as Profile);
      setMyFullName(prof.full_name ?? 'You');

      // Badge-progress math lives in lib/unlockProgress so Home cards and the
      // post-match nudge share the same source of truth. Map its
      // BadgeProgress shape onto this screen's { text, pct, showBar } Progress.
      const progressList = await computeBadgeProgress(uid);
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
  }

  // The name-style reward that unlocks with a badge, as a 44px line inside
  // its row. Tapping opens the Shop, where the locked row is visible (or the
  // inventory if owned).
  function renderNameStyleReward(badgeName: string) {
    const reward = nameStyleRewards[badgeName];
    if (!reward) return null;
    const earned = earnedBadgeNames.includes(badgeName);
    return (
      <TouchableOpacity
        onPress={() => navigation.navigate('Shop')}
        activeOpacity={0.75}
        style={styles.rewardRow}
        accessibilityRole="button"
        accessibilityLabel={`${earned ? 'Unlocked' : 'Reward'}: ${reward.name} name style. Open the Shop`}
      >
        <View style={styles.rewardPreviewBox}>
          <FlairName
            name={myFullName}
            styleId={reward.slug}
            // Locked rewards preview in 'list' mode so animated styles
            // degrade to their base color — keeps the row calm even for
            // hero-tier styles like the Champion / Top Rated effects.
            mode="list"
            style={[styles.rewardPreviewText, !earned && styles.muted]}
            numberOfLines={1}
          />
        </View>
        <View style={[styles.flexText, styles.inlineRow]}>
          {earned ? <Icon name="check-mark" size={12} color={colors.success} /> : null}
          <Text style={[t.meta, styles.flexShrink]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {earned ? 'Unlocked' : 'Reward'} · {reward.name} · {reward.category === 'profile_name_style' ? 'Profile' : 'List'} style
          </Text>
        </View>
        <Icon name="chevron-right" size={16} color={colors.textMuted} />
      </TouchableOpacity>
    );
  }

  /** One unlock: glyph · name + status chip · gating badge · progress or
   *  requirement · its name-style reward. A render function, not a nested
   *  component, so rows aren't remounted (and FlairName previews restarted)
   *  on every render. The tile shows the avatar's own emoji (`emoji`: the
   *  picture you unlock) or a glyph (`iconName` in `glyphColor`; a locked
   *  row draws it in the muted token rather than at low opacity). */
  function renderUnlockRow({
    key, emoji, iconName, glyphColor, glyphBg, name, badgeName, requirement, lastRow, onPress,
  }: {
    key: string | number; emoji?: string; iconName?: IconName; glyphColor?: string; glyphBg: string;
    name: string; badgeName: string; requirement: string; lastRow: boolean; onPress?: () => void;
  }) {
    const earned = earnedBadgeNames.includes(badgeName);
    const prog = badgeProgress[badgeName];
    const body = (
      <>
        <View style={[styles.tile, { backgroundColor: earned ? glyphBg : colors.surfaceAlt }]}>
          {iconName ? (
            <Icon name={iconName} size={22} color={earned ? glyphColor ?? colors.primary : colors.textMuted} />
          ) : (
            <Text style={[styles.tileGlyph, !earned && styles.muted]}>{emoji}</Text>
          )}
        </View>
        <View style={styles.flexText}>
          <View style={styles.nameLine}>
            <Text style={[t.title, styles.flexShrink]} numberOfLines={1}>{name}</Text>
            <Badge
              label={earned ? 'Earned' : 'Locked'}
              tone={earned ? 'success' : 'neutral'}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            />
          </View>
          <Text style={[t.meta, { color: colors.primary }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {badgeName}
          </Text>
          {!earned && prog?.showBar ? (
            <ProgressBar
              progress={prog.pct}
              minFill={0.02}
              height={4}
              trackColor={colors.border}
              caption={prog.text}
              containerStyle={styles.progress}
              accessibilityLabel={`${name} progress`}
              accessibilityValueText={prog.text}
            />
          ) : !earned && prog ? (
            <Text style={[t.meta, styles.italic]} numberOfLines={1}>{prog.text}</Text>
          ) : (
            <Text style={t.sub} numberOfLines={2}>{requirement}</Text>
          )}
          {renderNameStyleReward(badgeName)}
        </View>
      </>
    );
    const rowStyle = [styles.row, lastRow && styles.rowLast];
    return onPress ? (
      <TouchableOpacity key={key} style={rowStyle} activeOpacity={0.75} onPress={onPress} accessibilityRole="button">
        {body}
      </TouchableOpacity>
    ) : (
      <View key={key} style={rowStyle}>{body}</View>
    );
  }

  if (loading) return <View style={styles.screen}><SkeletonList rows={6} variant="row" /></View>;

  if (loadError && earnedBadgeNames.length === 0) {
    return (
      <View style={styles.screen}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load your progress. ${loadError}`}
          onRetry={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  const lockedAvatars = AVATARS.filter(a => !!a.unlock);
  const lockedTags    = PLAY_TAGS.filter(tg => !!tg.unlock);
  const earnedAvatars = lockedAvatars.filter(a => earnedBadgeNames.includes(a.unlock!.badge)).length;
  const earnedTags    = lockedTags.filter(tg => earnedBadgeNames.includes(tg.unlock!.badge)).length;
  const earnedSlots   = TAG_SLOT_UNLOCKS.filter(u => earnedBadgeNames.includes(u.badge)).length;
  // Name-style rewards section — list every badge that has a name-style
  // reward, even those that don't gate an avatar/tag/slot (e.g. First Rally,
  // Tournament Champion). This way every progression-unlock style surfaces
  // in the progress UI.
  const nameStyleBadgeNames = Object.keys(nameStyleRewards);
  const earnedNameStyles = nameStyleBadgeNames.filter(n => earnedBadgeNames.includes(n)).length;
  const coveredBadges = new Set<string>([
    ...lockedAvatars.map(a => a.unlock!.badge),
    ...TAG_SLOT_UNLOCKS.map(u => u.badge),
    ...lockedTags.map(tg => tg.unlock!.badge),
  ]);
  const uncoveredStyles = nameStyleBadgeNames.filter(n => !coveredBadges.has(n));

  const summary = [
    { label: 'Avatars',     value: `${earnedAvatars}/${lockedAvatars.length}` },
    { label: 'Tags',        value: `${earnedTags}/${lockedTags.length}` },
    { label: 'Tag slots',   value: `${earnedSlots}/${TAG_SLOT_UNLOCKS.length}` },
    ...(nameStyleBadgeNames.length > 0
      ? [{ label: 'Name styles', value: `${earnedNameStyles}/${nameStyleBadgeNames.length}` }]
      : []),
  ];

  return (
    <ScrollView contentContainerStyle={styles.container} refreshControl={<AppRefreshControl {...refresh} />}>
      <Text style={[t.sub, styles.intro]} numberOfLines={2}>
        Earn the gating badge to unlock each cosmetic. Progress is tracked across your account.
      </Text>

      <Panel padded={false} style={styles.block}>
        <View style={styles.summaryRow}>
          {summary.map((s, i) => (
            <View
              key={s.label}
              style={[styles.summaryCell, i > 0 && styles.summaryDivider]}
              accessible
              accessibilityLabel={`${s.label}: ${s.value.replace('/', ' of ')}`}
            >
              <Text style={t.title}>{s.value}</Text>
              <Text style={t.fieldLabel} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{s.label}</Text>
            </View>
          ))}
        </View>
      </Panel>

      {/* The FTUE checklist (and its Claim buttons) used to sit in Profile's
          rewards card; it lives here now, collapsed. Home's Get started still
          shows it while anything is unclaimed. */}
      <CollapsibleSection
        compact
        title="Getting started"
        onToggle={open => trackSectionToggle({ screen: 'UnlockProgress', section: 'getting_started', open })}
      >
        <FtueChecklistCard
          profile={profile}
          navigation={navigation}
          alwaysShow
          embedded
          onClaimed={bal => setProfile(p => (p ? { ...p, pickles: bal } : p))}
        />
      </CollapsibleSection>

      <View style={styles.block}>
        <SectionHeader title="Special avatars" count={`${earnedAvatars}/${lockedAvatars.length}`} />
        <Panel padded={false}>
          {lockedAvatars.map((av, i) => (
            renderUnlockRow({
              key: av.id,
              emoji: av.emoji,
              glyphBg: av.bgColor,
              name: `${av.name} Avatar`,
              badgeName: av.unlock!.badge,
              requirement: av.unlock!.description,
              lastRow: i === lockedAvatars.length - 1,
            })
          ))}
        </Panel>
      </View>

      <View style={styles.block}>
        <SectionHeader title="Extra tag slots" count={`${earnedSlots}/${TAG_SLOT_UNLOCKS.length}`} />
        <Panel padded={false}>
          {TAG_SLOT_UNLOCKS.map((u, i) => (
            // Tag slots are used on your profile (the tag picker), so tapping
            // routes there — not the Shop. (A name-style reward line inside,
            // if any, keeps its own tap → Shop.)
            renderUnlockRow({
              key: u.badge,
              iconName: 'tag',
              glyphBg: colors.primaryLight,
              name: '+1 Tag Slot',
              badgeName: u.badge,
              requirement: u.description,
              lastRow: i === TAG_SLOT_UNLOCKS.length - 1,
              onPress: () => navigation.navigate('Profile', {}),
            })
          ))}
        </Panel>
      </View>

      <View style={styles.block}>
        <SectionHeader title="Exclusive tags" count={`${earnedTags}/${lockedTags.length}`} />
        <Panel padded={false}>
          {lockedTags.map((tg, i) => (
            renderUnlockRow({
              key: tg.slug,
              iconName: 'tag',
              glyphBg: colors.primaryLight,
              name: tg.label,
              badgeName: tg.unlock!.badge,
              requirement: tg.unlock!.description,
              lastRow: i === lockedTags.length - 1,
            })
          ))}
        </Panel>
      </View>

      {/* Name-style rewards section — covers badges that don't gate an
          avatar/tag/slot but DO gate a name style (First Rally, Tournament
          Champion, etc.) so every progression-unlock style is discoverable. */}
      {uncoveredStyles.length > 0 && (
        <View style={styles.block}>
          <SectionHeader
            title="Exclusive name styles"
            count={`${uncoveredStyles.filter(n => earnedBadgeNames.includes(n)).length}/${uncoveredStyles.length}`}
          />
          <Panel padded={false}>
            {uncoveredStyles.map((badgeName, i) => {
              const reward = nameStyleRewards[badgeName];
              return (
                renderUnlockRow({
                  key: reward.slug,
                  iconName: 'palette',
                  glyphColor: colors.warning,
                  glyphBg: colors.warningLight,
                  name: reward.name,
                  badgeName: badgeName,
                  requirement: `Earn the ${badgeName} badge to unlock.`,
                  lastRow: i === uncoveredStyles.length - 1,
                })
              );
            })}
          </Panel>
        </View>
      )}
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    screen:     { flex: 1, backgroundColor: c.bg },
    container:  { padding: SPACE.lg, paddingBottom: SPACE.xl, backgroundColor: c.bg, flexGrow: 1 },
    inlineRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    intro:      { marginBottom: SPACE.md },
    block:      { marginBottom: SPACE.md },
    flexText:   { flex: 1, minWidth: 0 },
    flexShrink: { flexShrink: 1 },
    muted:      { opacity: 0.45 },
    italic:     { fontStyle: 'italic', marginTop: SPACE.xxs },

    summaryRow:     { flexDirection: 'row' },
    summaryCell:    { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACE.sm, gap: SPACE.xxs },
    summaryDivider: { borderLeftWidth: HAIRLINE, borderLeftColor: c.border },

    // A Row inside the category Panel: 64 min (title + badge + progress), a
    // hairline divider between rows, none under the last.
    row: {
      flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md,
      minHeight: 64, paddingVertical: SPACE.sm + SPACE.xxs, paddingHorizontal: SPACE.md,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    rowLast:   { borderBottomWidth: 0 },
    tile:      { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
    tileGlyph: { fontSize: FONT.size.h2 },
    nameLine:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    progress:  { marginTop: SPACE.xs },

    rewardRow: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      minHeight: 44, marginTop: SPACE.xs, paddingHorizontal: SPACE.sm,
      backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md,
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    rewardPreviewBox:  { paddingVertical: SPACE.xxs, paddingHorizontal: SPACE.xs + SPACE.xxs, borderRadius: RADIUS.sm, backgroundColor: c.bg, minWidth: 60, maxWidth: 110, alignItems: 'center' },
    rewardPreviewText: { fontSize: FONT.size.sm, fontWeight: FONT.weight.bold },
  });
}

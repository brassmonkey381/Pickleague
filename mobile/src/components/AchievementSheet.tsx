// The detail sheet for one Pickleague achievement: the foundation
// AchievementDetailSheet (medal, name, how to earn, date or progress) plus our
// extras in its renderExtra slot and one action button.
//
// Extras: every earned instance (league name for league badges, the match
// link when the badge row has a source match), what the badge unlocks on the
// profile, and a "hidden from your profile" note. Action (own page only):
// Claim / Start for a Getting started quest, else Hide from / Show on profile
// for anything earned (the toggle the old Profile badge tiles had).
import React, { useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  AchievementDetailSheet,
  longDateFormatter,
  type AchievementDetailAction,
  type AchievementGroup,
} from '@just-messin-around/expo-foundation/achievements';
import { TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import {
  awardLines,
  isHiddenFromProfile,
  type PickleagueAchievement,
  type PickleagueAchievementMeta,
} from '../lib/achievements';
import type { FtueChecklist } from './FtueChecklistCard';

/** Instances listed before "+N more". */
const MAX_LINES = 5;

type Nav = { navigate: (...args: any[]) => void };

type Props = {
  achievement: PickleagueAchievement | null;
  group: AchievementGroup | null;
  own: boolean;
  /** Whose achievements (for the match link's history). */
  userId: string | null;
  navigation: Nav;
  onClose: () => void;
  onSetHidden?: (a: PickleagueAchievement, hidden: boolean) => void;
  /** Own page: the Getting started quests (claim + where to go). */
  ftue?: FtueChecklist | null;
  /** After a claim lands. */
  onClaimed?: () => void;
};

export default function AchievementSheet({
  achievement, group, own, userId, navigation, onClose, onSetHidden, ftue, onClaimed,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  // Navigation waits for the sheet to finish closing (a modal left over the
  // next screen on native).
  const pendingNav = useRef<(() => void) | null>(null);
  const closeThen = (fn: () => void) => { pendingNav.current = fn; onClose(); };

  function renderExtra(a: PickleagueAchievement) {
    const meta = a.meta;
    if (!meta) return null;
    const lines = awardLines(meta.awards, longDateFormatter);
    const earned = !!a.earnedAt;
    const showInstances = meta.kind === 'badge' && (lines.length > 1 || meta.perLeague || lines.some(l => l.matchId || l.context));
    const hiddenNote = own && earned && isHiddenFromProfile(meta);
    const parts: React.ReactNode[] = [];

    if (showInstances && lines.length > 0) {
      parts.push(
        <View key="inst" style={[styles.box, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}>
          {lines.length > 1 ? (
            <Text style={t.fieldLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Earned {lines.length} times</Text>
          ) : null}
          {lines.slice(0, MAX_LINES).map(l => (
            <View key={l.id} style={styles.line}>
              <Icon name={meta.perLeague ? 'pickleball' : 'calendar'} size={14} color={c.textMuted} />
              <View style={styles.flex}>
                <Text style={t.sub} numberOfLines={1}>{l.text}</Text>
                {l.context ? <Text style={t.meta} numberOfLines={2}>{l.context}</Text> : null}
              </View>
              {l.matchId && userId ? (
                <TextLink
                  label="Match"
                  accessibilityLabel="View the match that earned it"
                  onPress={() => closeThen(() => navigation.navigate('MatchHistory', {
                    userId, title: 'Match history', highlightMatchId: l.matchId!,
                  }))}
                />
              ) : null}
            </View>
          ))}
          {lines.length > MAX_LINES ? (
            <Text style={t.meta}>+{lines.length - MAX_LINES} more</Text>
          ) : null}
        </View>,
      );
    } else if (meta.kind === 'badge' && meta.perLeague && !earned) {
      parts.push(
        <Text key="league" style={[t.meta, styles.center]}>Earned in league play. Each league awards its own.</Text>,
      );
    }

    if (meta.kind === 'collectible' && meta.collectible) {
      parts.push(
        <Text key="col" style={[t.meta, styles.center]}>{meta.collectible.note ?? 'From the Pickle Shop'}</Text>,
      );
    }

    if (meta.rewards.length > 0) {
      parts.push(
        <View key="rewards" style={[styles.box, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}>
          <Text style={t.fieldLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{earned ? 'Unlocked' : 'Unlocks'}</Text>
          {meta.rewards.map(r => (
            <View key={r} style={styles.line}>
              <Icon name={earned ? 'check-mark' : 'lock'} size={14} color={earned ? c.success : c.textMuted} />
              <Text style={[t.sub, styles.flex]} numberOfLines={1}>{r}</Text>
            </View>
          ))}
          {own ? (
            <TextLink label="Open the Shop" onPress={() => closeThen(() => navigation.navigate('Shop'))} />
          ) : null}
        </View>,
      );
    }

    if (hiddenNote) {
      parts.push(
        <View key="hidden" style={[styles.line, styles.centerRow]}>
          <Icon name="eye-off" size={14} color={c.textMuted} />
          <Text style={t.meta}>Hidden from your public profile</Text>
        </View>,
      );
    }

    return parts.length ? <View style={styles.extra}>{parts}</View> : null;
  }

  function action(a: PickleagueAchievement): AchievementDetailAction | null {
    const meta = a.meta;
    if (!own || !meta) return null;
    if (meta.kind === 'ftue' && ftue) {
      const step = ftue.steps.find(s => s.id === meta.ftueStep);
      if (!step || step.claimed || a.earnedAt) return null;
      if (meta.claimable || step.canClaim) {
        return {
          label: step.busy ? 'Claiming...' : `Claim +${(meta.ftueReward ?? step.reward).toLocaleString('en-US')} pickles`,
          iconName: 'pickle',
          onPress: () => { void ftue.claim(step.id).then(() => onClaimed?.()); },
        };
      }
      return { label: 'Start', iconName: 'arrow-right', onPress: () => closeThen(step.navTo) };
    }
    if (a.earnedAt && (meta.kind === 'collectible' || (meta.kind === 'badge' && meta.awards.length > 0)) && onSetHidden) {
      const hidden = isHiddenFromProfile(meta);
      return {
        label: hidden ? 'Show on profile' : 'Hide from profile',
        iconName: hidden ? 'eye' : 'eye-off',
        variant: 'outline',
        onPress: () => onSetHidden(a, !hidden),
      };
    }
    return null;
  }

  return (
    <AchievementDetailSheet<PickleagueAchievementMeta>
      achievement={achievement}
      group={group}
      onClose={onClose}
      onDismissed={() => {
        const fn = pendingNav.current;
        pendingNav.current = null;
        fn?.();
      }}
      renderExtra={renderExtra}
      action={action}
    />
  );
}

const styles = StyleSheet.create({
  extra: { gap: SPACE.md },
  box: { gap: SPACE.xs, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 28 },
  centerRow: { justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  center: { textAlign: 'center' },
});

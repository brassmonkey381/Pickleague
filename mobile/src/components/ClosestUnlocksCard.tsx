// Home's unlock teaser: ONE 44px row with the nearest badge still to earn on
// the foundation ProgressBar (layout 'inline'), tapping through to
// Achievements. Replaces the old "Closest unlocks" card with its hand-rolled
// bar (plan section 3: "Unlock teaser ... 44, built on the foundation
// ProgressBar"). Opens Achievements on that badge (its detail sheet).
// Home renders it only when Get started is hidden; it hides
// itself when nothing account-wide is left to earn or the progress can't load.
import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../lib/ThemeContext';
import { computeBadgeProgress, BadgeProgress } from '../lib/unlockProgress';

type Props = {
  userId: string | null;
  // Only navigates, so any screen's nav prop fits.
  navigation: { navigate: (screen: 'Achievements', params?: { focus?: string }) => void };
  /** Analytics hook (home.tap). */
  onPressed?: () => void;
};

export default function ClosestUnlocksCard({ userId, navigation, onPressed }: Props) {
  const { colors: c } = useTheme();
  const [next, setNext] = useState<BadgeProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setNext(null); return; }
    (async () => {
      try {
        const all = await computeBadgeProgress(userId);
        if (cancelled) return;
        // The nearest not-yet-earned badge with a real global threshold. The
        // lib already sorts closest-first.
        setNext(all.find(p => !p.earned && !p.perLeague) ?? null);
      } catch {
        // computeBadgeProgress throws rather than reporting zero progress. The
        // teaser stays hidden instead of claiming the user has made none.
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (!next) return null;
  const value = `${Math.min(next.current, next.target)}/${next.target}`;

  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
      activeOpacity={0.85}
      onPress={() => { onPressed?.(); navigation.navigate('Achievements', { focus: next.badge }); }}
      accessibilityRole="button"
      accessibilityLabel={`Next unlock: ${next.badge}, ${next.current} of ${next.target}. Open achievements`}
    >
      <Icon name="lock-open" size={16} color={c.primary} />
      <View style={styles.bar}>
        <ProgressBar
          progress={next.pct}
          layout="inline"
          label={`Next unlock: ${next.badge}`}
          valueText={value}
          accessibilityValueText={`${next.current} of ${next.target}`}
          height={SPACE.sm}
          minFill={0.02}
        />
      </View>
      <Icon name="chevron-right" size={16} color={c.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
  },
  bar: { flex: 1, minWidth: 0 },
});

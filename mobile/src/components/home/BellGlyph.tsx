// The Home bell's glyph WITH its badge, for AppTopBar's `icon` slot (plan P3).
//
// Why not AppTopBar's own `badge`: the bell's NUMBER is what needs you (votes,
// RSVPs, invites, requests, scores to confirm), and its screen-reader label
// must say so ("Notifications, 2 need you"). AppTopBar composes the label
// itself from `a11yLabel` + the count ("Notifications, 2"), with no way to
// phrase the count. So Home passes no `badge`, writes the whole label, and
// draws the same badge here with the foundation's own badgeDisplay rule (0
// hides, 9+ cap, a dot) and the same metrics as AppTopBar's badge.
// FOUNDATION-TODO: AppTopBarAction `badgeA11yLabel?: (count: number) => string`
// (or a count phrase), then delete this file and pass `badge` again.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { badgeDisplay, type TopBarBadge } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

/** The bell's label: "Notifications, 2 need you" / "Notifications, new". */
export function bellA11yLabel(needYou: number, unreadLive: number): string {
  if (needYou > 0) return `Notifications, ${needYou} need${needYou === 1 ? 's' : ''} you`;
  if (unreadLive > 0) return 'Notifications, new';
  return 'Notifications';
}

/** Count when something needs you, else a dot for plain unread, else nothing. */
export function bellBadge(needYou: number, unreadLive: number): TopBarBadge | undefined {
  if (needYou > 0) return needYou;
  if (unreadLive > 0) return 'dot';
  return undefined;
}

export default function BellGlyph({ badge }: { badge: TopBarBadge | undefined }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const d = badgeDisplay(badge);
  return (
    <View style={styles.glyph}>
      <Icon name="bell" size={20} color={c.text} />
      {d.kind === 'count' ? (
        <View style={[styles.badge, { backgroundColor: c.danger }]}>
          <Text style={[t.badge, styles.badgeText]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {d.text}
          </Text>
        </View>
      ) : d.kind === 'dot' ? (
        <View style={[styles.dot, { backgroundColor: c.danger }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  // AppTopBar's badge metrics (16 round, nudged up and right of the glyph).
  // Decorations never take the tap (style.pointerEvents: RNW warns on the prop).
  badge: {
    position: 'absolute',
    pointerEvents: 'none',
    top: -SPACE.xs,
    right: -SPACE.sm,
    minWidth: SPACE.lg,
    minHeight: SPACE.lg,
    paddingHorizontal: SPACE.xs,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { letterSpacing: 0 },
  dot: {
    position: 'absolute',
    pointerEvents: 'none',
    top: -SPACE.xxs,
    right: -SPACE.xxs,
    width: SPACE.sm,
    height: SPACE.sm,
    borderRadius: RADIUS.pill,
  },
});

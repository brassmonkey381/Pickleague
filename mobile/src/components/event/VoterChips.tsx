// Who answered, as small first-name chips (avatar emoji + first name), wrapping.
// Read-only; capped so a 30-person league doesn't turn one slot into a wall:
// the rest collapse into a tappable "Show N more" that expands the list in
// place (a capped list always says how to see the rest; nothing else on the
// event screen names a slot's voters). Renders nothing for an empty list.
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, type GestureResponderEvent } from 'react-native';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import type { SlotVoter } from '../../types';

const DEFAULT_MAX = 12;

export function firstName(fullName: string | null | undefined): string {
  return (fullName ?? '').trim().split(' ')[0] || 'Player';
}

export default function VoterChips({ voters, max = DEFAULT_MAX }: { voters: SlotVoter[]; max?: number }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [expanded, setExpanded] = useState(false);
  if (voters.length === 0) return null;
  const shown = expanded ? voters : voters.slice(0, max);
  const more = voters.length - shown.length;
  return (
    <View style={S.wrap}>
      {shown.map(v => {
        const first = firstName(v.full_name);
        return (
          <View key={v.id} style={S.chip}>
            <View style={[S.avatar, v.avatar_bg_color ? { backgroundColor: v.avatar_bg_color } : null]}>
              <Text style={[t.caption, S.avatarText]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {v.avatar_emoji ?? first[0]?.toUpperCase() ?? '?'}
              </Text>
            </View>
            <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{first}</Text>
          </View>
        );
      })}
      {more > 0 ? (
        <Pressable
          // The chips sit inside the slot card's tap-to-vote and the
          // Can't-make-it toggle: the inner Pressable wins the press on native,
          // and stopPropagation keeps a web click from also casting a vote.
          onPress={(e: GestureResponderEvent) => { e.stopPropagation?.(); setExpanded(true); }}
          accessibilityRole="button"
          accessibilityLabel={`Show ${more} more`}
          // A real 44 box: react-native-web ignores hitSlop.
          style={S.moreBox}
        >
          <View style={S.chip}>
            <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Show {more} more</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: SPACE.xs },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, maxWidth: 120,
      backgroundColor: c.surfaceAlt, borderRadius: RADIUS.pill, borderWidth: HAIRLINE, borderColor: c.border,
      paddingVertical: SPACE.xxs, paddingHorizontal: SPACE.sm,
    },
    avatar: {
      width: 18, height: 18, borderRadius: RADIUS.pill,
      alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryLight,
    },
    avatarText: { color: c.primary, fontWeight: FONT.weight.bold },
    moreBox: { minHeight: 44, justifyContent: 'center' },
  });
}

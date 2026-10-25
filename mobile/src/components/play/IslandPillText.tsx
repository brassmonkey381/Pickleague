// The floating island's pill text ("CHECKED IN · Lakeside · until 7:42 PM",
// "Open play · 12:04 · Lakeside") with the label kept whole and only the
// court part cut short. The foundation's object pill ({ primary, secondary })
// lets both texts shrink alike, so a long court name crushed the label to
// "CHE…" (the court page's island, 2026-10-24). LiveStatusIsland takes any
// node as its pill; this is the same markup with the label fixed.
//
// FOUNDATION FOLLOW-UP: in expo-foundation src/ui/island/LiveStatusIsland.tsx
// give the primary text `flexShrink: 0` (only `secondary` shrinks), or add a
// `pill.keepPrimary` option; then CheckinHost and PlayIsland pass the object
// again and this file goes.
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export default function IslandPillText({ primary, secondary }: { primary: string; secondary?: string | null }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const color = { color: c.textInverse };
  return (
    <>
      {/* Alone ("AT <A LONG COURT NAME>?") it may still be cut; beside a secondary it stays whole. */}
      <Text style={[t.title, secondary ? S.keep : S.shrink, color]} numberOfLines={1}>
        {primary}
      </Text>
      {secondary ? (
        <>
          <Text style={[t.title, S.sep, color]}>·</Text>
          <Text style={[t.title, S.shrink, color]} numberOfLines={1}>
            {secondary}
          </Text>
        </>
      ) : null}
    </>
  );
}

const S = StyleSheet.create({
  // Tabular figures so a ticking timer does not jitter (as the foundation's).
  keep: { flexShrink: 0, fontVariant: ['tabular-nums'] },
  shrink: { flexShrink: 1, minWidth: 0, fontVariant: ['tabular-nums'] },
  sep: { opacity: 0.55 },
});

// A Court Pass reward's picture at `size` px square: the kit RewardTrack's
// renderRewardArt. Draws with the same art the rest of the app uses
// (lib/courtArt picks which): the pickle glyph and +n for a pickles tier, the
// avatar circle as HomeGreeting draws it, the name in its style through
// FlairName, and decor through the kit's RoomArt (the SVG My Place draws), or
// a dashed placeholder with the item's icon while its art is loading.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Icon, EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { RoomArt } from '@just-messin-around/expo-foundation/room';
import { createArtResolver } from '@just-messin-around/expo-foundation/room/art';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { courtArtFor, COURT_ART, type CourtArtInput } from '../../lib/courtArt';
import FlairName from '../FlairName';

type Props = {
  reward: CourtArtInput;
  size: number;
  /** The decor item's SVG (data/myPlace useItemArt), null while it loads. */
  svg?: string | null;
  /** The name a name style is shown on (the player's first name). */
  name?: string | null;
};

// Server art only (no bundled art): one resolver keeps its sanitize cache across cells.
const resolveArt = createArtResolver();

export default function CourtRewardArt({ reward, size, svg, name }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const spec = courtArtFor(reward);

  if (spec.kind === 'pickles') {
    return (
      <View style={[styles.center, { width: size, height: size }]}>
        <Icon name="pickle" size={Math.round(size * 0.5)} color={c.primary} />
        <Text style={[t.badge, { color: c.primary }]} maxFontSizeMultiplier={1.3}>
          +{spec.amount}
        </Text>
      </View>
    );
  }

  if (spec.kind === 'avatar') {
    const d = Math.round(size * 0.8);
    return (
      <View style={[styles.center, { width: size, height: size }]}>
        <View style={[styles.center, { width: d, height: d, borderRadius: d / 2, backgroundColor: spec.bgColor }]}>
          <Text style={{ fontSize: Math.round(d * 0.56), lineHeight: Math.round(d * 0.7) }} maxFontSizeMultiplier={1}>
            {spec.emoji}
          </Text>
        </View>
      </View>
    );
  }

  if (spec.kind === 'name_style') {
    return (
      <View style={[styles.center, { width: size, height: size, paddingHorizontal: 2 }]}>
        <FlairName
          name={name?.trim() || 'Your name'}
          styleId={spec.slug}
          mode={spec.mode === 'list' ? 'list' : 'hero'}
          style={[t.title, { fontSize: Math.max(11, Math.round(size * 0.2)) }]}
          numberOfLines={1}
        />
      </View>
    );
  }

  if (spec.kind === 'decor') {
    // Fit the art's aspect inside 90% of the square.
    const box = size * 0.9;
    const ar = spec.aspect ?? 1;
    const w = ar >= 1 ? box : box * ar;
    const h = ar >= 1 ? box / ar : box;
    if (!svg) {
      const icon = reward.item?.icon ?? (reward.itemKey ? COURT_ART[reward.itemKey]?.icon : null) ?? '✨';
      return (
        <View style={[styles.center, { width: size, height: size }]}>
          <View style={[styles.center, styles.placeholder, { width: w, height: h, borderColor: c.textMuted }]}>
            <EmojiGlyph emoji={icon} size={Math.round(Math.min(w, h) * 0.45)} color={c.text} />
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.center, { width: size, height: size }]}>
        <RoomArt
          item={{ id: spec.itemId, name: spec.itemId, fits: spec.fits, cost: 0, svg, aspect: spec.aspect }}
          resolveArt={resolveArt}
          width={w}
          height={h}
        />
      </View>
    );
  }

  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <Icon name="gift" size={Math.round(size * 0.5)} color={c.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  placeholder: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 6 },
});

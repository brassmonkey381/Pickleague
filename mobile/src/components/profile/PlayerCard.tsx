// Your own Profile as a collectible player card (the redesign's option E, the
// user's pick 2026-11-04):
//
//   ┌ textured strip ── SINCE MAR 2021 ✎ ──────────────── (share) ┐
//   │ [avatar]  Brian Stockman                                  ✎ │
//   │           @brian, Dink first                                │
//   │ [3.5 player] [Mornings] [+2]                                │
//   ├┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┤
//   │     142      │      18/42      │     52,791                 │
//   │   MATCHES    │     BADGES      │     PICKLES                │
//   └─────────────────────────────────────────────────────────────┘
//     (the look's edge colour, offset behind the card)
//
// "Since" is when the player started playing pickleball (PlayingSinceSheet),
// not when they joined. Another player's card (PlayerProfile) is read-only:
// no edit, and "Since" only shows ("PICKLEAGUE PLAYER" when unset). The strip is the look's band and texture (BrandBand).
// Badges opens Achievements and carries the tour's 'rewards' anchor; pickles
// open the Shop.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BrandBand, Chip, StickerBacking } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { numberFont } from '@just-messin-around/expo-foundation/theme';
import { HAIRLINE, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

type Stat = { value: string; label: string; a11y: string; onPress?: () => void; anchorRef?: React.RefObject<View | null>; onLayout?: () => void };

type Props = {
  /** The avatar face (photo or emoji circle), drawn in the card's frame. */
  avatar: React.ReactNode;
  /** The name, with any purchased name style. */
  name: React.ReactNode;
  /** "@brian, Dink first, ask later" (username and tagline). */
  handle?: string | null;
  /** "SINCE MAR 2021", or null when not set yet. */
  since: string | null;
  tags: string[];
  /** A "+2" / "Show less" chip after the tags, when some are hidden. */
  tagToggle?: { label: string; a11y: string; onPress: () => void } | null;
  stats: Stat[];
  /** Your own card only: the avatar and the pencil open the Edit sheet. */
  onEdit?: () => void;
  /** Your own card only: "Since" opens its picker (another player's is read-only). */
  onSince?: () => void;
  onShare: () => void;
  /** The tour's 'profile/edit' anchor sits on the avatar. */
  editAnchorRef?: React.RefObject<View | null>;
  onEditLayout?: () => void;
};

const AVATAR = 64;
const STRIP = 44;

export default function PlayerCard({
  avatar, name, handle, since, tags, tagToggle, stats, onEdit, onSince, onShare, editAnchorRef, onEditLayout,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const edge = c.edge ?? c.primary;
  const radius = c.radiusCard ?? 14;
  const ink = c.headerText;

  return (
    <View style={S.lift}>
      <StickerBacking color={edge} radius={radius} />
      <View style={[S.card, { backgroundColor: c.surface, borderColor: edge, borderRadius: radius }]}>
        <BrandBand style={S.strip}>
          <View style={S.stripRow}>
            {onSince ? (
              <TouchableOpacity
                style={S.since}
                onPress={onSince}
                accessibilityRole="button"
                accessibilityLabel={since ? `${since.toLowerCase()}. Change when you started playing` : 'Add when you started playing'}
              >
                <Text style={[t.label, S.sinceText, { color: ink }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  {since ?? 'ADD WHEN YOU STARTED'}
                </Text>
                <Icon name={since ? 'edit' : 'plus'} size={12} color={ink} />
              </TouchableOpacity>
            ) : (
              <View style={S.since}>
                <Text style={[t.label, S.sinceText, { color: ink }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  {since ?? 'PICKLEAGUE PLAYER'}
                </Text>
              </View>
            )}
            <TouchableOpacity style={S.iconBox} onPress={onShare} accessibilityRole="button" accessibilityLabel="Share your player card">
              <Icon name="share" size={18} color={ink} />
            </TouchableOpacity>
          </View>
        </BrandBand>

        <View style={S.who}>
          <TouchableOpacity
            ref={editAnchorRef as React.RefObject<View>}
            onLayout={onEditLayout}
            onPress={onEdit}
            disabled={!onEdit}
            activeOpacity={0.8}
            accessibilityRole={onEdit ? 'button' : 'image'}
            accessibilityLabel={onEdit ? 'Edit profile' : 'Avatar'}
            style={[S.frame, { borderColor: edge, borderRadius: Math.min(radius, 12), backgroundColor: c.surface }]}
          >
            {avatar}
          </TouchableOpacity>
          <View style={S.nameCol}>
            {name}
            {handle ? <Text style={t.sub} numberOfLines={1}>{handle}</Text> : null}
          </View>
          {onEdit ? (
            <TouchableOpacity style={S.iconBox} onPress={onEdit} accessibilityRole="button" accessibilityLabel="Edit profile">
              <Icon name="edit" size={16} color={c.textSub} />
            </TouchableOpacity>
          ) : null}
        </View>

        {tags.length > 0 || tagToggle ? (
          <View style={S.tags}>
            {tags.map(label => (
              <Chip key={label} label={label} tone="brand" size="sm" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
            ))}
            {tagToggle ? (
              <Chip
                label={tagToggle.label}
                tone="neutral"
                size="sm"
                onPress={tagToggle.onPress}
                accessibilityRole="button"
                accessibilityLabel={tagToggle.a11y}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              />
            ) : null}
          </View>
        ) : null}

        <View style={[S.stats, { borderTopColor: c.border }]}>
          {stats.map((s, i) => (
            <TouchableOpacity
              key={s.label}
              ref={s.anchorRef as React.RefObject<View>}
              onLayout={s.onLayout}
              disabled={!s.onPress}
              onPress={s.onPress}
              style={[S.stat, i > 0 ? { borderLeftWidth: HAIRLINE, borderLeftColor: c.border } : null]}
              accessibilityRole={s.onPress ? 'button' : undefined}
              accessibilityLabel={s.a11y}
            >
              <Text style={[t.h3, { fontFamily: numberFont(c) }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {s.value}
              </Text>
              <Text style={[t.meta, S.statLabel, { color: c.textSub }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {s.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  // Room for the offset backing.
  lift: { marginRight: 3, marginBottom: 3 },
  card: { borderWidth: 2, overflow: 'hidden' },
  strip: { height: STRIP },
  stripRow: { flexDirection: 'row', alignItems: 'center', height: STRIP, paddingLeft: SPACE.md },
  since: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
  sinceText: { letterSpacing: 1.2 },
  iconBox: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  who: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.md, paddingHorizontal: SPACE.md, marginTop: -AVATAR / 2.5 },
  frame: { width: AVATAR, height: AVATAR, borderWidth: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  nameCol: { flex: 1, minWidth: 0, paddingBottom: SPACE.xxs },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, paddingHorizontal: SPACE.md, paddingTop: SPACE.sm },
  stats: { flexDirection: 'row', marginTop: SPACE.md, borderTopWidth: HAIRLINE, borderStyle: 'dashed' },
  stat: { flex: 1, minWidth: 0, minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACE.sm },
  statLabel: { textTransform: 'uppercase', letterSpacing: 0.8 },
});

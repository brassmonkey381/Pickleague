// The shared compact row behind LeagueRow and TournamentRow (plan section 6:
// the Compact and Row variants). Presentational only: no data, no navigation.
//
//   [glyph]  Title  (chip) (chip)              trailing text  ›
//            one-line subtitle                 or [ action ]
//
// Built on the foundation ListCard so the box metrics (56 min height, 10/12
// padding, hairline divider / border, minHeight never height) stay in one
// place:
//   layout='compact' → ListCard density='compact', a standalone card for
//                      full-screen lists (Play, Members, Bookmarks...).
//   layout='row'     → ListCard variant='row', a divider row inside a
//                      <Panel padded={false}> (Home, Profile "Coming up").
//
// Content rules enforced here: the subtitle is one line; at most 2 chips next
// to the title plus 1 trailing text badge (an action replaces the badge and the
// chevron); chips sit on the title line so a row stays 56, not 64.
//
// The action slot sits inside the row's pressable. That is safe on both
// platforms: native gives the touch to the innermost touchable, and on web
// react-native-web's PressResponder stops a click at the first pressable
// ancestor (an enabled OR a disabled role=button), so tapping [Join] never
// also opens the detail screen.
import React, { type ReactNode } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ListCard, Badge } from '@just-messin-around/expo-foundation/ui';
import { RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { entityGlyph, entityTileColors, type EntityKind, type RowChipTone } from '../lib/entityGlyph';

/** 'compact' = standalone card in a full-screen list; 'row' = divider row inside a Panel. */
export type EntityRowLayout = 'compact' | 'row';

export type EntityRowChip = { label: string; tone?: RowChipTone };

/** Rendered chips: at most this many (content rule 2). */
export const MAX_ROW_CHIPS = 2;

export type EntityRowProps = {
  kind: EntityKind;
  /** Default 'compact'. */
  layout?: EntityRowLayout;
  title: string;
  /** One line, clamped. Empty / null renders no subtitle (a layout='row' row is then 44;
   *  a compact card keeps its 56 floor). */
  subtitle?: string | null;
  /** Falsy entries drop out; only the first MAX_ROW_CHIPS truthy ones render. */
  chips?: ReadonlyArray<EntityRowChip | null | undefined | false>;
  /** The one trailing badge, as meta text ("Season ends Dec 1", "Sat 9 AM"). Hidden when `action` is set. */
  trailingText?: string | null;
  /** Trailing action (a Button size='sm' [Join] / [Request] / [Register]). Replaces the chevron. */
  action?: ReactNode;
  /** Default: shown when the row is pressable and has no action. */
  chevron?: boolean;
  onPress?: () => void;
  /** layout='row' only: the Panel's final row (no divider under it). */
  lastRow?: boolean;
  /** Tinted background (e.g. the league you just joined). */
  highlighted?: boolean;
  /** Replaces the kind's glyph. */
  glyph?: string;
  style?: StyleProp<ViewStyle>;
};

export default function EntityRow({
  kind,
  layout = 'compact',
  title,
  subtitle,
  chips,
  trailingText,
  action,
  chevron,
  onPress,
  lastRow,
  highlighted,
  glyph,
  style,
}: EntityRowProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const tile = entityTileColors(kind, c);
  const shownChips = (chips ?? [])
    .filter((x): x is EntityRowChip => !!x && !!x.label)
    .slice(0, MAX_ROW_CHIPS);
  const showChevron = chevron ?? (!!onPress && action == null);
  const sub = subtitle && subtitle.trim() ? subtitle : undefined;

  const leading = (
    <View
      style={[styles.tile, { backgroundColor: tile.bg, borderColor: tile.border }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.glyph} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{glyph ?? entityGlyph(kind)}</Text>
    </View>
  );

  const titleNode = (
    <View style={styles.titleLine}>
      <Text style={[t.title, styles.titleText]} numberOfLines={1}>{title}</Text>
      {shownChips.map((chip) => (
        <Badge
          key={chip.label}
          label={chip.label}
          tone={chip.tone ?? 'neutral'}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        />
      ))}
    </View>
  );

  let trailing: ReactNode = null;
  if (action != null) {
    trailing = action;
  } else if (trailingText || showChevron) {
    trailing = (
      <View style={styles.trailingLine}>
        {trailingText ? (
          <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {trailingText}
          </Text>
        ) : null}
        {showChevron ? <Text style={[styles.chevron, { color: c.textMuted }]}>›</Text> : null}
      </View>
    );
  }

  // A pressable row names itself as one button ("Ladder night, Live, Season ends Dec 1").
  // Not with an action: on web RNW renders a role=button as <button>, and the
  // card would then hold the action's <button> (invalid nesting).
  const a11y =
    onPress && action == null
      ? {
          accessibilityRole: 'button' as const,
          accessibilityLabel: [title, ...shownChips.map((x) => x.label), sub, trailingText].filter(Boolean).join(', '),
        }
      : null;
  return (
    <ListCard
      {...a11y}
      leading={leading}
      title={titleNode}
      subtitle={sub}
      trailing={trailing ?? undefined}
      onPress={onPress}
      density={layout === 'compact' ? 'compact' : 'default'}
      variant={layout === 'row' ? 'row' : 'card'}
      lastRow={lastRow}
      highlighted={highlighted}
      style={action != null ? [styles.actionRow, style] : style}
    />
  );
}

const TILE = 36;

const styles = StyleSheet.create({
  // A trailing action is a 44 tap box; with ListCard's 10px vertical padding
  // the row would grow to 64 (44 + 2 x 10). 4px padding keeps it a 56 row
  // (the minHeight floor still centres the text) and keeps the whole 44 box
  // inside the row's bounds, which Android needs to deliver a touch to it.
  actionRow: { paddingVertical: SPACE.xs },
  tile: {
    minWidth: TILE,
    minHeight: TILE,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: FONT.size.xl, lineHeight: FONT.size.xl + SPACE.xs * 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minWidth: 0 },
  // The name gives way first (ellipsis) so the chips stay readable.
  titleText: { flexShrink: 1 },
  trailingLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  chevron: { fontSize: FONT.size.h2, fontWeight: '700' },
});

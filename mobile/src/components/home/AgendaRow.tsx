// One UP NEXT row (plan section 3, layout A):
//
//   1d    Vote: Thu play day                 [ Vote ]
//   left  Dinks · you haven't voted
//   Thu   Ladder night                       [ RSVP ]
//   6 PM  Sean Leegue · RSVP open
//
// A ListCard variant='row' inside UpNextSection's <Panel padded={false}>: 56
// tall, a two-line "when" column, the title, a one-line subtitle that always
// names the league, and either a button (opens the detail screen AT that
// control via a `focus` param; never an inline write, decision 1), a bookmark
// + ✕ (drill rows: the old drill banner's dismiss, moved here), or a chevron.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ListCard } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { joinFacts } from '../../lib/entityGlyph';
import { agendaWhen, type AgendaRow as AgendaRowData } from '../../lib/agenda';
import BookmarkButton from '../BookmarkButton';

type Props = {
  row: AgendaRowData;
  now: number;
  lastRow?: boolean;
  onPress: () => void;
  onAction?: () => void;
  onDismiss?: () => void;
};

// The "when" column's floor: fits "12:30 PM" / "10:30 AM" / "Nov 12" at the
// meta preset (12/600 + 0.4 tracking), so titles line up at default text size.
// A floor, not a width: at large text the column grows instead of clipping
// the one fact it exists to show (section 6: rows grow, they don't clip).
const WHEN_MIN_WIDTH = 60;

export default function AgendaRow({ row, now, lastRow, onPress, onAction, onDismiss }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const when = agendaWhen(row, now);
  const live = row.bucket === 'live';
  const subtitle = joinFacts([row.leagueName, row.status]);

  const leading = (
    <View style={styles.when}>
      <Text
        style={[t.meta, { color: live ? c.danger : row.bucket === 'needsYou' ? c.primary : c.text }]}
        numberOfLines={1}
        maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
      >
        {when.top}
      </Text>
      {when.bottom ? (
        <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {when.bottom}
        </Text>
      ) : null}
    </View>
  );

  let trailing: React.ReactNode;
  if (row.action && onAction) {
    trailing = <Button size="sm" title={row.action.label} onPress={onAction} />;
  } else if (row.dismissibleDrillId && onDismiss) {
    // The bookmark stays (Home's drill row is the only place a drill session
    // can be saved), next to the ✕ that hides the row.
    trailing = (
      <View style={styles.pair}>
        <BookmarkButton targetType="drill_session" targetId={row.dismissibleDrillId} size={FONT.size.h2} style={styles.box} />
        <TouchableOpacity
          style={styles.box}
          onPress={onDismiss}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Hide this drill from Home"
        >
          <Text style={[t.title, { color: c.textMuted }]}>✕</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    trailing = <Text style={[styles.chevron, { color: c.textMuted }]}>›</Text>;
  }

  return (
    <ListCard
      variant="row"
      lastRow={lastRow}
      leading={leading}
      title={row.title}
      subtitle={subtitle || undefined}
      trailing={trailing}
      onPress={onPress}
      // A 44 action box plus the row's 10/10 padding would make a 64 row; 4px
      // keeps it 56 (same rule as EntityRow) with the box inside the row.
      style={row.action || row.dismissibleDrillId ? styles.actionRow : undefined}
    />
  );
}

const styles = StyleSheet.create({
  when: { minWidth: WHEN_MIN_WIDTH, flexShrink: 0, alignItems: 'flex-start' },
  pair: { flexDirection: 'row', alignItems: 'center' },
  box: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  chevron: { fontSize: FONT.size.h2, fontWeight: '700' },
  actionRow: { paddingVertical: SPACE.xs },
});

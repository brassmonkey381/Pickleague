// One outside event in a list (the Events page, a court's page, Home):
//
//   Saturday open play  NEW                         (Interested)
//   Sat, 9 AM to 11 AM, Ocean View Park
//   [via City of Albany]  Open play, Social
//
// "via <source>" is always on the row: never shown as Pickleague's own. The
// Interested chip saves on its own (kit InterestedToggleChip: optimistic,
// rolled back on a failure). `showPlace` false on a court's own page.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  InterestedToggleChip,
  OutsideEventNewTag,
  OutsideEventViaBadge,
  viaLabel,
} from '@just-messin-around/expo-foundation/outsideEvents';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { chipStatus, isOnNow, kindsLine, placeLine, whenLine, type OutsideEvent } from '../../lib/outsideEvents';
import { setOutsideEventRsvp } from '../../data/outsideEvents';

type Props = {
  event: OutsideEvent;
  isNew?: boolean;
  showPlace?: boolean;
  onPress: () => void;
  lastRow?: boolean;
};

function OutsideEventRow({ event: e, isNew = false, showPlace = true, onPress, lastRow = false }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const now = Date.now();
  const where = showPlace ? placeLine(e) : null;
  const when = isOnNow(e, now) ? `On now, ${whenLine(e, now)}` : whenLine(e, now);
  const via = viaLabel(e) ?? `via ${e.source_name}`;
  return (
    <View style={[S.row, !lastRow && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}>
      <Pressable
        style={S.body}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={[e.title, isNew ? 'new' : null, when, where, via, kindsLine(e)].filter(Boolean).join(', ')}
        accessibilityHint="Opens the event"
      >
        <View style={S.titleRow}>
          <Text style={[t.title, S.shrink]} numberOfLines={2}>
            {e.title}
          </Text>
          {isNew ? <OutsideEventNewTag /> : null}
        </View>
        <Text style={t.sub} numberOfLines={2}>
          {[when, where].filter(Boolean).join(', ')}
        </Text>
        <View style={S.meta}>
          <OutsideEventViaBadge label={via} />
          {e.kinds.length > 0 ? (
            <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {kindsLine(e)}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <InterestedToggleChip
        status={chipStatus(e.my_status)}
        onToggle={async (on) => {
          await setOutsideEventRsvp(e.id, on ? 'maybe' : null);
        }}
      />
    </View>
  );
}

export default React.memo(OutsideEventRow);

const S = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, paddingVertical: SPACE.sm },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  shrink: { flexShrink: 1 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: 2 },
});

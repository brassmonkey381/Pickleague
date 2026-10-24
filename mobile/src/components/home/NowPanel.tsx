// The non-court half of NOW (plan section 3, layout C): a play session that is
// running, and league events that are live (their confirmed time started less
// than 24h ago). The court block (check-in / check-in prompt) is the
// CourtCheckinCard itself, rendered just above this by HomeScreen, because that
// component must never unmount (see its header).
//
//   (play) Open play · Lake Merritt          [Enter score]
//   Now  Ladder night                                     ›
//        Sean Leegue · you're in
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Panel, ListCard } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import { joinFacts } from '../../lib/entityGlyph';
import type { AgendaRow as AgendaRowData } from '../../lib/agenda';
import AgendaRow from './AgendaRow';

type Props = {
  /** The running play session, if any (PlayMeta label + court). */
  session: { label: string; venueName: string | null } | null;
  liveEvents: AgendaRowData[];
  now: number;
  /** The screen's one Emphasis panel (when the court block isn't showing). */
  emphasis: boolean;
  onEnterScore: () => void;
  onEvent: (row: AgendaRowData, position: number) => void;
};

export default function NowPanel({ session, liveEvents, now, emphasis, onEnterScore, onEvent }: Props) {
  const { colors: c } = useTheme();

  if (!session && liveEvents.length === 0) return null;
  return (
    <Panel padded={false} emphasis={emphasis}>
      {session ? (
        <ListCard
          variant="row"
          lastRow={liveEvents.length === 0}
          leading={<Icon name="play" size={18} color={c.primary} />}
          title={joinFacts([session.label, session.venueName])}
          trailing={<Button size="sm" title="Enter score" onPress={onEnterScore} />}
          style={styles.actionRow}
        />
      ) : null}
      {liveEvents.map((row, i) => (
        <View key={row.key}>
          <AgendaRow row={row} now={now} lastRow={i === liveEvents.length - 1} onPress={() => onEvent(row, i)} />
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  actionRow: { paddingVertical: SPACE.xs },
});

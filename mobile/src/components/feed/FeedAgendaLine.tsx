// One league-side line of the Pickleague Feed: a vote, an event, a tournament,
// a drill or a request that waits on me (lib/agenda.ts rows), as a Doggle feed
// row. The header opens the thing; the pill opens it AT its control (Vote,
// RSVP, Next match: never an inline write, Home's decision 1), except a
// locked-in drill's Confirm (an RSVP), which answers in place.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FeedActionPill, FeedRowShell } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { joinFacts } from '../../lib/entityGlyph';
import { agendaWhen, type AgendaKind, type AgendaRow } from '../../lib/agenda';

const KIND_ICON: Record<AgendaKind, IconName> = {
  vote: 'check',
  event: 'calendar-event',
  tournament: 'trophy',
  drill: 'paddle',
  match: 'medal',
  match_confirm: 'check-mark',
  drill_request: 'mail',
  drill_waiting: 'mail',
  join_request: 'group',
  team_invite: 'mail',
  friend_request: 'person',
};

export default function FeedAgendaLine({
  row,
  now,
  highlight,
  band,
  onOpen,
  onAction,
  onConfirm,
  confirmed,
  onDismiss,
  place,
}: {
  row: AgendaRow;
  now: number;
  /** A needs-you line (pinned on top). */
  highlight?: boolean;
  /** The day band it sits in: inside Today / Tomorrow the day isn't repeated. */
  band?: 'today' | 'tomorrow' | 'later';
  onOpen: () => void;
  onAction?: () => void;
  onConfirm?: () => void;
  confirmed?: boolean;
  onDismiss?: () => void;
  /** Where it is, after the league name (an Elsewhere line: "The HUB" or "No court set"). */
  place?: string | null;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const w = agendaWhen(row, now);
  // Inside a dated band only the time shows (Doggle); elsewhere "Tmrw" is spelled out.
  const dated = (band === 'today' && w.top === 'Today') || (band === 'tomorrow' && w.top === 'Tmrw');
  const top = dated && w.bottom ? null : w.top === 'Tmrw' ? 'Tomorrow' : w.top;
  const when = [top, w.bottom].filter(Boolean).join(' ');
  const live = row.bucket === 'live';
  const facts = joinFacts([row.leagueName, place, row.status]);
  // Without the status when it is drawn with its glyph ("(check) Confirmed").
  const lead = row.statusIcon ? joinFacts([row.leagueName, place]) : facts;

  let actions: React.ReactNode = null;
  if (row.confirmDrillId && confirmed) {
    actions = (
      <View style={styles.inline}>
        <Icon name="check-mark" size={12} color={c.success} />
        <Text style={[t.meta, { color: c.success }]}>Confirmed</Text>
      </View>
    );
  } else if (row.confirmDrillId && onConfirm) {
    actions = <FeedActionPill label="Confirm" iconName="check-mark" filled onPress={onConfirm} />;
  } else if (row.action && onAction) {
    actions = <FeedActionPill label={row.action.label} filled={row.needsYou || live} onPress={onAction} />;
  } else if (row.dismissibleDrillId && onDismiss) {
    actions = <FeedActionPill label="Hide" accessibilityLabel="Hide this drill from Home" onPress={onDismiss} />;
  }

  return (
    <FeedRowShell
      iconName={KIND_ICON[row.kind] ?? 'calendar-event'}
      iconColor={live ? c.danger : c.primary}
      when={when}
      whenColor={live ? c.danger : row.bucket === 'needsYou' ? c.primary : c.textSub}
      title={row.title}
      onPress={onOpen}
      accessibilityLabel={[when, row.title, facts].filter(Boolean).join(', ')}
      highlight={highlight}
      actions={actions}
    >
      {row.statusIcon && row.status ? (
        <View style={styles.inline}>
          {lead ? (
            <Text style={[t.meta, styles.shrink, { color: c.textSub }]} numberOfLines={1}>
              {`${lead} · `}
            </Text>
          ) : null}
          <Icon name={row.statusIcon} size={12} color={c.success} />
          <Text style={[t.meta, { color: c.success }]} numberOfLines={1}>
            {row.status}
          </Text>
        </View>
      ) : facts ? (
        <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>
          {facts}
        </Text>
      ) : null}
    </FeedRowShell>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minWidth: 0 },
  shrink: { flexShrink: 1 },
});

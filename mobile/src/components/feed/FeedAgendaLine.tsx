// One league-side line of the Pickleague Feed: a vote, an event, a tournament,
// a drill or a request that waits on me (lib/agenda.ts rows), as a Doggle feed
// row. The header opens the thing; the pill opens it AT its control (Vote,
// RSVP, Next match: never an inline write, Home's decision 1), except a
// locked-in drill's Confirm (an RSVP), which answers in place.
import React from 'react';
import { Text } from 'react-native';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { FeedActionPill, FeedRowShell } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { joinFacts } from '../../lib/entityGlyph';
import { agendaWhen, type AgendaKind, type AgendaRow } from '../../lib/agenda';

const KIND_ICON: Record<AgendaKind, IconName> = {
  vote: 'check',
  event: 'calendar',
  tournament: 'trophy',
  drill: 'ball',
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
  onOpen,
  onAction,
  onConfirm,
  confirmed,
  onDismiss,
}: {
  row: AgendaRow;
  now: number;
  /** A needs-you line (pinned on top). */
  highlight?: boolean;
  onOpen: () => void;
  onAction?: () => void;
  onConfirm?: () => void;
  confirmed?: boolean;
  onDismiss?: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const w = agendaWhen(row, now);
  const when = [w.top, w.bottom].filter(Boolean).join(' ');
  const live = row.bucket === 'live';
  const facts = joinFacts([row.leagueName, row.status]);

  let actions: React.ReactNode = null;
  if (row.confirmDrillId && confirmed) {
    actions = <Text style={[t.meta, { color: c.success }]}>✓ Confirmed</Text>;
  } else if (row.confirmDrillId && onConfirm) {
    actions = <FeedActionPill label="Confirm" iconName="check-mark" filled onPress={onConfirm} />;
  } else if (row.action && onAction) {
    actions = <FeedActionPill label={row.action.label} filled={row.needsYou || live} onPress={onAction} />;
  } else if (row.dismissibleDrillId && onDismiss) {
    actions = <FeedActionPill label="Hide" accessibilityLabel="Hide this drill from Home" onPress={onDismiss} />;
  }

  return (
    <FeedRowShell
      iconName={KIND_ICON[row.kind] ?? 'calendar'}
      iconColor={live ? c.danger : c.primary}
      when={when}
      whenColor={live ? c.danger : row.bucket === 'needsYou' ? c.primary : c.textSub}
      title={row.title}
      onPress={onOpen}
      accessibilityLabel={[when, row.title, facts].filter(Boolean).join(', ')}
      highlight={highlight}
      actions={actions}
    >
      {facts ? (
        <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>
          {facts}
        </Text>
      ) : null}
    </FeedRowShell>
  );
}

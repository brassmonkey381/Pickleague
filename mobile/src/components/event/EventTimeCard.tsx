// The confirmed event's "You" card (plan section 5, Event → Confirmed): the one
// Emphasis card on EventDetail. Date, time, place and head count, then the
// RSVP row from 554837e (I'm in / Can't make it, open until the time ends),
// then Record match + Add to calendar.
//
// Emphasis variant: Panel + 3px accent left edge (primary; danger while live),
// no shadow.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type RsvpBusy = 'rsvp_in' | 'rsvp_out' | null;

export type EventTimeCardProps = {
  startsAt: string;
  endsAt: string;
  isLive: boolean;
  /** Venue (location_name) — omitted when unknown, never "TBD". */
  place?: string | null;
  inCount: number;
  outCount: number;
  rsvpOpen: boolean;
  iAmIn: boolean;
  iDeclined: boolean;
  /** Which RSVP write is in flight (null = none); any write disables both. */
  busy: RsvpBusy | 'other';
  onRsvp: (answer: 'in' | 'out') => void;
  onRecord: () => void;
  onAddToCalendar: () => void;
};

export default function EventTimeCard(p: EventTimeCardProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const day = new Date(p.startsAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const time = `${new Date(p.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} – ${new Date(p.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const anyBusy = p.busy != null;
  const counts = [`${p.inCount} in`, p.outCount > 0 ? `${p.outCount} can't make it` : null].filter(Boolean).join(' · ');

  return (
    <Panel emphasis accentColor={p.isLive ? c.danger : c.primary}>
      <Text style={[t.label, p.isLive && { color: c.danger }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {p.isLive ? 'Live now' : 'Confirmed time'}
      </Text>
      <Text style={[t.title, styles.day]} accessibilityRole="header">{day}</Text>
      <Text style={t.sub} numberOfLines={1}>{[time, p.place].filter(Boolean).join(' · ')}</Text>
      <Text style={[t.meta, styles.counts]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{counts}</Text>

      {p.rsvpOpen && (
        <View style={styles.rsvp}>
          <View style={styles.rsvpState}>
            {p.iAmIn ? (
              <Icon name="check" size={14} color={c.success} />
            ) : p.iDeclined ? (
              <Icon name="block" size={14} color={c.danger} />
            ) : null}
            <Text style={[t.sub, styles.rsvpText, { color: c.text }]} numberOfLines={1}>
              {p.iAmIn ? "You're in" : p.iDeclined ? "You can't make it" : 'Are you coming?'}
            </Text>
          </View>
          {/* Only the answers that would CHANGE something: the same guards the
              row always had (a tap on your current answer was a no-op). */}
          {!p.iAmIn && (
            <Button
              size="sm"
              title="I'm in"
              loading={p.busy === 'rsvp_in'}
              disabled={anyBusy}
              onPress={() => p.onRsvp('in')}
            />
          )}
          {!p.iDeclined && (
            <Button
              size="sm"
              variant="outline"
              title="Can't make it"
              loading={p.busy === 'rsvp_out'}
              disabled={anyBusy}
              onPress={() => p.onRsvp('out')}
            />
          )}
        </View>
      )}

      <View style={styles.actions}>
        <Button
          size="sm"
          variant={p.isLive ? 'primary' : 'outline'}
          title="Record match"
          onPress={p.onRecord}
        />
        <Button size="sm" variant="outline" title="Add to calendar" onPress={p.onAddToCalendar} />
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  day: { marginTop: SPACE.xxs },
  counts: { marginTop: SPACE.xxs },
  rsvp: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: SPACE.sm, marginTop: SPACE.sm },
  rsvpState: { flexGrow: 1, flexShrink: 1, minWidth: 120, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  rsvpText: { flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm },
});

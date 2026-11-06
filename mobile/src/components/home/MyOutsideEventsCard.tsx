// Home: the outside events I marked Interested or Going (list_outside_events
// p_mine), soonest first, at most 3, then "All events". An outside event
// reaches Home only this way (Doggle's rule, Brian 2026-11-06): just being
// near me keeps it on the Events page. Nothing when I've marked none.
//
//   YOUR EVENTS                                                 2
//   Saturday open play                              (Interested)
//   Sat, 9 AM to 11 AM, Ocean View Park
//   [via City of Albany]  Open play
//   All events ›
import React from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Panel, SectionHeader, TextLink } from '@just-messin-around/expo-foundation/ui';
import OutsideEventRow from '../events/OutsideEventRow';
import { useMyOutsideEvents } from '../../data/outsideEvents';
import type { RootStackParamList } from '../../types';

const MAX_ROWS = 3;

export default function MyOutsideEventsCard() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const q = useMyOutsideEvents();
  const events = q.data ?? [];
  if (events.length === 0) return null;
  const shown = events.slice(0, MAX_ROWS);
  return (
    <>
      <SectionHeader title="Your events" count={String(events.length)} />
      <Panel>
        {shown.map((e, i) => (
          <OutsideEventRow
            key={e.id}
            event={e}
            lastRow={i === shown.length - 1}
            onPress={() => navigation.navigate('PublicEvent', { eventId: e.id })}
          />
        ))}
        <TextLink label="All events" iconName="calendar-event" onPress={() => navigation.navigate('PublicEvents')} />
      </Panel>
    </>
  );
}

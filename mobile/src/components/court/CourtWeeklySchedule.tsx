// A court's week (supabase/migration_court_schedules.sql): the kit's calendar
// plus "Suggest a schedule". A court with no sessions shows only the link, so
// players who know a court's nights (Bushrod Park) can tell us.
import React, { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Panel, SectionHeader, TextLink } from '@just-messin-around/expo-foundation/ui';
import { ScheduleSuggestSheet, WeeklySchedule } from '@just-messin-around/expo-foundation/placeSchedule';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { suggestCourtSchedule, useCourtSessions } from '../../data/courtSchedules';
import { track } from '../../lib/analytics';
import { refusalMessage } from '../../lib/refusals';
import { useToast } from '../../lib/useToast';

export default function CourtWeeklySchedule({ venueId }: { venueId: string }) {
  const q = useCourtSessions(venueId);
  const sessions = q.data ?? [];
  const [suggesting, setSuggesting] = useState(false);
  const toast = useToast();

  const link = (
    <TextLink
      label={sessions.length > 0 ? 'Is this wrong? Suggest a change' : 'Know the schedule here? Suggest it'}
      iconName="calendar-event"
      size="sub"
      onPress={() => setSuggesting(true)}
    />
  );

  return (
    <>
      {sessions.length > 0 ? (
        <>
          <SectionHeader title="Weekly schedule" />
          <Panel>
            <WeeklySchedule
              sessions={sessions}
              onPressSession={(s) => {
                if (s.source_url) void Linking.openURL(s.source_url);
              }}
            />
            {link}
          </Panel>
        </>
      ) : (
        <View style={S.bare}>{link}</View>
      )}
      <ScheduleSuggestSheet
        visible={suggesting}
        onClose={() => setSuggesting(false)}
        title={sessions.length > 0 ? 'Suggest a change' : 'Suggest a schedule'}
        notePlaceholder="Tuesdays and Thursdays, 4:30 to 7:30, all levels, $2"
        onSubmit={async (s) => {
          await suggestCourtSchedule(venueId, s.full_note);
          track('courts.schedule_suggested', {});
          toast.success('Thanks! We check every suggestion before it shows.');
        }}
        message={(e) => refusalMessage(e) ?? 'That did not send. Try again.'}
      />
    </>
  );
}

const S = StyleSheet.create({
  bare: { paddingHorizontal: SPACE.xs },
});

// One outside event (supabase/migration_outside_events.sql), from the Events
// page, a court's page, Home, or the report push (outside_event/<id>).
//
//   Saturday open play                    (header: the event's title)
//   [via City of Albany]  Open play, Social
//   Sat, 9 AM to 11 AM
//   Ocean View Park, 900 Buchanan St, Albany   › (the court's page when pinned)
//   Organized by City of Albany
//   Our own one-line summary.
//   (Interested)   3 going, 5 interested
//   Pickleague doesn't run this event. Check the original event before you go.
//   Last checked 2 days ago        [View original event]
//   Report a problem
//
// Hidden (reports, an admin, a takedown) or over: the banner says why, and
// Interested and Report are gone. RSVPs pay nothing.
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  InterestedToggleChip,
  OUTSIDE_REPORT_REASONS,
  OutsideEventHiddenBanner,
  OutsideEventOriginalPanel,
  OutsideEventReportButton,
  OutsideEventReportSheet,
  OutsideEventViaBadge,
  reportResultLine,
  viaLabel,
  type OutsideReportReason,
} from '@just-messin-around/expo-foundation/outsideEvents';
import { ErrorState, Panel, QueryState, TextLink } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { track } from '../lib/analytics';
import { explainRefusal } from '../lib/refusalNotices';
import {
  APP_NAME,
  OUTSIDE_EVENT_NOTE,
  chipStatus,
  countsLine,
  isOnNow,
  kindsLine,
  placeLine,
  whenLine,
} from '../lib/outsideEvents';
import { reportOutsideEvent, setOutsideEventRsvp, useOutsideEvent } from '../data/outsideEvents';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'PublicEvent'>;

export default function PublicEventScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const id = route.params.eventId;
  const q = useOutsideEvent(id);
  const loaded = q.data;
  const [reportOpen, setReportOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) navigation.setOptions({ title: loaded.title });
  }, [loaded, navigation]);

  useEffect(() => {
    if (loaded) track('events.open', { kinds: loaded.kinds.length, pinned: !!loaded.venue_id });
    // Once per event shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.id]);

  async function report(reason: OutsideReportReason) {
    setReportOpen(false);
    setNote(null);
    try {
      const r = await reportOutsideEvent(id, reason);
      setNote(reportResultLine(r));
      void q.refresh();
    } catch (err) {
      setNote(explainRefusal(err, "Couldn't send your report. Check your connection and try again."));
    }
  }

  return (
    <View style={[S.fill, { backgroundColor: c.bg }]}>
      <QueryState
        query={q}
        loadingLabel="Loading the event…"
        renderError={(err, retry) => (
          <ErrorState
            iconName="calendar-event"
            error={err}
            message={`Couldn't open this event. ${explainRefusal(err, 'Try again.')}`}
            onRetry={retry}
          />
        )}
        isEmpty={(d) => d === null}
        emptyProps={{
          iconName: 'calendar-event',
          title: "This event isn't listed anymore",
          subtitle: 'It may be over, or it was taken down.',
        }}
      >
        {(e) =>
          e ? (
          <ScrollView contentContainerStyle={S.content}>
            <Panel>
              <View style={S.meta}>
                <OutsideEventViaBadge label={viaLabel(e) ?? `via ${e.source_name}`} />
                {e.kinds.length > 0 ? <Text style={t.meta}>{kindsLine(e)}</Text> : null}
              </View>
              <Text style={[t.title, S.gapSm]}>{isOnNow(e) ? `On now, ${whenLine(e)}` : whenLine(e)}</Text>
              {placeLine(e) || e.place_address ? (
                <Text style={t.sub}>{[placeLine(e), e.place_address].filter(Boolean).join(', ')}</Text>
              ) : null}
              {e.venue_id ? (
                <TextLink
                  label={`Open ${e.venue_name ?? 'the court'}`}
                  iconName="pin"
                  onPress={() => navigation.navigate('CourtDetail', { venueId: e.venue_id as string })}
                />
              ) : null}
              {e.organizer_name ? <Text style={[t.sub, S.gapSm]}>Organized by {e.organizer_name}</Text> : null}
              {e.summary ? <Text style={[t.body, S.gapSm]}>{e.summary}</Text> : null}
            </Panel>

            {e.hidden_reason ? (
              <OutsideEventHiddenBanner reason={e.hidden_reason} appName={APP_NAME} />
            ) : e.past ? (
              <Panel>
                <Text style={t.sub}>This event is over.</Text>
              </Panel>
            ) : (
              <Panel>
                <View style={S.rsvp}>
                  <InterestedToggleChip
                    status={chipStatus(e.my_status)}
                    onToggle={async (on) => {
                      await setOutsideEventRsvp(e.id, on ? 'maybe' : null);
                      track('events.interested', { on });
                    }}
                  />
                  {countsLine(e) ? <Text style={t.sub}>{countsLine(e)}</Text> : null}
                </View>
                <Text style={[t.hint, S.gapSm]}>Interested puts it in your Home feed. It doesn't sign you up.</Text>
              </Panel>
            )}

            <Panel>
              <OutsideEventOriginalPanel
                note={OUTSIDE_EVENT_NOTE}
                lastVerifiedAt={e.last_verified_at}
                sourceUrl={e.source_url}
              />
            </Panel>

            {!e.hidden_reason && !e.past ? (
              <OutsideEventReportButton reported={!!e.my_report} onPress={() => setReportOpen(true)} />
            ) : null}
            {note ? <Text style={t.sub}>{note}</Text> : null}

            <OutsideEventReportSheet
              visible={reportOpen}
              myReason={e.my_report}
              reasons={OUTSIDE_REPORT_REASONS}
              onPick={(r) => void report(r)}
              onClose={() => setReportOpen(false)}
            />
          </ScrollView>
          ) : null
        }
      </QueryState>
    </View>
  );
}

const S = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  rsvp: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  gapSm: { marginTop: SPACE.xs },
});

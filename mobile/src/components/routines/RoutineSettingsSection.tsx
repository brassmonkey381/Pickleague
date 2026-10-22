// Settings > Check-in automation, "At your routine courts" (Doggle's
// FavoriteCheckinSettingsPanel section of the same name): the switch
// "Check me in at my routine courts" (presence_settings.routine_auto_checkin,
// default on) and "Manage my routine ›". Renders nothing without
// ROUTINES_ENABLED.
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { Panel, SectionHeader, SettingSwitchRow } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { navigateWhenReady } from '../../lib/navigationRef';
import { ROUTINES_ENABLED } from '../../lib/features';
import { courtArrivalResync } from '../../data/courtArrival';
import { COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, setRoutineAutoCheckin } from '../../data/courtRoutines';

export default function RoutineSettingsSection() {
  return ROUTINES_ENABLED ? <Section /> : null;
}

function Section() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const q = useCachedQuery(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, { ttlMs: 60 * 60_000 });
  const [busy, setBusy] = React.useState(false);

  const set = async (on: boolean) => {
    setBusy(true);
    try {
      await setRoutineAutoCheckin(on);
      void q.refresh().catch(() => {});
      // Routine courts are fenced only while this is on.
      courtArrivalResync.emit();
      toast.success(on ? 'Routine check-ins on' : 'Routine check-ins off');
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't update that setting. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader icon="calendar" title="At your routine courts" />
      <Panel padded={false} style={S.group}>
        <SettingSwitchRow
          label="Check me in at my routine courts"
          hint="Arriving at one of your routine courts between 30 minutes before and 30 minutes after its time checks you in for as long as you plan to play, even with the switches above off. A court switched off above still asks first."
          value={q.data?.routine_auto_checkin !== false}
          onChange={(on) => void set(on)}
          disabled={busy || !q.data}
          footnote={Platform.OS === 'web' ? 'Applies on your phone.' : undefined}
          accessibilityLabel="Check me in when I arrive at a routine court"
        />
        <TouchableOpacity
          onPress={() => navigateWhenReady('Routines')}
          accessibilityRole="button"
          style={S.link}
        >
          <Text style={[t.sub, { color: c.primary }]}>Manage my routine ›</Text>
        </TouchableOpacity>
      </Panel>
    </>
  );
}

const S = StyleSheet.create({
  group: { overflow: 'hidden' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md },
});

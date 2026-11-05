// Settings > Check-in automation, "At your routine courts" (Doggle's
// FavoriteCheckinSettingsPanel section of the same name): sharing my routine
// stops, and the "Manage my routine" link. Renders nothing without
// ROUTINES_ENABLED. Its "Check me in at my routine courts" switch
// (presence_settings.routine_auto_checkin) is part of "Check me in when I
// arrive" above since 2026-11-05 (CourtArrivalSettingsPanel writes both).
import React from 'react';
import { StyleSheet } from 'react-native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { Panel, SectionHeader, TextLink } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { navigateWhenReady } from '../../lib/navigationRef';
import { CHECKIN_PLANS_ENABLED, PLAN_SHARING_ENABLED, ROUTINES_ENABLED } from '../../lib/features';
import { AutoShareSettingRow } from '@just-messin-around/expo-foundation/plans';
import { PL_AUTO_SHARE_COPY, autoShareToggledMessage } from '../../lib/planSharing';
import {
  COURT_ROUTINE_SETTINGS_KEY,
  autoShareOf,
  getCourtRoutineSettings,
  setAutoShareRoutines,
} from '../../data/courtRoutines';

export default function RoutineSettingsSection() {
  return ROUTINES_ENABLED ? <Section /> : null;
}

function Section() {
  const toast = useToast();
  const q = useCachedQuery(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, { ttlMs: 60 * 60_000 });
  const [busy, setBusy] = React.useState(false);

  /** Plan sharing: "Share my routine stops automatically". */
  const setShare = async (on: boolean) => {
    setBusy(true);
    try {
      await setAutoShareRoutines(on);
      toast.success(autoShareToggledMessage(on));
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't update that setting. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader icon="calendar-event" title="At your routine courts" />
      <Panel padded={false} style={S.group}>
        {PLAN_SHARING_ENABLED && CHECKIN_PLANS_ENABLED ? (
          <AutoShareSettingRow
            value={autoShareOf(q.data) === true}
            onChange={(on) => void setShare(on)}
            disabled={busy || !q.data}
            copy={PL_AUTO_SHARE_COPY}
          />
        ) : null}
        <TextLink label="Manage my routine" size="sub" onPress={() => navigateWhenReady('Routines')} style={S.link} />
      </Panel>
    </>
  );
}

const S = StyleSheet.create({
  group: { overflow: 'hidden' },
  link: { paddingHorizontal: SPACE.md },
});

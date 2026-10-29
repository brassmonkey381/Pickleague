// "Edit plan" for a one-off planned check-in (the feed line's and the court
// page's sheet): how long, and how that time splits into Closed group / Open
// play / Drill windows, the same fields a routine has (PlayPlanFields). Saves
// with set_court_plan_details (migration_plan_options.sql); its refusals have
// their own words (lib/refusals visit.* and windows.bad). The plan's time
// moves with Change time, not here.
import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { minutesToClock, wallClockIn } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import type { TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { refusalCode } from '../../lib/refusals';
import { routineWindowsToSave, type PlayMode } from '../../lib/courtRoutineRules';
import { planDayTime, planEditWindows, type CourtPlan } from '../../lib/courtPlans';
import { loadMyCourtPlans, setCourtPlanDetails } from '../../data/courtPlans';
import { listMyFriends } from '../../data/friends';
import type { FriendRow } from '../../lib/friendship';
import PlayPlanFields from './PlayPlanFields';

export type PlanEditTarget = Pick<CourtPlan, 'planId' | 'plannedAt' | 'lengthMin' | 'windows'> & { venueName: string };

export default function PlanEditSheet({
  plan,
  onClose,
}: {
  /** The plan to edit; null hides the sheet. */
  plan: PlanEditTarget | null;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [lengthMin, setLengthMin] = React.useState(plan?.lengthMin ?? 120);
  const [windows, setWindows] = React.useState<TimeWindow<PlayMode>[]>(plan ? planEditWindows(plan) : []);
  const [friends, setFriends] = React.useState<FriendRow[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The sheet keeps its plan while it slides away (plan is null then).
  const [shown, setShown] = React.useState<PlanEditTarget | null>(plan);

  React.useEffect(() => {
    if (!plan) return;
    setShown(plan);
    setLengthMin(plan.lengthMin);
    setWindows(planEditWindows(plan));
    setError(null);
    let on = true;
    listMyFriends()
      .then((f) => on && setFriends(f))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [plan]);

  if (!shown) return null;
  const startClock = minutesToClock(wallClockIn(null, new Date(shown.plannedAt)).minutes);

  async function save() {
    if (!shown || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setCourtPlanDetails(shown.planId, lengthMin, routineWindowsToSave(windows, lengthMin));
      toast.success(`Saved your plan at ${shown.venueName}.`);
      onClose();
    } catch (e) {
      setError(explainRefusal(e, "Couldn't save your plan. Try again.", { venueName: shown.venueName, action: 'plan_checkin' }));
      // Moved or cancelled on another device, or over: drop the dead line.
      if (refusalCode(e) === 'visit.gone') void loadMyCourtPlans(true).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet visible={!!plan} onClose={onClose} title="Edit plan" height="90%">
      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <Text style={[t.meta, { color: c.textSub }]}>
          {shown.venueName} · {planDayTime(shown.plannedAt, Date.now())}
        </Text>
        <PlayPlanFields
          lengthMin={lengthMin}
          windows={windows}
          onChange={(next) => {
            setLengthMin(next.lengthMin);
            setWindows(next.windows);
          }}
          startClock={startClock}
          friends={friends}
        />
        {error ? <Text style={[t.meta, S.error, { color: c.danger }]}>{error}</Text> : null}
        <Button title="Save plan" iconName="check-mark" loading={saving} disabled={saving} onPress={() => void save()} style={S.save} />
      </ScrollView>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  scroll: { flex: 1 },
  body: { paddingBottom: SPACE.xl },
  error: { marginTop: SPACE.md },
  save: { marginTop: SPACE.lg },
});

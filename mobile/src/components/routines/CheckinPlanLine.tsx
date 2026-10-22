// My open check-in's plan, under it wherever it shows (Home's court card, the
// play island, a court's page): "Closed group until 10:30 AM, then open play"
// or "Planned until 12 PM", with Plan (how long, and Closed group / Open play
// windows: set_checkin_plan) and "Switch to open play now".
//
// A check-in made by hand keeps today's behaviour until Plan is tapped (2
// hours, nothing said); the sheet preselects Open play (the plan's decision
// 5). A routine arrival brings its routine's windows with it. Renders nothing
// without ROUTINES_ENABLED, for a check-in still queued, or before its plan
// is read.
import React from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { BottomSheet, DurationChips, TimeWindowsEditor } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SMALL_TEXT_MAX_SCALE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { minutesToClock, wallClockIn } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import {
  formatDurationMinutes,
  modeAt,
  singleWindow,
  windowsToOffsets,
  type TimeWindow,
} from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { ROUTINES_ENABLED } from '../../lib/features';
import {
  checkinLengthOptions,
  checkinPlanWindows,
  clockLabel,
  DEFAULT_PLAY_LENGTH_MIN,
  MAX_PLAY_LENGTH_MIN,
  PLAY_HINTS,
  PLAY_MODE_LABEL,
  playModeNowLine,
  switchToOpenWindows,
  windowsSaySomething,
  type PlayMode,
} from '../../lib/courtRoutineRules';
import { checkinPlanChanged, getCheckinPlan, setCheckinPlan, type CheckinPlan } from '../../data/courtRoutines';
import { checkinChanged } from '../../lib/courtCheckin';

type Props = {
  checkinId: string | null;
  venueName?: string | null;
  /** Hide "Plan" (a narrow surface: the island). */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function CheckinPlanLine(props: Props) {
  if (!ROUTINES_ENABLED || !props.checkinId) return null;
  return <PlanLine {...props} checkinId={props.checkinId} />;
}

/** My check-in's plan, reread when it changes here or the check-in does. */
function useCheckinPlan(checkinId: string): [CheckinPlan | null, () => void] {
  const [plan, setPlan] = React.useState<CheckinPlan | null>(null);
  const load = React.useCallback(() => {
    getCheckinPlan(checkinId)
      .then(setPlan)
      .catch(() => {});
  }, [checkinId]);
  React.useEffect(load, [load]);
  useSignal(checkinPlanChanged, (p) => {
    if (p.checkinId === checkinId) setPlan(p);
  });
  useSignal(checkinChanged, (c) => {
    if (c?.id === checkinId) load();
  });
  return [plan, load];
}

function PlanLine({ checkinId, venueName, compact, style }: Props & { checkinId: string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [plan] = useCheckinPlan(checkinId);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  // A minute tick, so "until 10:30" moves on without a refetch.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!plan || !plan.checkedInAt) return null;
  const now = new Date();
  const line = playModeNowLine(plan.windows, now);
  const shown = line || (plan.plannedEndAt ? `Planned until ${clockLabel(plan.plannedEndAt)}` : '');
  const open = modeAt(plan.windows, now)?.mode === 'open';

  const switchToOpen = async () => {
    const next = switchToOpenWindows(plan.windows, plan.checkedInAt, plan.plannedEndAt ?? plan.expiresAt, new Date());
    if (!next) return;
    setBusy(true);
    try {
      await setCheckinPlan(checkinId, null, next);
      toast.success("You're open to play. Others here see it.");
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't switch to open play. Try again.", { venueName, action: 'plan' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[S.wrap, style]}>
      {shown ? (
        <Text style={[t.sub, S.text]} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {shown}
        </Text>
      ) : null}
      <View style={S.buttons}>
        {!open ? (
          <Button title="Switch to open play now" size="sm" variant="outline" loading={busy} onPress={() => void switchToOpen()} />
        ) : null}
        {!compact ? (
          <Button title={windowsSaySomething(plan.windows) || plan.plannedEndAt ? 'Change plan' : 'Plan my play'} size="sm" variant="outline" disabled={busy} onPress={() => setEditing(true)} />
        ) : null}
      </View>
      {editing ? <CheckinPlanSheet plan={plan} venueName={venueName ?? null} onClose={() => setEditing(false)} /> : null}
    </View>
  );
}

/** Minutes from the check-in's start to its planned end (else its end), on the 15-minute grid. */
function initialLength(plan: CheckinPlan): number {
  const start = Date.parse(plan.checkedInAt);
  const end = Date.parse(plan.plannedEndAt ?? plan.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return DEFAULT_PLAY_LENGTH_MIN;
  const m = Math.round((end - start) / 60_000 / 15) * 15;
  return Math.min(MAX_PLAY_LENGTH_MIN, Math.max(30, m));
}

/** How long, and Closed group / Open play, for the check-in I'm in. */
function CheckinPlanSheet({ plan, venueName, onClose }: { plan: CheckinPlan; venueName: string | null; onClose: () => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const options = checkinLengthOptions(plan.checkedInAt);
  const [lengthMin, setLengthMin] = React.useState(() => initialLength(plan));
  const [windows, setWindows] = React.useState<TimeWindow<PlayMode>[]>(() =>
    plan.windows.length ? windowsToOffsets(plan.windows, plan.checkedInAt) : singleWindow(initialLength(plan), 'open'),
  );
  const [saving, setSaving] = React.useState(false);
  const startClock = minutesToClock(wallClockIn(null, new Date(plan.checkedInAt)).minutes);
  const modes = [
    { value: 'closed' as PlayMode, label: PLAY_MODE_LABEL.closed, color: c.warning },
    { value: 'open' as PlayMode, label: PLAY_MODE_LABEL.open, color: c.success },
  ];

  const save = async () => {
    setSaving(true);
    try {
      const end = new Date(Date.parse(plan.checkedInAt) + lengthMin * 60_000);
      const send = windows.length === 1 && windows[0].mode == null ? [] : checkinPlanWindows(windows, plan.checkedInAt);
      await setCheckinPlan(plan.checkinId, end, send);
      toast.success(`Planned until ${clockLabel(end)}.`);
      onClose();
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't save your plan. Try again.", { venueName, action: 'plan' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible onClose={onClose} title="Plan my play" height="85%">
      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <Text style={[t.label, S.label]}>HOW LONG (FROM WHEN YOU CHECKED IN)</Text>
        <DurationChips value={lengthMin} onChange={setLengthMin} options={options} format={formatDurationMinutes} />
        <Text style={[t.label, S.label]}>CLOSED GROUP OR OPEN PLAY</Text>
        <TimeWindowsEditor<PlayMode>
          lengthMin={lengthMin}
          windows={windows}
          onChange={setWindows}
          modes={modes}
          hints={PLAY_HINTS}
          startClock={startClock}
          rules={{ stepMin: 15, minWindowMin: 15, maxWindows: 6, maxGroup: 7 }}
          unsaidColor={c.border}
        />
        <Text style={[t.hint, S.hint]}>
          Others at the court see "open to play" only during open play. A check-in can run at most 4 hours ahead.
        </Text>
        <Button title="Save plan" loading={saving} onPress={() => void save()} style={S.save} />
      </ScrollView>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  wrap: { gap: SPACE.xxs },
  text: { flexShrink: 1 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm },
  scroll: { flex: 1 },
  body: { paddingBottom: SPACE.xl },
  label: { marginTop: SPACE.md, marginBottom: SPACE.sm },
  hint: { marginTop: SPACE.lg },
  save: { marginTop: SPACE.md },
});

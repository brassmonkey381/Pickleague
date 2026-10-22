// My open check-in's plan, under it wherever it shows (Home's court card, the
// play island, a court's page): "Closed group until 10:30 AM, then open play"
// or "Planned until 12 PM", with Plan (how long, and Closed group / Open play
// windows: set_checkin_plan), "Switch to open play now", and "Stay until 12
// PM" when the check-in ends before its planned end.
//
// A check-in made by hand keeps today's behaviour until Plan is tapped (2
// hours, nothing said); the sheet preselects Open play (the plan's decision
// 5). A routine check-in, by arrival or by hand, brings its routine's windows
// and planned end with it. "Stay until" is the web's way to the rest of a
// routine (no "Staying until" push there) and an older build's (it asked 2
// hours). Renders nothing without ROUTINES_ENABLED, for a check-in still
// queued, or before its plan is read.
import React from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { BottomSheet, DurationChips, TimeWindowsEditor } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SMALL_TEXT_MAX_SCALE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { minutesToClock, wallClockIn } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { formatDurationMinutes, modeAt, type TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import { ROUTINES_ENABLED } from '../../lib/features';
import {
  checkinLengthOptions,
  checkinPlanSheetStart,
  checkinPlanWindowsToSave,
  clockLabel,
  fitCheckinPlanWindows,
  PLAY_HINTS,
  PLAY_MODE_LABEL,
  playModeNowLine,
  stayUntilLabel,
  stayUntilOffer,
  switchToOpenPlan,
  windowsSaySomething,
  type PlayMode,
} from '../../lib/courtRoutineRules';
import { checkinPlanChanged, getCheckinPlan, setCheckinPlan, type CheckinPlan } from '../../data/courtRoutines';
import { checkinChanged, extendCheckinUntil } from '../../lib/courtCheckin';

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
  const [plan, reload] = useCheckinPlan(checkinId);
  const [busy, setBusy] = React.useState<'switch' | 'stay' | null>(null);
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
  // The check-in ends before its planned end (a routine check-in by hand
  // keeps the length asked): one tap runs it to the planned end.
  const stayUntil = stayUntilOffer(plan, now);

  const switchToOpen = async () => {
    const next = switchToOpenPlan(plan, new Date());
    if (!next) return;
    setBusy('switch');
    try {
      await setCheckinPlan(checkinId, next.plannedEnd, next.windows);
      toast.success("You're open to play. Others here see it.");
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't switch to open play. Try again.", { venueName, action: 'plan' }));
    } finally {
      setBusy(null);
    }
  };

  // extend_checkin to the planned end, as the "Staying until" push's Stay
  // until does (no fix: the server caps it 4 hours past the last one, and
  // the note says so).
  const stay = async (until: string) => {
    setBusy('stay');
    try {
      const { note } = await extendCheckinUntil({ id: checkinId, venueName }, until);
      if (note.full) toast.success(note.message);
      else toast.info(note.message);
      reload();
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't extend your check-in. Try again.", { venueName, action: 'extend' }));
    } finally {
      setBusy(null);
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
        {stayUntil ? (
          <Button
            title={stayUntilLabel(stayUntil)}
            size="sm"
            variant="outline"
            loading={busy === 'stay'}
            disabled={busy != null}
            onPress={() => void stay(stayUntil)}
          />
        ) : null}
        {!open ? (
          <Button
            title="Switch to open play now"
            size="sm"
            variant="outline"
            loading={busy === 'switch'}
            disabled={busy != null}
            onPress={() => void switchToOpen()}
          />
        ) : null}
        {!compact ? (
          <Button title={windowsSaySomething(plan.windows) || plan.plannedEndAt ? 'Change plan' : 'Plan my play'} size="sm" variant="outline" disabled={busy != null} onPress={() => setEditing(true)} />
        ) : null}
      </View>
      {editing ? <CheckinPlanSheet plan={plan} venueName={venueName ?? null} onClose={() => setEditing(false)} /> : null}
    </View>
  );
}

/** How long, and Closed group / Open play, for the check-in I'm in. */
function CheckinPlanSheet({ plan, venueName, onClose }: { plan: CheckinPlan; venueName: string | null; onClose: () => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const options = checkinLengthOptions(plan.checkedInAt);
  // Opens at the latest of the planned end, the end and the last window's end,
  // with every window (a routine's start at its time, not at the check-in, on
  // the 15-minute grid), else all Open play.
  const [start] = React.useState(() => checkinPlanSheetStart(plan));
  const [lengthMin, setLengthMin] = React.useState(start.lengthMin);
  const [windows, setWindows] = React.useState<TimeWindow<PlayMode>[]>(start.windows);
  // What the player last left (the opening windows, or their last edit): each
  // "How long?" refits from it, so a shorter length and back never collapses
  // a split into one mode, and what is saved is what the editor shows.
  const [base, setBase] = React.useState<TimeWindow<PlayMode>[]>(start.windows);
  const changeLength = (m: number) => {
    setLengthMin(m);
    setWindows(fitCheckinPlanWindows(base, m));
  };
  const editWindows = (w: TimeWindow<PlayMode>[]) => {
    setWindows(w);
    setBase(w);
  };
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
      await setCheckinPlan(plan.checkinId, end, checkinPlanWindowsToSave(windows, lengthMin, plan.checkedInAt));
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
        <DurationChips value={lengthMin} onChange={changeLength} options={options} format={formatDurationMinutes} />
        <Text style={[t.label, S.label]}>CLOSED GROUP OR OPEN PLAY</Text>
        <TimeWindowsEditor<PlayMode>
          lengthMin={lengthMin}
          windows={windows}
          onChange={editWindows}
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

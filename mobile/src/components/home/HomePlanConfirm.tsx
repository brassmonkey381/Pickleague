// "Today's routine": the once-a-day sheet that asks me to confirm today's
// routine stops before friends see them (plan sharing; the user, 2026-10-24:
// "we never show routines automatically ... ask users to confirm their plans
// when they launch the app daily"). The foundation's useDailyPlanConfirm +
// DailyPlanConfirmSheet (`/plans`) do the work; this adapts them to Home:
//
//   - enabled: plan sharing, routines and plans on, signed in, not a guest,
//     no spotlight tour running;
//   - only with "Share my routine stops automatically" known to be off (null,
//     not loaded yet, never prompts) and a stop today not yet confirmed;
//   - autoPresent off: Home's modal queue presents it (after the welcome and
//     streak pop-ups, only while Home is focused and nothing else is up:
//     `canPresent`), so it never stacks on another Modal;
//   - "shown today" is marked when it is presented (PL_DAILY_GATE), once per
//     local day.
import React from 'react';
import { Text } from 'react-native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { DailyPlanConfirmSheet, useDailyPlanConfirm, type UseDailyPlanConfirm } from '@just-messin-around/expo-foundation/plans';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { track } from '../../lib/analytics';
import { useTour } from '../../lib/TourContext';
import { CHECKIN_PLANS_ENABLED, PLAN_SHARING_ENABLED, ROUTINES_ENABLED } from '../../lib/features';
import { explainRefusal } from '../../lib/refusalNotices';
import { refusalCode } from '../../lib/refusals';
import { playModeNowLine } from '../../lib/courtRoutineRules';
import { PL_DAILY_CONFIRM_COPY, type CourtStopExtras } from '../../lib/planSharing';
import { COURT_ROUTINE_SETTINGS_KEY, autoShareOf, getCourtRoutineSettings } from '../../data/courtRoutines';
import { PL_DAILY_GATE, plConfirmAdapter } from '../../data/planSharing';

export type HomePlanConfirm = UseDailyPlanConfirm<CourtStopExtras>;

const FALLBACK = "Couldn't save that. Try again.";

/** The daily confirm's state for Home. `canPresent`: Home's queue has it up next. */
export function useHomePlanConfirm(userId: string | null, isGuest: boolean, canPresent: boolean): HomePlanConfirm {
  const { activeTour } = useTour();
  const enabled =
    PLAN_SHARING_ENABLED && ROUTINES_ENABLED && CHECKIN_PLANS_ENABLED && !!userId && !isGuest && activeTour == null;
  const settingsQ = useCachedQuery(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, { ttlMs: 60 * 60_000, enabled });
  const autoShare = enabled ? autoShareOf(settingsQ.data) : null;
  // A copy an older build cached has no auto-share key: read it once now
  // rather than wait out its hour.
  const reread = React.useRef(false);
  const { refresh } = settingsQ;
  React.useEffect(() => {
    if (!enabled || reread.current || settingsQ.data === undefined || autoShare != null) return;
    reread.current = true;
    void refresh().catch(() => undefined);
  }, [enabled, settingsQ.data, autoShare, refresh]);

  return useDailyPlanConfirm<CourtStopExtras>({
    userId,
    enabled,
    adapter: plConfirmAdapter,
    autoShare,
    gate: PL_DAILY_GATE,
    autoPresent: false,
    canPresent,
    errorFallback: FALLBACK,
    explainError: (e) => ({ message: explainRefusal(e, FALLBACK), gone: refusalCode(e) === 'plan.gone' }),
    onEvent: (e) => {
      const { type, ...rest } = e;
      track(`plan_confirm.${type}`, rest);
    },
  });
}

/** The sheet, with Pickleague's words and each stop's play mode line. */
export function HomePlanConfirmSheet({
  state,
  onDismissed,
  onOpenSettings,
}: {
  state: HomePlanConfirm;
  onDismissed: () => void;
  onOpenSettings: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <DailyPlanConfirmSheet<CourtStopExtras>
      state={state}
      copy={PL_DAILY_CONFIRM_COPY}
      onDismissed={onDismissed}
      onOpenSettings={onOpenSettings}
      renderRowDetail={(occ) => {
        const line = playModeNowLine(occ.windows, new Date(Math.max(Date.now(), Date.parse(occ.at))), occ.tz ?? null);
        return line ? (
          <Text style={[t.meta, { color: c.textSub }]} numberOfLines={2}>
            {line}
          </Text>
        ) : null;
      }}
    />
  );
}

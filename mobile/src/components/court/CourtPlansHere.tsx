// My planned check-ins at this court, on its page: every one still to come,
// whatever the day (Doggle's place page lists your planned visit there with
// Cancel). The feed shows only this week's (its Later band ends 6 days out),
// and a plan can be up to 60 days ahead, so this is where one further out
// is seen, moved or cancelled. Owner-only, like the plans themselves.
//
//   YOUR PLANNED CHECK-INS HERE
//   (cal)  Sat at 6 PM                       [At Sat 6 PM ▾]
//          Planned check-in · until 8 PM
//
// The chip's sheet is the feed line's (lib/checkinOptions lineActionIds):
// Check in now · On my way (today) · Change time · Cancel this visit. Change
// time opens the page's plan sheet (any day); the writes run in
// useCheckinOptions, so the page's Check in waits for them.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { useSignal, useTicker } from '@just-messin-around/expo-foundation/hooks';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { ActionSheetModal, type ActionSheetAction } from '@just-messin-around/expo-foundation/ui';
import { FeedTimeChip } from '@just-messin-around/expo-foundation/ui/feed';
import { dayBandOf } from '@just-messin-around/expo-foundation/scheduling/dayBands';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { track } from '../../lib/analytics';
import { shortTime } from '../../lib/agenda';
import { CHECKIN_PLANS_ENABLED } from '../../lib/features';
import { checkinChanged } from '../../lib/courtCheckin';
import { lineActionIds, type LineActionId } from '../../lib/checkinOptions';
import { planDayTime, plansAtCourt, planWhen, type CourtPlan } from '../../lib/courtPlans';
import {
  MY_COURT_PLANS_KEY,
  MY_COURT_PLANS_PERSIST_MS,
  MY_COURT_PLANS_TTL_MS,
  fetchMyCourtPlans,
} from '../../data/courtPlans';
import { sentOnMyWayRecently } from '../../data/onMyWay';
import type { CheckinCourt, useCheckinOptions } from '../feed/useCheckinOptions';

type Props = {
  court: CheckinCourt;
  /** I'm checked in at this court now. */
  here: boolean;
  /** The page's useCheckinOptions (its plan sheet, the writes, On my way). */
  options: ReturnType<typeof useCheckinOptions>;
  /** The page's Check in now. */
  onCheckIn: () => void;
};

const ICON = 32;

export default function CourtPlansHere({ court, here, options, onCheckIn }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const now = Math.max(useTicker(60_000), Date.now());
  const plansQ = useCachedQuery(MY_COURT_PLANS_KEY, fetchMyCourtPlans, {
    ttlMs: MY_COURT_PLANS_TTL_MS,
    persistMs: MY_COURT_PLANS_PERSIST_MS,
    enabled: CHECKIN_PLANS_ENABLED,
  });
  // A check-in near a plan's time keeps it (the server): reload once one lands.
  const seen = React.useRef<string | null>(null);
  useSignal(checkinChanged, (cur) => {
    const id = cur && !cur.queued ? cur.id : null;
    if (id && id !== seen.current && CHECKIN_PLANS_ENABLED) void plansQ.refresh();
    seen.current = id;
  });
  const [open, setOpen] = React.useState<CourtPlan | null>(null);
  const after = React.useRef<(() => void) | null>(null);

  const mine = CHECKIN_PLANS_ENABLED ? plansAtCourt(plansQ.data ?? [], court.venueId, now) : [];
  const writing = options.busy === 'plan' && options.planning === court.venueId;

  function actions(p: CourtPlan): ActionSheetAction[] {
    const ids = lineActionIds(
      { kind: 'plan', at: p.plannedAt },
      {
        day: dayBandOf(Date.parse(p.plannedAt), now) ?? 'later',
        nowMs: now,
        hereMine: here,
        canOnMyWay: options.canOnMyWay,
        onMyWaySent: sentOnMyWayRecently(court.venueId, now),
      },
    );
    const tap = (id: LineActionId) => track('courts.plan_line', { action: id });
    const item = (id: LineActionId): ActionSheetAction | null => {
      switch (id) {
        case 'checkInNow':
          return {
            label: 'Check in now',
            iconName: 'pin',
            onPress: () => {
              tap(id);
              after.current = onCheckIn;
            },
          };
        case 'onMyWay':
          return {
            label: 'On my way',
            iconName: 'walk',
            onPress: () => {
              tap(id);
              after.current = () => options.onMyWay(court, 'court');
            },
          };
        case 'changeTime':
          return {
            label: 'Change time',
            iconName: 'clock',
            onPress: () => {
              tap(id);
              after.current = () => options.openMovePlan(court, p);
            },
          };
        case 'cancelPlan':
          return {
            label: 'Cancel this visit',
            style: 'destructive',
            onPress: () => {
              tap(id);
              void options.cancelPlan(court, p);
            },
          };
        default:
          return null;
      }
    };
    return ids.map(item).filter((a): a is ActionSheetAction => a != null);
  }

  const today = (iso: string) => dayBandOf(Date.parse(iso), now) === 'today';

  return (
    <>
      {mine.length > 0 ? (
        <View style={S.wrap}>
          <Text style={[t.label, { color: c.textSub }]} accessibilityRole="header">
            Your planned check-ins here
          </Text>
          {mine.map((p) => {
            const when = planDayTime(p.plannedAt, now);
            return (
              <View key={p.planId} style={S.line}>
                <View style={[S.kindIcon, { backgroundColor: c.primaryLight }]}>
                  <Icon name="calendar-event" size={18} color={c.primary} />
                </View>
                <View style={S.body}>
                  <Text style={t.title} numberOfLines={1}>
                    {when}
                  </Text>
                  <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>
                    {`Planned check-in · until ${shortTime(new Date(p.plannedEndAt))}`}
                  </Text>
                </View>
                <FeedTimeChip
                  label={today(p.plannedAt) ? `At ${shortTime(new Date(p.plannedAt))}` : 'Options'}
                  tone={Date.parse(p.plannedAt) <= now ? 'neutral' : 'warning'}
                  busy={writing}
                  disabled={options.busy != null && !writing}
                  onPress={() => {
                    if (options.busy != null) return;
                    after.current = null;
                    setOpen(p);
                  }}
                  a11y={`Your planned check-in at ${court.venueName}, ${when}. Options`}
                />
              </View>
            );
          })}
        </View>
      ) : null}
      <ActionSheetModal
        visible={open != null}
        title={`You · ${court.venueName}`}
        subtitle={open ? `Planned check-in ${today(open.plannedAt) ? 'at ' : ''}${planWhen(open.plannedAt, now)}` : undefined}
        actions={open ? actions(open) : []}
        cancelLabel="Close"
        onClose={() => setOpen(null)}
        onDismissed={() => {
          const next = after.current;
          after.current = null;
          next?.();
        }}
      />
    </>
  );
}

const S = StyleSheet.create({
  wrap: { gap: SPACE.sm, marginTop: SPACE.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  body: { flex: 1, minWidth: 0, gap: SPACE.xxs / 2 },
  kindIcon: { width: ICON, height: ICON, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
});

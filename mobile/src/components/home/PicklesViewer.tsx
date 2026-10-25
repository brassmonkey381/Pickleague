// The pickles viewer: Home's balance opens it (Doggle's points viewer, kit 1.73
// PointsActivityModal as a bottom sheet, like Pickleague's other sheets).
//
//   Balance                              (pickle) 1,240
//   Play streak today · 100 / 200        [=====      ]
//   Day 2 of your play streak is in. Play tomorrow for 150 more. …
//   Calendar                           Open the Shop ›
//   Match win vs Sam                         + (pickle) 50
//   Daily login reward       ★ BONUS          + (pickle) 25   (gold)
//   Shop: Neon paddle                        - (pickle) 300
//   Starting balance                           (pickle) 1,000 (muted)
//
// The meter is the play streak's 200 a day (my_pickle_today), the one daily
// cap Pickleague has: other pickles are never capped, so the meter reads the
// server's streak_today, never the day's earned total.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  PointsActivityModal,
  pointsErrorReason,
  resolvePointsCopy,
  usePointsLedger,
  type PointsCapProgress,
  type PointsUnit,
} from '@just-messin-around/expo-foundation/gamification/points';
import { TextLink } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';
import { PickleAmount, PickleBalance } from '../PickleAmount';
import {
  listPickleLedgerPage,
  loadPickleToday,
  playStreakCaption,
  playStreakLoadError,
  type PickleToday,
} from '../../data/pickleLedger';

// PointsCalendar's day summary draws its words ("earned", "spent") at 14 / 800
// and hands that style to its own amount, but renderAmount never receives it
// (kit 1.73 has no textStyle in PointsAmountRenderInfo), so match it here.
const DAY_TOTAL_TEXT = { fontSize: 14, fontWeight: '800' } as const;

/** Pickles, drawn with PickleAmount / PickleBalance everywhere the kit draws an amount. */
export const PICKLES_UNIT: PointsUnit = {
  singular: 'pickle',
  plural: 'pickles',
  iconName: 'pickle',
  renderAmount: ({ amount, kind, color, preset, context, accessibilityLabel }) => {
    const textStyle = context === 'day' ? DAY_TOTAL_TEXT : undefined;
    return kind == null ? (
      <PickleBalance balance={amount} preset={preset} color={color} textStyle={textStyle} />
    ) : (
      <PickleAmount
        amount={Math.abs(amount)}
        prefix={amount > 0 ? '+' : amount < 0 ? '-' : ''}
        preset={preset}
        color={color}
        textStyle={textStyle}
        accessibilityLabel={accessibilityLabel}
      />
    );
  },
};

/** The viewer's and the calendar's words (the rest are the kit's, in pickles). */
export const PICKLES_COPY = {
  title: 'Pickle history',
  empty: 'No pickles yet. Play a match, keep a play streak or add a court to start earning.',
  emptyDay: 'No pickles this day.',
  calendarA11y: 'Open your pickle calendar',
} as const;

type Props = {
  visible: boolean;
  onClose: () => void;
  /** profile.pickles; null while Home's profile is unknown. */
  balance: number | null;
  /** Home's own failed read, when it left the balance unknown. */
  balanceError?: unknown;
  /** Try again for the balance (Home's reload). */
  onReloadBalance?: () => void;
  onOpenShop: () => void;
  onOpenCalendar: () => void;
  onDismissed?: () => void;
};

export default function PicklesViewer({
  visible,
  onClose,
  balance,
  balanceError,
  onReloadBalance,
  onOpenShop,
  onOpenCalendar,
  onDismissed,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const ledger = usePointsLedger({ enabled: visible, fetchPage: listPickleLedgerPage });

  // Today's play streak, read each time the viewer opens.
  const [today, setToday] = useState<PickleToday | null>(null);
  const [todayError, setTodayError] = useState<unknown>(null);
  const seq = useRef(0);
  const loadToday = useCallback(() => {
    const n = ++seq.current;
    // A previous open's answer may be another day's: never show it as today's.
    setToday(null);
    setTodayError(null);
    loadPickleToday().then(
      (t) => { if (n === seq.current) setToday(t); },
      (e) => { if (n === seq.current) setTodayError(e ?? true); },
    );
  }, []);
  useEffect(() => {
    if (visible) loadToday();
    else {
      seq.current++; // drop a late answer after a close
      setToday(null);
      setTodayError(null);
    }
  }, [visible, loadToday]);

  // Only the balance joins the feed's "Couldn't load your pickles" banner: a
  // failed play-streak read leaves the balance and the rows fine, so it gets
  // its own line in place of the meter.
  const error = (balance == null ? balanceError : null) ?? null;
  const todayFailed = todayError != null && todayError !== false;
  const { reload } = ledger;
  const onRetry = useCallback(() => {
    loadToday();
    onReloadBalance?.();
    reload();
  }, [loadToday, onReloadBalance, reload]);

  return (
    <PointsActivityModal
      visible={visible}
      onClose={onClose}
      onDismissed={onDismissed}
      presentation="sheet"
      ledger={ledger}
      unit={PICKLES_UNIT}
      balance={balance}
      // Only with the server's figure: without earnedToday the meter would count every earned row.
      dailyCap={today ? { cap: today.cap, earnedToday: today.streak_today } : null}
      error={error}
      onRetry={onRetry}
      onOpenShop={onOpenShop}
      onOpenCalendar={onOpenCalendar}
      copy={{
        ...PICKLES_COPY,
        capTitle: 'Play streak today',
        capCaption: (_p: PointsCapProgress) => playStreakCaption(today),
      }}
    >
      {todayFailed ? (
        <View style={styles.todayFail} accessibilityRole="alert">
          <Text style={[t.sub, { color: c.textSub }]}>
            {playStreakLoadError(pointsErrorReason(todayError, resolvePointsCopy(PICKLES_UNIT, PICKLES_COPY)))}
          </Text>
          <TextLink label="Try again" onPress={loadToday} accessibilityLabel="Try loading today's play streak again" />
        </View>
      ) : null}
    </PointsActivityModal>
  );
}

const styles = StyleSheet.create({
  todayFail: { gap: SPACE.xs, marginBottom: SPACE.md },
});

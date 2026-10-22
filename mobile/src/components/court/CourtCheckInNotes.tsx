// The check-in flow's outcome lines (lib/useCourtCheckIn), shared by Home's
// court card and a court's page: why a check-in was refused (or that it was
// saved to send later), then the caller's own follow-ups (`children`: "Start
// without a court", "Add this court"), then the one-time "Star this court"
// offer and its result.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';
import { ALWAYS_LABEL } from '../../lib/courtArrivalAsk';
import type { CourtCheckInFlow } from '../../lib/useCourtCheckIn';

type Props = {
  flow: CourtCheckInFlow;
  /** Follow-up buttons under the message (the caller's own). */
  children?: React.ReactNode;
  /** "Star it" / "Not now" taps (analytics). */
  onStarOfferTap?: (target: 'alerts_on' | 'alerts_not_now') => void;
};

export default function CourtCheckInNotes({ flow, children, onStarOfferTap }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const { message, starOffer, alertsResult } = flow;
  return (
    <>
      {message ? <Text style={[t.sub, S.gapSm]}>{message}</Text> : null}
      {children}
      {starOffer ? (
        <View style={S.offer}>
          <Text style={t.body}>Star this court and get checked in when you arrive?</Text>
          <Text style={[t.sub, S.gapSm]}>
            Stay a minute and we check you in. Leave within 5 minutes and it doesn't count. Needs location set to "
            {ALWAYS_LABEL}".
          </Text>
          <View style={S.row}>
            <Button
              title="Star it"
              size="sm"
              loading={starOffer.busy}
              disabled={starOffer.busy}
              onPress={() => {
                onStarOfferTap?.('alerts_on');
                void flow.starAndAsk(starOffer);
              }}
            />
            <Button
              title="Not now"
              size="sm"
              variant="outline"
              disabled={starOffer.busy}
              onPress={() => {
                onStarOfferTap?.('alerts_not_now');
                flow.dismissStarOffer();
              }}
            />
          </View>
        </View>
      ) : null}
      {/* Always mounted, so a screen reader hears the star offer's result. */}
      <View aria-live="polite">{alertsResult ? <Text style={[t.sub, S.gapSm]}>{alertsResult}</Text> : null}</View>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
    gapSm: { marginTop: SPACE.xs, marginBottom: SPACE.xs },
    offer: { marginTop: SPACE.sm, paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: c.border },
  });
}

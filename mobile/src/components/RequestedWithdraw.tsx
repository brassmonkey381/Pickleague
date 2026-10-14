// "Requested · Withdraw": the done state of a private league's [Request], on
// LeagueJoinButton (Play rows, Home JOIN A LEAGUE) and LeagueJoinCard
// (LeagueDetail / LeagueMembers). Withdraw asks first, then calls
// useLeagueJoin().withdraw (withdraw_league_join_request).
//
// Same 44px-tall box as the button it replaces, so the row doesn't jump.
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ConfirmModal } from '@just-messin-around/expo-foundation/ui';
import { SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import type { UseLeagueJoin } from '../lib/useLeagueJoin';

type Props = {
  leagueId: string;
  leagueName: string;
  leagueJoin: UseLeagueJoin;
  /** The status word. Default 'Requested'. */
  label?: string;
};

export default function RequestedWithdraw({ leagueId, leagueName, leagueJoin, label = 'Requested' }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [confirming, setConfirming] = useState(false);
  const busy = leagueJoin.isBusy(leagueId);

  return (
    <View style={styles.box}>
      <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {label} ·{' '}
      </Text>
      <Pressable
        onPress={() => setConfirming(true)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Withdraw your request to join ${leagueName}`}
        style={styles.hit}
      >
        <Text style={[t.meta, { color: c.primary, opacity: busy ? 0.5 : 1 }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          Withdraw
        </Text>
      </Pressable>
      <ConfirmModal
        visible={confirming}
        title="Withdraw your request?"
        body={`The admins of "${leagueName}" won't see it anymore. You can ask again later.`}
        primaryLabel="Withdraw"
        cancelLabel="Keep it"
        variant="danger"
        busy={busy}
        onConfirm={() => {
          void leagueJoin.withdraw(leagueId).finally(() => setConfirming(false));
        }}
        onClose={() => setConfirming(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  // A real 44 target (RNW ignores hitSlop).
  hit: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});

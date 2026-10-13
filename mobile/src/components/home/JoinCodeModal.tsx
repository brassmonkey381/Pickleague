// "Enter code" from Home's JOIN A LEAGUE: one field, redeemed through the same
// useLeagueJoin.redeemCode as Play's Join-with-Code (same RPC, same copy).
// Errors render inline here; success closes the sheet and the hook's onJoined
// reloads Home (a league code moves the league into YOURS; a tournament code
// opens that tournament).
import React, { useEffect, useState } from 'react';
import { ConfirmModal } from '@just-messin-around/expo-foundation/ui';
import { TextField } from '@just-messin-around/expo-foundation/forms';
import type { RedeemedInviteCode, UseLeagueJoin } from '../../lib/useLeagueJoin';

type Props = {
  visible: boolean;
  leagueJoin: UseLeagueJoin;
  onClose: () => void;
  onRedeemed: (r: RedeemedInviteCode) => void;
};

export default function JoinCodeModal({ visible, leagueJoin, onClose, onRedeemed }: Props) {
  const [code, setCode] = useState('');

  // A fresh field each time it opens.
  useEffect(() => {
    if (visible) {
      setCode('');
      leagueJoin.setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [visible]);

  async function submit() {
    if (leagueJoin.joining) return;
    const redeemed = await leagueJoin.redeemCode(code);
    if (!redeemed) return;
    onRedeemed(redeemed);
  }

  return (
    <ConfirmModal
      visible={visible}
      title="Join with a code"
      body="Enter the invite code a league admin shared with you."
      primaryLabel={leagueJoin.joining ? 'Joining…' : 'Join'}
      cancelLabel="Cancel"
      busy={leagueJoin.joining}
      error={leagueJoin.error || null}
      primaryDisabled={code.trim().length === 0}
      extraField={
        <TextField
          value={code}
          onChangeText={setCode}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={() => { void submit(); }}
          returnKeyType="go"
          accessibilityLabel="Invite code"
        />
      }
      onConfirm={() => { void submit(); }}
      onClose={onClose}
    />
  );
}

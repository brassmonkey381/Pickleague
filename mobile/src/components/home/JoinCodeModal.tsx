// "Join with a code": one flow for Home's JOIN A LEAGUE [Enter code] and the
// Leagues screen's Enter code (PKL-031; they were a confirm dialog and a
// full-page sheet). The kit's CodeEntrySheet (a band sheet, Paste, the error
// inline), redeemed through useLeagueJoin.redeemCode (same RPC, same copy).
// Success closes the sheet; the hook's onJoined reloads the caller (a league
// code moves the league into YOURS; a tournament code opens that tournament).
import React, { useEffect, useState } from 'react';
import { CodeEntrySheet } from '@just-messin-around/expo-foundation/ui';
import type { RedeemedInviteCode, UseLeagueJoin } from '../../lib/useLeagueJoin';

type Props = {
  visible: boolean;
  leagueJoin: UseLeagueJoin;
  onClose: () => void;
  onRedeemed: (r: RedeemedInviteCode) => void;
  /** Called once the sheet has fully closed (open a follow-up from here). */
  onDismissed?: () => void;
  /** A code to start with (a shared link's code). */
  initialCode?: string;
};

/** Invite codes are hex groups joined by dashes (3F7A-B2C9-D1E4). */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z-]/g, '').toUpperCase();
}

export default function JoinCodeModal({ visible, leagueJoin, onClose, onRedeemed, onDismissed, initialCode }: Props) {
  const [code, setCode] = useState('');

  // A fresh field each time it opens.
  useEffect(() => {
    if (visible) {
      setCode(initialCode ? normalizeInviteCode(initialCode) : '');
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
    <CodeEntrySheet
      visible={visible}
      onClose={() => {
        leagueJoin.setError('');
        onClose();
      }}
      onDismissed={onDismissed}
      title="Join with a code"
      subtitle="Leagues, ladders and tournaments all use the same code."
      label="Invite code"
      placeholder="3F7A-B2C9"
      value={code}
      onChangeText={(v) => {
        setCode(v);
        if (leagueJoin.error) leagueJoin.setError('');
      }}
      normalize={normalizeInviteCode}
      onSubmit={() => { void submit(); }}
      submitLabel="Join"
      busySubmitLabel="Joining…"
      busy={leagueJoin.joining}
      error={leagueJoin.error || null}
    />
  );
}

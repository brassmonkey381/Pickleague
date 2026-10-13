import React from 'react';
import { View } from 'react-native';
import { Tournament } from '../../types';
import { ManageRow, type ManageRowItem } from './TournamentManageSection';
import type { TournamentDetailState } from './useTournamentDetail';

type Props = { tournament: Tournament } & Pick<TournamentDetailState,
  | 'generatedMatches' | 'locking' | 'doLockIn' | 'simulating' | 'simulateFillMatches' | 'deleteTournament'
  | 'godmodeApproveAllInvitees' | 'godmodeForceCreateTeams' | 'godmodeAutoGeneratePreview'>;

/**
 * Godmode test helpers (developer account only; the caller gates it): setup
 * shortcuts during registration, random-score auto-fill, and delete. Since
 * P5b they are the "Developer" group at the end of Manage, as plain 44px rows
 * (the purple cards were the only hex colours left on the screen).
 */
export default function GodmodePanel({
  tournament, generatedMatches, locking, doLockIn, simulating, simulateFillMatches, deleteTournament,
  godmodeApproveAllInvitees, godmodeForceCreateTeams, godmodeAutoGeneratePreview,
}: Props) {
  const rows: ManageRowItem[] = [];
  if (tournament.status === 'registration') {
    rows.push({ key: 'approve-all', label: '✅ Force-approve all invitees', onPress: godmodeApproveAllInvitees });
    if (tournament.match_type === 'doubles' || tournament.format === 'mlp' || tournament.format === 'mlp_random') {
      rows.push({ key: 'force-teams', label: '🤝 Force-create teams', onPress: godmodeForceCreateTeams });
    }
    rows.push({ key: 'auto-preview', label: '🎯 Auto-generate bracket preview', onPress: godmodeAutoGeneratePreview });
    if (generatedMatches && generatedMatches.length > 0) {
      rows.push({
        key: 'lock',
        label: locking ? 'Locking in…' : `🔒 Lock in bracket (${generatedMatches.length} matches) & notify`,
        onPress: () => doLockIn(),
        disabled: locking,
        attention: true,
      });
    }
  }
  rows.push({
    key: 'simulate',
    label: simulating ? 'Filling…' : '🎲 Auto-fill pending matches with random scores',
    meta: 'PLUPR fires per update',
    onPress: simulateFillMatches,
    disabled: simulating,
  });
  rows.push({ key: 'delete', label: '🗑  Delete tournament', onPress: deleteTournament, danger: true });
  return (
    <View>
      {rows.map((r, i) => <ManageRow key={r.key} row={r} first={i === 0} />)}
    </View>
  );
}

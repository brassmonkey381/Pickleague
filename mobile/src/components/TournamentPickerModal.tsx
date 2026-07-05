// Thin wrapper over the foundation's generic SingleSelectModal. Keeps the
// Pickleague-specific copy + the original prop API so call sites are unchanged.
import React from 'react';
import { SingleSelectModal } from '@just-messin-around/expo-foundation/ui';

// status/league_id are carried so callers can filter the candidate list
// (e.g. to active tournaments within the selected league); the modal itself
// only renders id + name.
export type PickableTournament = { id: string; name: string; status?: string; league_id?: string | null };

type Props = {
  visible: boolean;
  tournaments: PickableTournament[];
  selectedId: string | null;
  // null selects the "(none)" option (clears the tag).
  onPick: (id: string | null) => void;
  onClose: () => void;
};

// Always offers a "(none)" row so the user can clear the tag. Candidate list is
// supplied by the caller (already filtered to tournaments all selected players
// are approved registrants of).
export default function TournamentPickerModal({ visible, tournaments, selectedId, onPick, onClose }: Props) {
  return (
    <SingleSelectModal
      visible={visible}
      title="Tag a tournament"
      items={tournaments}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
      searchPlaceholder="Search tournaments…"
      noneLabel="(none)"
    />
  );
}

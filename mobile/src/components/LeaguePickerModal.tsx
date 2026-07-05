// Thin wrapper over the foundation's generic SingleSelectModal. Keeps the
// Pickleague-specific copy + the original prop API so call sites are unchanged.
import React from 'react';
import { SingleSelectModal } from '@just-messin-around/expo-foundation/ui';

export type PickableLeague = { id: string; name: string };

type Props = {
  visible: boolean;
  leagues: PickableLeague[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
};

// Candidate list is supplied by the caller (already filtered to leagues all
// selected players belong to).
export default function LeaguePickerModal({ visible, leagues, selectedId, onPick, onClose }: Props) {
  return (
    <SingleSelectModal
      visible={visible}
      title="Choose a league"
      items={leagues}
      selectedId={selectedId}
      onPick={(id) => { if (id) onPick(id); }}
      onClose={onClose}
      searchPlaceholder="Search leagues…"
      emptyText={
        leagues.length === 0
          ? 'No league has all the selected players as members.'
          : 'No matches.'
      }
    />
  );
}

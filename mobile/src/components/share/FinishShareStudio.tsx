// The season / tournament finish share card (PKL-013): the finish as a
// ShareCardModel (lib/shareCards finishCardModel) in the shared studio
// (PickleShareStudio: looks, layouts, banners, logo, photos, the Story link
// guide). Callers show the entry button only when isImageShareAvailable().
//
// Privacy (lib/finishShare.ts): other players are "First L." with initials,
// never photos; blocked and deleted players are "a player"; the podium is off
// by default.
import React from 'react';
import { finishCardModel } from '../../lib/shareCards';
import type { FinishShareData } from '../../lib/finishShare';
import PickleShareStudio from './PickleShareStudio';

type Props = {
  visible: boolean;
  onClose: () => void;
  data: FinishShareData;
};

export default function FinishShareStudio({ visible, onClose, data }: Props) {
  const model = React.useMemo(() => finishCardModel(data), [data]);
  return (
    <PickleShareStudio
      visible={visible}
      onClose={onClose}
      title="Share your finish"
      model={model}
      trackProps={{ finish: data.kind, rank: data.rank }}
    />
  );
}

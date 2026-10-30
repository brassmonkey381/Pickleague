// The drill share card (PKL-013): "I put in the work". Loads the drill's facts
// (data/drillShare) when `target` is set, then opens the shared studio on them
// (lib/shareCards drillCardModel, the Put in the work layout first). Callers
// show the entry only when isImageShareAvailable().
import React from 'react';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useToast } from '../../lib/useToast';
import { useBlockedIds } from '../../lib/moderation';
import { loadDrillShare } from '../../data/drillShare';
import { releasePayoutRain } from '../../lib/payoutRain';
import { drillCardModel, type ShareCardModel } from '../../lib/shareCards';
import PickleShareStudio from './PickleShareStudio';

export type DrillShareTarget = { playSessionId?: string | null; drillSessionId?: string | null };

type Props = {
  /** The drill to share; null: closed. */
  target: DrillShareTarget | null;
  onClose: () => void;
};

export default function DrillShareStudio({ target, onClose }: Props) {
  const toast = useToast();
  const blocked = useBlockedIds();
  const [model, setModel] = React.useState<ShareCardModel | null>(null);
  const [open, setOpen] = React.useState(false);
  const key = target ? `${target.playSessionId ?? ''}|${target.drillSessionId ?? ''}` : '';

  React.useEffect(() => {
    if (!target) {
      setOpen(false);
      return;
    }
    let alive = true;
    loadDrillShare(target, blocked)
      .then((d) => {
        if (!alive) return;
        setModel(drillCardModel(d));
        setOpen(true);
      })
      .catch((e) => {
        if (!alive) return;
        toast.error(friendlySbMessage(e, "Couldn't load that drill. Try again."));
        releasePayoutRain();
        onClose();
      });
    return () => { alive = false; };
    // Load once per drill; `blocked` changing mid-load doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!model) return null;
  return (
    <PickleShareStudio
      visible={open}
      onClose={() => {
        setOpen(false);
        // The review's pickles, held while this studio covered the screen.
        releasePayoutRain();
        onClose();
      }}
      title="Share your drill"
      model={model}
      trackProps={{ drill: true }}
    />
  );
}

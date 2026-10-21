// "Replace a starred court?": Doggle's full-list flow (ReplaceFavoriteModal +
// replace_user_favorite) for court stars. A star refused because 3 courts are
// starred opens a sheet with the 3; picking one swaps it for the new court in
// one server call (replace_court_favorite), then does what an unstar and a
// star do: the dropped court's waiting arrival notices go, and the phone
// re-picks the courts it watches (courtStarsChanged).
//
// The sheet is the kit's ActionSheetModal (title, line, a row per court,
// Cancel). The write starts once the sheet has fully closed (onDismissed), so
// a follow-up modal (the "Always" offer) can open on iOS.
import React, { useRef, useState } from 'react';
import { ActionSheetModal } from '@just-messin-around/expo-foundation/ui';
import { peekQuery, setQueryData } from '@just-messin-around/expo-foundation/cache';
import {
  COURT_FAVORITES_KEY,
  listMyCourtFavorites,
  replaceCourtFavorite,
  type CourtFavorite,
} from '../../data/courtFavorites';
import { replaceSheetCopy } from '../../lib/courtStarReplace';
import { dropWaitingArrivalNotices } from '../../lib/courtArrivalNotice';
import { courtStarsChanged } from '../../lib/courtArrivalAsk';
import { explainRefusal } from '../../lib/refusalNotices';
import { useToast } from '../../lib/useToast';

type Offer = {
  venueId: string;
  venueName?: string | null;
  stars: CourtFavorite[];
  /** After the sheet: true once the new court is starred, false on Cancel or a refused replace. */
  onDone?: (replaced: boolean) => void;
};

export function useReplaceCourtStar() {
  const toast = useToast();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [visible, setVisible] = useState(false);
  // The court picked in the sheet, replaced once the sheet has closed.
  const picked = useRef<string | null>(null);

  /**
   * Open the sheet for a court the cap refused (isCourtFavoritesFullError).
   * Reads the starred list fresh, as Doggle does. False when there's no list
   * to offer: the caller shows the refusal instead.
   */
  async function offerReplace(
    venueId: string,
    venueName?: string | null,
    onDone?: (replaced: boolean) => void,
  ): Promise<boolean> {
    let stars: CourtFavorite[] | undefined;
    try {
      stars = await listMyCourtFavorites();
      setQueryData(COURT_FAVORITES_KEY, stars);
    } catch {
      stars = peekQuery<CourtFavorite[]>(COURT_FAVORITES_KEY);
    }
    if (!stars?.length) return false;
    picked.current = null;
    setOffer({ venueId, venueName, stars, onDone });
    setVisible(true);
    return true;
  }

  async function replace(o: Offer, removeId: string) {
    const name = o.venueName?.trim() || 'That court';
    const old = o.stars.find((s) => s.venue_id === removeId)?.venue_name?.trim() || 'a court';
    try {
      await replaceCourtFavorite(removeId, o.venueId, o.venueName);
      // Unstarred: the server skips an arrival still waiting there now.
      void dropWaitingArrivalNotices(removeId);
      courtStarsChanged();
      toast.success(`${name} is one of your courts now, in place of ${old}.`);
      o.onDone?.(true);
    } catch (e) {
      toast.error(
        explainRefusal(e, "Couldn't replace that court just now. Try again.", { action: 'favorite', venueName: o.venueName }),
      );
      o.onDone?.(false);
    }
  }

  function dismissed() {
    const o = offer;
    const id = picked.current;
    picked.current = null;
    setOffer(null);
    if (!o) return;
    if (id) void replace(o, id);
    else o.onDone?.(false);
  }

  const copy = offer ? replaceSheetCopy(offer.stars, offer.venueName) : null;
  const sheet = copy ? (
    <ActionSheetModal
      visible={visible}
      title={copy.title}
      subtitle={copy.subtitle}
      actions={copy.rows.map((r) => ({
        label: r.label,
        onPress: () => {
          picked.current = r.venueId;
        },
      }))}
      onClose={() => setVisible(false)}
      onDismissed={dismissed}
    />
  ) : null;

  return { offerReplace, sheet };
}

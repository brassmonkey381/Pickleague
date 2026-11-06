// "You're home!" (supabase/migration_place_stays.sql): a stay at a friend's
// My Place ran its 4 hours. Each Home focus claims my finished stays
// (claim_place_stay_returns settles them and marks each one seen as it hands
// it over), then shows them one at a time with the kit's RewardRevealModal:
// my avatar, the souvenir line, the pickles, the Court Pass pickleballs (a
// cycle was running), and the decor the stay brought back, if any. The queue
// is the kit's useStayReturns (1.107): rows that arrive after a blur are kept,
// since the server won't hand them over again. Held while Home has another
// pop-up up (`enabled`), since a second Modal on iOS is dropped unseen.
import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { RewardRevealModal } from '@just-messin-around/expo-foundation/gamification';
import { useStayReturns } from '@just-messin-around/expo-foundation/stays';
import { RoomArt } from '@just-messin-around/expo-foundation/room';
import { createArtResolver } from '@just-messin-around/expo-foundation/room/art';
import { rarityColors, rarityLabel } from '@just-messin-around/expo-foundation/room/shop';
import { useTheme } from '../../lib/ThemeContext';
import { avatarLook } from '../../lib/myPlace';
import { returnMessage, returnTitle, type PlaceStayReturn } from '../../lib/placeStays';
import { claimPlaceStayReturns } from '../../data/placeStays';
import { useItemArt, useMyPlaceCatalog, usePlaceOwner } from '../../data/myPlace';
import { AVATARS } from '../../data/profileCustomization';
import MyPlaceAvatar from './MyPlaceAvatar';

const AVATAR_BOX = { left: 0, top: 0, width: 72, height: 90 };
const ITEM_SIZE = 72;
const pickles = (n: number) => `+${n.toLocaleString()}`;

export default function PlaceStayReturnHost({
  meId,
  enabled,
  onClaimed,
  onShowingChange,
  onClose,
}: {
  meId: string | null;
  /** False holds the card (another pop-up is up, or Home isn't focused). */
  enabled: boolean;
  /** Pickles changed: re-read the balance. */
  onClaimed?: () => void | Promise<void>;
  /** True while a card is up (so Home holds its other prompts). */
  onShowingChange?: (showing: boolean) => void;
  /** A card closed (Home hands off before its next pop-up). */
  onClose?: () => void;
}) {
  const { colors: c } = useTheme();
  const r = useStayReturns<PlaceStayReturn>({
    claim: claimPlaceStayReturns,
    keyOf: (x) => x.stay_id,
    enabled: enabled && !!meId,
    onClaimed: () => onClaimed?.(),
    rainAmountOf: (x) => x.pickles,
    onShowingChange,
  });
  const claim = r.claim;
  useFocusEffect(useCallback(() => (meId ? claim() : undefined), [meId, claim]));

  const current = r.current;
  const me = usePlaceOwner(current ? meId : null);
  const look = useMemo(() => avatarLook(me.data ?? null, AVATARS), [me.data]);

  // The decor it brought back: the catalog row and its art, only when there is one.
  const itemId = current?.item_id ?? null;
  const catalog = useMyPlaceCatalog(!!itemId);
  const art = useItemArt(useMemo(() => (itemId ? [itemId] : []), [itemId]));
  const resolveArt = useMemo(() => createArtResolver(), []);
  const item = useMemo(() => {
    const row = itemId ? catalog.data?.items.find((i) => i.id === itemId) ?? null : null;
    const svg = itemId ? art[itemId] : null;
    return row && svg && svg !== row.svg ? { ...row, svg } : row;
  }, [itemId, catalog.data, art]);

  if (!current) return null;
  const rarity = current.item_rarity ?? 'common';
  const aspect = item?.aspect ?? 1;
  return (
    <RewardRevealModal
      visible
      revealKey={current.stay_id}
      art={<View style={{ width: AVATAR_BOX.width, height: AVATAR_BOX.height }}><MyPlaceAvatar box={AVATAR_BOX} look={look} /></View>}
      title={returnTitle()}
      message={returnMessage(current)}
      amount={current.pickles}
      formatAmount={pickles}
      amountIconName="pickle"
      bonus={current.pickleballs > 0 ? { amount: current.pickleballs, iconName: 'pickleball', format: pickles } : null}
      item={
        current.item_id && current.item_name
          ? {
              label: 'You brought something back for your place!',
              name: current.item_name,
              art: item ? (
                <RoomArt
                  item={item}
                  resolveArt={resolveArt}
                  width={aspect >= 1 ? ITEM_SIZE : ITEM_SIZE * aspect}
                  height={aspect >= 1 ? ITEM_SIZE / aspect : ITEM_SIZE}
                />
              ) : undefined,
              tag: rarityLabel(rarity) ?? undefined,
              tagColor: rarityColors(c, rarity)?.accent,
            }
          : null
      }
      ctaLabel="Back to it"
      onClose={() => {
        r.dismiss();
        onClose?.();
      }}
    />
  );
}

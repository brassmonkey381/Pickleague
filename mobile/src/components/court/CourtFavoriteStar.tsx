// ☆ / ★ "one of my courts" toggle, in its own 44 box. Up to 5 courts; a 6th
// says so in a toast instead of failing quietly. Starred courts head Home's
// YOUR COURTS, and they are where court arrival checks you in when you arrive
// (lib/courtGeofence watches them; each change re-picks the watched courts).
//
// Starring a court while the phone doesn't have "Always" location offers to
// ask for it (decision D2: asked when starring, never on app open), behind a
// short offer so the OS sheet never appears unexplained. Once per run of the
// app: a player who said Not now isn't asked at every star (Settings >
// Check-in automation has Allow). Unstarring takes down that court's waiting
// arrival notices: the server no longer checks in there.
//
// Renders nothing while COURT_STARS_ENABLED is off.
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { ConfirmModal } from '@just-messin-around/expo-foundation/ui';
import { COURT_STARS_ENABLED } from '../../lib/features';
import { explainRefusal } from '../../lib/refusalNotices';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { toggleCourtFavorite, useCourtFavorites } from '../../data/courtFavorites';
import { dropWaitingArrivalNotices } from '../../lib/courtArrivalNotice';
import {
  ALWAYS_LABEL,
  arrivalSyncMessage,
  askForArrivalLocation,
  autoCheckinOff,
  backgroundLocationAllowed,
  courtStarsChanged,
  noticeMeOff,
} from '../../lib/courtArrivalAsk';

// Set when the offer is shown, so one run of the app makes it at most once.
let offeredThisRun = false;

type Props = {
  venueId: string;
  /** For the toast and the screen-reader label. */
  venueName?: string | null;
  style?: StyleProp<ViewStyle>;
};

export default function CourtFavoriteStar(props: Props) {
  return COURT_STARS_ENABLED ? <CourtFavoriteStarBody {...props} /> : null;
}

function CourtFavoriteStarBody({ venueId, venueName, style }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();
  const { data: favorites } = useCourtFavorites();
  const starred = !!favorites?.some((f) => f.venue_id === venueId);
  const [busy, setBusy] = useState(false);
  // The "Always" offer after a star: null, shown, or asking the OS.
  const [offer, setOffer] = useState<null | 'ask' | 'busy'>(null);
  const name = venueName?.trim() || 'this court';

  async function toggle() {
    if (busy) return;
    setBusy(true);
    // Read before the write patches the list.
    const adding = !starred;
    try {
      await toggleCourtFavorite(venueId, adding, venueName);
      toast.success(adding ? `${name} is one of your courts now.` : `${name} is off your courts.`);
      // Unstarred: the server skips an arrival still waiting here now.
      if (!adding) void dropWaitingArrivalNotices(venueId);
      courtStarsChanged();
      // Only when asking could help and the offer says what will happen:
      // native, "Notice me" not Off, "Check me in when I arrive" not off, the
      // OS says "Always" is missing (unknown: don't ask), and not offered yet
      // in this run of the app.
      if (
        adding &&
        !offeredThisRun &&
        Platform.OS !== 'web' &&
        !noticeMeOff() &&
        !autoCheckinOff() &&
        (await backgroundLocationAllowed()) === false
      ) {
        offeredThisRun = true;
        setOffer('ask');
      }
    } catch (e) {
      // Why (the 5-court cap, a court that's gone), then what to do.
      toast.error(explainRefusal(e, "Couldn't change your courts just now. Try again.", { action: 'favorite', venueName }));
    } finally {
      setBusy(false);
    }
  }

  // Not bounded: the player may sit on the OS sheet.
  async function allow() {
    setOffer('busy');
    const r = await askForArrivalLocation();
    setOffer(null);
    const m = arrivalSyncMessage(r, { noticeOff: noticeMeOff() });
    if (m.ok) toast.success(m.message);
    else toast.error(m.message);
  }

  return (
    <>
      <TouchableOpacity
        style={[S.box, style]}
        onPress={() => void toggle()}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityState={{ selected: starred, busy }}
        accessibilityLabel={starred ? `Remove ${name} from your courts` : `Add ${name} to your courts`}
      >
        <Text style={[S.glyph, { color: starred ? c.warning : c.textMuted }]}>{starred ? '★' : '☆'}</Text>
      </TouchableOpacity>
      <ConfirmModal
        visible={offer !== null}
        title="Check in when you arrive?"
        body={`Pickleague can check you in at ${name} when you arrive and stay a minute. Leave within 5 minutes and it doesn't count. It needs location set to "${ALWAYS_LABEL}".`}
        primaryLabel="Allow"
        cancelLabel="Not now"
        busy={offer === 'busy'}
        onConfirm={() => void allow()}
        onClose={() => setOffer(null)}
      />
    </>
  );
}

const S = StyleSheet.create({
  box: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: FONT.size.h2, lineHeight: FONT.size.h1 },
});

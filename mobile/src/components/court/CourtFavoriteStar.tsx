// ☆ / ★ "one of my courts" toggle, in its own 44 box. Up to 5 courts; a 6th
// says so in a toast instead of failing quietly. Starred courts head Home's
// YOUR COURTS and the arrival-alert fences (re-synced after each change).
// Renders nothing while FRIENDS_AT_COURTS_ENABLED is off.
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { toggleCourtFavorite, useCourtFavoriteIds } from '../../data/courtFavorites';
import { syncCourtGeofences } from '../../lib/courtGeofence';

type Props = {
  venueId: string;
  /** For the toast and the screen-reader label. */
  venueName?: string | null;
  style?: StyleProp<ViewStyle>;
};

export default function CourtFavoriteStar(props: Props) {
  return FRIENDS_AT_COURTS_ENABLED ? <CourtFavoriteStarBody {...props} /> : null;
}

function CourtFavoriteStarBody({ venueId, venueName, style }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();
  const starred = useCourtFavoriteIds().has(venueId);
  const [busy, setBusy] = useState(false);
  const name = venueName?.trim() || 'this court';

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await toggleCourtFavorite(venueId, !starred, venueName);
      toast.success(starred ? `${name} is off your courts.` : `${name} is one of your courts now.`);
      // Arrival alerts fence starred courts too (0 at once on web or with alerts off; never throws).
      void syncCourtGeofences();
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't change your courts just now."));
    } finally {
      setBusy(false);
    }
  }

  return (
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
  );
}

const S = StyleSheet.create({
  box: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: FONT.size.h2, lineHeight: FONT.size.h1 },
});

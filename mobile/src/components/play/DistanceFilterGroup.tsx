// The Filters sheet's Distance group (a FilterSheet `custom` group), shared by
// Play > Leagues and Play > Tournaments.
//
// THE ONLY PLACE THE APP ASKS FOR LOCATION (plan section 4). Without a
// location it shows a "Use my location" button:
//   tap -> LocationUseConfirmModal (our copy) -> requestForegroundLocationPermission()
//       -> granted: read a fix, share it with both lists, pick 25 mi
//       -> denied:  a "Location is off" confirm with Open settings.
// With a location it shows the radius chips (Any / 5 / 10 / 25 / 50 mi).
//
// Both confirms are rendered INSIDE the sheet's tree, not beside it. The sheet
// is an RN Modal, and iOS presents only one Modal at a time unless the second
// is a descendant of the first (then it is presented from it). A sibling
// Modal opened over the sheet would silently never appear on iOS.
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import {
  FilterChipRow,
  LocationDeniedModal,
  LocationUseConfirmModal,
  type FilterSheetRenderContext,
} from '@just-messin-around/expo-foundation/ui';
import {
  getCurrentCoords,
  openLocationSettings,
  requestForegroundLocationPermission,
} from '@just-messin-around/expo-foundation/platform/location';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { DISTANCE_OPTIONS, distanceMiles, type LatLng } from '../../lib/playFilters';
import { afterModalClose } from './afterModalClose';

const RADIUS_OPTIONS = [
  { value: 'any', label: 'Any' },
  ...DISTANCE_OPTIONS.map((o) => ({ value: o, label: `${o} mi` })),
];

/** The radius picked automatically once location is granted. */
const FIRST_RADIUS = '25';

export type DistanceFilterGroupProps = {
  ctx: FilterSheetRenderContext;
  coords: LatLng | null;
  onCoords: (coords: LatLng) => void;
  /** 'leagues' | 'tournaments', for the copy. */
  noun: string;
};

export default function DistanceFilterGroup({ ctx, coords, onCoords, noun }: DistanceFilterGroupProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [noFix, setNoFix] = useState(false);
  const isWeb = Platform.OS === 'web';

  // Web Escape with a confirm open: the sheet's BottomSheet listens for Escape
  // on window keydown with no stacking, so it would close the whole sheet (and
  // its draft) along with the confirm. Swallow keydown in the capture phase;
  // RNW's Modal still closes only the topmost confirm on keyup.
  // FOUNDATION-TODO: drop useEscapeKey from BottomSheet (RNW Modal's
  // onRequestClose already handles Escape, topmost only), then remove this.
  const nestedOpen = confirmOpen || blockedOpen;
  useEffect(() => {
    if (Platform.OS !== 'web' || !nestedOpen) return;
    const swallow = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopImmediatePropagation(); };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  }, [nestedOpen]);

  const allow = async () => {
    setBusy(true);
    setNoFix(false);
    try {
      const granted = await requestForegroundLocationPermission();
      if (!granted) {
        setConfirmOpen(false);
        afterModalClose(() => setBlockedOpen(true));
        return;
      }
      const fix = await getCurrentCoords({ fallbackToLastKnown: true });
      setConfirmOpen(false);
      if (!fix) { setNoFix(true); return; }
      onCoords({ lat: fix.lat, lng: fix.lng });
      // A radius is what the user came for; Any would make the tap look dead.
      if (distanceMiles(ctx.value) == null) ctx.setValue(FIRST_RADIUS);
    } catch {
      setConfirmOpen(false);
      setNoFix(true);
    } finally {
      setBusy(false);
    }
  };

  const current = typeof ctx.value === 'string' && ctx.value ? ctx.value : 'any';
  const savedRadius = distanceMiles(ctx.value);

  return (
    <View>
      {coords ? (
        <FilterChipRow
          size="md"
          scrollable={false}
          options={RADIUS_OPTIONS}
          value={current}
          onChange={(v) => ctx.setValue(v)}
        />
      ) : (
        <View style={styles.ask}>
          <Text style={t.hint} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {noFix
              ? "Couldn't find your location. Try again outside or with Wi-Fi on."
              : savedRadius != null
                // A radius saved on an earlier visit is kept but not in effect
                // (lib/playFilters sheetInEffect): say why it isn't applied.
                ? `Your ${savedRadius} mi radius applies once location is on.`
                : `Show ${noun} near you. Your location is only read while you browse.`}
          </Text>
          <Button
            size="sm"
            variant="outline"
            iconName="pin"
            title="Use my location"
            onPress={() => setConfirmOpen(true)}
            style={styles.hug}
          />
        </View>
      )}

      <LocationUseConfirmModal
        visible={confirmOpen}
        context="place"
        title="Use your location?"
        body={`Pickleague uses it to show ${noun} near you and sort them by distance. It isn't saved to your profile or shared.`}
        allowLabel="Use my location"
        skipLabel="Not now"
        busy={busy}
        onAllow={() => { void allow(); }}
        onSkip={() => setConfirmOpen(false)}
        onClose={() => { if (!busy) setConfirmOpen(false); }}
      />

      {/* The foundation's denied modal (a ConfirmModal, so still an RN Modal:
          it stays in the sheet's tree, see the header) with our copy. On web
          there is no settings screen to open, so its primary is just OK. */}
      <LocationDeniedModal
        visible={blockedOpen}
        title="Location is off"
        body={isWeb
          ? `Allow location for this site in your browser settings, then tap Use my location again to see ${noun} near you.`
          : `Turn on location for Pickleague in Settings to see ${noun} near you.`}
        primaryLabel={isWeb ? 'OK' : 'Open settings'}
        cancelLabel="Not now"
        onOpenSettings={() => {
          setBlockedOpen(false);
          if (!isWeb) void openLocationSettings();
        }}
        onContinueWithout={() => setBlockedOpen(false)}
        onClose={() => setBlockedOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ask: { gap: SPACE.xs },
  hug: { alignSelf: 'flex-start' },
});

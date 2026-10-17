// Godmode-only: draw or fix one court's outline on an OpenStreetMap basemap
// (the foundation's BoundaryEditorMap), then save it through
// admin_save_venue_boundary. Inside the outline a check-in passes however far
// the pin is; the 100 m circle around the pin still counts too. Mirrors
// Doggle's AdminBoundaryEditorScreen.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View, ActivityIndicator, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { BoundaryEditorMap, outerRing, ringToPolygon, ConfirmModal } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import type { LatLng } from '@just-messin-around/expo-foundation/platform/location';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import EmptyState from '../components/EmptyState';
import type { RootStackParamList } from '../types';
import { amIGodmode, adminSaveVenueBoundary, fetchVenueForBoundary, type VenueForBoundary } from '../data/venueAdmin';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AdminBoundaryEditor'>;
  route: RouteProp<RootStackParamList, 'AdminBoundaryEditor'>;
};

export default function AdminBoundaryEditorScreen({ navigation, route }: Props) {
  const { venueId } = route.params;
  const { colors: c } = useTheme();
  const toast = useToast();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [venue, setVenue] = useState<VenueForBoundary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ring, setRing] = useState<LatLng[]>([]);
  const [area, setArea] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // The editor keeps its own ring; a removal remounts it empty.
  const [seed, setSeed] = useState<LatLng[]>([]);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const ok = await amIGodmode();
      if (!live) return;
      setAuthorized(ok);
      if (!ok) return;
      try {
        const v = await fetchVenueForBoundary(venueId);
        if (!live) return;
        setVenue(v);
        setRing(outerRing(v?.boundary));
        setSeed(outerRing(v?.boundary));
        setArea(v?.area_sqm ?? null);
        if (v) navigation.setOptions({ title: v.name });
      } catch (e) {
        toast.error((e as Error)?.message ?? "Couldn't load the court.");
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  async function save(next: LatLng[]) {
    setSaving(true);
    try {
      const res = await adminSaveVenueBoundary(venueId, ringToPolygon(next));
      setArea(res.area_sqm);
      if (!res.has_boundary) {
        setRing([]);
        setSeed([]);
        setRev((r) => r + 1);
      }
      if (!res.has_boundary) toast.success('Outline removed. Check-ins use the 100 m circle again.');
      else if (!res.pin_inside) toast.success("Saved. The court's pin is outside the outline; that's fine if the outline is the building.");
      else toast.success('Outline saved. Check-ins anywhere inside it now pass.');
    } catch (e) {
      toast.error((e as Error)?.message ?? "Couldn't save the outline.");
    } finally {
      setSaving(false);
    }
  }

  if (authorized === null || (authorized && !loaded)) return <ActivityIndicator style={styles.center} color={c.primary} />;
  if (!authorized) return <EmptyState icon="🔒" title="Admin access required" subtitle="This screen is for app admins." />;
  if (!venue) return <EmptyState icon="🗺️" title="Court not found" subtitle="It may have been merged or removed." />;

  const canSave = ring.length >= 3;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <Text style={[styles.meta, { color: c.textSub }]}>
        {[venue.city, area != null ? `Outline ${Math.round(area).toLocaleString()} m²` : 'No outline yet', `${ring.length} points`]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <BoundaryEditorMap
        key={rev}
        initialRing={seed}
        centerFallback={{ lat: venue.lat, lng: venue.lng }}
        pin={{ lat: venue.lat, lng: venue.lng }}
        onRingChange={setRing}
      />
      <Text style={[styles.hint, { color: c.textSub }]}>
        Trace the building or fenced courts, not the parking lot. The red dot is the court's pin; arrival alerts still
        use a {venue.geofence_radius_m ?? 100} m circle around it.
      </Text>
      <View style={styles.actions}>
        <Button title="Save outline" variant="success" onPress={() => void save(ring)} loading={saving} disabled={!canSave} style={styles.flex} />
        {area != null ? (
          <Button title="Remove" variant="outline" onPress={() => setConfirmClear(true)} disabled={saving} />
        ) : null}
      </View>
      <ConfirmModal
        visible={confirmClear}
        title="Remove this outline?"
        body="Check-ins here go back to the 100 m circle around the pin."
        primaryLabel="Remove"
        variant="danger"
        onConfirm={() => { setConfirmClear(false); void save([]); }}
        onClose={() => setConfirmClear(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xl * 2 },
  meta: { fontSize: 13, fontWeight: FONT.weight.semibold },
  hint: { fontSize: 13, lineHeight: 18, marginTop: SPACE.sm },
  actions: { flexDirection: 'row', gap: SPACE.md, marginTop: SPACE.lg },
  flex: { flex: 1 },
});

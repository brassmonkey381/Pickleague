// Add a court the catalog is missing. Mirrors Doggle's SubmitDogPlaceScreen:
// captures a location (route params, GPS, or pasted coords), checks for a nearby
// unconfirmed submission ("same place?" affirm), and calls submit_venue. New
// submissions are source='user'/unconfirmed and show in search right away
// (ranked below confirmed) until a godmode admin confirms them.
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import {
  getCurrentCoords,
  requestForegroundLocationPermission,
  reverseGeocodeCoords,
} from '@just-messin-around/expo-foundation/platform';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import type { RootStackParamList } from '../types';
import {
  submitVenue,
  findNearbyVenueSubmissions,
  type NearbyVenueSubmission,
} from '../data/venueSubmissions';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SubmitVenue'>;
  route: RouteProp<RootStackParamList, 'SubmitVenue'>;
};

const SPORT_OPTIONS = ['pickleball', 'tennis', 'basketball', 'volleyball'];
const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'court', label: 'Court' },
  { value: 'sports_centre', label: 'Sports centre' },
  { value: 'gym', label: 'Gym' },
  { value: 'park', label: 'Park' },
];

type Coords = { lat: number; lng: number };
type Phase = 'form' | 'processing' | 'thanks';

function parseLatLng(s: string): Coords | null {
  const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export default function SubmitVenueScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const status = useStatusMessage();

  const paramCoords: Coords | null =
    route.params?.lat != null && route.params?.lng != null
      ? { lat: route.params.lat, lng: route.params.lng }
      : null;

  const [phase, setPhase] = useState<Phase>('form');
  const [coords, setCoords] = useState<Coords | null>(paramCoords);
  const [coordText, setCoordText] = useState('');
  const [locating, setLocating] = useState(false);
  const [name, setName] = useState('');
  const [sports, setSports] = useState<Set<string>>(new Set(['pickleball']));
  const [kind, setKind] = useState('court');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [nearby, setNearby] = useState<NearbyVenueSubmission[]>([]);
  const [busy, setBusy] = useState(false);

  // Whenever we have coordinates, look for an existing unconfirmed submission close by.
  useEffect(() => {
    let active = true;
    if (!coords) {
      setNearby([]);
      return;
    }
    findNearbyVenueSubmissions(coords.lat, coords.lng)
      .then((rows) => {
        if (active) setNearby(rows);
      })
      .catch(() => {
        if (active) setNearby([]);
      });
    return () => {
      active = false;
    };
  }, [coords]);

  async function useMyLocation() {
    setLocating(true);
    status.clear();
    try {
      const granted = await requestForegroundLocationPermission();
      if (!granted) {
        status.error('Location permission denied — paste coordinates instead.');
        return;
      }
      const gps = await getCurrentCoords();
      if (!gps) {
        status.error('Could not get your location — paste coordinates instead.');
        return;
      }
      setCoords({ lat: gps.lat, lng: gps.lng });
      // Best-effort prefill of address from a reverse geocode.
      try {
        const geo = await reverseGeocodeCoords(gps.lat, gps.lng);
        if (geo?.address && !address) setAddress(geo.address);
      } catch {
        /* non-fatal */
      }
    } finally {
      setLocating(false);
    }
  }

  function applyPastedCoords() {
    const parsed = parseLatLng(coordText);
    if (!parsed) {
      status.error('Paste coordinates as "lat, long" (e.g. 37.7749, -122.4194).');
      return;
    }
    status.clear();
    setCoords(parsed);
  }

  function toggleSport(s: string) {
    setSports((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function finish() {
    setPhase('processing');
    await new Promise((r) => setTimeout(r, 1200));
    setPhase('thanks');
  }

  async function affirm(match: NearbyVenueSubmission) {
    if (!coords) return;
    setBusy(true);
    status.clear();
    try {
      await submitVenue({
        name: match.name,
        lat: coords.lat,
        lng: coords.lng,
        sports: [...sports],
        affirmVenueId: match.id,
      });
      await finish();
    } catch (e: any) {
      status.error(e?.message ?? 'Could not link to the existing submission.');
    } finally {
      setBusy(false);
    }
  }

  async function submitNew() {
    if (!coords) {
      status.error('Set the court location first.');
      return;
    }
    if (!name.trim()) {
      status.error('Enter a name for this court.');
      return;
    }
    if (sports.size === 0) {
      status.error('Pick at least one sport.');
      return;
    }
    setBusy(true);
    status.clear();
    try {
      await submitVenue({
        name: name.trim(),
        lat: coords.lat,
        lng: coords.lng,
        sports: [...sports],
        kind,
        address: address.trim() || null,
        city: city.trim() || null,
      });
      await finish();
    } catch (e: any) {
      status.error(e?.message ?? 'Could not submit this court.');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'processing') {
    return (
      <View style={S.center}>
        <ActivityIndicator size="large" color={c.primary} />
        <Text style={S.processingText}>Submitting…</Text>
      </View>
    );
  }

  if (phase === 'thanks') {
    return (
      <View style={S.center}>
        <Text style={S.thanksEmoji}>🎾</Text>
        <Text style={S.thanksTitle}>Thanks!</Text>
        <Text style={S.thanksBody}>
          Your court was added and is searchable right away. An admin will confirm the details soon.
        </Text>
        <TouchableOpacity style={S.primaryBtn} onPress={() => navigation.goBack()}>
          <Text style={S.primaryBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
      <StatusBanner status={status.value} style={S.banner} />
      <Text style={S.intro}>
        Add a court we're missing. We'll list it right away as unconfirmed so you can use it while an
        admin verifies the details.
      </Text>

      {/* Location */}
      <Text style={S.label}>LOCATION</Text>
      {coords ? (
        <View style={S.coordsRow}>
          <Text style={S.coordsText}>📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
          <TouchableOpacity onPress={() => setCoords(null)}>
            <Text style={S.link}>Change</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={S.card}>
          <TouchableOpacity style={[S.secondaryBtn, locating && S.dim]} onPress={useMyLocation} disabled={locating}>
            {locating ? (
              <ActivityIndicator color={c.primary} size="small" />
            ) : (
              <Text style={S.secondaryBtnText}>📍 Use my location</Text>
            )}
          </TouchableOpacity>
          <Text style={S.orText}>or paste "lat, long" from a map</Text>
          <View style={S.pasteRow}>
            <TextInput
              style={[S.input, { flex: 1 }]}
              placeholder="37.7749, -122.4194"
              placeholderTextColor={c.textMuted}
              value={coordText}
              onChangeText={setCoordText}
              autoCapitalize="none"
            />
            <TouchableOpacity style={S.pasteBtn} onPress={applyPastedCoords}>
              <Text style={S.pasteBtnText}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* "Same place?" affirm prompt */}
      {coords && nearby.length > 0 ? (
        <View style={S.affirmCard}>
          <Text style={S.affirmTitle}>Same place as this?</Text>
          <Text style={S.affirmBody}>
            Someone already suggested “{nearby[0].name}” about {Math.round(nearby[0].distance_meters)} m
            from here.
          </Text>
          <TouchableOpacity style={[S.primaryBtn, busy && S.dim]} onPress={() => affirm(nearby[0])} disabled={busy}>
            <Text style={S.primaryBtnText}>Yes, it's this one</Text>
          </TouchableOpacity>
          <Text style={S.affirmHint}>Not it? Just fill in the form below to add a new court.</Text>
        </View>
      ) : null}

      {/* Name */}
      <Text style={S.label}>NAME</Text>
      <TextInput
        style={S.input}
        placeholder="e.g. Bay Club Pickleball Courts"
        placeholderTextColor={c.textMuted}
        value={name}
        onChangeText={setName}
      />

      {/* Sports */}
      <Text style={S.label}>SPORTS</Text>
      <View style={S.chipRow}>
        {SPORT_OPTIONS.map((s) => {
          const active = sports.has(s);
          return (
            <TouchableOpacity
              key={s}
              onPress={() => toggleSport(s)}
              style={[S.chip, { borderColor: active ? c.primary : c.border, backgroundColor: active ? c.primaryLight : c.surface }]}
            >
              <Text style={{ color: active ? c.primary : c.textSub, fontWeight: '600', fontSize: 13 }}>{s}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Kind */}
      <Text style={S.label}>TYPE</Text>
      <View style={S.chipRow}>
        {KIND_OPTIONS.map((k) => {
          const active = kind === k.value;
          return (
            <TouchableOpacity
              key={k.value}
              onPress={() => setKind(k.value)}
              style={[S.chip, { borderColor: active ? c.primary : c.border, backgroundColor: active ? c.primaryLight : c.surface }]}
            >
              <Text style={{ color: active ? c.primary : c.textSub, fontWeight: '600', fontSize: 13 }}>{k.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Address / city (optional) */}
      <Text style={S.label}>ADDRESS (OPTIONAL)</Text>
      <TextInput style={S.input} placeholder="Street address" placeholderTextColor={c.textMuted} value={address} onChangeText={setAddress} />
      <Text style={S.label}>CITY (OPTIONAL)</Text>
      <TextInput style={S.input} placeholder="City" placeholderTextColor={c.textMuted} value={city} onChangeText={setCity} />

      <TouchableOpacity style={[S.primaryBtn, S.submitBtn, busy && S.dim]} onPress={submitNew} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={S.primaryBtnText}>Submit court</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 16, backgroundColor: c.bg, flexGrow: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: c.bg },
    banner: { marginBottom: 12 },
    intro: { fontSize: 14, color: c.textSub, marginBottom: 16, lineHeight: 20 },
    label: { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 6, marginTop: 6 },
    card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, marginBottom: 8 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, backgroundColor: c.bg, color: c.text, marginBottom: 4 },
    coordsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 8 },
    coordsText: { fontSize: 15, color: c.text, fontWeight: '600' },
    link: { color: c.primary, fontWeight: '700', fontSize: 13 },
    secondaryBtn: { borderWidth: 1, borderColor: c.primary, borderRadius: 10, paddingVertical: 11, alignItems: 'center', backgroundColor: c.surface },
    secondaryBtnText: { color: c.primary, fontWeight: '700', fontSize: 15 },
    orText: { textAlign: 'center', color: c.textMuted, fontSize: 12, marginVertical: 8 },
    pasteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    pasteBtn: { backgroundColor: c.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
    pasteBtnText: { color: '#fff', fontWeight: '700' },
    affirmCard: { backgroundColor: c.primaryLight, borderWidth: 1, borderColor: c.primary, borderRadius: 12, padding: 14, marginBottom: 12, marginTop: 4 },
    affirmTitle: { fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 4 },
    affirmBody: { fontSize: 13, color: c.textSub, marginBottom: 10, lineHeight: 18 },
    affirmHint: { fontSize: 12, color: c.textMuted, marginTop: 8, textAlign: 'center' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
    chip: { borderWidth: 1.5, borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14 },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
    submitBtn: { marginTop: 16 },
    dim: { opacity: 0.5 },
    processingText: { marginTop: 12, color: c.textSub, fontSize: 15 },
    thanksEmoji: { fontSize: 48, marginBottom: 8 },
    thanksTitle: { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 8 },
    thanksBody: { fontSize: 14, color: c.textSub, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  });
}

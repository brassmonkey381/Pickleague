// Add a court the catalog is missing. Mirrors Doggle's SubmitDogPlaceScreen:
// captures a location (route params, GPS, or pasted coords), checks for a nearby
// unconfirmed submission ("same place?" affirm), and calls submit_venue. New
// submissions are source='user'/unconfirmed and show in search right away
// (ranked below confirmed) until a godmode admin confirms them.
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
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
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Chip, Panel, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
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
  const t = textStyles(c);
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
  // Nothing dedupes venue submissions, and both entry points (affirm an
  // existing pin / submit new) write; `busy` only reaches the buttons on the
  // next render, so the guard has to be a ref.
  const submitting = useRef(false);

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
    if (submitting.current) return;
    if (!coords) return;
    submitting.current = true;
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
      status.error(friendlySbMessage(e, 'Could not link to the existing submission.'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function submitNew() {
    if (submitting.current) return;
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
    submitting.current = true;
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
      status.error(friendlySbMessage(e, 'Could not submit this court.'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }


  if (phase === 'processing') {
    return (
      <View style={S.center}>
        <ActivityIndicator size="large" color={c.primary} />
        <Text style={[t.body, S.processingText]}>Submitting…</Text>
      </View>
    );
  }

  if (phase === 'thanks') {
    return (
      <View style={S.center}>
        <Icon name="pickleball" size={48} color={c.primary} style={S.thanksGlyph} />
        <Text style={[t.h2, S.thanksTitle]}>Thanks!</Text>
        <Text style={[t.bodySub, S.thanksBody]}>
          Your court was added and is searchable right away. An admin will confirm the details soon.
        </Text>
        <Button title="Done" onPress={() => navigation.goBack()} style={S.stretch} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
      <StatusBanner status={status.value} style={S.banner} />
      <Text style={[t.bodySub, S.intro]}>
        Add a court we're missing. We'll list it right away as unconfirmed so you can use it while an
        admin verifies the details.
      </Text>

      {/* Location */}
      <Text style={[t.fieldLabel, S.label]}>LOCATION</Text>
      {coords ? (
        <View style={S.coordsRow}>
          <View style={S.inline}>
            <Icon name="pin" size={16} color={c.textSub} />
            <Text style={S.coordsText}>{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
          </View>
          <TextLink label="Change" size="sub" chevron={false} onPress={() => setCoords(null)} accessibilityLabel="Change the location" />
        </View>
      ) : (
        <Panel style={S.card}>
          <Button
            variant="outline"
            iconName="pin"
            title="Use my location"
            onPress={useMyLocation}
            loading={locating}
          />
          <Text style={[t.caption, S.orText]}>or paste "lat, long" from a map</Text>
          <View style={S.pasteRow}>
            <TextInput
              style={[S.input, S.flex]}
              placeholder="37.7749, -122.4194"
              placeholderTextColor={c.textMuted}
              value={coordText}
              onChangeText={setCoordText}
              autoCapitalize="none"
              accessibilityLabel="Coordinates, as latitude, longitude"
            />
            <Button size="sm" title="Set" onPress={applyPastedCoords} accessibilityLabel="Set these coordinates" />
          </View>
        </Panel>
      )}

      {/* "Same place?" affirm prompt */}
      {coords && nearby.length > 0 ? (
        <View style={S.affirmCard}>
          <Text style={[t.title, S.affirmTitle]}>Same place as this?</Text>
          <Text style={[t.sub, S.affirmBody]}>
            Someone already suggested “{nearby[0].name}” about {Math.round(nearby[0].distance_meters)} m
            from here.
          </Text>
          <Button title="Yes, it's this one" onPress={() => affirm(nearby[0])} disabled={busy} />
          <Text style={[t.caption, S.affirmHint]}>Not it? Just fill in the form below to add a new court.</Text>
        </View>
      ) : null}

      {/* Name */}
      <Text style={[t.fieldLabel, S.label]}>NAME</Text>
      <TextInput
        style={S.input}
        placeholder="e.g. Bay Club Pickleball Courts"
        placeholderTextColor={c.textMuted}
        value={name}
        onChangeText={setName}
        accessibilityLabel="Name"
      />

      {/* Sports */}
      <Text style={[t.fieldLabel, S.label]}>SPORTS</Text>
      <View style={S.chipRow}>
        {SPORT_OPTIONS.map((s) => {
          const active = sports.has(s);
          return (
            <Chip
              key={s}
              label={s}
              tone={active ? 'brand' : 'neutral'}
              selected={active}
              onPress={() => toggleSport(s)}
              accessibilityRole="button"
            />
          );
        })}
      </View>

      {/* Kind */}
      <Text style={[t.fieldLabel, S.label]}>TYPE</Text>
      <View style={S.chipRow}>
        {KIND_OPTIONS.map((k) => {
          const active = kind === k.value;
          return (
            <Chip
              key={k.value}
              label={k.label}
              tone={active ? 'brand' : 'neutral'}
              selected={active}
              onPress={() => setKind(k.value)}
              accessibilityRole="button"
            />
          );
        })}
      </View>

      {/* Address / city (optional) */}
      <Text style={[t.fieldLabel, S.label]}>ADDRESS (OPTIONAL)</Text>
      <TextInput style={S.input} placeholder="Street address" placeholderTextColor={c.textMuted} value={address} onChangeText={setAddress} accessibilityLabel="Address" />
      <Text style={[t.fieldLabel, S.label]}>CITY (OPTIONAL)</Text>
      <TextInput style={S.input} placeholder="City" placeholderTextColor={c.textMuted} value={city} onChangeText={setCity} accessibilityLabel="City" />

      <Button title="Submit court" onPress={submitNew} loading={busy} disabled={busy} style={S.submitBtn} />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: SPACE.lg, backgroundColor: c.bg, flexGrow: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, backgroundColor: c.bg },
    flex: { flex: 1 },
    inline: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexShrink: 1 },
    stretch: { alignSelf: 'stretch' },
    banner: { marginBottom: SPACE.md },
    intro: { marginBottom: SPACE.lg },
    label: { marginTop: SPACE.sm, marginBottom: SPACE.xs },
    card: { marginBottom: SPACE.sm },
    input: {
      minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg,
      backgroundColor: c.bg, color: c.text, marginBottom: SPACE.xs,
    },
    coordsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm, marginBottom: SPACE.sm },
    coordsText: { fontSize: FONT.size.lg, color: c.text, fontWeight: FONT.weight.semibold, fontVariant: ['tabular-nums'] },
    orText: { textAlign: 'center', marginVertical: SPACE.sm },
    pasteRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    affirmCard: {
      backgroundColor: c.primaryLight, borderWidth: HAIRLINE, borderColor: c.primary, borderRadius: RADIUS.lg,
      padding: SPACE.md, marginBottom: SPACE.md, marginTop: SPACE.xs,
    },
    affirmTitle: { marginBottom: SPACE.xs },
    affirmBody: { marginBottom: SPACE.md },
    affirmHint: { marginTop: SPACE.sm, textAlign: 'center' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.sm },
    submitBtn: { marginTop: SPACE.lg },
    processingText: { marginTop: SPACE.md, color: c.textSub },
    thanksGlyph: { marginBottom: SPACE.sm },
    thanksTitle: { marginBottom: SPACE.sm },
    thanksBody: { textAlign: 'center', marginBottom: SPACE.xl },
  });
}

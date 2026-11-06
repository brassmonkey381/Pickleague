// Settings > Home location (supabase/migration_home_location.sql), as
// Doggle's Settings > Location: search a city or an address, or "Use my
// location" (GPS), then Save. Events near you are the ones within 40 km.
//
//   Your home location picks the events near you.
//   Currently: Alameda, CA
//   [ Search a city or address, or use your location ]   (Use my location)
//   🔒 Only your neighborhood, like Alameda, CA, is ever shown. Your exact
//      spot stays private.
//   [Save home location]
//   Remove home location
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Panel, TextLink, VenuePicker, type VenueResult } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { track } from '../lib/analytics';
import { explainRefusal } from '../lib/refusalNotices';
import { clearMyHomeLocation, setMyHomeLocation, useMyHomeLocation } from '../data/homeLocation';
import { searchPlacesOsm } from '../lib/placeSearch';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'HomeLocation'>;

export const HOME_LOCATION_PRIVACY =
  '🔒 Only your neighborhood, like Alameda, CA, is ever shown. Your exact spot stays private.';

export default function HomeLocationScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const q = useMyHomeLocation();
  const saved = q.data ?? null;
  const [place, setPlace] = useState<VenueResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Reopened: what I saved, shown back to me (my own address, never anyone else's).
  useEffect(() => {
    if (saved && !place) {
      const label = saved.address ?? saved.neighborhood ?? 'My home location';
      setPlace({ name: label, address: label, lat: saved.lat, lng: saved.lng, placeId: 'profile-home' });
    }
    // Only when the saved one first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  async function save() {
    if (!place) {
      toast.error('Search for a place, or tap Use my location first.');
      return;
    }
    setBusy(true);
    try {
      const r = await setMyHomeLocation({ lat: place.lat, lng: place.lng, address: place.address || place.name });
      track('home_location.save', { neighborhood: !!r?.neighborhood });
      toast.success(r?.neighborhood ? `Home location saved: ${r.neighborhood}` : 'Home location saved');
      navigation.goBack();
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't save your home location. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await clearMyHomeLocation();
      setPlace(null);
      track('home_location.clear');
      toast.success('Home location removed');
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't remove it. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
      <Panel>
        <Text style={t.sub}>
          Your home location picks the events near you (within about 25 miles).
          {saved?.neighborhood ? ` Currently: ${saved.neighborhood}.` : ''}
        </Text>
        <View style={S.gap}>
          <VenuePicker
            value={place}
            onSelect={setPlace}
            active
            // OpenStreetMap search on every platform (lib/placeSearch): the
            // kit's native picker only knows Google Places, and Pickleague has
            // no Google Places key (app.config.js).
            externalSearch="none"
            localSearch={searchPlacesOsm}
            catalogLabel="places"
            placeholder="Search a city or address, or use your location"
          />
        </View>
        <Text style={[t.meta, S.gap]}>{HOME_LOCATION_PRIVACY}</Text>
        <Button title="Save home location" loading={busy} onPress={() => void save()} style={S.gap} />
        {saved ? <TextLink label="Remove home location" onPress={() => void remove()} /> : null}
      </Panel>
    </ScrollView>
  );
}

const S = StyleSheet.create({
  content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl },
  gap: { marginTop: SPACE.sm },
});

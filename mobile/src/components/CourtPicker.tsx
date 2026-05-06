import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform,
} from 'react-native';
import { GooglePlacesAutocomplete, GooglePlacesAutocompleteRef } from 'react-native-google-places-autocomplete';
import * as Location from 'expo-location';

const PLACES_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';

export type CourtResult = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
};

type Props = {
  value: CourtResult | null;
  onSelect: (court: CourtResult | null) => void;
  placeholder?: string;
  showNoneOption?: boolean;
  /** Set to false to defer location request until picker is visible */
  active?: boolean;
};

export default function CourtPicker({
  value,
  onSelect,
  placeholder = 'Search for a court or venue...',
  showNoneOption = false,
}: Props) {
  const ref = useRef<GooglePlacesAutocompleteRef>(null);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locStatus, setLocStatus] = useState<'loading' | 'granted' | 'denied'>('loading');

  useEffect(() => {
    if (!active) return;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUserCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          setLocStatus('granted');
        } catch {
          setLocStatus('denied');
        }
      } else {
        setLocStatus('denied');
      }
    })();
  }, []);

  function clear() {
    ref.current?.clear();
    ref.current?.blur();
    onSelect(null);
  }

  // ── Selected state ─────────────────────────────────────────
  if (value) {
    return (
      <View style={styles.selectedCard}>
        <View style={styles.selectedPin}>
          <Text style={styles.pinIcon}>📍</Text>
        </View>
        <View style={styles.selectedInfo}>
          <Text style={styles.selectedName} numberOfLines={1}>{value.name}</Text>
          {value.address ? (
            <Text style={styles.selectedAddr} numberOfLines={1}>{value.address}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={styles.changeBtn} onPress={clear}>
          <Text style={styles.changeBtnText}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Search state ───────────────────────────────────────────
  return (
    <View style={styles.container}>
      {locStatus === 'loading' && (
        <View style={styles.locRow}>
          <ActivityIndicator size="small" color="#2e7d32" />
          <Text style={styles.locText}>Getting your location…</Text>
        </View>
      )}
      {locStatus === 'denied' && (
        <View style={styles.locRow}>
          <Text style={styles.locDenied}>📍 Location unavailable — results won't be filtered by proximity.</Text>
        </View>
      )}
      {locStatus === 'granted' && (
        <View style={styles.locRow}>
          <Text style={styles.locGranted}>📍 Showing nearby courts first</Text>
        </View>
      )}

      <GooglePlacesAutocomplete
        ref={ref}
        placeholder={placeholder}
        fetchDetails
        onPress={(data, details) => {
          if (!details) return;
          onSelect({
            name: data.structured_formatting?.main_text ?? data.description,
            address: data.structured_formatting?.secondary_text ?? '',
            lat: details.geometry.location.lat,
            lng: details.geometry.location.lng,
            placeId: data.place_id,
          });
        }}
        query={{
          key: PLACES_KEY,
          language: 'en',
          ...(userCoords
            ? { location: `${userCoords.lat},${userCoords.lng}`, radius: 50000 }
            : {}),
        }}
        GooglePlacesSearchQuery={{ rankby: 'distance' }}
        filterReverseGeocodingByTypes={['locality', 'administrative_area_level_3']}
        enablePoweredByContainer={false}
        minLength={2}
        debounce={300}
        keyboardShouldPersistTaps="handled"
        listViewDisplayed="auto"
        styles={{
          container:    { flex: 0, zIndex: 10 },
          textInputContainer: styles.inputContainer,
          textInput:    styles.input,
          listView:     styles.listView,
          row:          styles.row,
          description:  styles.rowText,
          separator:    styles.separator,
          poweredContainer: { display: 'none' },
        }}
        textInputProps={{
          placeholderTextColor: '#aaa',
          autoCorrect: false,
        }}
        renderRow={(rowData) => (
          <View style={styles.rowInner}>
            <Text style={styles.rowMain} numberOfLines={1}>
              {rowData.structured_formatting?.main_text ?? rowData.description}
            </Text>
            {rowData.structured_formatting?.secondary_text ? (
              <Text style={styles.rowSub} numberOfLines={1}>
                {rowData.structured_formatting.secondary_text}
              </Text>
            ) : null}
          </View>
        )}
      />

      {showNoneOption && (
        <TouchableOpacity style={styles.noneBtn} onPress={() => onSelect(null)}>
          <Text style={styles.noneBtnText}>Skip — no home court</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { zIndex: 10 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  locText: { fontSize: 12, color: '#888' },
  locGranted: { fontSize: 12, color: GREEN, fontWeight: '500' },
  locDenied: { fontSize: 12, color: '#e65100', flex: 1 },

  // Google Places input
  inputContainer: { backgroundColor: 'transparent', borderTopWidth: 0, borderBottomWidth: 0 },
  input: {
    height: 48, borderWidth: 1, borderColor: '#ddd', borderRadius: 8,
    paddingHorizontal: 14, fontSize: 15, backgroundColor: '#fff', color: '#1a1a1a',
    ...Platform.select({ web: { outlineStyle: 'none' } as any }),
  },
  listView: {
    borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginTop: 2,
    backgroundColor: '#fff', elevation: 4,
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8,
    zIndex: 20,
  },
  row: { padding: 0 },
  rowText: {},
  separator: { height: 1, backgroundColor: '#f0f0f0' },
  rowInner: { paddingHorizontal: 14, paddingVertical: 10 },
  rowMain: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  rowSub: { fontSize: 12, color: '#888', marginTop: 1 },

  // Selected card
  selectedCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0faf0',
    borderWidth: 1.5, borderColor: GREEN, borderRadius: 10, padding: 12, gap: 10,
  },
  selectedPin: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pinIcon: { fontSize: 20 },
  selectedInfo: { flex: 1 },
  selectedName: { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  selectedAddr: { fontSize: 12, color: '#666', marginTop: 1 },
  changeBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: GREEN },
  changeBtnText: { fontSize: 13, color: GREEN, fontWeight: '600' },

  // None option
  noneBtn: { marginTop: 8, padding: 10, alignItems: 'center' },
  noneBtnText: { fontSize: 14, color: '#aaa' },
});

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform,
} from 'react-native';
import { GooglePlacesAutocomplete, GooglePlacesAutocompleteRef } from 'react-native-google-places-autocomplete';
import * as Location from 'expo-location';
import { useTheme } from '../theme';

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
  active,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
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
  }, [active]);

  function clear() {
    ref.current?.clear();
    ref.current?.blur();
    onSelect(null);
  }

  if (value) {
    return (
      <View style={S.selectedCard}>
        <View style={S.selectedPin}>
          <Text style={S.pinIcon}>📍</Text>
        </View>
        <View style={S.selectedInfo}>
          <Text style={S.selectedName} numberOfLines={1}>{value.name}</Text>
          {value.address ? (
            <Text style={S.selectedAddr} numberOfLines={1}>{value.address}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={S.changeBtn} onPress={clear}>
          <Text style={S.changeBtnText}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={S.container}>
      {locStatus === 'loading' && (
        <View style={S.locRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={S.locText}>Getting your location…</Text>
        </View>
      )}
      {locStatus === 'denied' && (
        <View style={S.locRow}>
          <Text style={S.locDenied}>📍 Location unavailable — results won't be filtered by proximity.</Text>
        </View>
      )}
      {locStatus === 'granted' && (
        <View style={S.locRow}>
          <Text style={S.locGranted}>📍 Showing nearby courts first</Text>
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
          textInputContainer: S.inputContainer,
          textInput:    S.input,
          listView:     S.listView,
          row:          S.row,
          description:  S.rowText,
          separator:    S.separator,
          poweredContainer: { display: 'none' },
        }}
        textInputProps={{
          placeholderTextColor: colors.textMuted,
          autoCorrect: false,
        }}
        renderRow={(rowData) => (
          <View style={S.rowInner}>
            <Text style={S.rowMain} numberOfLines={1}>
              {rowData.structured_formatting?.main_text ?? rowData.description}
            </Text>
            {rowData.structured_formatting?.secondary_text ? (
              <Text style={S.rowSub} numberOfLines={1}>
                {rowData.structured_formatting.secondary_text}
              </Text>
            ) : null}
          </View>
        )}
      />

      {showNoneOption && (
        <TouchableOpacity style={S.noneBtn} onPress={() => onSelect(null)}>
          <Text style={S.noneBtnText}>Skip — no home court</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { zIndex: 10 },
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    locText: { fontSize: 12, color: c.textMuted },
    locGranted: { fontSize: 12, color: c.primary, fontWeight: '500' },
    locDenied: { fontSize: 12, color: '#e65100', flex: 1 },

    inputContainer: { backgroundColor: 'transparent', borderTopWidth: 0, borderBottomWidth: 0 },
    input: {
      height: 48, borderWidth: 1, borderColor: c.border, borderRadius: 8,
      paddingHorizontal: 14, fontSize: 15, backgroundColor: c.surface, color: c.text,
      ...Platform.select({ web: { outlineStyle: 'none' } as any }),
    },
    listView: {
      borderWidth: 1, borderColor: c.border, borderRadius: 8, marginTop: 2,
      backgroundColor: c.surface, elevation: 4,
      shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8,
      zIndex: 20,
    },
    row: { padding: 0 },
    rowText: {},
    separator: { height: 1, backgroundColor: c.border },
    rowInner: { paddingHorizontal: 14, paddingVertical: 10 },
    rowMain: { fontSize: 15, fontWeight: '600', color: c.text },
    rowSub: { fontSize: 12, color: c.textMuted, marginTop: 1 },

    selectedCard: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: c.primaryLight,
      borderWidth: 1.5, borderColor: c.primary, borderRadius: 10, padding: 12, gap: 10,
    },
    selectedPin: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    pinIcon: { fontSize: 20 },
    selectedInfo: { flex: 1 },
    selectedName: { fontSize: 15, fontWeight: '700', color: c.text },
    selectedAddr: { fontSize: 12, color: c.textSub, marginTop: 1 },
    changeBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: c.primary },
    changeBtnText: { fontSize: 13, color: c.primary, fontWeight: '600' },

    noneBtn: { marginTop: 8, padding: 10, alignItems: 'center' },
    noneBtnText: { fontSize: 14, color: c.textMuted },
  });
}

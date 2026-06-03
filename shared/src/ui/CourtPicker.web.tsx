/**
 * Web CourtPicker — uses browser Geolocation + Nominatim (OpenStreetMap).
 * No native deps, fully CORS-compatible. The native variant (iOS/Android) uses
 * Google Places autocomplete.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useTheme } from '../theme';

export type CourtResult = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
};

type NominatimResult = {
  place_id: number;
  display_name: string;
  name: string;
  lat: string;
  lon: string;
  address: {
    road?: string;
    city?: string;
    state?: string;
    postcode?: string;
  };
};

type Props = {
  value: CourtResult | null;
  onSelect: (court: CourtResult | null) => void;
  placeholder?: string;
  showNoneOption?: boolean;
};

export default function CourtPicker({
  value,
  onSelect,
  placeholder = 'Search for a court or venue...',
  showNoneOption = false,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}
    );
  }, []);

  function handleChange(text: string) {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.length < 2) { setResults([]); return; }

    debounceRef.current = setTimeout(() => search(text), 350);
  }

  async function search(q: string) {
    setSearching(true);
    try {
      const params = new URLSearchParams({
        q,
        format: 'json',
        limit: '8',
        addressdetails: '1',
        dedupe: '1',
        ...(userCoords
          ? {
              viewbox: `${userCoords.lng - 0.8},${userCoords.lat + 0.8},${userCoords.lng + 0.8},${userCoords.lat - 0.8}`,
            }
          : {}),
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'rn-foundation-courtpicker/1.0' },
      });
      const data: NominatimResult[] = await res.json();
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function selectResult(item: NominatimResult) {
    const parts = [item.address?.city, item.address?.state].filter(Boolean);
    const address = parts.join(', ');
    onSelect({
      name: item.name || item.display_name.split(',')[0],
      address,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      placeId: String(item.place_id),
    });
    setQuery('');
    setResults([]);
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
        <TouchableOpacity style={S.changeBtn} onPress={() => { onSelect(null); setQuery(''); }}>
          <Text style={S.changeBtnText}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={S.container}>
      {userCoords && (
        <Text style={S.locHint}>📍 Showing nearby results first</Text>
      )}

      <View style={S.inputRow}>
        {React.createElement('input', {
          type: 'text',
          value: query,
          onChange: (e: any) => handleChange(e.target.value),
          placeholder,
          style: {
            flex: 1,
            height: 48,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            paddingLeft: 14,
            paddingRight: 14,
            fontSize: 15,
            backgroundColor: colors.surface,
            color: colors.text,
            outline: 'none',
            boxSizing: 'border-box',
            width: '100%',
          },
        })}
        {searching && (
          <ActivityIndicator style={S.spinner} size="small" color={colors.primary} />
        )}
      </View>

      {results.length > 0 && (
        <View style={S.dropdown}>
          {results.map((item) => {
            const name = item.name || item.display_name.split(',')[0];
            const addr = item.display_name.split(',').slice(1, 3).join(',').trim();
            return (
              <TouchableOpacity
                key={item.place_id}
                style={S.resultRow}
                onPress={() => selectResult(item)}
              >
                <Text style={S.resultName} numberOfLines={1}>{name}</Text>
                <Text style={S.resultAddr} numberOfLines={1}>{addr}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {showNoneOption && !query && (
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
    locHint: { fontSize: 12, color: c.primary, fontWeight: '500', marginBottom: 6 },
    inputRow: { flexDirection: 'row', alignItems: 'center', position: 'relative' },
    spinner: { position: 'absolute', right: 12 },
    dropdown: {
      borderWidth: 1, borderColor: c.border, borderRadius: 8, marginTop: 2,
      backgroundColor: c.surface, zIndex: 20,
      shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8,
      elevation: 4,
    },
    resultRow: {
      paddingHorizontal: 14, paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    resultName: { fontSize: 14, fontWeight: '600', color: c.text },
    resultAddr: { fontSize: 12, color: c.textMuted, marginTop: 1 },
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

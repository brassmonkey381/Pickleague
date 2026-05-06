/**
 * Web CourtPicker — uses browser Geolocation + Nominatim (OpenStreetMap)
 * No native deps, fully CORS-compatible.
 * Google Places autocomplete works on the native app (iOS/Android).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  FlatList, StyleSheet, ActivityIndicator,
} from 'react-native';

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
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browser geolocation — only request when component is actually active
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {} // silently ignore denial
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
        headers: { 'User-Agent': 'Pickleague/1.0' },
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
    // Build a short address from components
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

  // ── Selected state ────────────────────────────────────────
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
        <TouchableOpacity style={styles.changeBtn} onPress={() => { onSelect(null); setQuery(''); }}>
          <Text style={styles.changeBtnText}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Search state ──────────────────────────────────────────
  return (
    <View style={styles.container}>
      {userCoords && (
        <Text style={styles.locHint}>📍 Showing nearby results first</Text>
      )}

      <View style={styles.inputRow}>
        {React.createElement('input', {
          type: 'text',
          value: query,
          onChange: (e: any) => handleChange(e.target.value),
          placeholder,
          style: {
            flex: 1,
            height: 48,
            border: '1px solid #ddd',
            borderRadius: 8,
            paddingLeft: 14,
            paddingRight: 14,
            fontSize: 15,
            backgroundColor: '#fff',
            color: '#1a1a1a',
            outline: 'none',
            boxSizing: 'border-box',
            width: '100%',
          },
        })}
        {searching && (
          <ActivityIndicator style={styles.spinner} size="small" color="#2e7d32" />
        )}
      </View>

      {results.length > 0 && (
        <View style={styles.dropdown}>
          {results.map((item) => {
            const name = item.name || item.display_name.split(',')[0];
            const addr = item.display_name.split(',').slice(1, 3).join(',').trim();
            return (
              <TouchableOpacity
                key={item.place_id}
                style={styles.resultRow}
                onPress={() => selectResult(item)}
              >
                <Text style={styles.resultName} numberOfLines={1}>{name}</Text>
                <Text style={styles.resultAddr} numberOfLines={1}>{addr}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {showNoneOption && !query && (
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
  locHint: { fontSize: 12, color: GREEN, fontWeight: '500', marginBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', position: 'relative' },
  spinner: { position: 'absolute', right: 12 },
  dropdown: {
    borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginTop: 2,
    backgroundColor: '#fff', zIndex: 20,
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 8,
    elevation: 4,
  },
  resultRow: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#f5f5f5',
  },
  resultName: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  resultAddr: { fontSize: 12, color: '#888', marginTop: 1 },
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
  noneBtn: { marginTop: 8, padding: 10, alignItems: 'center' },
  noneBtnText: { fontSize: 14, color: '#aaa' },
});

// The search-area control at the top of every Discover tab and Find Drillers
// (Doggle's Discover "Search near" / "Within 5 mi" pills):
//
//   [📍 Alameda, CA ▾] [Within 5 mi ▾]
//   (no location, no city, no league court)  [📍 Choose an area ▾] [Within 5 mi ▾]
//                  Pick your location or a city, and every search here stays near it.
// The place is the city, else the nearest city to the device or to my
// leagues' courts (lib/useSearchArea's fallbacks).
//
// The place pill opens "Search near": Use my location (asks for location
// here, the same confirm as Play's Distance filter) and Search a city
// (us_cities). The radius pill opens 5 / 10 / 25 / 50 mi. Both write the one
// shared area (lib/useSearchArea), so every tab follows at once.
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  BottomSheet,
  FilterPill,
  FilterSearchField,
  SingleSelectModal,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { track } from '../lib/analytics';
import { useSearchArea } from '../lib/useSearchArea';
import { SEARCH_RADIUS_MILES, type LatLng, type SearchCity } from '../lib/searchArea';
import { searchUsCities, useNearestCityLabel } from '../data/courtDiscovery';
import DistanceFilterGroup from './play/DistanceFilterGroup';

type Props = {
  /** For the analytics event ('discover' | 'drill'). */
  surface: string;
  style?: StyleProp<ViewStyle>;
};

const RADIUS_ITEMS = SEARCH_RADIUS_MILES.map((mi) => ({ id: String(mi), name: `Within ${mi} mi` }));

/** The place the area is centred on, for the pill: the city, else the nearest
 *  city to the device or to my leagues' courts. */
export function useSearchAreaPlace(): string | null {
  const { area } = useSearchArea();
  const near = useNearestCityLabel(area && !area.label ? area.center : null);
  if (!area) return null;
  return area.label ?? near.data
    ?? (area.source === 'device' ? 'Your location' : area.source === 'courts' ? 'Your courts' : null);
}

export default function SearchAreaBar({ surface, style }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { area, ready, saved, setRadius, centerOnDevice, pickCity } = useSearchArea();
  const place = useSearchAreaPlace();
  const [areaOpen, setAreaOpen] = useState(false);
  const [radiusOpen, setRadiusOpen] = useState(false);

  // Until the area is known (the saved value, the courts lookup): a quiet "…".
  const placeLabel = area ? place ?? 'Here' : ready ? 'Choose an area' : '…';

  return (
    <View style={style}>
      <View style={S.row}>
        <FilterPill
          iconName="pin"
          trailingIconName="chevron-down"
          label={placeLabel}
          active
          onPress={() => setAreaOpen(true)}
          accessibilityLabel={area ? `Search near ${placeLabel}. Change` : ready ? 'Choose an area to search near' : 'Search area. Change'}
          style={S.place}
        />
        <FilterPill
          trailingIconName="chevron-down"
          label={`Within ${saved.radiusMi} mi`}
          active
          onPress={() => setRadiusOpen(true)}
          accessibilityLabel={`Search radius ${saved.radiusMi} miles. Change`}
        />
      </View>
      {area || !ready ? null : (
        <Text style={[t.hint, S.hint]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          Pick your location or a city, and every search here stays near it.
        </Text>
      )}

      <BottomSheet visible={areaOpen} onClose={() => setAreaOpen(false)} title="Search near" keyboardShrink>
        <SearchAreaPanel
          radiusMi={saved.radiusMi}
          onDevice={(p) => {
            centerOnDevice(p);
            setAreaOpen(false);
            track('search_area.change', { surface, kind: 'my_location' });
          }}
          onCity={(city) => {
            pickCity(city);
            setAreaOpen(false);
            track('search_area.change', { surface, kind: 'city' });
          }}
        />
      </BottomSheet>

      <SingleSelectModal
        visible={radiusOpen}
        title="Search radius"
        searchable={false}
        items={RADIUS_ITEMS}
        selectedId={String(saved.radiusMi)}
        onPick={(id) => {
          setRadiusOpen(false);
          if (!id) return;
          const mi = Number(id);
          if (mi !== saved.radiusMi) {
            setRadius(mi);
            track('search_area.change', { surface, kind: 'radius', miles: mi });
          }
        }}
        onClose={() => setRadiusOpen(false)}
      />
    </View>
  );
}

/** "Use my location" (asks, through DistanceFilterGroup) and "Search a city".
 *  Also Places' first screen when there is no area yet. */
export function SearchAreaPanel({
  onCity,
  onDevice,
  radiusMi,
  noun = "what's",
}: {
  onCity: (c: SearchCity) => void;
  onDevice: (p: LatLng) => void;
  radiusMi: number;
  /** For the location ask's copy ("Show courts near you"). */
  noun?: string;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { coords } = useSearchArea();
  const [text, setText] = useState('');
  const [results, setResults] = useState<SearchCity[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const search = async (q: string) => {
    const n = ++seq.current;
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    try {
      const r = await searchUsCities(q);
      if (n === seq.current) {
        setResults(r);
        setFailed(false);
      }
    } catch {
      if (n === seq.current) setFailed(true);
    }
  };

  return (
    <View style={S.panel}>
      {coords ? (
        <Button
          size="sm"
          variant="outline"
          iconName="pin"
          title="Use my location"
          onPress={() => onDevice(coords)}
          style={S.hug}
        />
      ) : (
        // Without a location yet: the one place this asks for it.
        <DistanceFilterGroup
          noun={noun}
          coords={null}
          onCoords={onDevice}
          value={String(radiusMi)}
          includeAny={false}
        />
      )}
      <FilterSearchField
        size="sm"
        value={text}
        onChangeText={setText}
        onDebouncedChange={(q) => void search(q)}
        debounceMs={250}
        placeholder="Search a city"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search a city"
      />
      {failed ? <Text style={t.sub}>Couldn't search cities just now. Try again.</Text> : null}
      {results && results.length === 0 ? <Text style={t.sub}>No US city by that name.</Text> : null}
      {results?.map((r) => (
        <TouchableOpacity
          key={`${r.label}:${r.lat}:${r.lng}`}
          style={S.result}
          onPress={() => onCity(r)}
          accessibilityRole="button"
          accessibilityLabel={`Search near ${r.label}`}
        >
          <Text style={t.body}>📍 {r.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexWrap: 'wrap' },
  // The place can be long ("San Francisco, CA"): it gives way, the radius doesn't.
  place: { flexShrink: 1, minWidth: 0 },
  hint: { marginTop: SPACE.xxs },
  panel: { gap: SPACE.sm, paddingVertical: SPACE.xs },
  hug: { alignSelf: 'flex-start' },
  result: { minHeight: 44, justifyContent: 'center' },
});

// Courts: the courts near you, nearest first (court discovery, Phase 1;
// state/court-discovery-plan.md). A thin adapter over the foundation's
// PlaceDiscoveryView + ListFilterChrome, like Doggle's Discover places list:
//
//   [Q] Filter by name                                         x
//   (★ My courts)(With leagues)
//   📍 Near Alameda, CA                                  Change
//   Sort: Nearest ▾                                 + Add a court
//   12 courts within 5 mi of Alameda, CA
//   DISTANCE (5 mi)(10 mi)(25 mi)(50 mi)
//   [CourtListRow] ...                              Load more
//
// Where it centres: the route's lat/lng, else a city the player searched,
// else the device location, read only when location is ALREADY allowed
// (usePlayLocation: opening Courts never prompts). "Use my location" asks
// through DistanceFilterGroup; "Search a city" looks up us_cities. The label
// comes from nearest_us_city. Signed-in only (decision 5).
//
// The catalog is cached a day (data/courtDiscovery); the crowd on each row is
// one venue_crowd call per page, polled once a minute while this screen is
// focused. Offline, the cached list still renders under the app's
// OfflineBanner. Pickleball courts only (decision 2). No map yet (Phase 2).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ActionSheetModal,
  FilterSearchField,
  ListFilterChrome,
  PlaceDiscoveryView,
  type ActionSheetAction,
  type FilterChipOption,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { track } from '../lib/analytics';
import { explainRefusal } from '../lib/refusalNotices';
import {
  COURT_RADIUS_MILES,
  COURT_SORTS,
  COURT_SORT_LABELS,
  DEFAULT_COURT_RADIUS_MILES,
  WIDEN_COURT_RADIUS_MILES,
  mergeCourtPages,
  milesToMeters,
  nextCourtCursor,
  visibleCourts,
  type CourtRow,
  type CourtSort,
  type LatLngLike,
} from '../lib/courtDiscovery';
import {
  listCourtsNearby,
  searchUsCities,
  useCourtCrowds,
  useCourtsNearby,
  useNearestCityLabel,
  type CitySuggestion,
} from '../data/courtDiscovery';
import { toggleCourtFavorite, useCourtFavoriteIds } from '../data/courtFavorites';
import { courtStarsChanged } from '../lib/courtArrivalAsk';
import { usePlayLocation } from '../components/play/usePlayLocation';
import DistanceFilterGroup from '../components/play/DistanceFilterGroup';
import CourtListRow from '../components/court/CourtListRow';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Courts'>;

type Center = LatLngLike & { label: string | null; from: 'route' | 'city' | 'device' };

const RADIUS_OPTIONS = COURT_RADIUS_MILES.map((mi) => ({ value: milesToMeters(mi), label: `${mi} mi` }));

const CHIP_OPTIONS: FilterChipOption[] = [
  { value: 'starred', label: '★ My courts' },
  { value: 'leagues', label: 'With leagues' },
];

/** Pages past the cached first one, for the list currently shown (`key`). */
type Extra = { key: string | null; rows: CourtRow[]; lastPage: CourtRow[] | null; loading: boolean };
const NO_EXTRA: Extra = { key: null, rows: [], lastPage: null, loading: false };

export default function CourtsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const focused = useIsFocused();
  const { coords, setCoords } = usePlayLocation();

  const routeLat = route.params?.lat;
  const routeLng = route.params?.lng;
  const [city, setCity] = useState<CitySuggestion | null>(null);
  const [radiusMi, setRadiusMi] = useState<number>(DEFAULT_COURT_RADIUS_MILES);
  const radiusM = milesToMeters(radiusMi);

  const center: Center | null = useMemo(() => {
    if (typeof routeLat === 'number' && typeof routeLng === 'number') {
      return { lat: routeLat, lng: routeLng, label: null, from: 'route' };
    }
    if (city) return { lat: city.lat, lng: city.lng, label: city.label, from: 'city' };
    if (coords) return { lat: coords.lat, lng: coords.lng, label: null, from: 'device' };
    return null;
  }, [routeLat, routeLng, city, coords]);

  const nearLabel = useNearestCityLabel(center && !center.label ? center : null);
  const centerLabel = center?.label ?? nearLabel.data ?? (center?.from === 'device' ? 'your location' : null);

  // Filter, chips, sort.
  const [query, setQuery] = useState('');
  const [filterText, setFilterText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [sort, setSort] = useState<CourtSort>('nearest');
  const [sortOpen, setSortOpen] = useState(false);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    track('courts.open', { has_location: !!coords, from_route: typeof routeLat === 'number' });
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = useCourtsNearby(center, radiusM);

  // "Load more": keyset pages after the cached first page (not cached).
  const [extra, setExtra] = useState<Extra>(NO_EXTRA);
  const extraRef = useRef(extra);
  extraRef.current = extra;
  const listKey = q.key;
  const page1 = q.data;
  useEffect(() => {
    setExtra({ ...NO_EXTRA, key: listKey });
  }, [listKey, page1]);

  const mine = extra.key === listKey;
  const rows = useMemo(
    () => mergeCourtPages(page1 ?? [], mine ? extra.rows : []),
    [page1, extra.rows, mine],
  );
  // The next page starts after the last page fetched: the first, or the latest extra.
  const cursor = useMemo(
    () => nextCourtCursor(mine && extra.lastPage ? extra.lastPage : page1 ?? []),
    [mine, extra.lastPage, page1],
  );

  const loadMore = useCallback(async () => {
    const cur = extraRef.current;
    if (!center || !cursor || cur.loading) return;
    setExtra({ ...cur, key: listKey, loading: true });
    try {
      const next = await listCourtsNearby(center, radiusM, { after: { afterM: cursor.afterM, afterId: cursor.afterId } });
      setExtra((e) => (e.key === listKey ? { key: listKey, rows: [...e.rows, ...next], lastPage: next, loading: false } : e));
    } catch (e) {
      setExtra((x) => ({ ...x, loading: false }));
      toast.error(explainRefusal(e, "Couldn't load more courts. Try again."));
    }
  }, [center, cursor, listKey, radiusM, toast]);

  const starredIds = useCourtFavoriteIds();
  const visible = useMemo(
    () => visibleCourts(rows, { query: filterText, chips, starredIds, sort }),
    [rows, filterText, chips, starredIds, sort],
  );
  const crowd = useCourtCrowds(
    useMemo(() => visible.map((r) => r.id), [visible]),
    focused,
  );

  const chipOptions = useMemo<FilterChipOption[]>(
    () =>
      CHIP_OPTIONS.map((o) => ({
        ...o,
        count: o.value === 'starred' ? rows.filter((r) => starredIds.has(r.id)).length : rows.filter((r) => r.league_count > 0).length,
      })),
    [rows, starredIds],
  );

  const changeRadius = (m: number) => {
    const mi = COURT_RADIUS_MILES.find((x) => milesToMeters(x) === m) ?? DEFAULT_COURT_RADIUS_MILES;
    setRadiusMi(mi);
    track('courts.filter', { kind: 'radius', miles: mi });
  };

  const pickCity = (s: CitySuggestion) => {
    setCity(s);
    setChanging(false);
    track('courts.filter', { kind: 'city' });
  };

  const useDevice = (p: LatLngLike) => {
    setCoords({ lat: p.lat, lng: p.lng });
    // A route or city centre gives way to the place the player is.
    setCity(null);
    setChanging(false);
    if (typeof routeLat === 'number') navigation.setParams({ lat: undefined, lng: undefined });
    track('courts.filter', { kind: 'my_location' });
  };

  // courts.view is tracked by the court's page itself (any way in).
  const openCourt = useCallback(
    (row: CourtRow) => navigation.navigate('CourtDetail', { venueId: row.id }),
    [navigation],
  );

  const toggleStar = useCallback(
    async (row: CourtRow) => {
      const adding = !starredIds.has(row.id);
      try {
        await toggleCourtFavorite(row.id, adding, row.name);
        courtStarsChanged();
        toast.success(adding ? `${row.name} is one of your courts now.` : `${row.name} is off your courts.`);
      } catch (e) {
        toast.error(explainRefusal(e, "Couldn't change your courts just now. Try again.", { action: 'favorite', venueName: row.name }));
      }
    },
    [starredIds, toast],
  );

  const sortActions: ActionSheetAction[] = COURT_SORTS.map((k) => ({
    label: `${k === sort ? '✓ ' : ''}${COURT_SORT_LABELS[k]}`,
    onPress: () => {
      setSort(k);
      track('courts.filter', { kind: 'sort', sort: k });
    },
  }));

  const addCourt = () => navigation.navigate('SubmitVenue', center ? { lat: center.lat, lng: center.lng } : undefined);

  const locationPanel = <LocationPanel onCity={pickCity} onDevice={useDevice} radiusMi={radiusMi} />;

  const chrome = (
    <ListFilterChrome
      query={query}
      onChangeQuery={setQuery}
      onDebouncedQuery={(text) => {
        setFilterText(text);
        if (text.trim()) track('courts.filter', { kind: 'name', length: text.trim().length });
      }}
      placeholder="Filter courts by name"
      chipOptions={chipOptions}
      chips={chips}
      onChangeChips={(next) => {
        setChips(next);
        track('courts.filter', { kind: 'chips', count: next.length });
      }}
      pinnedKeys={['starred']}
    />
  );

  if (!center) {
    return (
      <View style={[S.fill, { backgroundColor: c.bg }]}>
        <View style={S.pad}>
          <Text style={t.title}>Find courts near you</Text>
          <Text style={[t.sub, S.gapXs]}>Use your location, or search a city.</Text>
          {locationPanel}
        </View>
      </View>
    );
  }

  const header = (
    <View style={S.headerWrap}>
      <View style={S.line}>
        <Text style={[t.body, S.flex]} numberOfLines={1}>
          📍 Near {centerLabel ?? 'here'}
        </Text>
        <TouchableOpacity
          style={S.link}
          onPress={() => setChanging((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={changing ? 'Keep this location' : 'Change location'}
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {changing ? 'Done' : 'Change'}
          </Text>
        </TouchableOpacity>
      </View>
      {changing ? locationPanel : null}
      <View style={S.line}>
        <TouchableOpacity
          style={S.link}
          onPress={() => setSortOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Sort: ${COURT_SORT_LABELS[sort]}. Change sort`}
        >
          <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            Sort: {COURT_SORT_LABELS[sort]} ▾
          </Text>
        </TouchableOpacity>
        <View style={S.flex} />
        <TouchableOpacity style={S.link} onPress={addCourt} accessibilityRole="button" accessibilityLabel="Add a court">
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            + Add a court
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const canWiden = radiusMi < WIDEN_COURT_RADIUS_MILES;
  const filtered = rows.length > 0 && visible.length === 0;

  return (
    <View style={[S.fill, { backgroundColor: c.bg }]}>
      {chrome}
      <PlaceDiscoveryView<CourtRow>
        items={visible}
        query={q}
        center={center}
        centerLabel={centerLabel}
        radiusM={radiusM}
        radiusOptions={RADIUS_OPTIONS}
        onRadiusChange={changeRadius}
        header={header}
        keyOf={(r) => r.id}
        renderItem={(r) => (
          <CourtListRow
            court={r}
            crowd={crowd.data[r.id]}
            starred={starredIds.has(r.id)}
            onPress={() => openCourt(r)}
            onToggleStar={() => void toggleStar(r)}
          />
        )}
        onLoadMore={cursor && !filterText && chips.length === 0 ? () => void loadMore() : undefined}
        hasMore={!!cursor}
        loadingMore={mine && extra.loading}
        emptyProps={
          filtered
            ? { icon: '🔍', title: 'No courts match', subtitle: 'Try another name, or clear the chips.' }
            : canWiden
              ? {
                  icon: '📍',
                  title: `No courts within ${radiusMi} mi`,
                  subtitle: "Widen the search, or add a court we don't know yet.",
                  actionLabel: `Widen to ${WIDEN_COURT_RADIUS_MILES} mi`,
                  onAction: () => changeRadius(milesToMeters(WIDEN_COURT_RADIUS_MILES)),
                }
              : {
                  icon: '📍',
                  title: `No courts within ${radiusMi} mi`,
                  subtitle: "Know one we don't? Add it, and players near you will see it.",
                  actionLabel: 'Add a court',
                  onAction: addCourt,
                }
        }
        copy={{
          count: (n, r, where) => `${n} ${n === 1 ? 'court' : 'courts'} within ${r}${where ? ` of ${where}` : ''}`,
          loading: 'Loading courts…',
        }}
        contentContainerStyle={S.list}
        style={S.view}
      />
      <ActionSheetModal visible={sortOpen} title="Sort courts" actions={sortActions} onClose={() => setSortOpen(false)} />
    </View>
  );
}

/** "Use my location" (asks, through DistanceFilterGroup) and "Search a city". */
function LocationPanel({
  onCity,
  onDevice,
  radiusMi,
}: {
  onCity: (c: CitySuggestion) => void;
  onDevice: (p: LatLngLike) => void;
  radiusMi: number;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { coords } = usePlayLocation();
  const [text, setText] = useState('');
  const [results, setResults] = useState<CitySuggestion[] | null>(null);
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
        // Without a location yet: the one place Courts asks for it.
        <DistanceFilterGroup
          noun="courts"
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
          accessibilityLabel={`Courts near ${r.label}`}
        >
          <Text style={t.body}>📍 {r.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  fill: { flex: 1 },
  pad: { padding: SPACE.lg, gap: SPACE.sm },
  view: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm },
  list: { paddingBottom: SPACE.xl, gap: SPACE.sm },
  headerWrap: { gap: SPACE.xxs },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: SPACE.xs },
  flex: { flex: 1, minWidth: 0 },
  link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
  panel: { gap: SPACE.sm, paddingVertical: SPACE.xs },
  hug: { alignSelf: 'flex-start' },
  gapXs: { marginBottom: SPACE.xs },
  result: { minHeight: 44, justifyContent: 'center' },
});

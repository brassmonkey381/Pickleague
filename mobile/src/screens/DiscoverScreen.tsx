// Discover: one screen, four tabs in the user's order (state/feed-discover-play-plan.md
// §4, P2; Doggle's DiscoverScreen look):
//
//   <  Home                 Discover                 [+]   the "+" follows the tab
//   [🎾 Leagues] [🏆 Tournaments] [📍 Places] [👥 Players 2]   tiles; Players badges requests
//   Leagues      LeaguesScreen's body: search, Mine · Saved, distance, Join / Enter code
//   Tournaments  TournamentsScreen's body: Mine · Open for registration · In progress · Ended
//   Places       CourtsScreen's body: the courts near you, List / Map, ★ My courts
//   Players      PlayersPanel: friends, requests, people you've played with, search, invites
//
// It replaces the Play hub (Leagues + Tournaments), the Courts screen and the
// Friends screen. Their routes are aliases now (screens/DiscoverAliases.tsx)
// and their links open /discover/<tab> (lib/discoverTabs.ts).
//
// - The tab lives in route params, not a useState copy (PlayScreen's lesson: a
//   copy ignored a later navigate('Discover', { tab }) while Discover was in
//   the stack). Taps write it back with setParams, so a web refresh and Back
//   keep it. Without one it opens on the tab used last (kept on this device),
//   else Leagues.
// - Panels mount on their first visit and then stay mounted, hidden (C5:
//   mounting all four at open fired four sets of queries and laid out a hidden
//   map). Each gets `active`, so only the showing one owns the header "+", the
//   spotlight-tour anchors and its polling.
// - Params for the tabs: mine (Home's "All my leagues" / "My tournaments")
//   turns the Mine chip on for that tab only, this visit; prefillInviteCode
//   brings Leagues forward with Join with code open; players picks Players'
//   view; lat / lng centre Places. Each one-shot param is consumed.
// - The leagues tour (FTUE "Join a league") selects Leagues when it starts.
// - Once per device, on the Leagues or Tournaments tab: "Leagues and
//   tournaments live here now." (they used to be the Play tile's screen).
// - One search area for every tab (lib/searchArea, components/SearchAreaBar):
//   "[📍 Alameda, CA ▾] [Within 5 mi ▾]" under the tabs. Leagues, Tournaments,
//   Places and Players' searches are limited to it; the Mine lists (my
//   leagues, my tournaments, my friends and requests) are not. A link's lat /
//   lng (Courts {lat, lng}) moves the area there (a city-like centre).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { LazyTabPanels, SegmentedToggle } from '@just-messin-around/expo-foundation/ui';
import { usePersistedState } from '@just-messin-around/expo-foundation/hooks';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { onTourStart, useTour } from '../lib/TourContext';
import { trackDiscoverTab } from '../lib/analytics';
import { COURT_DISCOVERY_ENABLED, FRIENDS_AT_COURTS_ENABLED } from '../lib/features';
import {
  DISCOVER_TAB_LABELS,
  asDiscoverTab,
  asPlayersView,
  availableDiscoverTabs,
  openingDiscoverTab,
  type DiscoverTab,
} from '../lib/discoverTabs';
import type { RootStackParamList } from '../types';
import LeaguesScreen from './LeaguesScreen';
import TournamentsScreen from './TournamentsScreen';
import CourtsScreen from './CourtsScreen';
import PlayersPanel, { usePlayersBadge } from '../components/discover/PlayersPanel';
import SearchAreaBar from '../components/SearchAreaBar';
import { searchAreaStore } from '../lib/useSearchArea';
import { nearestCityLabel } from '../data/courtDiscovery';

type Props = NativeStackScreenProps<RootStackParamList, 'Discover'>;

const TABS = availableDiscoverTabs({ places: COURT_DISCOVERY_ENABLED, players: FRIENDS_AT_COURTS_ENABLED });

const TAB_ICONS: Record<DiscoverTab, IconName> = {
  leagues: 'ball',
  tournaments: 'trophy',
  places: 'pin',
  players: 'group',
};

/** The tab used last, on this device (a convenience: storage may fail). */
const LAST_TAB_KEY = 'pickleague:discover:last_tab';
const LAST_TAB_DEFAULTS: { tab: string | null } = { tab: null };
/** The one-time "Leagues and tournaments live here now." */
const MOVED_NOTICE_KEY = 'pickleague:discover:moved_notice_v1';
const MOVED_NOTICE_DELAY_MS = 900;

type MineTokens = { leagues: number; tournaments: number };

export default function DiscoverScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();
  const params = route.params;

  // ── The tab ──
  const [last, setLast, lastMeta] = usePersistedState(LAST_TAB_KEY, { version: 1, defaults: LAST_TAB_DEFAULTS });
  const routeTab = asDiscoverTab(params?.tab);
  const shownRouteTab = routeTab && TABS.includes(routeTab) ? routeTab : null;
  // Without a tab in the route, wait for the stored one (a few ms) rather than
  // mounting Leagues and then jumping away from it.
  const tab: DiscoverTab | null = shownRouteTab ?? (lastMeta.ready ? openingDiscoverTab(null, last.tab, TABS) : null);

  const selectTab = useCallback((next: DiscoverTab) => navigation.setParams({ tab: next }), [navigation]);

  // The opening tab goes into the route (the address bar says /discover/<tab>;
  // a bad or hidden tab is corrected).
  useEffect(() => {
    if (tab && params?.tab !== tab) navigation.setParams({ tab });
  }, [tab, params?.tab, navigation]);

  // Remembered for the next open without a tab.
  useEffect(() => {
    if (tab && last.tab !== tab) setLast({ tab });
  }, [tab, last.tab, setLast]);

  // `discover.tab`: the opening tab, then every switch.
  const trackedRef = useRef<DiscoverTab | null>(null);
  useEffect(() => {
    if (!tab || trackedRef.current === tab) return;
    trackDiscoverTab(tab, trackedRef.current ? 'tap' : 'open');
    trackedRef.current = tab;
  }, [tab]);

  // ── One-shot params ──
  // mine: the Mine chip on for the tab it came with, this visit only (each
  // list's token; a list mounting later must not inherit another's).
  const [mineTokens, setMineTokens] = useState<MineTokens>({ leagues: 0, tournaments: 0 });
  useEffect(() => {
    if (params?.mine === undefined || !tab) return;
    if (params.mine === true) {
      const target: keyof MineTokens = tab === 'tournaments' ? 'tournaments' : 'leagues';
      setMineTokens((m) => ({ ...m, [target]: m[target] + 1 }));
    }
    // Anything else came from a URL (the string 'true'): ignored, as before,
    // and cleared so the address bar doesn't keep it.
    navigation.setParams({ mine: undefined });
  }, [params?.mine, tab, navigation]);

  // An invite code: Join with code lives on Leagues, so bring it forward. The
  // Leagues body opens the modal and clears the param.
  const prefillInviteCode = params?.prefillInviteCode;
  useEffect(() => {
    if (prefillInviteCode && tab && tab !== 'leagues') selectTab('leagues');
  }, [prefillInviteCode, tab, selectTab]);

  // A link's lat / lng (the old Courts {lat, lng}): the shared area moves
  // there, labelled by the nearest city, then the params go so a refresh or
  // Back doesn't move it again.
  const routeLat = params?.lat;
  const routeLng = params?.lng;
  useEffect(() => {
    const lat = typeof routeLat === 'string' ? Number(routeLat) : routeLat;
    const lng = typeof routeLng === 'string' ? Number(routeLng) : routeLng;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    let alive = true;
    void nearestCityLabel({ lat, lng })
      .catch(() => null)
      .then((label) => {
        if (!alive) return;
        searchAreaStore.pickCity({ label: label ?? 'Pinned place', lat, lng });
        navigation.setParams({ lat: undefined, lng: undefined });
      });
    return () => { alive = false; };
  }, [routeLat, routeLng, navigation]);

  // The leagues tour (search -> join) runs on the Leagues body.
  useEffect(() => onTourStart((key) => { if (key === 'leagues') selectTab('leagues'); }), [selectTab]);

  // ── The one-time notice ──
  // It is about leagues and tournaments, so it waits for one of their tabs: a
  // first open on Places (🔍) or Players (a friend-request push) doesn't show
  // or spend it.
  const { activeTour } = useTour();
  const tourRef = useRef(activeTour);
  tourRef.current = activeTour;
  const onListTab = tab === 'leagues' || tab === 'tournaments';
  const noticeTriedRef = useRef(false);
  useEffect(() => {
    if (!onListTab || noticeTriedRef.current) return;
    let alive = true;
    const timer = setTimeout(() => {
      // Not over a spotlight tour (FTUE "Join a league" lands here): later.
      if (!alive || tourRef.current) return;
      noticeTriedRef.current = true;
      void (async () => {
        try {
          if (await AsyncStorage.getItem(MOVED_NOTICE_KEY)) return;
          await AsyncStorage.setItem(MOVED_NOTICE_KEY, '1');
          if (alive) toast.info('Leagues and tournaments live here now.');
        } catch {
          // Storage unavailable (private window): skip it rather than repeat it.
        }
      })();
    }, MOVED_NOTICE_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // Tried once per visit, on the first Leagues or Tournaments view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onListTab]);

  // ── Tab badges: only what waits on you (friend requests) ──
  const playersBadge = usePlayersBadge(TABS.includes('players'));

  // The embedded screens want navigation typed to their own route name; it is
  // the same stack navigator, so the cast is safe (PlayScreen did the same).
  const leaguesNav = navigation as unknown as NativeStackNavigationProp<RootStackParamList, 'Leagues'>;
  const tournamentsNav = navigation as unknown as NativeStackNavigationProp<RootStackParamList, 'Tournaments'>;

  const panels = TABS.map((key) => ({
    key,
    render: () => {
      const active = key === tab;
      switch (key) {
        case 'leagues':
          return (
            <LeaguesScreen
              navigation={leaguesNav}
              route={{
                key: `${route.key}-leagues`,
                name: 'Leagues',
                params: prefillInviteCode ? { prefillInviteCode } : undefined,
              } as RouteProp<RootStackParamList, 'Leagues'>}
              active={active}
              routeMineToken={mineTokens.leagues}
              areaLimited
            />
          );
        case 'tournaments':
          return (
            <TournamentsScreen
              navigation={tournamentsNav}
              route={{ key: `${route.key}-tournaments`, name: 'Tournaments', params: {} } as RouteProp<RootStackParamList, 'Tournaments'>}
              active={active}
              routeMineToken={mineTokens.tournaments}
              onBrowseLeagues={() => selectTab('leagues')}
              areaLimited
            />
          );
        case 'places':
          return <CourtsScreen navigation={navigation} route={route} active={active} inDiscover />;
        case 'players':
          return (
            <PlayersPanel
              navigation={navigation}
              active={active}
              // A URL can carry anything: only a real view opens.
              view={asPlayersView(params?.players) ?? undefined}
              onViewConsumed={() => navigation.setParams({ players: undefined })}
            />
          );
      }
    },
  }));

  return (
    <View style={[S.screen, { backgroundColor: c.bg }]}>
      <SegmentedToggle<DiscoverTab>
        variant="tiles"
        options={TABS.map((k) => ({
          value: k,
          label: DISCOVER_TAB_LABELS[k],
          iconName: TAB_ICONS[k],
          count: k === 'players' ? playersBadge : undefined,
          // Say what the badge counts ("Players, 2" alone doesn't).
          accessibilityLabel: k === 'players' && playersBadge > 0
            ? `${DISCOVER_TAB_LABELS[k]}, ${playersBadge} friend ${playersBadge === 1 ? 'request' : 'requests'} waiting`
            : undefined,
        }))}
        // Nothing selected for the few ms before the stored tab loads.
        value={tab ?? ('' as DiscoverTab)}
        onChange={(next) => {
          if (next !== tab) selectTab(next);
        }}
        style={[S.tabs, { backgroundColor: c.surface, borderBottomColor: c.border }]}
      />
      <SearchAreaBar surface="discover" style={[S.area, { backgroundColor: c.surface, borderBottomColor: c.border }]} />
      {tab ? <LazyTabPanels<DiscoverTab> value={tab} panels={panels} /> : <View style={S.screen} />}
    </View>
  );
}

const S = StyleSheet.create({
  screen: { flex: 1 },
  tabs: {
    // 8, not 12: four tiles need the width for "Tournaments" at 360-375 px
    // (the foundation's tiles note has the sums).
    paddingHorizontal: SPACE.sm,
    paddingTop: SPACE.sm + 2,
    paddingBottom: SPACE.sm,
    borderBottomWidth: HAIRLINE,
  },
  area: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.xs,
    borderBottomWidth: HAIRLINE,
  },
});

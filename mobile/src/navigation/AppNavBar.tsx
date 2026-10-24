// The bottom bar (PLAY_NAV_ENABLED; the user's layout, 2026-10-24, "go merge
// play and check-in"):
//
//   Home · Saved · ( ▶ Play ) · Discover · Me
//
// Pickleague's adapter on the foundation's FloatingNavBar (Doggle's
// GlobalTabBar layout, plain Views). Mounted once inside AppNavigator's web
// column, after the navigator, so on web it spans the 720 px column, not the
// window. Play and Check in are one raised centre action (lib/navBarRules
// centreState): idle, ▶ Play checks me in at the court I'm at and starts the
// timer in one tap (components/play/CheckinHost; the ▶ Play sheet only when
// no court is found); playing, it shows the running clock and opens the
// island; checked in with no session, it opens the check-in's island. Saved
// is the Bookmarks screen. No Alerts slot: the bell (with its badge) stays in
// Home's top bar.
//
// Hidden signed out, on Claim / UpgradeAccount / MatchEntry (lib/navBarRules)
// and while the keyboard is up. It folds away when a session starts (the
// island takes the bottom, Doggle's walk) and comes back when it ends; on
// Home it starts folded to its chevron; the chevron folds and unfolds it by hand. Its height goes to lib/appChrome, so
// AppNavigator keeps that much clear under every screen and the island sits
// just above it.
import React, { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { FloatingNavBar, type FloatingNavItem } from '@just-messin-around/expo-foundation/ui';
import { createSignal, useElapsed, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { navigationRef } from '../lib/navigationRef';
import { PLAY_NAV_ENABLED, DISCOVER_ENABLED } from '../lib/features';
import { activeNavSlot, centreState, navBarVisible, navSideSlots, type NavSlot, type SideSlot } from '../lib/navBarRules';
import { setNavBarHeight } from '../lib/appChrome';
import { playIslandExpand, playSession } from '../lib/playSession';
import { checkinChanged, peekCurrentCheckin, type CurrentCheckin } from '../lib/courtCheckin';
import {
  checkinHereRequested,
  checkinHostBusy,
  checkoutInFlight,
  checkoutInFlightId,
  type CheckinHostBusy,
} from '../lib/checkinHost';
import { track } from '../lib/analytics';

/** AppNavigator calls this when the navigator is ready and on every state change. */
export const navRouteChanged = createSignal<void>();

type Tab = 'Home' | 'Bookmarks' | 'Discover' | 'Profile';

/**
 * Go to a tab's screen without remounting it. Home pops back to the Home at
 * the bottom of the stack (push.ts does the same). Discover and Me pop back
 * to their existing screen when there is one, else open a new one.
 */
function go(tab: Tab, myId: string | null): void {
  if (!navigationRef.isReady()) return;
  const root = navigationRef.getRootState();
  if (!root) return;
  const routes = root.routes;
  const top = routes[routes.length - 1];
  if (tab === 'Home') {
    if (top?.name === 'Home' && routes.length === 1) return;
    navigationRef.navigate('Home', undefined, { pop: true });
    return;
  }
  const isTab = (r: { name: string; params?: object }): boolean => {
    if (r.name !== tab) return false;
    if (tab !== 'Profile') return true;
    const userId = (r.params as { userId?: string } | undefined)?.userId;
    return !userId || userId === myId;
  };
  if (top && isTab(top)) return;
  let at = -1;
  for (let i = routes.length - 1; i >= 0; i--) if (isTab(routes[i])) { at = i; break; }
  // The same plain navigate Home uses: back to the existing screen (it keeps
  // its tab and scroll), else a new one. A hand-built reset here did nothing
  // on device or web (the user, 2026-10-22: Me and Discover "arent working").
  const nav = navigationRef.navigate as (name: Tab, params?: object, options?: { pop?: boolean }) => void;
  if (at >= 0) nav(tab, routes[at].params as object | undefined, { pop: true });
  else nav(tab, tab === 'Profile' ? {} : undefined);
}

export default function AppNavBar({ signedIn }: { signedIn: boolean }) {
  if (!PLAY_NAV_ENABLED) return null;
  return <Bar signedIn={signedIn} />;
}

function Bar({ signedIn }: { signedIn: boolean }) {
  const { colors: c } = useTheme();
  const [route, setRoute] = useState<{ name: string; params: Record<string, unknown> | null } | null>(null);
  const readRoute = () => {
    const r = navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined;
    setRoute(r ? { name: r.name, params: (r.params as Record<string, unknown> | undefined) ?? null } : null);
  };
  useEffect(readRoute, [signedIn]);
  useSignal(navRouteChanged, readRoute);

  const [myId, setMyId] = useState<string | null>(null);
  useEffect(() => {
    if (!signedIn) {
      setMyId(null);
      return;
    }
    void currentUserId(supabase).then(setMyId).catch(() => {});
  }, [signedIn]);

  const [checkin, setCheckin] = useState<CurrentCheckin | null>(null);
  useEffect(() => {
    void peekCurrentCheckin().then(setCheckin);
    return checkinChanged.subscribe(setCheckin);
  }, [signedIn]);
  const [busy, setBusy] = useState<CheckinHostBusy>(null);
  useSignal(checkinHostBusy, setBusy);
  // The island's Check out on its way (lib/checkinPlay): that check-in is
  // leaving, so the button says so instead of "Checked in".
  const [outId, setOutId] = useState<string | null>(checkoutInFlightId());
  useSignal(checkoutInFlight, setOutId);
  const shownCheckin = checkin && checkin.id !== outId ? checkin : null;

  // Folds away when a session starts, comes back when it ends (except on
  // Home, where it stays folded to its chevron, as below).
  const routeName = route?.name ?? null;
  const live = playSession.useLiveSession();
  const playing = live.status !== 'idle';
  const elapsed = useElapsed(playing ? (live.startedAtMs ?? null) : null);
  const [collapsed, setCollapsed] = useState(false);
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (playing !== wasPlaying.current) setCollapsed(playing || routeName === 'Home');
    wasPlaying.current = playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a session's start or end only
  }, [playing]);

  // Folded to its chevron on Home (the user, 2026-10-22: "closed by default on
  // the home page"), open elsewhere. Only on a change of screen, so a tap on
  // the chevron holds until the player moves on.
  const lastRoute = useRef<string | null>(null);
  useEffect(() => {
    if (!routeName || routeName === lastRoute.current) return;
    lastRoute.current = routeName;
    if (playing) return;
    setCollapsed(routeName === 'Home');
  }, [routeName, playing]);

  const visible = navBarVisible({ enabled: true, signedIn, route: route?.name });
  useEffect(() => {
    if (!visible) setNavBarHeight(0);
  }, [visible]);

  const lit: NavSlot | null = activeNavSlot(route?.name, route?.params, myId);
  const tap = (slot: NavSlot, fn: () => void) => () => {
    track('nav.tap', { slot, from: route?.name ?? null });
    fn();
  };

  const side: Record<SideSlot, FloatingNavItem> = {
    home: { key: 'home', label: 'Home', icon: 'home', active: lit === 'home', onPress: tap('home', () => go('Home', myId)) },
    saved: {
      key: 'saved',
      label: 'Saved',
      glyph: <Text style={{ fontSize: 18, lineHeight: 24, opacity: lit === 'saved' ? 1 : 0.7 }}>🔖</Text>,
      active: lit === 'saved',
      accessibilityLabel: 'Saved',
      onPress: tap('saved', () => go('Bookmarks', myId)),
    },
    discover: { key: 'discover', label: 'Discover', icon: 'search', active: lit === 'discover', onPress: tap('discover', () => go('Discover', myId)) },
    me: { key: 'me', label: 'Me', icon: 'account', active: lit === 'me', onPress: tap('me', () => go('Profile', myId)) },
  };
  const items = navSideSlots({ discover: DISCOVER_ENABLED }).map((k) => side[k]);
  // Play and Check in are one centre action (2026-10-24): ▶ Play when idle
  // (one tap checks in here and starts the timer, components/play/CheckinHost),
  // the running clock while playing (opens the island).
  const state = centreState({
    playing,
    elapsedSeconds: elapsed,
    checkedInVenue: shownCheckin?.venueName ?? null,
    busy: busy ?? (outId ? 'out' : null),
  });
  const centre: FloatingNavItem = {
    key: 'play',
    label: state.label,
    glyph: <Text style={{ fontSize: 22, lineHeight: 26, color: c.textInverse }}>▶</Text>,
    active: state.active,
    accessibilityLabel: state.accessibilityLabel,
    accessibilityHint: state.accessibilityHint,
    onPress: tap('play', () => (state.action === 'island' ? playIslandExpand.emit() : checkinHereRequested.emit())),
  };

  return (
    <FloatingNavBar
      items={items}
      centre={centre}
      hidden={!visible}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((x) => !x)}
      onHeightChange={setNavBarHeight}
      testID="app-nav-bar"
    />
  );
}

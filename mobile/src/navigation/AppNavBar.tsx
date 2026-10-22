// The bottom bar (PLAY_NAV_ENABLED; the user's layout, 2026-10-22):
//
//   Home · Play · ( Check in ) · Discover · Me
//
// Pickleague's adapter on the foundation's FloatingNavBar (Doggle's
// GlobalTabBar layout, plain Views). Mounted once inside AppNavigator's web
// column, after the navigator, so on web it spans the 720 px column, not the
// window. Play opens the ▶ Play sheet (or expands the island while a session
// runs); the raised centre Check in is the one-tap check-in at the court I'm
// at (components/play/CheckinHost), lit while I'm checked in. No Alerts slot:
// the bell (with its badge) stays in Home's top bar.
//
// Hidden signed out, on Claim / UpgradeAccount / MatchEntry (lib/navBarRules)
// and while the keyboard is up. It folds away when a session starts (the
// island takes the bottom, Doggle's walk) and comes back when it ends; the
// chevron folds and unfolds it by hand. Its height goes to lib/appChrome, so
// AppNavigator keeps that much clear under every screen and the island sits
// just above it.
import React, { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { FloatingNavBar, type FloatingNavItem } from '@just-messin-around/expo-foundation/ui';
import { createSignal, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { navigationRef } from '../lib/navigationRef';
import { PLAY_NAV_ENABLED, DISCOVER_ENABLED } from '../lib/features';
import { activeNavSlot, navBarVisible, type NavSlot } from '../lib/navBarRules';
import { setNavBarHeight } from '../lib/appChrome';
import { openPlayStart, playSession } from '../lib/playSession';
import { checkinChanged, peekCurrentCheckin, type CurrentCheckin } from '../lib/courtCheckin';
import { checkinHereRequested, checkinHostBusy, type CheckinHostBusy } from '../lib/checkinHost';
import { track } from '../lib/analytics';

/** AppNavigator calls this when the navigator is ready and on every state change. */
export const navRouteChanged = createSignal<void>();

type Tab = 'Home' | 'Discover' | 'Profile';

/**
 * Go to a tab's screen without remounting it. Home pops back to the Home at
 * the bottom of the stack (push.ts does the same). Discover and Me move their
 * existing route (same key, so it keeps its tab and scroll) to the top, or add
 * one; Back from it then goes where the player was, as in Doggle's bar. When
 * that screen is right under the current one (Me from Settings), it just
 * steps back to it.
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
  if (at === routes.length - 2) {
    navigationRef.goBack();
    return;
  }
  const existing = at >= 0 ? routes[at] : null;
  navigationRef.dispatch((state) => {
    const kept = state.routes.filter((r) => r.key !== existing?.key);
    const moved = existing ?? { name: tab, params: tab === 'Profile' ? {} : undefined };
    return CommonActions.reset({ ...state, index: kept.length, routes: [...kept, moved] } as never);
  });
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

  // Folds away when a session starts, comes back when it ends.
  const playing = playSession.useLiveSession().status !== 'idle';
  const [collapsed, setCollapsed] = useState(false);
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (playing !== wasPlaying.current) setCollapsed(playing);
    wasPlaying.current = playing;
  }, [playing]);

  const visible = navBarVisible({ enabled: true, signedIn, route: route?.name });
  useEffect(() => {
    if (!visible) setNavBarHeight(0);
  }, [visible]);

  const lit: NavSlot | null = activeNavSlot(route?.name, route?.params, myId);
  const tap = (slot: NavSlot, fn: () => void) => () => {
    track('nav.tap', { slot, from: route?.name ?? null });
    fn();
  };

  const items: FloatingNavItem[] = [
    { key: 'home', label: 'Home', icon: 'home', active: lit === 'home', onPress: tap('home', () => go('Home', myId)) },
    {
      key: 'play',
      label: playing ? 'Playing' : 'Play',
      glyph: <Text style={{ fontSize: 20, lineHeight: 24, color: playing ? c.success : c.textMuted }}>▶</Text>,
      active: playing,
      accessibilityLabel: playing ? 'Playing now' : 'Play',
      accessibilityHint: playing ? 'Shows your session' : 'Starts a play session',
      onPress: tap('play', () => openPlayStart()),
    },
    ...(DISCOVER_ENABLED
      ? [{ key: 'discover', label: 'Discover', icon: 'search' as const, active: lit === 'discover', onPress: tap('discover', () => go('Discover', myId)) }]
      : []),
    { key: 'me', label: 'Me', icon: 'account', active: lit === 'me', onPress: tap('me', () => go('Profile', myId)) },
  ];
  const centre: FloatingNavItem = {
    key: 'checkin',
    label: busy === 'checkin' ? 'Checking in…' : busy === 'find' ? 'Finding…' : busy === 'out' ? 'Checking out…' : checkin ? 'Checked in' : 'Check in',
    icon: 'pin',
    active: !!checkin,
    accessibilityLabel: checkin ? `Checked in at ${checkin.venueName}` : 'Check in',
    accessibilityHint: checkin ? 'Shows your check-in' : 'Checks you in at the court you are at',
    onPress: tap('checkin', () => checkinHereRequested.emit()),
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

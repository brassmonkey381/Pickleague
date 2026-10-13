// The Leagues list's spotlight-tour wiring ('leagues/search', 'leagues/join'
// and the scroll host), shared by both places the list mounts: the Play tab
// and the standalone 'Leagues' route (FTUE "Join a league", the invite_code
// push).
//
// Why it is gated on `live` (focused AND its tab visible): Play keeps both
// tabs mounted, and the stack can hold Play and Leagues at once, so up to two
// Leagues lists exist. Before this, both registered 'leagues/search' on mount
// and the last one won, which could be a hidden tab that measures 0x0. Now an
// instance registers when it becomes live, so the list the user is looking at
// always owns the steps.
//
// The anchors registered are PROXIES whose `current` is the real element only
// while this instance is live (null otherwise). The engine has no unregister,
// and a proxy needs none: once this list is hidden or blurred, a step that
// still points at it reads null and is skipped instead of spotlighting
// nothing. Registering a dead ref instead would count as "an anchor exists"
// and could start an armed tour on the wrong screen.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { FilterSearchFieldHandle } from '@just-messin-around/expo-foundation/ui';
import { useTour } from '../../lib/TourContext';

type Measurable = { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;

export function usePlayTour(visible: boolean) {
  const { registerAnchor, registerScroll, getScroll } = useTour();
  const isFocused = useIsFocused();
  const live = isFocused && visible;
  const liveRef = useRef(live);
  liveRef.current = live;

  const searchRef = useRef<FilterSearchFieldHandle>(null);
  const joinRef = useRef<View>(null);
  const listRef = useRef<FlatList<any>>(null);
  const offsetRef = useRef(0);

  const searchProxy = useMemo(() => ({
    get current(): Measurable { return liveRef.current ? (searchRef.current as Measurable) : null; },
  }), []);
  const joinProxy = useMemo(() => ({
    get current(): Measurable { return liveRef.current ? (joinRef.current as unknown as Measurable) : null; },
  }), []);

  // The FlatList as the tour's scroll host: pinning MINE above DISCOVER can
  // push the first joinable row below the fold.
  const host = useMemo(() => ({
    getOffset: () => offsetRef.current,
    scrollTo: (y: number) => listRef.current?.scrollToOffset({ offset: y, animated: true }),
  }), []);

  useEffect(() => {
    if (!live) return;
    registerAnchor('leagues', 'search', searchProxy);
    // The [Join] row may have laid out while this tab was hidden.
    if (joinRef.current) registerAnchor('leagues', 'join', joinProxy);
    registerScroll(host);
    return () => {
      if (getScroll() === host) registerScroll(null);
    };
  }, [live, registerAnchor, registerScroll, getScroll, searchProxy, joinProxy, host]);

  /** onLayout of the first joinable Discover row's [Join] wrapper. */
  const registerJoin = useCallback(() => {
    if (liveRef.current) registerAnchor('leagues', 'join', joinProxy);
  }, [registerAnchor, joinProxy]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  return { live, searchRef, joinRef, listRef, onScroll, registerJoin };
}

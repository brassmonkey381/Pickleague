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
// When the instance stops being live (blur, tab hidden, unmount) it
// unregisters its anchors, so a step can't point at a hidden list: the step
// is skipped, and a dead anchor never counts as "an anchor exists" that could
// start an armed tour on the wrong screen. The unregister is identity-guarded:
// it drops a step only while this instance still owns it, so a list that
// blurs after another one went live leaves the new anchor alone.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { FilterSearchFieldHandle } from '@just-messin-around/expo-foundation/ui';
import type { AnchorRef } from '@just-messin-around/expo-foundation/tour';
import { useTour } from '../../lib/TourContext';

export function usePlayTour(visible: boolean) {
  const { registerAnchor, unregisterAnchor, registerScroll, getScroll } = useTour();
  const isFocused = useIsFocused();
  const live = isFocused && visible;
  const liveRef = useRef(live);
  liveRef.current = live;

  const searchRef = useRef<FilterSearchFieldHandle>(null);
  const joinRef = useRef<View>(null);
  const listRef = useRef<FlatList<any>>(null);
  const offsetRef = useRef(0);

  // The refs themselves are the anchors (the handle and the View both have
  // measureInWindow); typed for the engine once.
  const searchAnchor = searchRef as unknown as AnchorRef;
  const joinAnchor = joinRef as unknown as AnchorRef;

  // The FlatList as the tour's scroll host: pinning MINE above DISCOVER can
  // push the first joinable row below the fold.
  const host = useMemo(() => ({
    getOffset: () => offsetRef.current,
    scrollTo: (y: number) => listRef.current?.scrollToOffset({ offset: y, animated: true }),
  }), []);

  useEffect(() => {
    if (!live) return;
    registerAnchor('leagues', 'search', searchAnchor);
    // The [Join] row may have laid out while this tab was hidden.
    if (joinRef.current) registerAnchor('leagues', 'join', joinAnchor);
    registerScroll(host);
    return () => {
      // Also drops a 'join' that registerJoin added while live.
      unregisterAnchor('leagues', 'search', searchAnchor);
      unregisterAnchor('leagues', 'join', joinAnchor);
      if (getScroll() === host) registerScroll(null);
    };
  }, [live, registerAnchor, unregisterAnchor, registerScroll, getScroll, searchAnchor, joinAnchor, host]);

  /** onLayout of the first joinable Discover row's [Join] wrapper. */
  const registerJoin = useCallback(() => {
    if (liveRef.current) registerAnchor('leagues', 'join', joinAnchor);
  }, [registerAnchor, joinAnchor]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  return { live, searchRef, joinRef, listRef, onScroll, registerJoin };
}

// The old list routes, while Discover is on (state/feed-discover-play-plan.md
// §4, C5): Play, Leagues, Courts, Friends and the league-less Tournaments
// stay registered, so any navigate to them (an old push's link, a stale
// in-app caller, a restored state) still lands, but each one replaces itself
// with Discover on the matching tab, carrying the params its callers send
// (lib/discoverTabs discoverParamsForLegacy). Their URLs never get here: the
// linking table rewrites /play, /leagues, /tournaments, /courts and /friends
// to /discover/<tab> first (navigation/linking.ts).
//
// A league's own tournaments list (Tournaments { leagueId }) is not an alias:
// it renders TournamentsScreen as before.
import React, { useLayoutEffect } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../lib/ThemeContext';
import { discoverParamsForLegacy, type LegacyDiscoverRoute } from '../lib/discoverTabs';
import type { RootStackParamList } from '../types';
import TournamentsScreen from './TournamentsScreen';

type AliasProps<R extends LegacyDiscoverRoute> = NativeStackScreenProps<RootStackParamList, R>;

/** Replaces itself with Discover before it paints; a blank page meanwhile. */
function useReplaceWithDiscover<R extends LegacyDiscoverRoute>({ navigation, route }: AliasProps<R>, skip = false) {
  useLayoutEffect(() => {
    if (skip) return;
    const params = discoverParamsForLegacy(route.name as LegacyDiscoverRoute, route.params as Record<string, unknown> | undefined);
    if (params) navigation.replace('Discover', params);
    // Once, on mount: the alias is gone right after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Blank() {
  const { colors: c } = useTheme();
  return <View style={{ flex: 1, backgroundColor: c.bg }} />;
}

export function PlayAlias(props: AliasProps<'Play'>) {
  useReplaceWithDiscover(props);
  return <Blank />;
}

export function LeaguesAlias(props: AliasProps<'Leagues'>) {
  useReplaceWithDiscover(props);
  return <Blank />;
}

export function CourtsAlias(props: AliasProps<'Courts'>) {
  useReplaceWithDiscover(props);
  return <Blank />;
}

export function FriendsAlias(props: AliasProps<'Friends'>) {
  useReplaceWithDiscover(props);
  return <Blank />;
}

/** A league's tournaments (leagueId) keep their screen; the full list is Discover's. */
export function TournamentsRoute(props: AliasProps<'Tournaments'>) {
  const scoped = !!props.route.params?.leagueId;
  useReplaceWithDiscover(props, scoped);
  return scoped ? <TournamentsScreen navigation={props.navigation} route={props.route} /> : <Blank />;
}

/** Stack options for an alias: no header and no entrance of its own, so the
 *  only movement is Discover arriving. */
export const DISCOVER_ALIAS_OPTIONS = { headerShown: false, animation: 'none' } as const;

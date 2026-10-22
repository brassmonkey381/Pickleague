// Every way into Discover goes through here, so each entry point follows the
// flag of its TARGET (plan §2): Discover while DISCOVER_ENABLED, else the old
// screen that held that tab (Play / Courts / Friends), else nothing.
import { CommonActions } from '@react-navigation/native';
import { COURT_DISCOVERY_ENABLED, DISCOVER_ENABLED, FRIENDS_AT_COURTS_ENABLED } from './features';
import { legacyRouteForDiscover, type DiscoverParams } from './discoverTabs';

/** The route (and params) a link into Discover opens, or null when no screen holds it. */
export function discoverTarget(params: DiscoverParams): [string, Record<string, unknown> | undefined] | null {
  if (DISCOVER_ENABLED) return ['Discover', params];
  return legacyRouteForDiscover(params, { courts: COURT_DISCOVERY_ENABLED, friends: FRIENDS_AT_COURTS_ENABLED });
}

/** Open Discover on `params.tab` (a navigate: a focused Discover just switches tab). */
export function openDiscover(navigation: { dispatch: (action: ReturnType<typeof CommonActions.navigate>) => void }, params: DiscoverParams): void {
  const target = discoverTarget(params);
  if (!target) return;
  navigation.dispatch(CommonActions.navigate({ name: target[0], params: target[1] }));
}

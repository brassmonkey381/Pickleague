// The navigation-ref + pending-queue logic moved to @just-messin-around/expo-foundation as a
// factory generic over the param list. This file instantiates it with the app's
// RootStackParamList, so all consumers (`import { navigationRef, navigateWhenReady,
// flushPendingNavigation } from '../lib/navigationRef'`) are unchanged.
import { CommonActions } from '@react-navigation/native';
import { createNavigationRef } from '@just-messin-around/expo-foundation/navigation';
import { RootStackParamList } from '../types';

export const { navigationRef, navigateWhenReady, flushPendingNavigation } =
  createNavigationRef<RootStackParamList>();

/**
 * Record a match for this play session (the island's Enter score, the end
 * sheet's Record match). Both float over every screen, so MatchEntry may
 * already be open from an event, league or tournament: a same-name navigate
 * would REPLACE its params in React Navigation 7 (eventId, leagueId,
 * tournamentMatchId gone mid-form), so the open form only gains the session
 * id. Otherwise MatchEntry opens as from Home.
 */
export function openMatchEntryForSession(playSessionId: string | undefined): void {
  const cur = navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined;
  if (cur?.name === 'MatchEntry') {
    if (playSessionId) navigationRef.dispatch({ ...CommonActions.setParams({ playSessionId }), source: cur.key });
    return;
  }
  navigateWhenReady('MatchEntry', { fromHome: true, playSessionId });
}

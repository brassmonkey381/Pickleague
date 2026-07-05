// The navigation-ref + pending-queue logic moved to @just-messin-around/expo-foundation as a
// factory generic over the param list. This file instantiates it with the app's
// RootStackParamList, so all consumers (`import { navigationRef, navigateWhenReady,
// flushPendingNavigation } from '../lib/navigationRef'`) are unchanged.
import { createNavigationRef } from '@just-messin-around/expo-foundation/navigation';
import { RootStackParamList } from '../types';

export const { navigationRef, navigateWhenReady, flushPendingNavigation } =
  createNavigationRef<RootStackParamList>();

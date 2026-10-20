// Keeps court arrival running for the signed-in player (Doggle's
// PassiveFavoriteHost; state/court-arrival-doggle-parity.md rows 10, 34, 40):
//   - re-picks the watched courts (lib/courtGeofence) on sign-in, whenever the
//     app comes to the front, and when a star, a QR wallet code or a Settings
//     choice changes (courtArrivalResync). Never with a permission sheet.
//   - takes down "At X?" notices over 2 minutes old on open (by then the
//     check-in landed with its own push, or was cancelled), and re-reads my
//     open check-in, which "Leaving X?" reads later from a wake. When the
//     phone scheduled its own "Checked in" / "Still at" (D3) for an arrival
//     the server has decided by now, the read also checks them: one for a
//     check-in the server never made (or that's over) is cancelled.
//   - runs the foreground monitor (lib/courtPromptMonitor) once a minute while
//     the app is open. No extra tick on resume: the resync above makes the
//     OS re-report every region at that moment, and the two would race.
//
// Mounted once at the app root (navigation/AppNavigator). Renders nothing.
import { useCallback, useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { usePollWhileActive, useSignal } from '@just-messin-around/expo-foundation/hooks';
import { syncCourtGeofences } from '../lib/courtGeofence';
import { arrivalLocalNoticesToSettle, arrivalNotice } from '../lib/courtArrivalNotice';
import { refreshCurrentCheckin } from '../lib/courtCheckin';
import { MONITOR_TICK_MS, STALE_ON_OPEN_MS } from '../lib/courtArrivalRules';
import { courtPromptTick, resetCourtPromptCooldowns } from '../lib/courtPromptMonitor';
import { courtArrivalResync } from '../data/courtArrival';
import { refreshMyOpenCheckin } from '../data/venueCheckins';

export default function CourtArrivalHost({ userId }: { userId: string | null }) {
  const refresh = useCallback(() => {
    // Geofences, lock-screen notices and "Leaving X?" are the phone's; web
    // runs only the monitor below.
    if (Platform.OS === 'web') return;
    void syncCourtGeofences();
    void arrivalNotice.dismissStale(STALE_ON_OPEN_MS);
    void refreshMyOpenCheckin();
    // Only when there's something to check: the reconcile read (it throws
    // offline, and then nothing is cancelled on a guess).
    void arrivalLocalNoticesToSettle().then((settle) => {
      if (settle) void refreshCurrentCheckin().catch(() => null);
    });
  }, []);

  useEffect(() => {
    // A new player (or none) starts with no monitor cooldowns.
    resetCourtPromptCooldowns();
    if (!userId) return;
    refresh();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [userId, refresh]);

  useSignal(courtArrivalResync, () => {
    if (userId && Platform.OS !== 'web') void syncCourtGeofences();
  });

  usePollWhileActive(courtPromptTick, MONITOR_TICK_MS, userId ?? null, { tickOnResume: false });

  return null;
}

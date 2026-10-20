// Asking for "Always" location for court arrival, and saying what came of it
// (state/court-arrival-doggle-parity.md, decision D2 and section F). Pickleague
// never asks on app open, only when the player does something that needs it:
// starring a court, the court card's offer, Settings' Allow, the QR wallet.
// Every other sync runs without a permission sheet.
//
// UI only: the geofence task and the notice buttons never import this (they
// must never show a sheet).
import { Platform } from 'react-native';
import { invalidateQueries, peekQuery } from '@just-messin-around/expo-foundation/cache';
import { syncCourtGeofences, type CourtGeofenceSyncResult } from './courtGeofence';
import type { CourtArrivalSettings } from './courtArrivalRules';
import { COURT_ARRIVAL_SETTINGS_KEY, courtArrivalResync, STARRED_COURT_GEOFENCES_KEY } from '../data/courtArrival';

/** The OS's own name for the choice: Android says "Allow all the time". */
export const ALWAYS_LABEL = Platform.OS === 'android' ? 'Allow all the time' : 'Always';

/** Why a starred-court control is disabled while "Notice me at starred courts" is Off. */
export const NOTICE_ME_OFF_NOTE = 'Turn on "Notice me at starred courts" to use this.';

type LocationModule = { getBackgroundPermissionsAsync(): Promise<{ status: string }> };

/**
 * "Always" location as the OS has it right now, without asking. null on web,
 * or when it can't be read.
 */
export async function backgroundLocationAllowed(): Promise<boolean | null> {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Location = require('expo-location') as LocationModule;
    return (await Location.getBackgroundPermissionsAsync()).status === 'granted';
  } catch {
    return null;
  }
}

/**
 * Show the OS sheets for "Always" when it is missing, then re-pick the
 * watched courts. With no court to watch, nothing is asked ('stopped').
 * Never throws.
 */
export function askForArrivalLocation(): Promise<CourtGeofenceSyncResult> {
  return syncCourtGeofences({ interactive: true });
}

/** "Notice me at starred courts" is Off, as last read this session (unknown: not Off). */
export function noticeMeOff(): boolean {
  return peekQuery<CourtArrivalSettings>(COURT_ARRIVAL_SETTINGS_KEY)?.court_radius_m === 0;
}

/** "Check me in when I arrive" is off, as last read this session (unknown: not off). */
export function autoCheckinOff(): boolean {
  return peekQuery<CourtArrivalSettings>(COURT_ARRIVAL_SETTINGS_KEY)?.auto_checkin === false;
}

/**
 * What a sync that could ask came to, in words the player can act on
 * (section F's results). `ok` false is a problem to show as one.
 */
export function arrivalSyncMessage(
  r: CourtGeofenceSyncResult,
  opts: { noticeOff?: boolean } = {},
): { ok: boolean; message: string } {
  switch (r.reason) {
    case 'ok':
      return { ok: true, message: `Watching ${r.count} court${r.count === 1 ? '' : 's'}.` };
    // Nothing to watch, so nothing was asked: with stars but "Notice me" Off,
    // the switch is what to change, not the stars.
    case 'stopped':
      return { ok: false, message: opts.noticeOff ? NOTICE_ME_OFF_NOTE : 'Star a court first.' };
    case 'no-foreground':
    case 'no-background':
      return {
        ok: false,
        message: `Arrival alerts need location set to "${ALWAYS_LABEL}". Change it in your phone's Settings for Pickleague.`,
      };
    // The starred courts or the settings couldn't be read: what was watched stays.
    case 'offline':
      return { ok: false, message: "Couldn't reach Pickleague. Try again when you have signal." };
    // The OS call threw (or the location modules are missing).
    default:
      return { ok: false, message: "Couldn't turn on arrival alerts. Try again." };
  }
}

/**
 * A star was added or removed: Settings' per-court list reads it again, and
 * CourtArrivalHost re-picks the watched courts (no permission sheet).
 */
export function courtStarsChanged(): void {
  invalidateQueries(STARRED_COURT_GEOFENCES_KEY);
  courtArrivalResync.emit();
}

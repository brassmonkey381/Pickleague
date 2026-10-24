// How the rest of the app talks to components/play/CheckinHost, the one owner
// of the check-in flow at the root (plan C1): the bar's centre Check in, the
// ▶ Play sheet's "Just check in", and the 'home/' pushes (the check-in
// reminder and the arrival notice) that used to land on Home's court card.
import { createSignal } from '@just-messin-around/expo-foundation/hooks';

/** The bar's Check in: at the court I'm at (one tap), or show my check-in. */
export const checkinHereRequested = createSignal<void>();

/** "Just check in" at this court (the ▶ Play sheet, a court card). */
export const checkinAtRequested = createSignal<{ id: string; name: string }>();

/** A 'home/' push opened the app: show my check-in, or ask "At X?" when I'm at a court. */
export const checkinIslandExpand = createSignal<void>();

// Held until the host takes it: a cold start from the push reaches Home
// before the host has subscribed.
let pendingIsland = false;
/** Ask the host to show the island (kept until it is mounted). */
export function requestCheckinIsland(): void {
  pendingIsland = true;
  checkinIslandExpand.emit();
}
/** For the host: a request waiting from before it mounted (cleared on read). */
export function takeCheckinIslandRequest(): boolean {
  const r = pendingIsland;
  pendingIsland = false;
  return r;
}

/** What the host is doing, for the bar's centre button. */
export type CheckinHostBusy = 'find' | 'checkin' | 'extend' | 'out' | null;
export const checkinHostBusy = createSignal<CheckinHostBusy>();

// The play island's Check out (= End, lib/checkinPlay checkOutAndEnd): the
// session clears at once, the check-out takes up to its fix wait plus the
// write. Meanwhile the host and the bar hide that check-in (it is on its
// way out), and it shows again if the check-out is refused.
let checkingOut: string | null = null;
/** Emits the check-in id the island is checking out of, or null when that is done. */
export const checkoutInFlight = createSignal<string | null>();
export function setCheckoutInFlight(id: string | null): void {
  checkingOut = id;
  checkoutInFlight.emit(id);
}
/** The check-in the island is checking out of right now, or null. */
export function checkoutInFlightId(): string | null {
  return checkingOut;
}

/**
 * Whether CheckinHost is mounted and owns the once-only notes (a queued
 * check-in refused later, one that ended without a Check out). Home's court
 * card leaves them to it, so a note is never taken twice or shown twice.
 */
let hostMounted = false;
export function setCheckinHostMounted(on: boolean): void {
  hostMounted = on;
}
export function checkinHostOwnsNotes(): boolean {
  return hostMounted;
}

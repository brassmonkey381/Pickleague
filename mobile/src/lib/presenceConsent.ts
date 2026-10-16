// PLACEHOLDER (presence stream owns this file and overwrites it at
// integration): the one-time "who sees you at the courts" consent sheet
// shown before the first check-in or session at a court. Resolves true to go
// ahead, false when the player backs out. Until the real sheet lands, it
// never blocks.
// TODO(presence integration): replace with the presence stream's version.
export async function ensurePresenceConsent(): Promise<boolean> {
  return true;
}

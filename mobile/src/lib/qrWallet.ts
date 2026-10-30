// QR wallet: front desk / member QR codes saved to THIS PHONE, each tied to a
// court. Arriving at that court (court arrival alerts, lib/courtGeofence)
// posts "You're at <court>"; a tap opens the code full screen (QrPass).
//
// Device-only on purpose: a member code is a credential, so it is never
// uploaded. Keyed by the signed-in user, so a second account on the same
// phone sees its own wallet. Each image sits under its own key (a data URI),
// apart from the small index, so listing never loads every image.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

export type WalletPass = {
  id: string;
  /** What the code is for, e.g. "Front desk check-in". */
  label: string;
  /** public.venues id when the court came from our catalog; null for a spot picked by GPS / coordinates. */
  venueId: string | null;
  venueName: string;
  lat: number;
  lng: number;
  addedAt: string;
};

/** The built-in pass: my invite link, drawn as a QR code (never stored). */
export const INVITE_PASS_ID = 'invite';

/** My invite link: my profile page. It unfurls into my card and opens my profile in the app. */
export function inviteUrl(uid: string | null): string {
  return uid ? `https://www.pickleague.club/players/${uid}` : 'https://www.pickleague.club';
}

const INDEX_PREFIX = 'pickleague_qr_wallet_v1:';
const IMAGE_PREFIX = 'pickleague_qr_wallet_img_v1:';
/** About 1.5 MB of base64. A cropped QR screenshot is far smaller. */
export const MAX_IMAGE_CHARS = 2_000_000;

async function indexKey(): Promise<string | null> {
  const uid = await currentUserId(supabase).catch(() => null);
  return uid ? INDEX_PREFIX + uid : null;
}

export async function listPasses(): Promise<WalletPass[]> {
  const key = await indexKey();
  if (!key) return [];
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as WalletPass[]) : [];
  } catch {
    return [];
  }
}

export async function getPass(id: string): Promise<WalletPass | null> {
  return (await listPasses()).find((p) => p.id === id) ?? null;
}

/** The image as a data URI, or null when it is gone. */
export async function getPassImage(id: string): Promise<string | null> {
  return AsyncStorage.getItem(IMAGE_PREFIX + id).catch(() => null);
}

/** The code saved for this catalog court (the newest), or null. */
export async function passForVenue(venueId: string | null | undefined): Promise<WalletPass | null> {
  if (!venueId) return null;
  const mine = (await listPasses()).filter((p) => p.venueId === venueId);
  mine.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return mine[0] ?? null;
}

/** The geofence region id: the court's id, so the arrival notice keeps its Check in button. */
export function walletRegionId(p: Pick<WalletPass, 'id' | 'venueId'>): string {
  return p.venueId ?? `qr:${p.id}`;
}

export async function addPass(p: Omit<WalletPass, 'id' | 'addedAt'>, image: string): Promise<WalletPass> {
  const key = await indexKey();
  if (!key) throw new Error('Sign in to save a QR code.');
  if (image.length > MAX_IMAGE_CHARS) throw new Error('That image is too large. Crop it to just the code and try again.');
  const pass: WalletPass = {
    ...p,
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    addedAt: new Date().toISOString(),
  };
  // Image first: an index entry never points at a missing image.
  await AsyncStorage.setItem(IMAGE_PREFIX + pass.id, image);
  const all = await listPasses();
  await AsyncStorage.setItem(key, JSON.stringify([...all, pass]));
  return pass;
}

export async function removePass(id: string): Promise<void> {
  const key = await indexKey();
  if (!key) return;
  const all = await listPasses();
  await AsyncStorage.setItem(key, JSON.stringify(all.filter((p) => p.id !== id)));
  await AsyncStorage.removeItem(IMAGE_PREFIX + id).catch(() => {});
}

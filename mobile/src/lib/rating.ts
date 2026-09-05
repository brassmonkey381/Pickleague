// In-app rating prompt.
//
// Three facts about iOS's SKStoreReviewController shape everything here:
//
//   1. iOS caps it at 3 prompts per app per device per YEAR and silently shows
//      nothing beyond that.
//   2. You cannot detect whether the prompt appeared, or what the user did.
//      requestReview() resolves either way.
//   3. Apple's guidance is explicit: never on launch, never mid-task, never as
//      a nag.
//
// So this is a best-effort nudge and can never be the app's only route to the
// store — Settings keeps a permanent "Rate Pickleague" row that opens the
// listing directly, which is the path that always works.
//
// Because (2) means we can't tell a shown prompt from a suppressed one, every
// gate below is deliberately conservative: we would much rather ask a happy
// user once too rarely than burn one of their three annual slots on a bad
// moment.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as StoreReview from 'expo-store-review';
import { Platform } from 'react-native';

const K_FIRST_SEEN = 'rating:firstSeenAt';
const K_MOMENTS = 'rating:positiveMoments';
const K_LAST_ASKED = 'rating:lastAskedAt';
const K_ASKED_VERSION = 'rating:lastAskedVersion';

/** Never ask someone who has just arrived — they have nothing to review yet. */
const MIN_DAYS_INSTALLED = 5;
/** Real engagement, not a single curious tap. */
const MIN_POSITIVE_MOMENTS = 3;
/** Well inside iOS's own 3-per-year cap, so we never spend slots we can't see. */
const MIN_DAYS_BETWEEN_ASKS = 120;
/** Let the success toast and any navigation settle before the sheet appears —
 *  a prompt that lands mid-transition reads as a glitch. */
const SETTLE_MS = 1_200;

const DAY_MS = 86_400_000;

async function readNumber(key: string): Promise<number> {
  const raw = await AsyncStorage.getItem(key);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Record that something good just happened (a match recorded, a tournament
 * finished). Cheap, local, and safe to call often — it does NOT prompt.
 */
export async function notePositiveMoment(): Promise<void> {
  try {
    if (Platform.OS === 'web') return;
    const now = Date.now();
    const first = await readNumber(K_FIRST_SEEN);
    if (!first) await AsyncStorage.setItem(K_FIRST_SEEN, String(now));
    const moments = await readNumber(K_MOMENTS);
    await AsyncStorage.setItem(K_MOMENTS, String(moments + 1));
  } catch {
    // Analytics-grade importance: never let bookkeeping break a real flow.
  }
}

/**
 * Ask for a rating if every gate passes. Fire-and-forget; never throws, and
 * never blocks the caller — award the user their success feedback first.
 */
export async function maybeAskForReview(): Promise<void> {
  try {
    if (Platform.OS === 'web') return;

    const version = Constants.expoConfig?.version ?? '';
    const now = Date.now();

    const first = await readNumber(K_FIRST_SEEN);
    if (!first || now - first < MIN_DAYS_INSTALLED * DAY_MS) return;

    const moments = await readNumber(K_MOMENTS);
    if (moments < MIN_POSITIVE_MOMENTS) return;

    // Once per version at most: a user who declined on 1.0.3 should not be
    // asked again until we have actually shipped them something new.
    const askedVersion = await AsyncStorage.getItem(K_ASKED_VERSION);
    if (askedVersion && askedVersion === version) return;

    const lastAsked = await readNumber(K_LAST_ASKED);
    if (lastAsked && now - lastAsked < MIN_DAYS_BETWEEN_ASKS * DAY_MS) return;

    // hasAction() is false when there is no store to review on (a simulator, an
    // unsupported platform), so this also keeps dev builds quiet.
    if (!(await StoreReview.isAvailableAsync())) return;
    if (!(await StoreReview.hasAction())) return;

    // Record the attempt BEFORE showing it. We cannot observe the outcome, so
    // the only safe assumption is that a slot was spent — crashing or
    // backgrounding right after must not leave us free to ask again tomorrow.
    await AsyncStorage.multiSet([
      [K_LAST_ASKED, String(now)],
      [K_ASKED_VERSION, version],
    ]);

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await StoreReview.requestReview();
  } catch {
    // A failed rating prompt is never worth surfacing to a user.
  }
}

/**
 * Convenience for call sites at a genuine high point: count it, then consider
 * asking. Deliberately returns void and swallows everything.
 */
export function celebrateAndMaybeAsk(): void {
  void (async () => {
    await notePositiveMoment();
    await maybeAskForReview();
  })();
}

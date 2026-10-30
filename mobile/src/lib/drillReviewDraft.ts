// Drill review drafts: "Save draft" in DrillReviewModal keeps the ratings and
// self-review typed so far, and the review reopens with them later (from the
// island's Review, the end sheet's Review drill, or Review your drills).
//
// On this device only (AsyncStorage), per account: a draft pays nothing and
// never reaches the server, so submit_drill_review stays the one place a
// review is saved and paid. A submitted (or already reviewed) drill drops its
// draft. Anything unreadable (an older or broken copy) reads as no draft.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

export const DRILL_REVIEW_FACETS = ['consistency', 'effort', 'organization', 'intentionality', 'fun'] as const;
export type DrillReviewFacet = (typeof DRILL_REVIEW_FACETS)[number];
export type DrillReviewRatings = Record<DrillReviewFacet, number>;
export type DrillReviewDraft = { ratings: DrillReviewRatings; notes: string; savedAt: string };

const KEY_PREFIX = 'pickleague_drill_review_drafts_v1:';
/** A draft untouched this long is dropped (the drill is long past). */
export const DRAFT_KEEP_MS = 30 * 24 * 60 * 60_000;
const NOTES_MAX = 500;

export function emptyRatings(): DrillReviewRatings {
  return { consistency: 0, effort: 0, organization: 0, intentionality: 0, fun: 0 };
}

/** Something worth keeping: a rating or some text. */
export function draftHasContent(d: { ratings: DrillReviewRatings; notes: string }): boolean {
  return DRILL_REVIEW_FACETS.some((f) => d.ratings[f] >= 1) || d.notes.trim().length > 0;
}

/** One stored draft, or null when it isn't one (or is older than DRAFT_KEEP_MS). */
export function parseDraft(raw: unknown, nowMs: number = Date.now()): DrillReviewDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const savedAt = typeof r.savedAt === 'string' ? r.savedAt : null;
  const savedMs = savedAt ? Date.parse(savedAt) : NaN;
  if (!savedAt || !Number.isFinite(savedMs) || nowMs - savedMs > DRAFT_KEEP_MS) return null;
  const rr = r.ratings && typeof r.ratings === 'object' ? (r.ratings as Record<string, unknown>) : {};
  const ratings = emptyRatings();
  for (const f of DRILL_REVIEW_FACETS) {
    const v = rr[f];
    ratings[f] = typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(0, Math.round(v))) : 0;
  }
  const notes = typeof r.notes === 'string' ? r.notes.slice(0, NOTES_MAX) : '';
  const d = { ratings, notes, savedAt };
  return draftHasContent(d) ? d : null;
}

/** Every stored draft by drill session id, the unreadable and stale ones left out. */
export function parseDraftMap(raw: string | null, nowMs: number = Date.now()): Record<string, DrillReviewDraft> {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, DrillReviewDraft> = {};
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const d = parseDraft(v, nowMs);
    if (d) out[id] = d;
  }
  return out;
}

async function storageKey(): Promise<string | null> {
  try {
    const uid = await currentUserId(supabase);
    return uid ? `${KEY_PREFIX}${uid}` : null;
  } catch {
    return null;
  }
}

async function readAll(): Promise<{ key: string | null; drafts: Record<string, DrillReviewDraft> }> {
  const key = await storageKey();
  if (!key) return { key, drafts: {} };
  try {
    return { key, drafts: parseDraftMap(await AsyncStorage.getItem(key)) };
  } catch {
    return { key, drafts: {} };
  }
}

/** All my drafts, by drill session id. */
export async function loadDrillReviewDrafts(): Promise<Record<string, DrillReviewDraft>> {
  return (await readAll()).drafts;
}

export async function loadDrillReviewDraft(sessionId: string): Promise<DrillReviewDraft | null> {
  return (await readAll()).drafts[sessionId] ?? null;
}

/** Keep what's typed so far (nothing typed: drops the draft). False when it couldn't be stored. */
export async function saveDrillReviewDraft(
  sessionId: string,
  draft: { ratings: DrillReviewRatings; notes: string },
): Promise<boolean> {
  const { key, drafts } = await readAll();
  if (!key) return false;
  if (draftHasContent(draft)) {
    drafts[sessionId] = { ratings: { ...draft.ratings }, notes: draft.notes.slice(0, NOTES_MAX), savedAt: new Date().toISOString() };
  } else {
    delete drafts[sessionId];
  }
  try {
    await AsyncStorage.setItem(key, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

/** The review was sent (or was already in): its draft goes. */
export async function clearDrillReviewDraft(sessionId: string): Promise<void> {
  const { key, drafts } = await readAll();
  if (!key || !(sessionId in drafts)) return;
  delete drafts[sessionId];
  try {
    await AsyncStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // best-effort: a stale draft only prefills a review the server refuses
  }
}

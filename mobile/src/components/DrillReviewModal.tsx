import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView, StyleSheet,
} from 'react-native';
import { isImageShareAvailable, isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { PickleAmount } from './PickleAmount';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { noteDrillReviewed } from '../lib/playSession';
import { explainRefusal } from '../lib/refusalNotices';
import { drillReviewRefusal, isAlreadyReviewedMessage } from '../lib/refusals';
import { isAlreadyLoggedMessage, loggedDrillNote } from '../lib/sessionAdds';
import { getMySessionValidity } from '../data/playSessions';
import {
  clearDrillReviewDraft,
  draftHasContent,
  emptyRatings,
  loadDrillReviewDraft,
  saveDrillReviewDraft,
} from '../lib/drillReviewDraft';

// The minimal session shape both DrillScreen and DrillRequestsScreen can supply.
// `logForPlaySession`: a drill of my own, logged for that play session and
// reviewed in one step (log_session_drill; End's "Log a drill", Play
// history's "Add a drill"). Then `id` is only the draft's key
// (lib/sessionAdds loggedDrillDraftId) and `heading` names the session.
export type ReviewableDrill = { id: string; partner_name: string; logForPlaySession?: string; heading?: string };

const FACETS = [
  { key: 'consistency',    label: 'Consistency' },
  { key: 'effort',         label: 'Effort' },
  { key: 'organization',   label: 'Organization' },
  { key: 'intentionality', label: 'Intentionality' },
  { key: 'fun',            label: 'Fun' },
] as const;
type FacetKey = typeof FACETS[number]['key'];

const TEXT_MAX = 500;       // 500 chars × 0.1 = the 50-pickle cap
const PICKLES_PER_FACET = 5;
const TEXT_PICKLE_CAP = 50;

/**
 * Drill self-review: rate 5 facets (5 pickles each) + an optional long-text review
 * (0.1 pickle/char, capped at 50). Submits via submit_drill_review and shows the
 * pickles earned. One review per participant per session (server-enforced).
 *
 * The call is bounded at 15 s and never retried. A lost answer (timeout or
 * dropped connection) may still have saved, so the copy never says it
 * wasn't; when the next try answers "already reviewed", that earlier try
 * saved: it reads as saved (earned unknown: `onSubmitted(id, null)`).
 *
 * Save draft keeps the ratings and text on this device (lib/drillReviewDraft)
 * and closes; the review reopens with them. Sending it drops the draft.
 *
 * With `onShare` (and image sharing on this binary), the thanks stays up with
 * "Share your drill" and Done instead of closing by itself: either one calls
 * onSubmitted, and Share then hands the drill to the caller's share card.
 */
export default function DrillReviewModal({
  session, onSubmitted, onClose, onDraftSaved, onShare,
}: {
  /** After the review: the caller opens the drill share card (PKL-013). */
  onShare?: (sessionId: string) => void;
  session: ReviewableDrill | null;
  /** Save draft kept it (a list can mark the drill as having a draft). */
  onDraftSaved?: (sessionId: string) => void;
  /** `earned` null: saved by an earlier try whose answer was lost, so the amount isn't known here. */
  onSubmitted: (sessionId: string, earned: number | null) => void;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const t = textStyles(c);
  const toast = useToast();

  const [ratings, setRatings] = useState<Record<FacetKey, number>>(emptyRatings);
  const [notes, setNotes]           = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  // Saved: the pickles earned, or null when an earlier try saved it and its answer was lost.
  const [done, setDone]             = useState<{ earned: number | null; drillId?: string | null } | null>(null);
  // The review reopened from a saved draft.
  const [fromDraft, setFromDraft]   = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  // A try whose answer never came back (it may have saved).
  const lostAnswer = useRef(false);
  const shareable = !!onShare && isImageShareAvailable();
  // onSubmitted runs once per review, whichever way the thanks closes.
  const left = useRef(false);

  useEffect(() => {
    if (!session) return;
    setRatings(emptyRatings());
    setNotes('');
    setSubmitting(false);
    setError(null);
    setDone(null);
    setFromDraft(false);
    setSavingDraft(false);
    lostAnswer.current = false;
    left.current = false;
    // Pick up a saved draft, unless something was already typed meanwhile.
    let live = true;
    const id = session.id;
    void loadDrillReviewDraft(id).then((d) => {
      if (!live || !d) return;
      setRatings((prev) => (Object.values(prev).some((v) => v >= 1) ? prev : d.ratings));
      setNotes((prev) => (prev.trim() ? prev : d.notes));
      setFromDraft(true);
    });
    return () => {
      live = false;
    };
  }, [session?.id]);

  if (!session) return null;

  const answered    = FACETS.filter(f => ratings[f.key] >= 1).length;
  const facetPickles = answered * PICKLES_PER_FACET;
  const textPickles  = Math.min(Math.floor(notes.trim().length * 0.1), TEXT_PICKLE_CAP);
  const preview      = facetPickles + textPickles;

  async function submit() {
    if (!session || answered < 1) return;
    setSubmitting(true);
    setError(null);
    type Row = { success?: boolean; pickles_granted?: number; message?: string; drill_session_id?: string | null };
    let data: Row[] | Row | null;
    const facets = {
      p_consistency:    ratings.consistency    || null,
      p_effort:         ratings.effort         || null,
      p_organization:   ratings.organization   || null,
      p_intentionality: ratings.intentionality || null,
      p_fun:            ratings.fun            || null,
      p_notes:          notes.trim() || null,
    };
    const logFor = session.logForPlaySession;
    try {
      // Bounded (a dead connection never leaves the spinner running); not
      // retried: a second try of a review that landed reads "already reviewed"
      // (a logged drill: "already logged").
      data = (await sbCall(
        () =>
          logFor
            ? supabase.rpc('log_session_drill', { p_play_session: logFor, ...facets })
            : supabase.rpc('submit_drill_review', { p_session_id: session.id, ...facets }),
        { retries: 0, timeoutMs: 15_000 },
      )) as Row[] | Row | null;
    } catch (e) {
      setSubmitting(false);
      // A timeout or a dropped connection may have saved it: never claim it
      // didn't. The next try tells (an "already reviewed" answer = saved).
      if (isNetworkError(e)) lostAnswer.current = true;
      setError(
        explainRefusal(e, "Your review wasn't saved. Try again.", {}, {
          network: "Lost the connection, so we can't tell whether your review was saved. Try again: if it was, Pickleague will say so.",
        }),
      );
      return;
    }
    setSubmitting(false);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      const already = isAlreadyReviewedMessage(row?.message) || (!!logFor && isAlreadyLoggedMessage(row?.message));
      // The try whose answer was lost had saved it.
      if (lostAnswer.current && already) { finish(null); return; }
      // Reviewed already (another device): the draft has nothing left to finish.
      if (already) void clearDrillReviewDraft(session.id);
      // Why the server didn't take it, then what to do.
      setError(drillReviewRefusal(row?.message));
      return;
    }
    finish(row.pickles_granted ?? preview, row.drill_session_id ?? null);
  }

  async function saveDraft() {
    if (!session || savingDraft) return;
    setSavingDraft(true);
    const ok = await saveDrillReviewDraft(session.id, { ratings, notes });
    setSavingDraft(false);
    if (!ok) {
      setError("Couldn't save your draft on this phone. Try again.");
      return;
    }
    toast.success(session.logForPlaySession
      ? 'Draft saved. Finish it from Me › Play history.'
      : 'Draft saved. Finish it from Review your drills.');
    onDraftSaved?.(session.id);
    onClose();
  }

  function finish(earned: number | null, drillId: string | null = null) {
    if (!session) return;
    setDone({ earned, drillId });
    void clearDrillReviewDraft(session.id);
    // A drill held during my running (or just-ended) play session makes it
    // count: say so, or why this drill doesn't count for it. A toast, so it
    // outlives this sheet. A logged drill: whether its own session counts now.
    const logFor = session.logForPlaySession;
    const note = logFor
      ? getMySessionValidity(logFor).then(loggedDrillNote, () => null)
      : noteDrillReviewed();
    void note.then((n) => {
      if (n) toast.info(n);
    });
    if (shareable) return; // the thanks stays up with Share / Done
    const sid = session.id;
    setTimeout(() => onSubmitted(sid, earned), 1300);
  }

  /** Close the thanks (shareable mode): the caller's bookkeeping, then maybe the share card. */
  function leave(share: boolean) {
    if (!session || !done || left.current) return;
    left.current = true;
    onSubmitted(session.id, done.earned);
    // A logged drill shares by the drill it stored (unknown when the answer was lost: no card).
    const shareId = session.logForPlaySession ? done.drillId : session.id;
    if (share && shareId) onShare?.(shareId);
  }
  const closeNow = () => (done && shareable ? leave(false) : onClose());


  return (
    <Modal visible={!!session} transparent animationType="fade" onRequestClose={closeNow}>
      <View style={S.overlay}>
        <View style={S.panel}>
          <View style={S.header}>
            <Icon name="edit" size={16} color={c.textSub} />
            <Text style={[t.title, S.title]} numberOfLines={1}>{session.logForPlaySession ? 'Log your drill' : 'Review your drill'}</Text>
            <TouchableOpacity onPress={closeNow} style={S.closeBox} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="close" size={20} color={c.textSub} />
            </TouchableOpacity>
          </View>

          {done !== null ? (
            <View style={S.successWrap}>
              <Icon name="pickle" size={48} color={c.primary} style={S.successGlyph} />
              {done.earned !== null ? (
                <>
                  <Text style={[t.h2, S.successText]}>+{done.earned} pickles earned!</Text>
                  <Text style={[t.sub, S.center]}>{session.logForPlaySession ? 'Your drill is logged.' : 'Thanks for reviewing your drill.'}</Text>
                </>
              ) : (
                <>
                  <Text style={[t.h2, S.successText]}>Your review was saved</Text>
                  <Text style={[t.sub, S.center]}>It went through before the connection dropped. Thanks for reviewing your drill.</Text>
                </>
              )}
              {shareable ? (
                <View style={S.shareActions}>
                  <Text style={[t.sub, S.center]}>Put in the work? Show it off.</Text>
                  <Button title="Share your drill" iconName="share" onPress={() => leave(true)} style={S.shareBtn} />
                  <Button title="Done" variant="outline" onPress={() => leave(false)} style={S.shareBtn} />
                </View>
              ) : null}
            </View>
          ) : (
            <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
              <Text style={t.title}>{session.heading ?? `Drill with ${session.partner_name}`}</Text>
              <Text style={[t.hint, S.hint]}>Rate each aspect (5 pickles each) and add a review (1 pickle per 10 characters, up to 50).</Text>
              {fromDraft ? <Text style={[t.caption, S.draftNote]}>Picked up from your saved draft.</Text> : null}

              {FACETS.map(f => (
                <View key={f.key} style={S.facetRow}>
                  <Text style={S.facetLabel} numberOfLines={1}>{f.label}</Text>
                  <View style={S.starsRow}>
                    {[1, 2, 3, 4, 5].map(n => {
                      const on = n <= ratings[f.key];
                      return (
                        <TouchableOpacity
                          key={n}
                          style={S.starBox}
                          onPress={() => setRatings(prev => ({ ...prev, [f.key]: n }))}
                          disabled={submitting}
                          accessibilityRole="button"
                          accessibilityLabel={`${f.label}, ${n} of 5`}
                          accessibilityState={{ selected: n === ratings[f.key], disabled: submitting }}
                        >
                          <Icon
                            name={on ? 'star' : 'star-outline'}
                            size={24}
                            color={on ? c.rarityLegendary : c.textMuted}
                          />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))}

              <Text style={[t.fieldLabel, S.label]}>Self-review (optional)</Text>
              <TextInput
                style={S.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder="What did you work on? What went well, what to improve?"
                placeholderTextColor={c.textMuted}
                multiline
                maxLength={TEXT_MAX}
                editable={!submitting}
              />
              <View style={S.counter}>
                <Text style={t.caption}>{notes.trim().length}/{TEXT_MAX} ·</Text>
                <PickleAmount amount={textPickles} prefix="+" preset="caption" color={c.textMuted} iconColor={c.primary} />
              </View>

              {error && <Text style={S.errorText}>{error}</Text>}

              <Button
                title={`Submit & claim ${preview}`}
                iconName="pickle"
                iconPosition="trailing"
                onPress={submit}
                loading={submitting}
                disabled={answered < 1 || submitting}
                accessibilityLabel={`Submit and claim ${preview} pickles`}
              />
              {answered < 1 && <Text style={[t.hint, S.hint]}>Rate at least one aspect to claim your bonus.</Text>}
              <Button
                title="Save draft"
                variant="outline"
                onPress={() => void saveDraft()}
                loading={savingDraft}
                disabled={submitting || savingDraft || !draftHasContent({ ratings, notes })}
                accessibilityLabel="Save draft and finish later"
                style={S.draftBtn}
              />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay:      { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.lg },
    panel:        { backgroundColor: c.bg, borderRadius: RADIUS.lg, width: '100%', maxWidth: 480, maxHeight: '88%', borderWidth: HAIRLINE, borderColor: c.border, overflow: 'hidden' },
    header:       {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
      paddingVertical: SPACE.xs, paddingLeft: SPACE.lg, paddingRight: SPACE.xs,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    title:        { flex: 1 },
    closeBox:     { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    body:         { padding: SPACE.lg },
    center:       { textAlign: 'center' },
    hint:         { marginTop: SPACE.xs, marginBottom: SPACE.md },
    draftNote:    { marginTop: -SPACE.sm, marginBottom: SPACE.md, color: c.primary },
    draftBtn:     { marginTop: SPACE.sm },
    facetRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
    facetLabel:   { fontSize: FONT.size.md, fontWeight: FONT.weight.semibold, color: c.text, flex: 1, minWidth: 0 },
    starsRow:     { flexDirection: 'row' },
    // 40 wide x 44 tall: five fit beside the longest facet name at 375.
    starBox:      { width: 40, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    label:        { marginTop: SPACE.sm, marginBottom: SPACE.sm },
    notesInput:   {
      borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 84, maxHeight: 160,
      fontSize: FONT.size.md, color: c.text, backgroundColor: c.surface, textAlignVertical: 'top',
    },
    counter:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: SPACE.xs, marginTop: SPACE.xs, marginBottom: SPACE.md },
    errorText:    { fontSize: FONT.size.sm, fontWeight: FONT.weight.semibold, color: c.danger, marginBottom: SPACE.sm },
    successWrap:  { alignItems: 'center', paddingVertical: SPACE.xl + SPACE.lg, paddingHorizontal: SPACE.xl },
    shareActions: { alignSelf: 'stretch', gap: SPACE.sm, marginTop: SPACE.lg },
    shareBtn:     { alignSelf: 'stretch' },
    successGlyph: { marginBottom: SPACE.md },
    successText:  { color: c.primary, marginBottom: SPACE.xs, textAlign: 'center' },
  });
}

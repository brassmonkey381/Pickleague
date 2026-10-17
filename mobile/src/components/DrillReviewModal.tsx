import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { noteDrillReviewed } from '../lib/playSession';
import { explainRefusal } from '../lib/refusalNotices';
import { drillReviewRefusal, isAlreadyReviewedMessage } from '../lib/refusals';

// The minimal session shape both DrillScreen and DrillRequestsScreen can supply.
export type ReviewableDrill = { id: string; partner_name: string };

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
 * Drill self-review: rate 5 facets (5 🥒 each) + an optional long-text review
 * (0.1 🥒/char, capped at 50). Submits via submit_drill_review and shows the
 * pickles earned. One review per participant per session (server-enforced).
 *
 * The call is bounded at 15 s and never retried. A lost answer (timeout or
 * dropped connection) may still have saved, so the copy never says it
 * wasn't; when the next try answers "already reviewed", that earlier try
 * saved: it reads as saved (earned unknown: `onSubmitted(id, null)`).
 */
export default function DrillReviewModal({
  session, onSubmitted, onClose,
}: {
  session: ReviewableDrill | null;
  /** `earned` null: saved by an earlier try whose answer was lost, so the amount isn't known here. */
  onSubmitted: (sessionId: string, earned: number | null) => void;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const toast = useToast();

  const [ratings, setRatings] = useState<Record<FacetKey, number>>({
    consistency: 0, effort: 0, organization: 0, intentionality: 0, fun: 0,
  });
  const [notes, setNotes]           = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  // Saved: the pickles earned, or null when an earlier try saved it and its answer was lost.
  const [done, setDone]             = useState<{ earned: number | null } | null>(null);
  // A try whose answer never came back (it may have saved).
  const lostAnswer = useRef(false);

  useEffect(() => {
    if (session) {
      setRatings({ consistency: 0, effort: 0, organization: 0, intentionality: 0, fun: 0 });
      setNotes('');
      setSubmitting(false);
      setError(null);
      setDone(null);
      lostAnswer.current = false;
    }
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
    type Row = { success?: boolean; pickles_granted?: number; message?: string };
    let data: Row[] | Row | null;
    try {
      // Bounded (a dead connection never leaves the spinner running); not
      // retried: a second try of a review that landed reads "already reviewed".
      data = (await sbCall(
        () =>
          supabase.rpc('submit_drill_review', {
            p_session_id:     session.id,
            p_consistency:    ratings.consistency    || null,
            p_effort:         ratings.effort         || null,
            p_organization:   ratings.organization   || null,
            p_intentionality: ratings.intentionality || null,
            p_fun:            ratings.fun            || null,
            p_notes:          notes.trim() || null,
          }),
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
      // The try whose answer was lost had saved it.
      if (lostAnswer.current && isAlreadyReviewedMessage(row?.message)) { finish(null); return; }
      // Why the server didn't take it, then what to do.
      setError(drillReviewRefusal(row?.message));
      return;
    }
    finish(row.pickles_granted ?? preview);
  }

  function finish(earned: number | null) {
    if (!session) return;
    setDone({ earned });
    // A drill held during my running (or just-ended) play session makes it
    // count: say so, or why this drill doesn't count for it. A toast, so it
    // outlives this sheet.
    void noteDrillReviewed().then((note) => {
      if (note) toast.info(note);
    });
    const sid = session.id;
    setTimeout(() => onSubmitted(sid, earned), 1300);
  }

  return (
    <Modal visible={!!session} transparent animationType="fade" onRequestClose={onClose}>
      <View style={S.overlay}>
        <View style={S.panel}>
          <View style={S.header}>
            <Text style={S.title} numberOfLines={1}>📝 Review your drill</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={S.close}>✕</Text>
            </TouchableOpacity>
          </View>

          {done !== null ? (
            <View style={S.successWrap}>
              <Text style={S.successEmoji}>🥒</Text>
              {done.earned !== null ? (
                <>
                  <Text style={S.successText}>+{done.earned} pickles earned!</Text>
                  <Text style={S.successSub}>Thanks for reviewing your drill.</Text>
                </>
              ) : (
                <>
                  <Text style={S.successText}>Your review was saved</Text>
                  <Text style={S.successSub}>It went through before the connection dropped. Thanks for reviewing your drill.</Text>
                </>
              )}
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              <Text style={S.partnerLine}>Drill with {session.partner_name}</Text>
              <Text style={S.hint}>Rate each aspect (5 🥒 each) and add a review (0.1 🥒/char, up to 50).</Text>

              {FACETS.map(f => (
                <View key={f.key} style={S.facetRow}>
                  <Text style={S.facetLabel}>{f.label}</Text>
                  <View style={S.starsRow}>
                    {[1, 2, 3, 4, 5].map(n => (
                      <TouchableOpacity
                        key={n}
                        onPress={() => setRatings(prev => ({ ...prev, [f.key]: n }))}
                        hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                        disabled={submitting}
                      >
                        <Text style={[S.star, n <= ratings[f.key] ? S.starOn : S.starOff]}>★</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ))}

              <Text style={S.label}>Self-review (optional)</Text>
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
              <Text style={S.counter}>{notes.trim().length}/{TEXT_MAX} · +{textPickles} 🥒</Text>

              {error && <Text style={S.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[S.submitBtn, (answered < 1 || submitting) && S.submitBtnDim]}
                onPress={submit}
                disabled={answered < 1 || submitting}
              >
                {submitting
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={S.submitBtnText}>Submit & claim {preview} 🥒</Text>}
              </TouchableOpacity>
              {answered < 1 && <Text style={S.hint}>Rate at least one aspect to claim your bonus.</Text>}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    panel:        { backgroundColor: c.bg, borderRadius: 14, width: '100%', maxWidth: 480, maxHeight: '88%', borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
    header:       { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    title:        { flex: 1, fontSize: 16, fontWeight: '800', color: c.text },
    close:        { fontSize: 20, color: c.textSub, fontWeight: '700', paddingHorizontal: 4 },
    partnerLine:  { fontSize: 14, color: c.text, fontWeight: '700' },
    hint:         { fontSize: 12, color: c.textMuted, marginTop: 4, marginBottom: 12, lineHeight: 17 },
    facetRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    facetLabel:   { fontSize: 14, fontWeight: '600', color: c.text, flex: 1 },
    starsRow:     { flexDirection: 'row', gap: 4 },
    star:         { fontSize: 26 },
    starOn:       { color: '#f5b301' },
    starOff:      { color: c.border },
    label:        { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 8, marginBottom: 6 },
    notesInput:   { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 84, maxHeight: 160, fontSize: 14, color: c.text, backgroundColor: c.surface, textAlignVertical: 'top' },
    counter:      { fontSize: 11, color: c.textMuted, textAlign: 'right', marginTop: 4, marginBottom: 12 },
    errorText:    { color: c.danger, fontSize: 12, fontWeight: '600', marginBottom: 10 },
    submitBtn:    { backgroundColor: c.primary, paddingVertical: 13, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    submitBtnDim: { opacity: 0.5 },
    submitBtnText:{ color: '#fff', fontWeight: '800', fontSize: 15 },
    successWrap:  { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
    successEmoji: { fontSize: 56, marginBottom: 12 },
    successText:  { fontSize: 22, fontWeight: '800', color: c.primary, marginBottom: 6 },
    successSub:   { fontSize: 14, color: c.textSub, textAlign: 'center' },
  });
}

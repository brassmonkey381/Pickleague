import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView, StyleSheet,
} from 'react-native';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
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
 * Drill self-review: rate 5 facets (5 pickles each) + an optional long-text review
 * (0.1 pickle/char, capped at 50). Submits via submit_drill_review and shows the
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
  const t = textStyles(c);
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
            <Icon name="edit" size={16} color={c.textSub} />
            <Text style={[t.title, S.title]} numberOfLines={1}>Review your drill</Text>
            <TouchableOpacity onPress={onClose} style={S.closeBox} accessibilityRole="button" accessibilityLabel="Close">
              <Icon name="close" size={20} color={c.textSub} />
            </TouchableOpacity>
          </View>

          {done !== null ? (
            <View style={S.successWrap}>
              <Icon name="pickle" size={48} color={c.primary} style={S.successGlyph} />
              {done.earned !== null ? (
                <>
                  <Text style={[t.h2, S.successText]}>+{done.earned} pickles earned!</Text>
                  <Text style={[t.sub, S.center]}>Thanks for reviewing your drill.</Text>
                </>
              ) : (
                <>
                  <Text style={[t.h2, S.successText]}>Your review was saved</Text>
                  <Text style={[t.sub, S.center]}>It went through before the connection dropped. Thanks for reviewing your drill.</Text>
                </>
              )}
            </View>
          ) : (
            <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
              <Text style={t.title}>Drill with {session.partner_name}</Text>
              <Text style={[t.hint, S.hint]}>Rate each aspect (5 pickles each) and add a review (1 pickle per 10 characters, up to 50).</Text>

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
    successGlyph: { marginBottom: SPACE.md },
    successText:  { color: c.primary, marginBottom: SPACE.xs, textAlign: 'center' },
  });
}

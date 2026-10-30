// "Record a match or drill?": what ending a play session shows
// (docs/play-sessions-presence.md, Phase 1.5). A session counts for rewards
// and streaks once it lasted 5+ minutes and a match or drill was recorded for
// it; the server judges (play_sessions.valid). Too short, or a confirmed
// match or a drill this device knows counts: a toast, no sheet. Otherwise
// (nothing known, or a match this device recorded that may have expired
// unconfirmed since) it asks the server (my_session_validity, bounded at
// 2 s), which may already count the session (a match a partner recorded, a
// drill reviewed): then a toast too, since asking would invite a duplicate
// match. Only when the server says a match or drill is still needed, or
// can't answer, does this sheet ask, while the player still remembers:
// Record match opens MatchEntry linked to the session
// (matches.play_session_id), Review drill opens DrillRequests ("Review your
// drills", which lists today's drill) for a session started from a scheduled
// drill, Log a drill (every other session) logs and reviews a drill of my own
// for this session in one step (DrillReviewModal, log_session_drill; it then
// counts, and Share puts it on the drill card), and Not now (or
// closing the sheet) leaves a note that it still counts when one is recorded
// within 2 hours. Discard throws the session away (discard_play_session,
// PKL-011): it leaves Play history and never counts. Without a server answer the copy is hedged ("If you haven't
// recorded it yet"), or, after a match this device recorded, decision 3's
// toast. Every line says why it doesn't count yet and by when to fix that
// (rule 11): nothing recorded, what the player recorded counts for another
// session, or the match recorded during it was removed; a pending match
// "counts once the other team confirms (within the hour)" (or names the team
// that still has to). Once the 2 hours are over (a session found auto-ended
// late), a toast says it didn't count instead. lib/sessionValidity decides;
// presence never depends on any of this. A match or drill can also be added
// later, for 7 days, from Me › Play history (lib/sessionAdds).
//
// Mounted once at the app root next to PlayIsland (navigation/AppNavigator),
// outside the navigator, so it navigates through navigateWhenReady. The island
// is not a Modal, so this sheet can open the moment End is tapped.
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { BottomSheet, TextLink } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { navigateWhenReady, openMatchEntryForSession } from '../../lib/navigationRef';
import { whenLabel } from '../../lib/refusals';
import { playEnded } from '../../lib/playSession';
import {
  END_CHECK_MS,
  endDecision,
  endDecisionWithServer,
  endSheetBody,
  notNowNote,
  type EndDecision,
  type EndedPlay,
  type ServerAnswer,
} from '../../lib/sessionValidity';
import { discardPlaySession, getMySessionValidity } from '../../data/playSessions';
import { refusalCode } from '../../lib/refusals';
import { PLAY_NAV_ENABLED } from '../../lib/features';
import { playCompleteLine } from '../../lib/playStartRules';
import { END_SHEET_DRILL_TITLE, endSheetDrillAction, loggedDrillDraftId } from '../../lib/sessionAdds';
import DrillReviewModal, { type ReviewableDrill } from '../DrillReviewModal';
import DrillShareStudio, { type DrillShareTarget } from '../share/DrillShareStudio';

type Shown = { ended: EndedPlay; ask: Extract<EndDecision, { show: 'record' }> };

export default function PlayEndSheetHost({ signedIn }: { signedIn: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [shown, setShown] = useState<Shown | null>(null);
  // Log a drill: its review sheet, then maybe its share card.
  const [logging, setLogging] = useState<ReviewableDrill | null>(null);
  const [drillShare, setDrillShare] = useState<DrillShareTarget | null>(null);
  // Keeps the content on screen while the sheet slides away.
  const last = useRef<Shown | null>(null);
  if (shown) last.current = shown;
  const view = shown ?? last.current;
  // The latest End (or sign-out): a slower server answer for an older one is dropped.
  const seq = useRef(0);
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  const show = (d: EndDecision, ended: EndedPlay) => {
    if (d.show === 'note') {
      if (d.tone === 'success') toast.success(d.message);
      else toast.info(d.message);
      return;
    }
    setShown({ ended, ask: d });
  };

  useSignal(playEnded, (ended) => {
    if (!signedIn) return;
    const token = ++seq.current;
    const local = endDecision(ended);
    if (local.show === 'note') {
      show(local, ended);
      return;
    }
    // The server may already count it. Never longer than END_CHECK_MS.
    void withTimeout(getMySessionValidity(ended.id), END_CHECK_MS)
      .then(
        (v): ServerAnswer => v,
        (): ServerAnswer => 'unknown',
      )
      .then((v) => {
        if (token !== seq.current || !signedInRef.current) return;
        show(endDecisionWithServer(local, v), ended);
      });
  });
  useEffect(() => {
    if (!signedIn) {
      seq.current += 1;
      setShown(null);
      setLogging(null);
      setDrillShare(null);
    }
  }, [signedIn]);

  const notNow = () => {
    // The deadline may fall after midnight: "Fri 12:40 AM" then.
    if (shown) toast.info(notNowNote(shown.ask.windowEndsAtMs, (d) => whenLabel(d), !!shown.ask.unsure));
    setShown(null);
  };
  const recordMatch = () => {
    if (!shown) return;
    const id = shown.ended.id;
    setShown(null);
    openMatchEntryForSession(id);
  };
  const discard = () => {
    if (!shown) return;
    const id = shown.ended.id;
    setShown(null);
    discardPlaySession(id).then(
      () => toast.info('Session discarded'),
      // Its End still on its way (session.open), offline, or an older server.
      (e) => toast.info(refusalCode(e) === 'session.gone'
        ? 'Session discarded'
        : "Couldn't discard it yet. Discard it from Me › Play history in a moment."),
    );
  };
  const logDrill = () => {
    if (!shown) return;
    const { ended, ask } = shown;
    setShown(null);
    // After the sheet has slid away: one modal at a time on iOS.
    setTimeout(() => {
      if (!signedInRef.current) return;
      setLogging({
        id: loggedDrillDraftId(ended.id),
        partner_name: '',
        logForPlaySession: ended.id,
        heading: `Your drill · ${ask.lengthLabel}`,
      });
    }, 350);
  };
  const reviewDrill = () => {
    const sourceId = shown?.ended.kind === 'drill' ? shown.ended.sourceId : null;
    setShown(null);
    // "Review your drills" lists every started, unreviewed drill, today's
    // included (Drill's own Review button shows only from tomorrow, too late).
    // A session started from a drill opens that drill's review (and its draft).
    navigateWhenReady('DrillRequests', sourceId ? { reviewId: sourceId } : undefined);
  };

  return (
    <>
      <BottomSheet visible={!!shown} onClose={notNow} title="Record a match or drill?">
        {view ? (
          <View style={S.body}>
            {PLAY_NAV_ENABLED ? <Text style={t.title}>{playCompleteLine(view.ended)}</Text> : null}
            <Text style={t.sub}>{endSheetBody(view.ask)}</Text>
            <View style={S.actions}>
              <Button title="Record match" variant="success" onPress={recordMatch} />
              {/* Always a drill: review the scheduled one it was started from, else log one. */}
              <Button
                title={END_SHEET_DRILL_TITLE[endSheetDrillAction(view.ended)]}
                variant="outline"
                onPress={endSheetDrillAction(view.ended) === 'review' ? reviewDrill : logDrill}
              />
              <Button title="Not now" variant="outline" onPress={notNow} />
              <TextLink label="Discard session" onPress={discard} accessibilityLabel="Discard this play session" style={S.discard} />
            </View>
          </View>
        ) : null}
      </BottomSheet>
      <DrillReviewModal
        session={logging}
        onClose={() => setLogging(null)}
        onSubmitted={() => setLogging(null)}
        onShare={(drillSessionId) => setTimeout(() => setDrillShare({ drillSessionId }), 350)}
      />
      <DrillShareStudio target={drillShare} onClose={() => setDrillShare(null)} />
    </>
  );
}

const S = StyleSheet.create({
  body: { gap: SPACE.md, paddingBottom: SPACE.sm },
  actions: { gap: SPACE.sm },
  discard: { alignSelf: 'center', minHeight: 44 },
});

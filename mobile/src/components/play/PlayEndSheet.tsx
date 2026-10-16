// "Record a match or drill?": what ending a play session shows
// (docs/play-sessions-presence.md, Phase 1.5). A session counts for rewards
// and streaks once it lasted 5+ minutes and a match or drill was recorded for
// it; the server judges (play_sessions.valid). Too short, or something this
// device knows already counts: a toast, no sheet. Otherwise it asks the server
// (my_session_validity, bounded at 2 s), which may already count the session
// (a match a partner recorded, a drill reviewed): then a toast too, since
// asking would invite a duplicate match. Only when the server says a match or
// drill is still needed, or can't answer, does this sheet ask, while the
// player still remembers: Record match opens MatchEntry linked to the session
// (matches.play_session_id), Review drill opens DrillRequests ("Review your
// drills", which lists today's drill) for a drill session, and Not now (or
// closing the sheet) leaves a note that it still counts when one is recorded
// within 2 hours. Without a server answer the copy is hedged ("If you haven't
// recorded it yet"). lib/sessionValidity decides; presence never depends on
// any of this.
//
// Mounted once at the app root next to PlayIsland (navigation/AppNavigator),
// outside the navigator, so it navigates through navigateWhenReady. The island
// is not a Modal, so this sheet can open the moment End is tapped.
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { navigateWhenReady, openMatchEntryForSession } from '../../lib/navigationRef';
import { shortTime } from '../../lib/agenda';
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
import { getMySessionValidity } from '../../data/playSessions';

type Shown = { ended: EndedPlay; ask: Extract<EndDecision, { show: 'record' }> };

export default function PlayEndSheetHost({ signedIn }: { signedIn: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [shown, setShown] = useState<Shown | null>(null);
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
    }
  }, [signedIn]);

  const notNow = () => {
    if (shown) toast.info(notNowNote(shown.ask.windowEndsAtMs, shortTime, !!shown.ask.unsure));
    setShown(null);
  };
  const recordMatch = () => {
    if (!shown) return;
    const id = shown.ended.id;
    setShown(null);
    openMatchEntryForSession(id);
  };
  const reviewDrill = () => {
    setShown(null);
    // "Review your drills" lists every started, unreviewed drill, today's
    // included (Drill's own Review button shows only from tomorrow, too late).
    navigateWhenReady('DrillRequests');
  };

  return (
    <BottomSheet visible={!!shown} onClose={notNow} title="Record a match or drill?">
      {view ? (
        <View style={S.body}>
          <Text style={t.sub}>{endSheetBody(view.ask)}</Text>
          <View style={S.actions}>
            <Button title="Record match" variant="success" onPress={recordMatch} />
            {view.ask.offerDrill ? <Button title="Review drill" variant="outline" onPress={reviewDrill} /> : null}
            <Button title="Not now" variant="outline" onPress={notNow} />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  body: { gap: SPACE.md, paddingBottom: SPACE.sm },
  actions: { gap: SPACE.sm },
});

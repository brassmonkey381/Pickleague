// "Record a match or drill?": what ending a play session shows
// (docs/play-sessions-presence.md, Phase 1.5). A session counts for rewards
// and streaks once it lasted 5+ minutes and a match or drill was recorded for
// it; the server judges (play_sessions.valid). This sheet asks while the
// player still remembers: Record match opens MatchEntry linked to the session
// (matches.play_session_id), Review drill opens Drill for a drill session, and
// Not now (or closing the sheet) leaves a note that it still counts when one
// is recorded within 2 hours. Too short, or a match already recorded from the
// island's Enter score: a toast instead, no sheet (lib/sessionValidity
// decides). Presence never depends on any of this.
//
// Mounted once at the app root next to PlayIsland (navigation/AppNavigator),
// outside the navigator, so it navigates through navigateWhenReady. The island
// is not a Modal, so this sheet can open the moment End is tapped.
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { navigateWhenReady } from '../../lib/navigationRef';
import { shortTime } from '../../lib/agenda';
import { playEnded } from '../../lib/playSession';
import { endDecision, notNowNote, type EndDecision, type EndedPlay } from '../../lib/sessionValidity';

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

  useSignal(playEnded, (ended) => {
    if (!signedIn) return;
    const d = endDecision(ended);
    if (d.show === 'note') {
      if (d.tone === 'success') toast.success(d.message);
      else toast.info(d.message);
      return;
    }
    setShown({ ended, ask: d });
  });
  useEffect(() => {
    if (!signedIn) setShown(null);
  }, [signedIn]);

  const notNow = () => {
    if (shown) toast.info(notNowNote(shown.ask.windowEndsAtMs, shortTime));
    setShown(null);
  };
  const recordMatch = () => {
    if (!shown) return;
    const id = shown.ended.id;
    setShown(null);
    navigateWhenReady('MatchEntry', { fromHome: true, playSessionId: id });
  };
  const reviewDrill = () => {
    setShown(null);
    navigateWhenReady('Drill');
  };

  return (
    <BottomSheet visible={!!shown} onClose={notNow} title="Record a match or drill?">
      {view ? (
        <View style={S.body}>
          <Text style={t.sub}>
            {`Session ended after ${view.ask.lengthLabel}. It counts once you record what you played, within 2 hours.`}
          </Text>
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

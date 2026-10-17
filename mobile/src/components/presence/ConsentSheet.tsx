// The one-time sheet before a first check-in or play session: who will see
// your name at the court, with "Change" to pick another level right here (the
// same setting as Settings > Privacy > Who sees me at the courts).
//
//   Who sees you at the courts
//   Your friends and players in your closed leagues will see your name ...
//   Everyone else sees "a player" in the count. Blocked players never see your name.
//   Friends and league-mates · Change
//   [Got it]  [Not now]
//
// PresenceConsentHost is mounted once (App.tsx) and opened by
// ensurePresenceConsent() (lib/presenceConsent.ts). It answers only once the
// sheet has fully closed, so the caller can present its next Modal at once
// (iOS drops a Modal presented while another is still dismissing).
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { explainRefusal } from '../../lib/refusalNotices';
import {
  CHECKINS_LEVELS,
  DEFAULT_PRESENCE_SETTINGS,
  LEAGUEMATES_NOTE,
  checkinsLevelLabel,
  consentAudienceLine,
  consentOthersLine,
  type CheckinsLevel,
} from '../../lib/presencePrivacy';
import { registerConsentHost, recordPresenceConsent, type ConsentRequest } from '../../lib/presenceConsent';
import { setPresenceSettings, usePresenceSettings } from '../../data/presenceSettings';
import LevelChoiceList from './LevelChoiceList';

/** Longest wait for the sheet's own "fully closed" signal before answering anyway. */
const DISMISS_FALLBACK_MS = 700;

type SheetProps = {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onDismissed?: () => void;
};

export function ConsentSheet({ visible, onAccept, onDecline, onDismissed }: SheetProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const settings = usePresenceSettings(visible);
  const [level, setLevel] = useState<CheckinsLevel>(DEFAULT_PRESENCE_SETTINGS.checkins_level);
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState<CheckinsLevel | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Each open starts from the saved level, collapsed.
  useEffect(() => {
    if (!visible) return;
    setChanging(false);
    setError(null);
  }, [visible]);
  const saved = settings.data?.checkins_level;
  useEffect(() => {
    if (saved) setLevel(saved);
  }, [saved]);

  async function pick(next: CheckinsLevel) {
    const prev = level;
    setLevel(next);
    setSaving(next);
    setError(null);
    try {
      await setPresenceSettings({ checkinsLevel: next });
      setChanging(false);
    } catch (e) {
      setLevel(prev);
      setError(explainRefusal(e, "Couldn't save that. Try again, or change it later in Settings."));
    } finally {
      setSaving(null);
    }
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onDecline}
      onDismissed={onDismissed}
      title="Who sees you at the courts"
    >
      {/* The text scrolls at large font sizes; the buttons stay in view. */}
      <ScrollView style={S.scroll} contentContainerStyle={S.body}>
        <Text style={t.body}>{consentAudienceLine(level)}</Text>
        <Text style={t.sub}>{consentOthersLine(level)}</Text>
        <Text style={t.sub}>Your check-in ends when you check out or when its time runs out.</Text>

        {changing ? (
          <View>
            <LevelChoiceList options={CHECKINS_LEVELS} value={level} onPick={(l) => void pick(l)} saving={saving} disabled={!!saving} />
            <Text style={[t.hint, S.note]}>{LEAGUEMATES_NOTE}</Text>
          </View>
        ) : (
          <View style={S.levelRow}>
            <Text style={[t.title, S.flex]} numberOfLines={1}>
              {checkinsLevelLabel(level)}
            </Text>
            <TouchableOpacity
              style={S.link}
              onPress={() => setChanging(true)}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Change who sees you at the courts"
            >
              <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                Change
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {!changing && level === 'leaguemates' ? <Text style={t.hint}>{LEAGUEMATES_NOTE}</Text> : null}
        {error ? <Text style={[t.sub, { color: c.danger }]}>{error}</Text> : null}
        <Text style={t.hint}>You can change this any time in Settings › Privacy.</Text>
      </ScrollView>
      <View style={S.buttons}>
        <Button title="Got it" onPress={onAccept} disabled={!!saving} style={S.flex} />
        <Button title="Not now" variant="outline" onPress={onDecline} disabled={!!saving} style={S.flex} />
      </View>
    </BottomSheet>
  );
}

/** Mounted once, in App.tsx. Shows the sheet when ensurePresenceConsent() asks. */
export function PresenceConsentHost() {
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [visible, setVisible] = useState(false);
  // The answer waits here until the sheet is fully closed.
  const answer = useRef<{ req: ConsentRequest; accepted: boolean } | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () =>
      registerConsentHost((req) => {
        setRequest(req);
        setVisible(true);
      }),
    [],
  );
  useEffect(() => () => {
    if (fallback.current) clearTimeout(fallback.current);
  }, []);

  function deliver() {
    if (fallback.current) clearTimeout(fallback.current);
    fallback.current = null;
    const a = answer.current;
    answer.current = null;
    if (a) a.req.answer(a.accepted);
    setRequest(null);
  }

  function close(accepted: boolean) {
    if (!request) return;
    answer.current = { req: request, accepted };
    setVisible(false);
    // onDismissed is the real signal; this only covers a platform that never sends it.
    fallback.current = setTimeout(deliver, DISMISS_FALLBACK_MS);
  }

  return (
    <ConsentSheet
      visible={visible}
      onAccept={() => {
        void recordPresenceConsent();
        close(true);
      }}
      onDecline={() => close(false)}
      onDismissed={deliver}
    />
  );
}

const S = StyleSheet.create({
  // Sizes to its content, shrinking (and scrolling) only under the sheet's cap.
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: SPACE.sm },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
  note: { marginTop: SPACE.xs },
  buttons: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
  flex: { flex: 1 },
});

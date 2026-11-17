// Dev-only web page for the PKL-031 UI revamp: each new overlay and screen
// drawn at phone size with sample data, no sign-in, for screenshot QA. Reached
// only on a dev web build at /?revamplab=<scene> (index.ts checks __DEV__
// first). Scenes: crash, notices, system, pot, danger, join, welcome, courts,
// alerts. Nothing here talks to the server unless a button is pressed.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BrandBand, ConfirmModal, CrashScreen, Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { edgeColor, medalColor } from '@just-messin-around/expo-foundation/theme';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import { ThemeProvider, useTheme } from '../lib/ThemeContext';
import ToastProvider from '../lib/ToastProvider';
import { useBootLook } from '../lib/fonts';
import { CRASH_BODY, CRASH_TITLE, CRASH_TITLE_FONT, PICKLEAGUE_CRASH_PALETTE } from '../lib/crashPalette';
import PicklePotCard from '../components/PicklePotCard';
import JoinCodeModal from '../components/home/JoinCodeModal';
import FirstRunScreen from '../screens/FirstRunScreen';
import type { UseLeagueJoin } from '../lib/useLeagueJoin';

const scene = (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('revamplab')) || 'notices';

// An iPhone 15's insets, so the notice stack sits where it would on a phone.
const PHONE_METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 59, left: 0, right: 0, bottom: 34 } };

/** A Home-like page behind the overlays. */
function Backdrop() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }}>
      <BrandBand style={{ paddingTop: 72, paddingBottom: 18, paddingHorizontal: 16 }}>
        <Text style={[t.h1, { color: c.headerText }]}>Hi, Jordan</Text>
        <Text style={[t.sub, { color: c.headerText }]}>3 games near you this week</Text>
      </BrandBand>
      <View style={{ padding: 16, gap: 12 }}>
        <SectionHeader title="Up next" />
        <Panel padded={16}><Text style={t.title}>Doubles vs Sam &amp; Priya</Text><Text style={t.sub}>Riverside Courts, 9:00 AM</Text></Panel>
        <Panel padded={16}><Text style={t.title}>Eastside Ladder</Text><Text style={t.sub}>You're 4th, 2 points behind Chris</Text></Panel>
        <SectionHeader title="Your leagues" />
        <Panel padded={16}><View style={{ height: 48 }} /></Panel>
        <Panel padded={16}><View style={{ height: 48 }} /></Panel>
      </View>
    </ScrollView>
  );
}

function Notices({ system }: { system: boolean }) {
  const toast = useToast();
  const { colors: c } = useTheme();
  useEffect(() => {
    if (system) {
      toast.success('Joined Eastside Ladder');
      toast.error("Couldn't save the score.", { action: { label: 'Retry', onPress: () => {} }, sticky: true });
      toast.info('Sam accepted your invite.');
    } else {
      toast.success('Match saved. Waiting for Sam to confirm.', { sticky: true });
      toast.celebrate({
        kicker: 'Badge earned',
        title: 'First Win',
        text: 'Added to your achievements.',
        sticky: true,
        art: (
          <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: medalColor(c, 1), borderColor: edgeColor(c) }}>
            <EmojiGlyph emoji="🏆" size={24} color={edgeColor(c)} />
          </View>
        ),
        action: { label: 'View', onPress: () => {} },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Backdrop />;
}

const fakeJoin = {
  joining: false,
  error: "That code isn't active. Check it with the organiser.",
  setError: () => {},
  redeemCode: async () => null,
} as unknown as UseLeagueJoin;

function Scene() {
  const [open, setOpen] = useState(true);
  switch (scene) {
    case 'crash':
      return (
        <CrashScreen
          error={new Error('Cannot read properties of undefined (reading "players")')}
          onRetry={() => {}}
          onHome={() => {}}
          title={CRASH_TITLE}
          body={CRASH_BODY}
          palette={PICKLEAGUE_CRASH_PALETTE}
          titleFontFamily={CRASH_TITLE_FONT}
          showStack={false}
        />
      );
    case 'notices':
      return <Notices system={false} />;
    case 'system':
      return <Notices system />;
    case 'pot':
      return (
        <View style={{ flex: 1 }}>
          <Backdrop />
          <View style={{ position: 'absolute', left: 16, right: 16, bottom: 40 }}>
            <PicklePotCard
              scopeType="season"
              scopeId="lab"
              scopeLabel="Spring Ladder"
              pool={3500}
              structure={[60, 25, 15]}
              isAdmin
              canDistribute={false}
              members={[]}
              myPickleBalance={1240}
              onChange={() => {}}
            />
          </View>
        </View>
      );
    case 'danger':
      return (
        <View style={{ flex: 1 }}>
          <Backdrop />
          <ConfirmModal
            visible={open}
            variant="danger"
            iconName="logout"
            title="Leave Spring Ladder?"
            body="Your 6 matches stay on your record. You'll drop off the standings and lose your spot (4th)."
            primaryLabel="Leave ladder"
            cancelLabel="Stay"
            onConfirm={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        </View>
      );
    case 'join':
      return (
        <View style={{ flex: 1 }}>
          <Backdrop />
          <JoinCodeModal visible={open} leagueJoin={fakeJoin} initialCode="3F7A-B2C9" onClose={() => setOpen(false)} onRedeemed={() => {}} />
        </View>
      );
    default: {
      // welcome | courts | alerts: the real FirstRunScreen, stepped by the shooter.
      const nav = { canGoBack: () => true, goBack: () => {}, reset: () => {} } as never;
      return <FirstRunScreen navigation={nav} route={{ key: 'lab', name: 'FirstRun' } as never} nativePreview />;
    }
  }
}

export default function RevampLabWeb() {
  const ready = useBootLook();
  if (!ready) return null;
  return (
    <SafeAreaProvider initialMetrics={PHONE_METRICS}>
      <ThemeProvider>
        <ToastProvider>
          <Scene />
        </ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

// "Check in at a court" + who's here now. Home screen card; works on web too
// (the browser asks for location, and only when "Find my court" is tapped).
//
// Two looks, ONE mounted component (plan section 3, layout C): idle, it is the
// 48px court row ("At the courts?  Find my court ›") near the bottom of Home;
// checked in, or offering a check-in, it is the NOW panel's court block under
// the greeting: two 44 lines (about 120 with NOW's header), the second one
// "(A)(B)(C) +4 here   [+1 h] [Check out]". Tapping the avatars shows the full
// roster underneath; it is never rendered unasked. Home moves this same keyed element between the two spots and
// never unmounts it, because the 'home/' push target (the check-in reminder and
// the court-arrival notice) lands here and relies on its state and listeners.
// `onModeChange` tells Home which spot it belongs in.
//
// Every button is bounded (10 s) and resets its busy state in `finally`, so a
// dead connection can never leave a spinner running.
//
// No court in range offers "Add this court" (SubmitVenue, prefilled with the
// spot). After the first check-in that goes through, native shows a one-time
// offer to turn on court arrival alerts (otherwise only in Settings).
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { getCurrentCoords, getLastKnownCoords, withTimeout } from '@just-messin-around/expo-foundation/platform';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import {
  checkInAt,
  checkinChanged,
  checkOut,
  extendCheckinByHour,
  peekCurrentCheckin,
  refreshCurrentCheckin,
  type CurrentCheckin,
} from '../lib/courtCheckin';
import { resolveVenueAt, type NearbyVenue } from '../data/venueCheckins';
import { PlayersHerePile, PlayersHereRoster, usePlayersHere } from './PlayersHereList';
import PauseSharingChip from './presence/PauseSharingChip';
import CrowdLine from './court/CrowdLine';
import { noteGoodMoment } from '../lib/ratingPrompt';
import { playSession, startPlay } from '../lib/playSession';
import { getCourtAlertsEnabled, setCourtAlertsEnabled } from '../lib/courtGeofence';
import type { RootStackParamList } from '../types';

const BOUND_MS = 10_000;
// Set the moment the arrival-alerts offer is shown, so it never asks twice.
const ALERTS_OFFERED_KEY = 'pickleague_court_alerts_offered_v1';
const ALWAYS_LABEL = Platform.OS === 'android' ? 'Allow all the time' : 'Always';

/** True once per device: native, alerts off, never offered. Marks it offered. */
async function claimAlertsOffer(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (await AsyncStorage.getItem(ALERTS_OFFERED_KEY)) return false;
    if (await getCourtAlertsEnabled()) return false;
    await AsyncStorage.setItem(ALERTS_OFFERED_KEY, '1');
    return true;
  } catch {
    return false; // can't remember we asked, so don't ask
  }
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Roster rows once the avatars are tapped (the old always-on cap). */
const ROSTER_MAX_ROWS = 3;

/**
 * The NOW block's second line: who's here on the left, the actions on the
 * right. One fetch feeds both the pile and the roster it expands. The line
 * wraps the buttons under the pile only when they don't fit (a narrow phone or
 * large text): rows grow, they don't clip.
 */
function HereLine({ venueId, children }: { venueId: string | null; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return venueId ? (
    <HereLineWithRoster venueId={venueId} expanded={expanded} onToggle={() => setExpanded((x) => !x)}>
      {children}
    </HereLineWithRoster>
  ) : (
    // A check-in saved offline has no roster to show yet.
    <View style={lineStyles.row}>
      <View style={lineStyles.pile} />
      <View style={lineStyles.buttons}>{children}</View>
    </View>
  );
}

function HereLineWithRoster({
  venueId,
  expanded,
  onToggle,
  children,
}: {
  venueId: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { players, failed } = usePlayersHere(venueId);
  return (
    <>
      <View style={lineStyles.row}>
        <PlayersHerePile players={players} failed={failed} expanded={expanded} onPress={onToggle} style={lineStyles.pile} />
        <View style={lineStyles.buttons}>{children}</View>
      </View>
      {expanded && players && players.length > 0 ? <PlayersHereRoster players={players} maxRows={ROSTER_MAX_ROWS} /> : null}
    </>
  );
}

const lineStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: SPACE.sm,
    minHeight: 44,
  },
  pile: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginLeft: 'auto' },
});

/** idle = the court row; checked_in / prompt = the NOW block. */
export type CourtCardMode = 'idle' | 'checked_in' | 'prompt';

/** What was tapped (home.tap targets). */
export type CourtCardTap =
  | 'find_court'
  | 'just_play'
  | 'check_in'
  | 'not_here'
  | 'extend'
  | 'check_out'
  | 'start_playing'
  | 'add_court'
  | 'alerts_on'
  | 'alerts_not_now';

type Props = {
  onModeChange?: (mode: CourtCardMode) => void;
  onTap?: (target: CourtCardTap) => void;
};

export default function CourtCheckinCard({ onModeChange, onTap }: Props = {}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);
  const [nearby, setNearby] = useState<NearbyVenue | null>(null);
  const [busy, setBusy] = useState<null | 'find' | 'checkin' | 'extend' | 'out'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rosterKey, setRosterKey] = useState(0);
  // Where "Find my court" found nothing: offered as "Add this court".
  const [addAt, setAddAt] = useState<{ lat: number; lng: number } | null>(null);
  const [alertsOffer, setAlertsOffer] = useState<null | 'ask' | 'busy'>(null);
  const [alertsResult, setAlertsResult] = useState<string | null>(null);
  const playing = playSession.useLiveSession().status !== 'idle';
  const mode: CourtCardMode = current ? 'checked_in' : nearby ? 'prompt' : 'idle';

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    void peekCurrentCheckin().then(setCurrent);
    return checkinChanged.subscribe(setCurrent);
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Offline: keep the cached check-in.
      refreshCurrentCheckin().then(setCurrent).catch(() => {});
    }, []),
  );

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>, failMsg: string) {
    setBusy(kind);
    setMessage(null);
    setAlertsResult(null);
    try {
      await withTimeout(fn(), BOUND_MS);
    } catch (e) {
      setMessage(friendlySbMessage(e, failMsg));
    } finally {
      setBusy(null);
    }
  }

  const findCourt = () =>
    run(
      'find',
      async () => {
        setAddAt(null);
        // Fresh fix first; the remembered one (up to a day old) still finds a
        // court but never prefills "Add this court" with a stale spot.
        const freshAt = await getCurrentCoords({ timeoutMs: 6_000 });
        const at = freshAt ?? (await getLastKnownCoords());
        if (!at) {
          setMessage('Turn on location to find the court you are at.');
          return;
        }
        const v = await resolveVenueAt(at.lat, at.lng, 150);
        setNearby(v);
        if (!v) {
          setMessage('No court found within 150 m of you.');
          setAddAt(freshAt);
        }
      },
      "Couldn't look up nearby courts.",
    );

  const checkIn = (v: NearbyVenue) =>
    run(
      'checkin',
      async () => {
        const next = await checkInAt({ id: v.id, name: v.name });
        setCurrent(next);
        setNearby(null);
        setAddAt(null);
        setRosterKey((k) => k + 1);
        if (next.queued) setMessage('Saved offline. It syncs when you are back online.');
        else {
          noteGoodMoment(); // a check-in that went through (rating prompt)
          void claimAlertsOffer().then((show) => show && setAlertsOffer('ask'));
        }
      },
      "Couldn't check you in.",
    );

  const extend = (cur: CurrentCheckin) =>
    run(
      'extend',
      async () => {
        const next = await extendCheckinByHour(cur);
        if (next) setCurrent(next);
      },
      "Couldn't extend your check-in.",
    );

  const out = (cur: CurrentCheckin) =>
    run(
      'out',
      async () => {
        await checkOut(cur.id);
        setCurrent(null);
        setRosterKey((k) => k + 1);
      },
      "Couldn't check you out.",
    );

  // Same path as the Settings toggle: the OS sheets ask for Always location;
  // 0 fenced courts means it couldn't start, so leave it off. Not bounded:
  // the user may sit on the permission sheet.
  async function turnOnAlerts() {
    setAlertsOffer('busy');
    try {
      const n = await setCourtAlertsEnabled(true);
      if (n === 0) {
        await setCourtAlertsEnabled(false);
        setAlertsResult(
          `Arrival alerts are off: they need location set to "${ALWAYS_LABEL}". Change it in your phone's Settings for Pickleague, then turn them on in Settings > Court Arrival Alerts.`,
        );
      } else {
        setAlertsResult(
          `Arrival alerts are on for ${n} court${n === 1 ? '' : 's'}. You'll get a notification with a Check in button; it never checks you in on its own.`,
        );
      }
    } catch {
      await setCourtAlertsEnabled(false).catch(() => 0);
      setAlertsResult("Couldn't turn on arrival alerts. Try again in Settings > Court Arrival Alerts.");
    } finally {
      setAlertsOffer(null);
    }
  }

  const tap = (target: CourtCardTap, fn: () => void) => () => {
    onTap?.(target);
    fn();
  };

  // Outcome lines and the one-time offers render under either look.
  const footer = (
    <>
      {message ? <Text style={[t.sub, S.gapSm]}>{message}</Text> : null}
      {addAt && !current && !nearby && !busy ? (
        <Button
          title="Add this court"
          size="sm"
          variant="outline"
          onPress={tap('add_court', () => {
            // Cleared so coming back doesn't offer the just-added court again.
            setAddAt(null);
            setMessage(null);
            navigation.navigate('SubmitVenue', { lat: addAt.lat, lng: addAt.lng });
          })}
          style={S.hug}
        />
      ) : null}
      {alertsOffer ? (
        <View style={S.offer}>
          <Text style={t.body}>Get a nudge when you arrive here next time?</Text>
          <Text style={[t.sub, S.gapSm]}>
            A notification with a Check in button. It never checks you in on its own. Needs location set to "
            {ALWAYS_LABEL}".
          </Text>
          <View style={S.row}>
            <Button
              title="Turn on"
              size="sm"
              loading={alertsOffer === 'busy'}
              disabled={alertsOffer === 'busy'}
              onPress={() => {
                onTap?.('alerts_on');
                void turnOnAlerts();
              }}
            />
            <Button
              title="Not now"
              size="sm"
              variant="outline"
              disabled={alertsOffer === 'busy'}
              onPress={tap('alerts_not_now', () => setAlertsOffer(null))}
            />
          </View>
        </View>
      ) : null}
      {alertsResult ? <Text style={[t.sub, S.gapSm]}>{alertsResult}</Text> : null}
    </>
  );

  if (current) {
    // NOW: "📍 Lake Merritt · checked in · til 7:30", then who's here next to
    // the actions. "Start playing" rides the title line (the plan's second line
    // only fits [+1 h] [Check out] beside the avatars). "Start playing" and
    // "+1 h" hide while a play session runs, because the floating PlayIsland
    // shows that same button then (one place per action). Check out stays: the
    // island's End stops the session, it doesn't check you out.
    return (
      <Panel padded={false} emphasis style={S.panel}>
        <View style={[S.line, S.titleRow]}>
          <Text style={[t.title, S.flex]} numberOfLines={1}>
            📍 {current.venueName}
            <Text style={t.sub}> · checked in · til {timeLabel(current.expiresAt)}</Text>
          </Text>
          {!playing && (
            <Button
              title="Start playing"
              size="sm"
              variant="success"
              disabled={!!busy}
              onPress={tap('start_playing', () =>
                startPlay({ kind: 'open_play', sourceId: null, venueId: current.venueId, venueName: current.venueName }),
              )}
            />
          )}
        </View>
        <HereLine key={`${current.venueId}:${rosterKey}`} venueId={current.queued ? null : current.venueId}>
          {!playing && (
            <Button
              title="+1 h"
              size="sm"
              variant="outline"
              loading={busy === 'extend'}
              disabled={!!busy || !!current.queued}
              onPress={tap('extend', () => {
                void extend(current);
              })}
            />
          )}
          <Button
            title="Check out"
            size="sm"
            variant="danger"
            loading={busy === 'out'}
            disabled={!!busy}
            onPress={tap('check_out', () => {
              void out(current);
            })}
          />
        </HereLine>
        <PauseSharingChip style={S.hug} />
        {footer}
      </Panel>
    );
  }

  if (nearby) {
    return (
      <Panel padded={false} emphasis style={S.panel}>
        <View style={S.line}>
          <Text style={t.title} numberOfLines={2}>
            📍 Check in at {nearby.name} for 2 hours?
          </Text>
        </View>
        <HereLine key={`${nearby.id}:${rosterKey}`} venueId={nearby.id}>
          <Button
            title="Check in"
            size="sm"
            loading={busy === 'checkin'}
            disabled={!!busy}
            onPress={tap('check_in', () => {
              void checkIn(nearby);
            })}
          />
          <Button
            title="Not here"
            size="sm"
            variant="outline"
            disabled={!!busy}
            onPress={tap('not_here', () => setNearby(null))}
          />
        </HereLine>
        <CrowdLine venueId={nearby.id} venueName={nearby.name} star />
        {footer}
      </Panel>
    );
  }

  // Idle: the 48px court row. "Just play" keeps the old "Start a session
  // without checking in" reachable; it hides while a session already runs.
  return (
    <Panel padded={false} style={S.panel}>
      <View style={S.courtRow}>
        <Text style={[t.title, S.flex]} numberOfLines={1}>
          📍 At the courts?
        </Text>
        {busy === 'find' ? <ActivityIndicator color={c.primary} /> : null}
        {!playing && (
          <TouchableOpacity
            style={S.link}
            activeOpacity={0.6}
            disabled={!!busy}
            onPress={tap('just_play', () => startPlay({ kind: 'open_play', sourceId: null, venueId: null, venueName: null }))}
            accessibilityRole="button"
            accessibilityLabel="Start a session without checking in"
          >
            <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Just play
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={S.link}
          activeOpacity={0.6}
          disabled={!!busy}
          onPress={tap('find_court', () => {
            void findCourt();
          })}
          accessibilityRole="button"
          accessibilityLabel="Find my court"
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            Find my court ›
          </Text>
        </TouchableOpacity>
      </View>
      {footer}
    </Panel>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Panel's chrome (radius 14) with this card's own inset. `padded={false}`
    // sets no padding of its own (foundation 1.42), so this applies on web too.
    // Checked in or offering a check-in it is the Emphasis variant (one per
    // screen; HomeScreen gives NOW's other panel none while this one shows).
    panel: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.xxs },
    // The court row: 48 tall (44 tap boxes inside the 2px inset).
    courtRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
    line: { minHeight: 44, justifyContent: 'center' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
    flex: { flex: 1, minWidth: 0 },
    link: { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
    hug: { alignSelf: 'flex-start' },
    gapSm: { marginTop: SPACE.xs, marginBottom: SPACE.xs },
    offer: { marginTop: SPACE.sm, paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: c.border },
  });
}

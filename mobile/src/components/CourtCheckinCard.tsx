// "Check in at a court" + who's here now. Home screen card; works on web too
// (the browser asks for location).
//
// Every button is bounded (10 s) and resets its busy state in `finally`, so a
// dead connection can never leave a spinner running.
//
// No court in range offers "Add this court" (SubmitVenue, prefilled with the
// spot). After the first check-in that goes through, native shows a one-time
// offer to turn on court arrival alerts (otherwise only in Settings).
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
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
import PlayersHereList from './PlayersHereList';
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

export default function CourtCheckinCard() {
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

  return (
    <View style={S.card}>
      <Text style={[t.title, S.gapSm]}>📍 Court check-in</Text>
      {current ? (
        <>
          <Text style={t.body}>
            You're at <Text style={S.strong}>{current.venueName}</Text> until {timeLabel(current.expiresAt)}.
          </Text>
          <View style={S.row}>
            <Button
              title="Stay 1 more hour"
              variant="outline"
              loading={busy === 'extend'}
              disabled={!!busy || !!current.queued}
              onPress={() => extend(current)}
              style={S.flex}
            />
            <Button
              title="Check out"
              variant="danger"
              loading={busy === 'out'}
              disabled={!!busy}
              onPress={() => out(current)}
              style={S.flex}
            />
          </View>
          {!playing && (
            <Button
              title="Start playing"
              variant="success"
              disabled={!!busy}
              onPress={() =>
                startPlay({ kind: 'open_play', sourceId: null, venueId: current.venueId, venueName: current.venueName })
              }
              style={S.top}
            />
          )}
          {!current.queued && <PlayersHereList key={`${current.venueId}:${rosterKey}`} venueId={current.venueId} />}
        </>
      ) : nearby ? (
        <>
          <Text style={t.body}>
            Check in at <Text style={S.strong}>{nearby.name}</Text> for 2 hours?
          </Text>
          <View style={S.row}>
            <Button
              title="Check in"
              loading={busy === 'checkin'}
              disabled={!!busy}
              onPress={() => checkIn(nearby)}
              style={S.flex}
            />
            <Button title="Not here" variant="outline" disabled={!!busy} onPress={() => setNearby(null)} style={S.flex} />
          </View>
          <PlayersHereList key={`${nearby.id}:${rosterKey}`} venueId={nearby.id} />
        </>
      ) : (
        <>
          <Text style={[t.bodySub, S.gapSm]}>Let other players know you're at the courts.</Text>
          <Button title="Find my court" loading={busy === 'find'} disabled={!!busy} onPress={findCourt} />
          {!playing && (
            <Button
              title="Start a session without checking in"
              variant="outline"
              disabled={!!busy}
              onPress={() => startPlay({ kind: 'open_play', sourceId: null, venueId: null, venueName: null })}
              style={S.top}
            />
          )}
        </>
      )}
      {busy === 'find' && !nearby ? <ActivityIndicator style={S.gapSm} color={c.primary} /> : null}
      {message ? <Text style={[t.sub, S.gapSm]}>{message}</Text> : null}
      {addAt && !current && !nearby && !busy ? (
        <Button
          title="Add this court"
          variant="outline"
          onPress={() => {
            // Cleared so coming back doesn't offer the just-added court again.
            setAddAt(null);
            setMessage(null);
            navigation.navigate('SubmitVenue', { lat: addAt.lat, lng: addAt.lng });
          }}
          style={S.top}
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
              loading={alertsOffer === 'busy'}
              disabled={alertsOffer === 'busy'}
              onPress={turnOnAlerts}
              style={S.flex}
            />
            <Button
              title="Not now"
              variant="outline"
              disabled={alertsOffer === 'busy'}
              onPress={() => setAlertsOffer(null)}
              style={S.flex}
            />
          </View>
        </View>
      ) : null}
      {alertsResult ? <Text style={[t.sub, S.gapSm]}>{alertsResult}</Text> : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 14,
      marginHorizontal: 16,
      marginTop: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    row: { flexDirection: 'row', gap: 10, marginTop: 12 },
    flex: { flex: 1 },
    strong: { fontWeight: '700' },
    top: { marginTop: 10 },
    gapSm: { marginTop: 6, marginBottom: 4 },
    offer: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border },
  });
}

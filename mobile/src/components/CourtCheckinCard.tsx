// "Check in at a court" + who's here now. Home screen card; works on web too
// (the browser asks for location).
//
// Every button is bounded (10 s) and resets its busy state in `finally`, so a
// dead connection can never leave a spinner running.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { getCurrentCoords, withTimeout } from '@just-messin-around/expo-foundation/platform';
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

const BOUND_MS = 10_000;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function CourtCheckinCard() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);
  const [nearby, setNearby] = useState<NearbyVenue | null>(null);
  const [busy, setBusy] = useState<null | 'find' | 'checkin' | 'extend' | 'out'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rosterKey, setRosterKey] = useState(0);

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
        const at = await getCurrentCoords({ fallbackToLastKnown: true, timeoutMs: 6_000 });
        if (!at) {
          setMessage('Turn on location to find the court you are at.');
          return;
        }
        const v = await resolveVenueAt(at.lat, at.lng, 150);
        setNearby(v);
        if (!v) setMessage('No court found within 150 m of you.');
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
        setRosterKey((k) => k + 1);
        if (next.queued) setMessage('Saved offline. It syncs when you are back online.');
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
        </>
      )}
      {busy === 'find' && !nearby ? <ActivityIndicator style={S.gapSm} color={c.primary} /> : null}
      {message ? <Text style={[t.sub, S.gapSm]}>{message}</Text> : null}
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
    gapSm: { marginTop: 6, marginBottom: 4 },
  });
}

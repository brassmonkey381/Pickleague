// First run (PKL-020 change 3): Welcome, Your courts, Alerts, one per screen,
// then Home. Brian picked option A without the "How do you play" step. The
// shell is the kit's FirstRunSteps; the rules are in lib/firstRun.ts.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { FirstRunSteps, type FirstRunStep } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import { currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import {
  getCurrentCoords,
  getForegroundLocationStatus,
  requestForegroundLocationPermission,
} from '@just-messin-around/expo-foundation/platform/location';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import type { RootStackParamList } from '../types';
import { courtMetaLine, courtReasons, markFirstRunSeen, type SuggestedCourt } from '../lib/firstRun';
import { fetchSuggestedCourts } from '../data/suggestedCourts';
import { searchUsCities, type CitySuggestion } from '../data/courtDiscovery';
import { MAX_COURT_FAVORITES, toggleCourtFavorite } from '../data/courtFavorites';
import { enablePushNotifications } from '../lib/push';
import { loadUserPreferencesResult, saveUserPreferences } from '../lib/userPreferences';
import { trackRecActed, trackRecShown } from '../lib/analytics';

type Props = NativeStackScreenProps<RootStackParamList, 'FirstRun'>;

type CourtsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; courts: SuggestedCourt[]; where: 'here' | 'home' | 'city' }
  | { kind: 'needPlace' }
  | { kind: 'error'; message: string };

export default function FirstRunScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();

  useEffect(() => {
    void currentUserId(supabase).then(uid => (uid ? markFirstRunSeen(uid) : undefined));
  }, []);

  const finish = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  }, [navigation]);

  // ── Your courts ──
  const [courts, setCourts] = useState<CourtsState>({ kind: 'idle' });
  const [picked, setPicked] = useState<string[]>([]);
  const shownRef = useRef(false);

  const load = useCallback(async (point: { lat: number; lng: number } | null, where: 'here' | 'home' | 'city') => {
    setCourts({ kind: 'loading' });
    try {
      const res = await fetchSuggestedCourts(point);
      if (!res.located) {
        setCourts({ kind: 'needPlace' });
        return;
      }
      setCourts({ kind: 'ready', courts: res.courts, where: point ? where : 'home' });
      if (!shownRef.current && res.courts.length > 0 && res.source === 'ranked') {
        shownRef.current = true;
        trackRecShown('suggested-courts', { surface: 'first-run', count: res.courts.length });
      }
    } catch (e) {
      setCourts({ kind: 'error', message: friendlySbMessage(e, "Couldn't load courts. Check your connection.") });
    }
  }, []);

  /** On the courts step: the phone's location if already allowed, else the home location. */
  const startCourts = useCallback(async () => {
    if (courts.kind !== 'idle') return;
    const status = await getForegroundLocationStatus().catch(() => 'denied' as const);
    if (status === 'granted') {
      const here = await getCurrentCoords({ timeoutMs: 6_000, fallbackToLastKnown: true }).catch(() => null);
      if (here) return load({ lat: here.lat, lng: here.lng }, 'here');
    }
    return load(null, 'home');
  }, [courts.kind, load]);

  const useMyLocation = useCallback(async () => {
    const ok = await requestForegroundLocationPermission().catch(() => false);
    if (!ok) {
      toast.error('Location is off for Pickleague. Search for your city instead.');
      setCourts(s => (s.kind === 'ready' ? s : { kind: 'needPlace' }));
      return;
    }
    const here = await getCurrentCoords({ timeoutMs: 8_000, fallbackToLastKnown: true }).catch(() => null);
    if (!here) {
      toast.error("Couldn't find your location. Search for your city instead.");
      return;
    }
    await load({ lat: here.lat, lng: here.lng }, 'here');
  }, [load, toast]);

  const togglePick = useCallback((id: string) => {
    setPicked(p => {
      if (p.includes(id)) return p.filter(x => x !== id);
      if (p.length >= MAX_COURT_FAVORITES) {
        toast.info(`Pick up to ${MAX_COURT_FAVORITES} courts. You can change them later.`);
        return p;
      }
      return [...p, id];
    });
  }, [toast]);

  const saveCourts = useCallback(async () => {
    if (picked.length === 0) return;
    const list = courts.kind === 'ready' ? courts.courts : [];
    for (const id of picked) {
      const row = list.find(x => x.venue_id === id);
      try {
        await toggleCourtFavorite(id, true, row?.name ?? null);
      } catch (e) {
        toast.error((e as Error)?.message ?? "Couldn't save your courts.");
        throw e;
      }
      const rank = list.findIndex(x => x.venue_id === id);
      trackRecActed('suggested-courts', { surface: 'first-run', action: 'accepted', rank: rank >= 0 ? rank + 1 : null });
    }
  }, [picked, courts, toast]);

  // ── Alerts ──
  const pushPossible = Platform.OS !== 'web';
  const turnOnAlerts = useCallback(async () => {
    if (!pushPossible) return;
    const outcome = await enablePushNotifications();
    if (outcome.status === 'registered') {
      const r = await loadUserPreferencesResult();
      if (r.status === 'ok') await saveUserPreferences({ ...r.prefs, pushEnabled: true });
      toast.success('Alerts are on. Change them any time in Settings.');
    } else if (outcome.status === 'failed') {
      toast.error(friendlySbMessage(outcome.error, "Couldn't turn on alerts just now. Try again in Settings."));
    } else {
      toast.info('Alerts are off. Turn them on any time in Settings.');
    }
  }, [pushPossible, toast]);

  const steps: FirstRunStep[] = [
    {
      key: 'welcome',
      title: 'Welcome to Pickleague',
      body: 'Two quick things so we can find you games: the courts you play at, and your alerts.',
      nextLabel: "Let's go",
      skippable: false,
      content: <CheckList rows={['Your courts', 'Alerts', 'Then Home: leagues near you']} />,
    },
    {
      key: 'courts',
      title: 'Your courts',
      body: `Pick up to ${MAX_COURT_FAVORITES}. We'll show who's playing there and tell you about games nearby.`,
      nextLabel: picked.length > 0 ? `Save ${picked.length === 1 ? 'court' : `${picked.length} courts`}` : 'Next',
      onNext: saveCourts,
      content: (
        <CourtsStep
          state={courts}
          picked={picked}
          onPick={togglePick}
          onUseLocation={useMyLocation}
          onCity={city => load({ lat: city.lat, lng: city.lng }, 'city')}
          onRetry={() => {
            setCourts({ kind: 'idle' });
            void load(null, 'home');
          }}
        />
      ),
    },
    {
      key: 'alerts',
      title: 'Alerts',
      body: pushPossible
        ? 'Get a nudge for match invites, scores to confirm and league news. You choose which ones in Settings.'
        : 'Alerts work in the Pickleague phone app. On the web, check Home for what is new.',
      nextLabel: pushPossible ? 'Turn on alerts' : 'Done',
      onNext: turnOnAlerts,
      content: pushPossible ? (
        <CheckList rows={['Match invites and challenges', 'Scores to confirm (unconfirmed matches drop after an hour)', 'League and event news']} />
      ) : null,
    },
  ];

  return (
    <FirstRunSteps
      steps={steps}
      onDone={finish}
      onIndexChange={i => {
        if (steps[i]?.key === 'courts') void startCourts();
      }}
    />
  );

}

function CheckList({ rows }: { rows: string[] }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <View style={S.alertList}>
      {rows.map(r => (
        <View key={r} style={S.alertRow}>
          <Icon name="check" size={18} color={c.primary} />
          <Text style={[t.body, S.flex]}>{r}</Text>
        </View>
      ))}
    </View>
  );
}

function CourtsStep({
  state,
  picked,
  onPick,
  onUseLocation,
  onCity,
  onRetry,
}: {
  state: CourtsState;
  picked: string[];
  onPick: (id: string) => void;
  onUseLocation: () => Promise<void>;
  onCity: (city: CitySuggestion) => void;
  onRetry: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [locBusy, setLocBusy] = useState(false);

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <ActivityIndicator style={S.spinner} color={c.primary} />;
  }
  if (state.kind === 'error') {
    return (
      <View style={S.gap}>
        <Text style={t.bodySub}>{state.message}</Text>
        <Button title="Try again" variant="outline" onPress={onRetry} />
      </View>
    );
  }

  const locate = (
    <Button
      title="Use my location"
      variant="outline"
      iconName="pin"
      loading={locBusy}
      onPress={async () => {
        setLocBusy(true);
        try {
          await onUseLocation();
        } finally {
          setLocBusy(false);
        }
      }}
    />
  );

  if (state.kind === 'needPlace') {
    return (
      <View style={S.gap}>
        {locate}
        <CitySearch onCity={onCity} />
      </View>
    );
  }

  return (
    <View style={S.gap}>
      {state.courts.length === 0 ? (
        <Text style={t.bodySub}>No courts listed near there yet. Try another city, or skip and add one later.</Text>
      ) : (
        state.courts.map(court => {
          const on = picked.includes(court.venue_id);
          const reasons = courtReasons(court);
          return (
            <TouchableOpacity
              key={court.venue_id}
              onPress={() => onPick(court.venue_id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={[
                S.row,
                { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primaryLight : c.surface },
              ]}
            >
              <View style={S.flex}>
                {court.recommended ? (
                  <Text style={[t.caption, S.tag, { color: c.primary }]}>RECOMMENDED</Text>
                ) : null}
                <Text style={t.title} numberOfLines={1}>
                  {court.name}
                </Text>
                <Text style={t.meta} numberOfLines={1}>
                  {courtMetaLine(court)}
                </Text>
                {reasons.length > 0 ? (
                  <Text style={[t.meta, { color: c.text }]} numberOfLines={1}>
                    {reasons.join(', ')}
                  </Text>
                ) : null}
              </View>
              <Icon name={on ? 'star' : 'star-outline'} size={24} color={on ? c.primary : c.textSub} />
            </TouchableOpacity>
          );
        })
      )}
      {state.where !== 'here' ? locate : null}
      <CitySearch onCity={onCity} />
    </View>
  );
}

function CitySearch({ onCity }: { onCity: (city: CitySuggestion) => void }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CitySuggestion[]>([]);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchUsCities(query, 5)
        .then(r => live && setHits(r))
        .catch(() => live && setHits([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <View>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Or search a city"
        placeholderTextColor={c.textSub}
        autoCorrect={false}
        style={[S.input, t.body, { borderColor: c.border, color: c.text, backgroundColor: c.surface }]}
        accessibilityLabel="Search a city"
      />
      {hits.map(h => (
        <TouchableOpacity
          key={`${h.label}:${h.lat}`}
          onPress={() => {
            setQ('');
            setHits([]);
            onCity(h);
          }}
          accessibilityRole="button"
          style={[S.hit, { borderColor: c.border }]}
        >
          <Text style={t.body}>{h.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: 10 },
  spinner: { marginTop: 24 },
  alertList: { gap: 12 },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 64 },
  tag: { fontWeight: '700', letterSpacing: 1, marginBottom: 2 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, minHeight: 48 },
  hit: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12, minHeight: 44, justifyContent: 'center' },
});

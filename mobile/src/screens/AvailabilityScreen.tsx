// Availability: one weekly grid for when I can play and when I can drill (the
// user, 2026-11-04). Pick Play, Drill or Either, then drag on the grid; a drag
// that starts on the kind being painted clears. Saved as the two grids the
// rest of the app reads (lib/availabilityKinds): play time feeds the "fits my
// schedule" filter and league member overlap, drill time the drill partner
// search. Opened from Drills, Profile (Play) and Play history.
//
//   Paint  [ Play | Drill | Either ]
//   ■ Play  ■ Drill  ■ Either                         Saved
//   presets ... [Edit]
//   the grid, with this week's drill sessions and matches painted over it
//   "Drill times show to partners while Open to drilling is on (Drills)."
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { AvailabilityGrid, ErrorState, Panel, SegmentedToggle, SkeletonList, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { PRESETS } from '../components/AvailabilityGrid';
import { KIND, PAINT_KINDS, fromKinds, kindsSummary, toKinds } from '../lib/availabilityKinds';
import { loadCommitments, type Commitments } from '../data/availabilityCommitments';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Availability'>;

type Save = 'idle' | 'saving' | 'saved' | 'error';

export default function AvailabilityScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [kinds, setKinds] = useState<number[] | null>(null);
  const [drilling, setDrilling] = useState(true);
  const [paint, setPaint] = useState<number>(KIND.play);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [save, setSave] = useState<Save>('idle');
  // What's already booked this week, over the grid (best effort).
  const [booked, setBooked] = useState<Commitments | null>(null);
  const userId = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Edits save in order: a newer save never lands under an older one.
  const saveSeq = useRef(0);

  const colorOf: Record<number, string> = {
    [KIND.play]: c.primary,
    [KIND.drill]: c.warning,
    [KIND.either]: c.info,
  };

  async function load() {
    setLoadError(null);
    try {
      const id = await currentUserId(supabase);
      userId.current = id;
      if (!id) throw new Error('Not signed in');
      const data = await sbCall(() =>
        supabase.from('profiles').select('availability, drill_availability, drilling_enabled').eq('id', id).single(),
      );
      setKinds(toKinds(data?.availability, data?.drill_availability));
      setDrilling(data?.drilling_enabled !== false);
      loadCommitments(id).then(setBooked, () => setBooked(null));
    } catch (e) {
      setLoadError(e);
    }
  }

  useEffect(() => {
    void load();
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  // Fires once per drag release or preset tap.
  async function onValuesChange(next: number[]) {
    setKinds(next);
    const id = userId.current;
    if (!id) return;
    const seq = ++saveSeq.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave('saving');
    try {
      await sbCall(() => supabase.from('profiles').update(fromKinds(next)).eq('id', id));
      if (seq !== saveSeq.current) return;
      setSave('saved');
      saveTimer.current = setTimeout(() => setSave('idle'), 2500);
    } catch {
      if (seq !== saveSeq.current) return;
      setSave('error');
    }
  }

  if (loadError) {
    return (
      <View style={[S.flex, { backgroundColor: c.bg }]}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load your availability. ${friendlySbMessage(loadError)}`}
          onRetry={() => { void load(); }}
        />
      </View>
    );
  }
  if (!kinds) return <View style={[S.flex, { backgroundColor: c.bg }]}><SkeletonList rows={6} variant="row" /></View>;

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={S.page} scrollEnabled={!locked}>
      <Text style={t.sub}>
        When you can play and when you can drill. Players looking for a drill partner see your drill times;
        play times fit you to events and league schedules.
      </Text>

      <View style={S.gap}>
        <Text style={t.label}>Paint</Text>
        <SegmentedToggle
          options={PAINT_KINDS.map(k => ({ value: String(k.value), label: k.label }))}
          value={String(paint)}
          onChange={(v) => setPaint(Number(v))}
          fullWidth
        />
      </View>

      <View style={S.legendRow}>
        {PAINT_KINDS.map(k => (
          <View key={k.value} style={S.legend}>
            <View style={[S.swatch, { backgroundColor: colorOf[k.value] }]} />
            <Text style={t.meta}>{k.label}</Text>
          </View>
        ))}
        <View style={S.flex} />
        {save === 'saving' ? <Text style={t.meta}>Saving…</Text> : null}
        {save === 'saved' ? (
          <View style={S.legend}>
            <Icon name="check-mark" size={12} color={c.success} />
            <Text style={[t.meta, { color: c.success }]}>Saved</Text>
          </View>
        ) : null}
        {save === 'error' ? <Text style={[t.meta, { color: c.danger }]}>Save failed</Text> : null}
      </View>

      <Panel>
        <AvailabilityGrid
          availability={[]}
          values={kinds}
          paintValue={paint}
          valueColors={colorOf}
          onValuesChange={(v) => { void onValuesChange(v); }}
          onScrollLock={setLocked}
          presets={PRESETS}
          dragSelect="rectangle"
          showSummary={false}
          highlightToday
          overlays={booked ? [
            { label: 'Drill session', color: c.rarityRare, slots: booked.drills },
            { label: 'Match or tournament', color: c.danger, slots: booked.matches },
          ] : undefined}
          hoursLabel={() => kindsSummary(kinds)}
        />
      </Panel>

      {!drilling ? (
        <View style={S.note}>
          <Text style={[t.sub, S.flex]}>Your drill times show to other players once Open to drilling is on.</Text>
          <TextLink label="Drills" onPress={() => navigation.navigate('Drill')} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const S = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: 96 },
  gap: { gap: SPACE.xs },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 24 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  note: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});

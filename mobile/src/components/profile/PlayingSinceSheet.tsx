// "When did you start playing?": the month and year a player picked up
// pickleball (not when they joined Pickleague), shown on the Profile player
// card as "SINCE MAR 2021". Saved through set_playing_since
// (migration_profile_playing_since.sql), which keeps the month only.
//
//   Year   [2026] [2025] [2024] ...  (scrolls back to 1965)
//   Month  Jan Feb Mar Apr
//          May Jun Jul Aug
//          Sep Oct Nov Dec            (months after this one are off)
//   [Clear]                  [Save]
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomSheet, Chip } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { isMissingRpcError } from '../../lib/playersNear';
import { MONTHS, monthAllowed, parseSince, sinceDate, sinceYears } from '../../lib/playingSince';

type Props = {
  visible: boolean;
  /** profiles.playing_since ('YYYY-MM-01') or null. */
  value: string | null;
  onClose: () => void;
  /** The saved value ('YYYY-MM-01', or null once cleared). */
  onSaved: (value: string | null) => void;
};

export default function PlayingSinceSheet({ visible, value, onClose, onSaved }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const now = new Date();
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Each opening starts from what's saved.
  useEffect(() => {
    if (!visible) return;
    const p = parseSince(value);
    setYear(p?.year ?? null);
    setMonth(p?.month ?? null);
  }, [visible, value]);

  async function save(next: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await sbCall(() => supabase.rpc('set_playing_since', { p_since: next }));
      onSaved((saved as string | null) ?? null);
      onClose();
    } catch (e) {
      toast.error(isMissingRpcError(e)
        ? "Playing since isn't switched on yet. Try again after the next update."
        : `Couldn't save that. ${friendlySbMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const ready = year != null && month != null && monthAllowed(year, month, now);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="When did you start playing?">
      <Text style={[t.sub, S.lede]}>The month you first played pickleball, shown on your player card.</Text>

      <Text style={t.label}>Year</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.years}>
        {sinceYears(now).map(y => (
          <Chip key={y} label={String(y)} selected={year === y} onPress={() => setYear(y)} />
        ))}
      </ScrollView>

      <Text style={[t.label, S.monthLabel]}>Month</Text>
      <View style={S.months}>
        {MONTHS.map((m, i) => (
          <View key={m} style={S.monthCell}>
            <Chip
              label={m}
              selected={month === i}
              disabled={year != null && !monthAllowed(year, i, now)}
              onPress={() => setMonth(i)}
            />
          </View>
        ))}
      </View>

      <View style={S.actions}>
        {value ? (
          <Button title="Clear" variant="outline" onPress={() => void save(null)} disabled={busy} style={S.flex} />
        ) : null}
        <Button
          title="Save"
          onPress={() => { if (ready) void save(sinceDate(year!, month!)); }}
          disabled={!ready || busy}
          loading={busy}
          style={S.flex}
        />
      </View>
    </BottomSheet>
  );
}

const S = StyleSheet.create({
  lede: { marginBottom: SPACE.md },
  years: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  monthLabel: { marginTop: SPACE.sm },
  months: { flexDirection: 'row', flexWrap: 'wrap', marginTop: SPACE.sm, rowGap: SPACE.sm },
  monthCell: { width: '25%', paddingRight: SPACE.sm },
  actions: { flexDirection: 'row', gap: SPACE.md, marginTop: SPACE.lg },
  flex: { flex: 1 },
});
